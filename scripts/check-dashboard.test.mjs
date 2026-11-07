import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory;
before(() => { directory = mkdtempSync(join(tmpdir(), "nanodeploy-catalogue-")); });
after(() => rmSync(directory, { recursive: true, force: true }));

const fixture = `<!doctype html><html><body><span data-i18n="caption"></span><script>
const I18N = { en: { greeting: "Hello" }, fr: { greeting: "Bonjour" } };
const LANGS = [["en", "English"], ["fr", "Français"]];
const I18N_UI = { en: { caption: "Caption" } };
const I18N_UI_EXTRA = { fr: { caption: "Légende" } };
for (const [lang, strings] of Object.entries(I18N_UI)) Object.assign(I18N[lang], strings);
for (const [lang, strings] of Object.entries(I18N_UI_EXTRA)) Object.assign(I18N[lang], strings);
const SUPPORTED = new Set(LANGS.map(([code]) => code));
const keys = { title: "greeting" };
const t = (key) => I18N.en[key];
document.body.textContent = t(keys.title);
</script></body></html>`;

function check(html) {
  const path = join(directory, "index.html");
  writeFileSync(path, html);
  return spawnSync(process.execPath, ["scripts/check-dashboard.mjs", path], { encoding: "utf8" });
}

test("merged language blocks, mapped keys and declarative labels are valid", () => {
  const result = check(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 merged catalogues share 2 keys/);
});

test("a missing translation after all merges fails", () => {
  const result = check(fixture.replace('caption: "Légende"', ""));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fr is missing the key "caption"/);
});

test("a missing supported language fails", () => {
  const result = check(fixture.replace('["fr", "Français"]', '["fr", "Français"], ["es", "Español"]'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no es catalogue/);
});

test("an unknown declarative key fails", () => {
  const result = check(fixture.replace('data-i18n="caption"', 'data-i18n="typo"'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown translation key "typo"/);
});

test("an unknown direct translation call fails", () => {
  const result = check(fixture.replace("t(keys.title)", 't(keys.title) + t("typo")'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown translation key "typo"/);
});

test("unused catalogue entries still fail", () => {
  const result = check(fixture.replaceAll("greeting:", 'unused: "Unused", greeting:'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /key "unused" is never used/);
});

test("invalid JavaScript fails before catalogue evaluation", () => {
  const result = check(fixture.replace("</script>", "const broken = ;</script>"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dashboard script does not parse/);
});

test("the real dashboard passes the same guard", () => {
  execFileSync(process.execPath, ["scripts/check-dashboard.mjs"], { encoding: "utf8" });
});
