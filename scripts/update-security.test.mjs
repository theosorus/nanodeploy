import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = await readFile(new URL('./update.sh', import.meta.url), 'utf8');
const start = source.indexOf('\nrollback() {');
const end = source.indexOf('\n}\n', start);
assert.ok(start >= 0 && end > start);
const rollback = source.slice(start, end + 3);

async function fixture(encrypted) {
  const work = await mkdtemp(join(tmpdir(), 'nanodeploy-update-audit-'));
  const env = { ...process.env, PATH: `${work}/bin:${process.env.PATH}` };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await mkdir(join(work, 'bin'));
  await mkdir(join(work, 'control-plane/src'), { recursive: true });
  await writeFile(join(work, 'bin/docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> docker-calls\n', { mode: 0o755 });
  await writeFile(join(work, 'install.sh'), '#!/bin/sh\ntouch installer-ran\n', { mode: 0o755 });
  await writeFile(join(work, 'control-plane/src/db.ts'), '// old fixture\n');
  if (encrypted) await writeFile(join(work, 'control-plane/src/app-secrets.ts'), '// encrypted fixture\n');
  git('init', '-q');
  const commit = () => { git('add', '.'); git('-c', 'user.name=Security test', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const current = commit();
  await writeFile(join(work, 'control-plane/src/app-secrets.ts'), '// upgraded fixture\n');
  const next = commit();
  return { work, env, git, current, next };
}

for (const encrypted of [false, true]) {
  test(encrypted ? 'a compatible code rollback still restarts the previous version' : 'an encryption migration never rolls old code back onto the new database', async () => {
    const f = await fixture(encrypted);
    try {
      const code = `set -euo pipefail\ncurrent=${f.current}\nnext=${f.next}\nFAILED_MARK=.update-failed\nsay() { printf '%s\\n' "$1"; }\n${rollback}\nrollback`;
      const result = spawnSync('bash', ['-c', code], { cwd: f.work, env: f.env, encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(await readFile(join(f.work, '.update-failed'), 'utf8'), f.next + '\n');
      if (encrypted) {
        assert.equal(f.git('rev-parse', 'HEAD'), f.current);
        assert.equal(await readFile(join(f.work, 'installer-ran'), 'utf8'), '');
      } else {
        assert.equal(f.git('rev-parse', 'HEAD'), f.next, 'incompatible checkout must never be started');
        await assert.rejects(readFile(join(f.work, 'installer-ran')), { code: 'ENOENT' });
        assert.equal(await readFile(join(f.work, 'docker-calls'), 'utf8'), 'compose stop control-plane\n');
        assert.match(result.stdout, /encryption migration/);
      }
    } finally { await rm(f.work, { recursive: true, force: true }); }
  });
}
