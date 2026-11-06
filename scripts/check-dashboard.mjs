#!/usr/bin/env node
// The dashboard is one self-contained HTML file with no build step, so nothing
// would otherwise catch a syntax error or a translation key that exists in one
// language only. Both are shipping bugs the moment someone switches language.
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const path = "control-plane/public/index.html";
const html = readFileSync(path, "utf8");
const script = html.substring(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));

let failed = 0;
const fail = (msg) => {
  console.error(`  x ${msg}`);
  failed++;
};

try {
  new Script(script, { filename: path });
  console.log("  ok dashboard script parses");
} catch (err) {
  fail(`dashboard script does not parse: ${err.message}`);
  process.exit(1);
}

const block = html.match(/const I18N = \{[\s\S]*?\n\};/);
if (!block) {
  fail("could not find the I18N table");
  process.exit(1);
}
const I18N = new Script(`(${block[0].replace("const I18N = ", "").replace(/;$/, "")})`).runInNewContext();

const languages = Object.keys(I18N);
const reference = Object.keys(I18N[languages[0]]).sort();
for (const lang of languages.slice(1)) {
  const keys = Object.keys(I18N[lang]).sort();
  for (const key of reference) if (!keys.includes(key)) fail(`${lang} is missing the key "${key}"`);
  for (const key of keys) if (!reference.includes(key)) fail(`${languages[0]} is missing the key "${key}"`);
}
if (!failed) console.log(`  ok ${languages.join(" and ")} share ${reference.length} keys`);

// Later features add their strings in separate tables merged into I18N
// (I18N_PEOPLE, I18N_KEYS...). Each must cover every language with the same keys,
// or a language silently falls back to English for that feature.
for (const extra of html.matchAll(/const (I18N_[A-Z]+) = \{[\s\S]*?\n\};/g)) {
  const table = new Script(`(${extra[0].replace(`const ${extra[1]} = `, "").replace(/;$/, "")})`).runInNewContext();
  const missingLangs = languages.filter((l) => !table[l]);
  if (missingLangs.length) fail(`${extra[1]} has no ${missingLangs.join(", ")} block`);
  const ref = Object.keys(table.en ?? {}).sort();
  for (const lang of Object.keys(table)) {
    const keys = Object.keys(table[lang]);
    for (const key of ref) if (!keys.includes(key)) fail(`${extra[1]}.${lang} is missing the key "${key}"`);
    for (const key of keys) if (!ref.includes(key)) fail(`${extra[1]}.en is missing the key "${key}"`);
    for (const key of keys) reference.includes(key) || reference.push(key);
  }
  if (!failed) console.log(`  ok ${extra[1]} covers ${Object.keys(table).length} languages with ${ref.length} keys`);
}

// a key nobody reads is dead weight that drifts out of date
const dynamic = new Set(["navApps", "navPeople"]);
for (const key of reference) {
  if (!dynamic.has(key) && !script.includes(`t("${key}"`)) fail(`key "${key}" is never used`);
}

process.exit(failed ? 1 : 0);
