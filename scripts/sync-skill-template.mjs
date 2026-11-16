#!/usr/bin/env node
// The nanodeploy-app agent skill carries its own copy of the app template, so it
// works where this repository is not around (claude.ai, another machine). This
// keeps that copy identical to templates/app-template.
//
//   node scripts/sync-skill-template.mjs           copy the template into the skill
//   node scripts/sync-skill-template.mjs --check   fail if the copy has drifted (CI)
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'templates', 'app-template');
const target = join(root, '.agents', 'skills', 'nanodeploy-app', 'assets', 'app-template');

// Local state of a working copy, never part of the template.
const skipped = (rel) => /(?:^|\/)(?:node_modules|dist|\.vite|coverage)(?:\/|$)/.test(rel) ||
  rel === 'server.js' || rel.endsWith('.zip') || /(?:^|\/)\.env(?:\.(?!example$)[^/]*)?$/.test(rel) ||
  /^migrations\/(?!\.gitkeep$)/.test(rel) || rel.endsWith('.DS_Store');

async function list(base, rel = '') {
  if (!existsSync(join(base, rel))) return [];
  const out = [];
  for (const entry of await readdir(join(base, rel), { withFileTypes: true })) {
    const path = rel ? posix.join(rel, entry.name) : entry.name;
    if (skipped(path)) continue;
    if (entry.isDirectory()) out.push(...await list(base, path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

const wanted = await list(source);
const present = await list(target);
const differences = [];
for (const rel of wanted) {
  const want = await readFile(join(source, rel));
  const have = present.includes(rel) ? await readFile(join(target, rel)) : null;
  if (!have) differences.push(`missing  ${rel}`);
  else if (!want.equals(have)) differences.push(`changed  ${rel}`);
}
for (const rel of present) if (!wanted.includes(rel)) differences.push(`extra    ${rel}`);

if (process.argv.includes('--check')) {
  if (differences.length) {
    console.error('The skill copy of the app template differs from templates/app-template:');
    for (const d of differences) console.error(`  ${d}`);
    console.error('Run: node scripts/sync-skill-template.mjs');
    process.exitCode = 1;
  } else {
    console.log(`Skill template copy is in sync (${wanted.length} files).`);
  }
} else {
  for (const rel of present) if (!wanted.includes(rel)) await rm(join(target, rel));
  for (const rel of wanted) {
    await mkdir(dirname(join(target, rel)), { recursive: true });
    await writeFile(join(target, rel), await readFile(join(source, rel)));
  }
  console.log(differences.length
    ? `Synced the skill template copy: ${differences.length} file(s) updated.`
    : `Skill template copy was already in sync (${wanted.length} files).`);
}
