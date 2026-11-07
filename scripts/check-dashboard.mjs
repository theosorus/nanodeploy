#!/usr/bin/env node
// Validate the merged catalogues used by the browser, including declarative
// labels and mapped keys. Browser code is parsed but never executed.
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const path = process.argv[2] ?? "control-plane/public/index.html";
const html = readFileSync(path, "utf8");
const first = html.indexOf("<script>");
const last = html.lastIndexOf("</script>");
if (first < 0 || last < first) {
  console.error("  x could not find the dashboard script");
  process.exit(1);
}
const script = html.slice(first + "<script>".length, last);
let failed = 0;
const fail = (message) => { console.error("  x " + message); failed++; };

try {
  new Script(script, { filename: path });
  console.log("  ok dashboard script parses");
} catch (err) {
  fail("dashboard script does not parse: " + err.message);
  process.exit(1);
}

const catalogueStart = script.indexOf("const I18N = {");
const catalogueEnd = script.indexOf("const SUPPORTED =");
if (catalogueStart < 0 || catalogueEnd <= catalogueStart) {
  fail("could not find the translation catalogue boundaries");
  process.exit(1);
}
let I18N, LANGS;
try {
  ({ I18N, LANGS } = new Script(script.slice(catalogueStart, catalogueEnd) + ";({ I18N, LANGS });")
    .runInNewContext({}, { timeout: 1000 }));
} catch (err) {
  fail("could not load the translation catalogues: " + err.message);
  process.exit(1);
}
if (!I18N?.en || !Array.isArray(LANGS) || !LANGS.length) {
  fail("English translations and supported languages are required");
  process.exit(1);
}

const languages = LANGS.map(([code]) => code);
const reference = Object.keys(I18N.en).sort();
if (new Set(languages).size !== languages.length) fail("supported languages contain duplicates");
for (const lang of languages) {
  if (!I18N[lang]) { fail("no " + lang + " catalogue"); continue; }
  const keys = Object.keys(I18N[lang]);
  for (const key of reference) if (!keys.includes(key)) fail(lang + ' is missing the key "' + key + '"');
  for (const key of keys) {
    if (!reference.includes(key)) fail('en is missing the key "' + key + '"');
    if (typeof I18N[lang][key] !== "string") fail(lang + "." + key + " is not a string");
  }
}
for (const lang of Object.keys(I18N)) if (!languages.includes(lang)) fail(lang + " is not in the supported languages");
if (!failed) console.log("  ok " + languages.length + " merged catalogues share " + reference.length + " keys");

const runtime = script.slice(0, catalogueStart) + script.slice(catalogueEnd);
const markup = html.slice(0, first) + html.slice(last + "</script>".length);
const labels = [...(markup + runtime).matchAll(/\bdata-i18n\s*=\s*["']([^"']+)["']/g)]
  .map((match) => match[1]).filter((key) => !key.includes("$" + "{"));
const directCalls = [...runtime.matchAll(/\bt\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
for (const key of new Set([...labels, ...directCalls])) {
  if (!reference.includes(key)) fail('unknown translation key "' + key + '"');
}
// Mapped keys appear as literals outside the catalogue. Declarative labels
// live in markup; concatenated translation keys should use a map as well.
for (const key of reference) {
  if (!labels.includes(key) && !runtime.includes(JSON.stringify(key)) && !runtime.includes("'" + key + "'")) {
    fail('key "' + key + '" is never used');
  }
}
if (!failed) console.log("  ok direct, mapped and declarative translation references");
process.exit(failed ? 1 : 0);
