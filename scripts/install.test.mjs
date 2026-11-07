import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const exec = promisify(execFile);
const root = new URL('../', import.meta.url);

async function fixture(run) {
  const work = await mkdtemp(join(tmpdir(), 'nanodeploy-install-'));
  // Spaces, dollar signs, backslashes and percent signs exercise real .env and
  // systemd quoting. No test reads the developer's .env or contacts Docker.
  const checkout = join(work, 'checkout $literal\\name 50%');
  const bin = join(work, 'bin');
  try {
    await mkdir(checkout);
    await mkdir(join(checkout, 'scripts'));
    await mkdir(bin);
    for (const file of ['install.sh', '.env.example', 'nanodeploy.service', 'nanodeploy-update.service', 'nanodeploy-update.timer', 'scripts/configure-systemd.sh']) {
      await cp(new URL(file, root), join(checkout, file));
    }
    await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$NANODEPLOY_INSTALL_CALLS"
case "$*" in
  'version --format {{.Server.Version}}') printf '%s\\n' "\${NANODEPLOY_FIXTURE_ENGINE:-29.4.0}" ;;
  'info --format {{.OSType}}') echo linux ;;
  'info --format {{.Architecture}}') echo x86_64 ;;
  'info --format {{.DockerRootDir}}') echo /srv/docker ;;
  'info --format {{json .SecurityOptions}}') printf '%s\\n' "\${NANODEPLOY_FIXTURE_SECURITY:-[]}" ;;
  'context inspect --format {{.Endpoints.docker.Host}}') echo unix:///var/run/docker.sock ;;
  'network inspect -f {{.Internal}} '*|network*) echo 'unexpected network mutation' >&2; exit 90 ;;
esac
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NANODEPLOY_INSTALL_CALLS: join(work, 'calls') };
    for (const key of ['APPS_DIR', 'APPS_DOMAIN', 'POSTGRES_PASSWORD', 'DEPLOY_TOKEN', 'GATE_DB_PASSWORD', 'NANODEPLOY_SECRET_KEY',
      'PUBLIC_SCHEME', 'PUBLIC_PORT', 'COOKIE_SECURE', 'CADDY_PORT', 'SUDO_USER', 'DOCKER_HOST', 'DOCKER_CONTEXT',
      'NANODEPLOY_ALLOW_LEGACY_DOCKER']) delete env[key];
    const install = (args, extra = {}) => exec('bash', [join(checkout, 'install.sh'), ...args], { cwd: work, env: { ...env, ...extra } });
    const configure = () => exec('bash', [join(checkout, 'scripts/configure-systemd.sh')], { cwd: work, env });
    const config = () => readFile(join(checkout, '.env'), 'utf8');
    const set = async (key, value) => writeFile(join(checkout, '.env'), (await config()).replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));
    await run({ work, checkout, install, configure, config, set });
  } finally { await rm(work, { recursive: true, force: true }); }
}

test('initialization works from another directory and preserves every generated secret', async () => fixture(async (f) => {
  await f.install(['--init']);
  const first = await f.config();
  for (const key of ['POSTGRES_PASSWORD', 'DEPLOY_TOKEN', 'GATE_DB_PASSWORD']) assert.match(first, new RegExp(`^${key}=[a-f0-9]{48}$`, 'm'));
  assert.match(first, /^NANODEPLOY_SECRET_KEY=[a-f0-9]{64}$/m);
  assert.equal((await stat(join(f.checkout, '.env'))).mode & 0o777, 0o600);
  assert.ok(first.includes(`APPS_DIR='${f.checkout}/var/apps'`));
  await f.install(['--init']);
  assert.equal(await f.config(), first);
  await assert.rejects(readFile(join(f.work, 'calls')), { code: 'ENOENT' }, 'initialization must not use Docker');
}));

test('a copied example gets all four secrets without overwriting configured values', async () => fixture(async (f) => {
  await cp(new URL('.env.example', root), join(f.checkout, '.env'));
  await f.set('APPS_DOMAIN', 'apps.fixture.invalid');
  await f.set('DEPLOY_TOKEN', 'existing-deploy-token-to-preserve');
  await f.set('NANODEPLOY_SECRET_KEY', 'ab'.repeat(32));
  await f.install(['--init']);
  const config = await f.config();
  assert.match(config, /^DEPLOY_TOKEN=existing-deploy-token-to-preserve$/m);
  assert.ok(config.includes('NANODEPLOY_SECRET_KEY=' + 'ab'.repeat(32)));
  assert.match(config, /^POSTGRES_PASSWORD=[a-f0-9]{48}$/m);
  assert.match(config, /^GATE_DB_PASSWORD=[a-f0-9]{48}$/m);
}));

test('a localhost trial passes validation without creating directories or networks', async () => fixture(async (f) => {
  await f.install(['--init', '--local']);
  const before = await f.config();
  assert.match(before, /^COOKIE_SECURE=false$/m);
  assert.match(before, /^PUBLIC_SCHEME=http$/m);
  assert.match(before, /^APPS_DOMAIN=apps.localhost$/m);
  await f.install(['--check']);
  assert.equal(await f.config(), before);
  await assert.rejects(stat(join(f.checkout, 'var')), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(join(f.work, 'calls'), 'utf8'), /network|build|pull|up -d/);
}));

test('check-only never creates a missing configuration', async () => fixture(async (f) => {
  await assert.rejects(f.install(['--check']), /run \.\/install.sh --init first/);
  await assert.rejects(f.config(), { code: 'ENOENT' });
}));

test('local mode never changes a configured server to HTTP', async () => fixture(async (f) => {
  await f.install(['--init']);
  await f.set('APPS_DOMAIN', 'apps.fixture.invalid');
  const before = await f.config();
  await assert.rejects(f.install(['--local']), /cannot change an existing installation/);
  assert.equal(await f.config(), before);
}));

for (const [key, value, expected] of [
  ['APPS_DOMAIN', 'https://apps.fixture.invalid', /lowercase domain/],
  ['APPS_DOMAIN', 'apps..fixture.invalid', /lowercase domain/],
  ['APPS_DIR', 'relative/path', /absolute path/],
  ['PUBLIC_PORT', '70000', /between 1 and 65535/],
  ['COOKIE_SECURE', 'true', /HTTP trials require COOKIE_SECURE=false/],
  ['PUBLIC_SCHEME', 'https', /HTTPS requires COOKIE_SECURE=true/],
  ['DEPLOY_TOKEN', 'short', /24–128/],
]) {
  test(`invalid ${key} fails before contacting Docker`, async () => fixture(async (f) => {
    await f.install(['--init', '--local']);
    await f.set(key, value);
    await assert.rejects(f.install(['--check']), expected);
    await assert.rejects(readFile(join(f.work, 'calls')), { code: 'ENOENT' });
  }));
}

test('obsolete Docker fails before any network or service change', async () => fixture(async (f) => {
  await f.install(['--init', '--local']);
  await assert.rejects(f.install(['--check'], { NANODEPLOY_FIXTURE_ENGINE: '27.5.0' }), /Docker Engine 28 or newer/);
  assert.doesNotMatch(await readFile(join(f.work, 'calls'), 'utf8'), /network|build|pull|up -d/);
}));

test('an existing legacy host can explicitly opt in without changing its configuration', async () => fixture(async (f) => {
  await f.install(['--init', '--local']);
  await writeFile(join(f.checkout, '.env'), (await f.config()) + '\nNANODEPLOY_ALLOW_LEGACY_DOCKER=true\n');
  const before = await f.config();
  const result = await f.install(['--check'], { NANODEPLOY_FIXTURE_ENGINE: '20.10.21' });
  assert.match(result.stdout, /legacy Docker 20\.10\.21 explicitly allowed/);
  assert.equal(await f.config(), before);
  assert.doesNotMatch(await readFile(join(f.work, 'calls'), 'utf8'), /network|build|pull|up -d/);
}));

for (const version of ['19.03.15', '20.9.0']) {
  test(`legacy mode still rejects Docker ${version}`, async () => fixture(async (f) => {
    await f.install(['--init', '--local']);
    await assert.rejects(f.install(['--check'], { NANODEPLOY_FIXTURE_ENGINE: version, NANODEPLOY_ALLOW_LEGACY_DOCKER: 'true' }), /requires Docker Engine 20\.10 or newer/);
    assert.doesNotMatch(await readFile(join(f.work, 'calls'), 'utf8'), /network|build|pull|up -d/);
  }));
}

test('legacy mode requires an explicit boolean setting', async () => fixture(async (f) => {
  await f.install(['--init', '--local']);
  await assert.rejects(f.install(['--check'], { NANODEPLOY_ALLOW_LEGACY_DOCKER: 'yes' }), /must be true or false/);
  assert.doesNotMatch(await readFile(join(f.work, 'calls'), 'utf8'), /network|build|pull|up -d/);
}));

for (const [description, env, expected] of [
  ['a remote Docker daemon', { DOCKER_HOST: 'ssh://fixture.invalid' }, /remote TCP\/SSH daemons are not supported/],
  ['rootless Docker', { NANODEPLOY_FIXTURE_SECURITY: '["name=rootless"]' }, /rootless Docker is not supported/],
  ['rootless Docker with a legacy override', { NANODEPLOY_FIXTURE_SECURITY: '["name=rootless"]', NANODEPLOY_ALLOW_LEGACY_DOCKER: 'true' }, /rootless Docker is not supported/],
  ['a remote Docker daemon with a legacy override', { DOCKER_HOST: 'ssh://fixture.invalid', NANODEPLOY_ALLOW_LEGACY_DOCKER: 'true' }, /remote TCP\/SSH daemons are not supported/],
]) {
  test(`${description} fails before creating networks`, async () => fixture(async (f) => {
    await f.install(['--init', '--local']);
    await assert.rejects(f.install(['--check'], env), expected);
    assert.doesNotMatch(await readFile(join(f.work, 'calls'), 'utf8'), /network|build|pull|up -d/);
  }));
}

test('generated systemd units use the chosen checkout, storage, Docker and operator', async () => fixture(async (f) => {
  await f.install(['--init']);
  await f.configure();
  const boot = await readFile(join(f.checkout, 'var/systemd/nanodeploy.service'), 'utf8');
  const update = await readFile(join(f.checkout, 'var/systemd/nanodeploy-update.service'), 'utf8');
  assert.ok(boot.includes(`User=${userInfo().username}\n`));
  const escaped = f.checkout.replaceAll('\\', '\\\\').replaceAll('%', '%%');
  assert.ok(boot.includes(`WorkingDirectory="${escaped}"`));
  assert.ok(boot.includes(`"${escaped}/var/apps"`));
  assert.match(boot, /RequiresMountsFor=.*"\/srv\/docker"/);
  assert.ok(update.includes(`ExecStart="${escaped}/scripts/update.sh"`));
  assert.doesNotMatch(boot + update, /\/mnt\/ssd|User=nanodeploy\n/);
}));
