// Browser regression tests against the local fixture server. No live platform
// or external account is used. Requires the agent-browser CLI (via npx).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("../", import.meta.url));
let server, session, base, work;

async function browser(...args) {
  const { stdout } = await exec("npx", ["--yes", "agent-browser", "--session", session, "--json", ...args], { cwd, timeout: 30000, maxBuffer: 4e6 });
  const response = JSON.parse(stdout);
  assert.equal(response.success, true, JSON.stringify(response.error));
  return response.data;
}
const evaluate = async (code) => (await browser("eval", "-b", Buffer.from(code).toString("base64"))).result;
const waitFor = (condition) => browser("wait", "--fn", condition, "--timeout", "20000");
const click = async (selector) => { await browser("scrollintoview", selector); return browser("click", selector); };
const findClick = async (role, name) => {
  const selector = role === "button" ? "button" : `[role="${role}"]`;
  await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.checkVisibility() && (e.getAttribute('aria-label') || e.textContent.trim().replace(/\\s+/g, ' ')) === ${JSON.stringify(name)})?.scrollIntoView({block: 'center', behavior: 'instant'})`);
  return browser("find", "role", role, "click", "--name", name, "--exact");
};
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim()`);
const openRoute = async (route) => { await browser("open", base + "/#/" + route); };

before(async () => {
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["scripts/preview-ui.mjs"], { cwd, env: { ...process.env, UI_PREVIEW_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Preview server did not start")), 10000);
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Preview server exited: ${code}`)));
    server.stdout.on("data", (chunk) => { if (chunk.toString().includes("UI preview:")) { clearTimeout(timeout); resolve(); } });
  });
  const result = await exec("npx", ["--yes", "agent-browser", "session", "id", "--scope", "worktree", "--prefix", "nanodeploy-ui-test"], { cwd, timeout: 30000 });
  session = result.stdout.trim();
  work = await mkdtemp(join(tmpdir(), "nanodeploy-ui-test-"));
  await writeFile(join(work, "candidate.zip"), "UI fixture; the preview server supplies the release diff.");
  await writeFile(join(work, "invalid.txt"), "Not an archive");
  await browser("open", base);
  await browser("storage", "local", "set", "nanodeploy.lang", "en");
  await browser("reload");
  await browser("set", "viewport", "1440", "1000");
  await waitFor("document.querySelectorAll('.app-card').length === 6");
}, { timeout: 60000 });

after(async () => {
  try { if (session) await browser("close"); }
  finally { server?.kill(); if (work) await rm(work, { recursive: true, force: true }); }
});

test("applications can be searched, filtered, sorted and displayed as a persistent list", async () => {
  assert.equal(await text("#metric-total"), "6");
  assert.equal(await text("#metric-active"), "3");
  assert.equal(await text("#metric-sleeping"), "2");
  await browser("fill", "#app-search", "CARNET");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#apps .app-name')].map(e => e.textContent)"), ["Carnet"]);
  await browser("fill", "#app-search", "no-such-project");
  assert.equal(await text("#apps h3"), "No applications found");
  await findClick("button", "Clear filters");
  await click('[data-filter="sleeping"]');
  assert.equal(await evaluate("document.querySelectorAll('.app-card').length"), 2);
  await click('[data-filter="missing"]');
  assert.equal(await text("#apps .app-name"), "Atelier");
  await click('[data-filter="all"]');
  await browser("select", "#app-sort", "name");
  const names = await evaluate("[...document.querySelectorAll('#apps .app-name')].map(e => e.textContent)");
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en")));
  await findClick("button", "List view");
  await browser("reload");
  await waitFor("document.querySelectorAll('.app-card').length === 6");
  assert.equal(await evaluate("document.querySelector('#apps').classList.contains('list')"), true);
  assert.equal(await evaluate("document.querySelector('.app-external').getAttribute('href')"), "https://finances.apps.maison.test");
  await findClick("button", "Grid view");
});

test("application routes, browser history and unsaved secrets survive tab changes and polling", { timeout: 40000 }, async () => {
  await openRoute("apps");
  await waitFor("document.querySelectorAll('.app-card').length === 6");
  await findClick("button", "Manage Finances");
  await waitFor("document.querySelector('#detail-title')?.textContent === 'Finances'");
  await findClick("tab", "Settings");
  await browser("fill", "#env-0", "ui-test-secret");
  await findClick("tab", "Logs");
  await waitFor("document.querySelector('[data-logs]')?.textContent.includes('Listening on port')");
  await findClick("tab", "Settings");
  assert.equal(await evaluate("document.querySelector('#env-0').value"), "ui-test-secret");
  await evaluate("window.__uiRefreshes = 0; const fetchBeforeTest = window.fetch; window.fetch = (...args) => { if (args[0] === '/api/apps') window.__uiRefreshes++; return fetchBeforeTest(...args); }; document.querySelector('#main').focus();");
  await waitFor("window.__uiRefreshes > 0 && document.querySelector('#env-0')?.value === 'ui-test-secret'");
  await browser("back");
  await waitFor("document.querySelector('#detail-tab-logs')?.getAttribute('aria-selected') === 'true'");
  await findClick("tab", "Settings");
  await click("[data-saveenv]");
  await waitFor("document.querySelector('#env-0')?.value === ''");
  assert.match(await text("#toast-message"), /Variables saved/);
});

test("always on is saved per application, survives refresh and recovers from errors", { timeout: 60000 }, async () => {
  await openRoute("apps/carnet/config");
  await waitFor("!!document.querySelector('#app-warm')");
  assert.equal(await evaluate("document.querySelector('#app-warm').checked"), false);
  await evaluate(`window.__warmRefreshes = 0; const original = window.fetch;
    window.fetch = (input, options) => {
      if (input === '/api/apps') window.__warmRefreshes++;
      if (input === '/api/apps/carnet/warm') return new Promise(resolve => {
        window.__finishWarm = () => { window.fetch = original; resolve(original(input, options)); };
      });
      return original(input, options);
    };`);
  await browser("find", "role", "checkbox", "check", "--name", "Always on", "--exact");
  await waitFor("document.querySelector('#app-warm')?.disabled && window.__warmRefreshes > 0");
  assert.equal(await evaluate("document.querySelector('#app-warm').checked"), true);
  await findClick("tab", "Overview");
  await findClick("tab", "Settings");
  assert.equal(await evaluate("document.querySelector('#app-warm').disabled && document.querySelector('#app-warm').checked"), true);
  await evaluate("window.__finishWarm()");
  await waitFor("document.querySelector('#app-warm')?.checked && !document.querySelector('#app-warm').disabled");
  assert.match(await text("#toast-message"), /Always on enabled/);
  assert.equal(await text(".detail-heading .status"), "Active");
  await browser("reload");
  await waitFor("document.querySelector('#app-warm')?.checked");
  await browser("network", "route", `${base}/api/apps/carnet/warm`, "--abort");
  await browser("uncheck", "#app-warm");
  await waitFor("document.querySelector('#app-warm')?.checked && !document.querySelector('#app-warm').disabled && document.querySelector('#toast-message').textContent.includes('Failed')");
  await browser("network", "unroute", `${base}/api/apps/carnet/warm`);
  await browser("uncheck", "#app-warm");
  await waitFor("!document.querySelector('#app-warm')?.checked && !document.querySelector('#app-warm')?.disabled && document.querySelector('.detail-heading .status')?.textContent === 'Sleeping'");
  await browser("reload");
  await waitFor("!!document.querySelector('#app-warm')");
  assert.equal(await evaluate("document.querySelector('#app-warm').checked"), false);
  await openRoute("apps/pulse/config");
  await waitFor("document.querySelector('#app-warm')?.checked");
  await openRoute("apps/finances/config");
  await waitFor("document.querySelector('#detail-title')?.textContent === 'Finances'");
  assert.equal(await evaluate("document.querySelector('#app-warm').checked"), false);
  await openRoute("apps/portfolio/config");
  await waitFor("document.querySelector('#detail-title')?.textContent === 'Portfolio'");
  assert.equal(await evaluate("document.querySelector('#app-warm')"), null);
  assert.match(await text("#app-tabpanel"), /Static websites are already always available/);
});

test("archive updates show a review and only go live after explicit confirmation", async () => {
  await openRoute("apps");
  await waitFor("document.querySelectorAll('.app-card').length === 6");
  await findClick("button", "New application");
  await browser("upload", "#file", join(work, "invalid.txt"));
  await waitFor("document.querySelector('#toast-message').textContent.includes('Choose a .zip')");
  assert.equal(await evaluate("document.querySelector('#deploy-dialog').open"), true);
  await browser("upload", "#file", join(work, "candidate.zip"));
  await waitFor("!!document.querySelector('.diff [data-promote]')");
  assert.equal(await evaluate("document.querySelector('#deploy-dialog').open"), false);
  assert.equal((await browser("get", "url")).url.endsWith("#/apps/finances/versions"), true);
  await click("[data-discard]");
  await waitFor("!document.querySelector('.diff')");
  assert.match(await text("#app-tabpanel"), /v12 is live/);
  await click("[data-newversion]");
  await browser("upload", "#update-file", join(work, "candidate.zip"));
  await waitFor("!!document.querySelector('.diff [data-promote]')");
  await click("[data-promote]");
  await waitFor("document.querySelector('#app-tabpanel')?.textContent.includes('v13 is live')");
});

test("deployment keys are shown once and destructive actions can be cancelled", async () => {
  await openRoute("apps/finances");
  await waitFor("!!document.querySelector('#detail-tab-config')");
  await findClick("tab", "Settings");
  await browser("fill", "#app-key-label", "UI regression");
  await click("[data-newkey]");
  await waitFor("!!document.querySelector('[data-key-value]')");
  assert.match(await text("[data-key-value]"), /^ndd_preview_/);
  assert.match(await text("#app-tabpanel"), /UI regression/);
  await click(".danger-zone summary");
  await click("[data-delete]");
  await waitFor("document.querySelector('#confirm-dialog').open");
  assert.equal(await evaluate("document.activeElement.id"), "confirm-cancel");
  await click("#confirm-cancel");
  assert.equal(await text("#detail-title"), "Finances");
  await click("[data-revokekey]");
  await waitFor("document.querySelector('#confirm-dialog').open");
  await click("#confirm-ok");
  await waitFor("document.querySelectorAll('.keyrow').length === 0 && !document.querySelector('[data-key-value]')");
  await findClick("button", "All applications");
  await findClick("button", "Manage Carnet");
  await findClick("tab", "Settings");
  assert.equal(await evaluate("document.querySelectorAll('[data-key-value]').length"), 0);
});

test("invitations, group membership and admin controls work with labelled forms", async () => {
  await openRoute("people");
  await waitFor("!!document.querySelector('#invite-form')");
  await browser("fill", "#new-username", "nora");
  await browser("fill", "#new-email", "nora@example.test");
  await click("#invite");
  await waitFor("!!document.querySelector('.invite-card [data-key-value]')");
  assert.match(await text(".people-grid"), /nora/);
  await browser("fill", "#new-group", "Studio");
  await click("#add-group");
  await waitFor("[...document.querySelectorAll('[data-person]')].some(e => e.textContent.includes('Studio'))");
  await findClick("button", "Camille Dupont · Studio");
  await waitFor("document.querySelector('[aria-label=\"Camille Dupont · Studio\"]')?.getAttribute('aria-pressed') === 'true'");
  assert.equal(await evaluate("document.querySelectorAll('[data-admin=\"u1\"]').length"), 0);
  await click('[data-admin="u2"]');
  await waitFor("document.querySelector('#confirm-dialog').open");
  await click("#confirm-cancel");
  assert.equal(await evaluate("document.querySelector('[data-admin=\"u2\"]').getAttribute('aria-pressed')"), "false");
});

test("Git setup selects repositories, preserves build settings and displays logs", async () => {
  await openRoute("git");
  await waitFor("!!document.querySelector('#git-provider')");
  await browser("select", "#git-provider", "p1");
  await waitFor("document.querySelectorAll('#git-repo option').length === 2");
  await browser("select", "#git-repo", "r1");
  assert.equal(await evaluate("document.querySelector('#git-branch').value"), "main");
  await browser("fill", "#git-root", "frontend");
  await findClick("button", "People");
  await findClick("button", "Git deployments");
  await waitFor("document.querySelector('#git-root')?.value === 'frontend'");
  await click('[data-gitlog="12"]');
  await waitFor("document.querySelector('#view-git pre')?.textContent.includes('Build completed')");
  await click("#git-deploy");
  await waitFor("document.querySelectorAll('[data-gitdisconnect]').length === 2");
  assert.equal(await evaluate("document.querySelector('#git-deploy').disabled"), true);
});

test("empty and disconnected states provide a working next action", async () => {
  await browser("network", "route", `${base}/api/apps`, "--body", JSON.stringify({ apps: [], host: null }));
  await browser("open", base + "/#/apps");
  await waitFor("document.querySelector('#apps h2')?.textContent === 'A home for your next idea.'");
  await findClick("button", "Deploy my first application");
  assert.equal(await evaluate("document.querySelector('#deploy-dialog').open"), true);
  await click("#close-deploy");
  await browser("network", "unroute", `${base}/api/apps`);
  await browser("network", "route", `${base}/api/apps`, "--abort");
  await browser("reload");
  await waitFor("document.querySelector('#apps h2')?.textContent === 'We couldn’t reach your server'");
  await browser("network", "unroute", `${base}/api/apps`);
  await findClick("button", "Try again");
  await waitFor("document.querySelectorAll('.app-card').length === 6");
});

test("mobile navigation and dialogs fit the viewport and support keyboard dismissal", async () => {
  await browser("set", "viewport", "390", "844");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  assert.equal(await evaluate("document.querySelector('#sidebar').inert"), true);
  await findClick("button", "Open navigation");
  assert.equal(await evaluate("document.querySelector('#sidebar').inert"), false);
  assert.equal(await evaluate("document.querySelector('#main').inert"), true);
  await browser("press", "Escape");
  assert.equal(await evaluate("document.querySelector('#sidebar').inert"), true);
  await findClick("button", "New application");
  assert.equal(await evaluate("const box = document.querySelector('#deploy-dialog').getBoundingClientRect(); box.left >= 0 && box.right <= innerWidth"), true);
  await browser("press", "Escape");
  assert.equal(await evaluate("document.querySelector('#deploy-dialog').open"), false);
  await browser("select", "#lang", "fr");
  assert.equal(await text("#page-title"), "Vos applications");
  await browser("set", "viewport", "1440", "1000");
});

test("a member gets a clear account link instead of administration controls", async () => {
  await browser("network", "route", `${base}/api/me`, "--body", JSON.stringify({ name: "Camille", email: "camille@example.test", sub: "u2", domain: "apps.maison.test", admin: false }));
  await browser("reload");
  await waitFor("!document.querySelector('#view-denied').hidden");
  assert.equal(await evaluate("document.querySelector('#main-navigation').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#view-apps').hidden"), true);
  assert.match(await evaluate("document.querySelector('#view-denied a').href"), /auth\.apps\.maison\.test.*\/account$/);
  await browser("select", "#lang", "en");
  assert.equal(await text(".profile-role"), "Member");
  await browser("network", "unroute", `${base}/api/me`);
  await browser("reload");
  await waitFor("document.querySelector('#metric-total').textContent === '6'");
});

test("group access and application roles can be assigned independently", async () => {
  await openRoute("apps/finances/access");
  await waitFor("!!document.querySelector('[data-grant]')");
  await browser("select", "#app-access", "groups");
  await waitFor("!!document.querySelector('[data-group=\"Famille\"]')");
  await click('[data-group="Famille"]');
  await waitFor("document.querySelector('#app-access')?.value === 'groups' && document.querySelector('[data-group=\"Famille\"]')?.getAttribute('aria-pressed') === 'true'");
  await click('[data-grant="finances"][data-kind="user"][data-sid="u2"]');
  await waitFor("document.querySelector('[data-grant=\"finances\"][data-kind=\"user\"][data-sid=\"u2\"]')?.getAttribute('aria-pressed') === 'true'");
  await browser("select", "#app-access", "private");
  await waitFor("document.querySelector('#app-access')?.value === 'private'");
});

test("terminal keys are shown once and the Git method opens its setup screen", async () => {
  await openRoute("apps");
  await findClick("button", "New application");
  await findClick("tab", "Terminal & agents");
  await browser("fill", "#newkey-slug", "new-project");
  await click("#newkey-create");
  await waitFor("!!document.querySelector('#newkey-result [data-key-value]')");
  await click("#close-deploy");
  await findClick("button", "New application");
  await findClick("tab", "Terminal & agents");
  assert.equal(await evaluate("document.querySelectorAll('#newkey-result [data-key-value]').length"), 0);
  await findClick("tab", "Git repository");
  await click("#deploy-from-git");
  await waitFor("!document.querySelector('#view-git').hidden");
  assert.equal(await evaluate("document.querySelector('#deploy-dialog').open"), false);
});

test("the main screens have no automatically detected WCAG A/AA violations", async () => {
  for (const route of ["apps", "apps/finances", "apps/finances/access", "apps/finances/config", "apps/finances/logs", "people", "git", "analytics"]) {
    await openRoute(route);
    await waitFor("document.querySelector('#metric-total').textContent === '6'");
    if (route === "people") await waitFor("!!document.querySelector('#invite-form')");
    if (route === "git") await waitFor("!!document.querySelector('#git-provider')");
    if (route === "analytics") await waitFor("!!document.querySelector('.chart')");
    const audit = await browser("a11y", "--tags", "wcag2a,wcag2aa");
    assert.deepEqual(audit.violations, [], `${route}: ${JSON.stringify(audit.violations)}`);
  }
});

test("all supported locales cover the new interface and fit on a phone", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(join(cwd, "control-plane/public/index.html"), "utf8")).split("<script>")[1].split("</script>")[0];
  const { I18N, I18N_UI } = new Function(source.slice(0, source.indexOf("const SUPPORTED")) + "; return { I18N, I18N_UI };")();
  for (const [locale, strings] of Object.entries(I18N)) {
    assert.deepEqual(Object.keys(I18N_UI.en).filter((key) => !(key in strings)), [], `Missing strings: ${locale}`);
  }
  await openRoute("apps");
  await browser("set", "viewport", "390", "844");
  for (const locale of Object.keys(I18N)) {
    await browser("select", "#lang", locale);
    assert.equal(await text("#page-title"), I18N[locale].appsTitle);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Overflow in ${locale}`);
  }
  await browser("select", "#lang", "en");
  await browser("set", "viewport", "1440", "1000");
});

test("confirming deletion removes the app and returns to the application list", async () => {
  await openRoute("apps/atelier/config");
  await waitFor("!!document.querySelector('.danger-zone')");
  await click(".danger-zone summary");
  await click("[data-delete]");
  await waitFor("document.querySelector('#confirm-dialog').open");
  await click("#confirm-ok");
  await waitFor("!document.querySelector('#app-dashboard').hidden && document.querySelectorAll('.app-card').length === 5");
  assert.equal(await evaluate("document.querySelectorAll('[data-open=\"atelier\"]').length"), 0);
});
