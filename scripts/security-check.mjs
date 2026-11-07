#!/usr/bin/env node
// Uses fresh, disposable Docker resources. Never sources .env or connects to
// an installation database. Install the control-plane and gate packages first.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const capture = promisify(execFile);
const fixture = `nanodeploy-audit-full-${process.pid}-${randomBytes(4).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const caddyImage = process.env.NANODEPLOY_TEST_CADDY_IMAGE ?? `${fixture}:caddy`;
let created = false;
let built = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', timeout: 600_000, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

try {
  const context = await capture('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  for (const image of ['node:24-bookworm-slim', 'postgres:16-alpine', 'haproxy:3.2.26-alpine', 'sablierapp/sablier:1.18.0']) {
    await run('docker', ['pull', image]);
  }
  if (!process.env.NANODEPLOY_TEST_CADDY_IMAGE) {
    await run('docker', ['build', '--tag', caddyImage, 'caddy']);
    built = true;
  }
  await run('docker', ['run', '--detach', '--name', fixture, '--memory', '512m', '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=nanodeploy_security_audit', 'postgres:16-alpine']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await capture('docker', ['exec', '--env', `PGPASSWORD=${password}`, fixture, 'psql', '-h', '127.0.0.1',
        '-U', 'postgres', '-d', 'nanodeploy_security_audit', '-Atc', 'select 1']);
      ready = true; break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  if (!ready) throw new Error('disposable Postgres did not start');
  const inspection = await capture('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', fixture]);
  const port = JSON.parse(inspection.stdout)['5432/tcp'][0].HostPort;
  const env = { ...process.env, DOCKER_HOST: context.stdout.trim(), NANODEPLOY_SECURITY_DOCKER: '1',
    NANODEPLOY_TEST_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/nanodeploy_security_audit`,
    NANODEPLOY_TEST_POSTGRES_CONTAINER: fixture, NANODEPLOY_TEST_CADDY_IMAGE: caddyImage };
  await run('npm', ['test'], { cwd: `${root}control-plane`, env });
  await run('npm', ['test'], { cwd: `${root}gate` });
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  if (created) await run('docker', ['rm', '--force', '--volumes', fixture]).catch(() => { process.exitCode = 1; });
  if (built) await run('docker', ['image', 'rm', caddyImage]).catch(() => { process.exitCode = 1; });
}
