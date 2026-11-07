import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

const exec = promisify(execFile);

for (const mode of ['green', 'pending', 'red', 'absent', 'unreachable', 'baseline-unavailable', 'baseline-invalid', 'baseline-redirect']) {
  test(`automatic update: ${mode}`, async () => {
    const work = await mkdtemp(join(tmpdir(), 'nanodeploy-update-setup-'));
    const token = 'fixture-deploy-token-never-printed';
    const requests = [];
    const server = createServer((req, res) => {
      requests.push({ path: req.url, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.statusCode = mode === 'baseline-unavailable' ? 503 : mode === 'baseline-redirect' ? 302 : 200;
      if (mode === 'baseline-redirect') res.setHeader('location', '/redirected');
      res.end(mode === 'baseline-invalid' ? 'not JSON' : JSON.stringify({ apps: [{}, {}] }));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      await mkdir(join(work, 'scripts'));
      await mkdir(join(work, 'bin'));
      await writeFile(join(work, 'scripts/update.sh'), source);
      await writeFile(join(work, '.env'), `APPS_DOMAIN=apps.fixture.invalid\nDEPLOY_TOKEN=${token}\nCADDY_PORT=${server.address().port}\nUPDATE_HEALTH_TRIES=1\nUPDATE_BRANCH=main\nGITHUB_API_URL=https://github.fixture.invalid\n`);
      const scripts = {
        'bin/flock': '#!/bin/sh\nexit 0\n',
        'scripts/backup.sh': '#!/bin/sh\nprintf "backup\\n" >> "$NANODEPLOY_UPDATE_FIXTURE/actions"\nprintf private > "$NANODEPLOY_UPDATE_FIXTURE/backup-private"\n',
        'install.sh': '#!/bin/sh\nprintf "install\\n" >> "$NANODEPLOY_UPDATE_FIXTURE/actions"\nprintf private > "$NANODEPLOY_UPDATE_FIXTURE/installer-secret"\n',
        'bin/git': `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') console.log((args[1] === 'HEAD' ? 'a' : 'b').repeat(40));
else if (args[0] === 'remote') console.log('https://github.com/fixture/platform.git');
else if (args[0] === 'merge') {
  appendFileSync(process.env.NANODEPLOY_UPDATE_FIXTURE + '/actions', 'merge\\n');
  writeFileSync(process.env.NANODEPLOY_UPDATE_FIXTURE + '/checkout-source', 'public source');
}
`,
        'bin/curl': `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.NANODEPLOY_UPDATE_FIXTURE + '/curl-args', JSON.stringify(args) + '\\n');
const mode = process.env.NANODEPLOY_UPDATE_MODE;
if (mode === 'unreachable') process.exit(22);
const checks = mode === 'absent' ? [] : [{ status: mode === 'pending' ? 'in_progress' : 'completed', conclusion: mode === 'red' ? 'failure' : 'success' }];
console.log(JSON.stringify({ check_runs: checks }));
`,
      };
      // Executable fixture scripts use ESM on every supported Node version.
      await writeFile(join(work, 'package.json'), '{"type":"module"}\n');
      for (const [path, code] of Object.entries(scripts)) await writeFile(join(work, path), code, { mode: 0o700 });
      const env = { ...process.env, PATH: `${work}/bin:${process.env.PATH}`, NANODEPLOY_UPDATE_FIXTURE: work, NANODEPLOY_UPDATE_MODE: mode,
        HTTP_PROXY: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:1', NO_PROXY: '', no_proxy: '' };
      for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
      const run = await exec('bash', [join(work, 'scripts/update.sh')], { cwd: work, env, timeout: 10000 })
        .then((result) => ({ status: 0, ...result }), (error) => ({ status: error.code, stdout: error.stdout, stderr: error.stderr }));
      const failed = mode === 'red' || mode.startsWith('baseline-');
      assert.equal(run.status, failed ? 1 : 0, run.stderr);
      const actions = await readFile(join(work, 'actions'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      assert.deepEqual(actions.trim().split('\n').filter(Boolean), mode === 'green' ? ['backup', 'merge', 'install'] : []);
      if (mode === 'green') {
        assert.equal((await stat(join(work, 'checkout-source'))).mode & 0o777, 0o644);
        for (const path of ['backup-private', 'installer-secret']) assert.equal((await stat(join(work, path))).mode & 0o777, 0o600);
      }
      const curlArgs = await readFile(join(work, 'curl-args'), 'utf8');
      assert.equal(curlArgs.includes(token), false, 'the deployment token must not appear in command arguments');
      assert.equal(requests.length, mode === 'green' ? 2 : mode.startsWith('baseline-') ? 1 : 0);
      for (const request of requests) {
        assert.equal(request.path, '/api/apps');
        assert.equal(request.authorization, `Bearer ${token}`);
      }
      if (mode === 'red') assert.equal(await readFile(join(work, '.update-failed'), 'utf8'), 'b'.repeat(40) + '\n');
      else await assert.rejects(readFile(join(work, '.update-failed')), { code: 'ENOENT' });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(work, { recursive: true, force: true });
    }
  });
}
