// Opt-in: creates the first administrator on a fresh local trial. CI invokes
// this on a disposable runner; ordinary test runs never touch an installation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const port = Number(process.env.CADDY_PORT || 8080);
const cookies = new Map();

function request(url, form, options = {}) {
  const headers = { Host: url.host, Accept: 'text/html', ...(cookies.has(url.hostname) ? { Cookie: cookies.get(url.hostname) } : {}) };
  const body = options.json !== undefined ? JSON.stringify(options.json) : form ? new URLSearchParams(form).toString() : undefined;
  const method = options.method ?? (body ? 'POST' : 'GET');
  if (method !== 'GET') headers.Origin = url.origin;
  if (body) headers['Content-Type'] = options.json !== undefined ? 'application/json' : 'application/x-www-form-urlencoded';
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: url.pathname + url.search,
      method, headers, timeout: 10_000 }, (res) => {
      const chunks = [];
      res.on('data', (data) => chunks.push(data));
      res.once('error', reject);
      res.once('end', () => {
        const ownCookies = res.headers['set-cookie'] ?? [];
        if (ownCookies.length) cookies.set(url.hostname, ownCookies.map((cookie) => cookie.split(';')[0]).join('; '));
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('local onboarding request timed out')));
    req.end(body);
  });
}

async function browse(url) {
  let current = url;
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await request(current);
    if (![301, 302, 303, 307, 308].includes(response.status)) return { current, response };
    current = new URL(response.headers.location, current);
    assert.ok(current.hostname.endsWith('.apps.localhost'), 'redirects must stay within the local instance');
  }
  throw new Error('local sign-in did not finish within ten redirects');
}

async function deployTemplate(consoleUrl) {
  const work = await mkdtemp(join(tmpdir(), 'nanodeploy-first-app-'));
  const app = join(work, 'my-app');
  let deployed = false;
  try {
    await cp(new URL('../templates/app-template/', import.meta.url), app, { recursive: true,
      filter: (path) => !/(?:^|\/)(?:node_modules|dist|server\.js)(?:\/|$)/.test(path) });
    const manifest = await readFile(join(app, 'app.yaml'), 'utf8');
    await writeFile(join(app, 'app.yaml'), manifest.replace(/^slug: .+$/m, 'slug: oss-example'));
    const created = await request(new URL('/api/apps/oss-example/keys', consoleUrl), undefined, { json: { label: 'first app test' } });
    assert.equal(created.status, 200, 'an administrator must be able to create a key for a new app');
    const { key } = JSON.parse(created.body);
    const options = { cwd: app, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 };
    await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    await exec('npm', ['run', 'db:generate'], options);
    await exec('npm', ['run', 'deploy', '--', '-m', 'First app test'], {
      ...options, env: { ...process.env, NANODEPLOY_URL: consoleUrl.origin, NANODEPLOY_TOKEN: key },
    });
    deployed = true;
    const appUrl = new URL(`http://oss-example.apps.localhost:${port}/`);
    const page = await browse(appUrl);
    assert.equal(page.response.status, 200, 'the template must load through its private app host');
    const notesUrl = new URL('/api/notes', appUrl);
    const notes = async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await request(notesUrl);
        if (response.status === 200 && response.headers['content-type']?.includes('application/json')) return JSON.parse(response.body);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error('the template backend did not answer after waking');
    };
    assert.deepEqual(await notes(), [], 'the initial migration must create the notes table');
    const added = await request(notesUrl, undefined, { json: { body: 'A note that survives sleep' } });
    assert.equal(added.status, 201, 'the signed-in user must be able to create a note');
    await exec('docker', ['stop', '--timeout', '1', 'app-oss-example']);
    const afterWake = await notes();
    assert.equal(afterWake.length, 1);
    assert.equal(afterWake[0].body, 'A note that survives sleep');
  } finally {
    const deleted = await request(new URL('/api/apps/oss-example', consoleUrl), undefined, { method: 'DELETE' });
    await rm(work, { recursive: true, force: true });
    if (deployed) assert.equal(deleted.status, 200, 'the test app must be cleaned up');
  }
}

test('fresh local installation supports administrator setup and signed-in console access',
  { skip: process.env.NANODEPLOY_TEST_FRESH_INSTALL !== '1', timeout: 300_000 }, async () => {
    let setup;
    for (let attempt = 0; attempt < 120; attempt++) {
      const { stdout } = await exec('docker', ['compose', 'logs', '--no-color', 'control-plane']);
      const matches = [...stdout.matchAll(/http:\/\/auth\.apps\.localhost(?::\d+)?\/welcome\/[A-Za-z0-9_-]+/g)];
      if (matches.length) {
        const candidate = new URL(matches.at(-1)[0]);
        const response = await request(candidate).catch(() => null);
        if (response?.status === 200) { setup = candidate; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(setup, 'fresh installation must expose a working one-time setup page');
    const password = randomBytes(24).toString('base64url');
    const created = await request(setup, { username: 'oss-admin', display_name: 'OSS Test Admin', password, confirm: password });
    assert.equal(created.status, 303, 'administrator setup must succeed');
    assert.ok(created.headers['set-cookie'].some((cookie) => cookie.startsWith('nd_root=')));
    assert.ok(created.headers['set-cookie'].every((cookie) => !/;\s*Secure(?:;|$)/i.test(cookie)), 'localhost HTTP must use non-secure cookies');
    assert.equal((await request(setup)).status, 410, 'the setup link must be single-use');
    const account = await request(new URL('/account', setup));
    assert.equal(account.status, 200, 'account cookie must work');
    assert.ok(account.body.includes('OSS Test Admin'));

    const consoleUrl = new URL(`http://deploy.apps.localhost:${port}/`);
    const confirmation = await browse(consoleUrl);
    assert.equal(confirmation.current.pathname, '/login', 'the console asks for fresh proof of identity');
    const signedIn = await request(new URL('/login', setup), { login: 'oss-admin', password, to: consoleUrl.href });
    assert.equal(signedIn.status, 303);
    const { current, response: consoleResponse } = await browse(new URL(signedIn.headers.location, setup));
    assert.equal(current.hostname, 'deploy.apps.localhost');
    assert.equal(consoleResponse.status, 200, 'administrator must reach the console after sign-in');
    assert.ok(cookies.get(current.hostname)?.startsWith('nd_s='), 'console must receive its own host cookie');
    const apps = await request(new URL('/api/apps', current));
    assert.equal(apps.status, 200, 'the control plane must independently accept the local console session');
    assert.ok(Array.isArray(JSON.parse(apps.body).apps));
    await deployTemplate(current);
  });
