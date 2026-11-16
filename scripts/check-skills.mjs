#!/usr/bin/env node
// Checks the agent skills in .agents/skills/ against the Agent Skills format
// (https://agentskills.io/specification) and the authoring rules they follow:
// a name that matches its folder, a description that says what and when, a
// short SKILL.md, and every reference file linked directly from SKILL.md (one
// level deep), so an agent never has to follow a chain to find a rule.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillsDir = join(root, '.agents', 'skills');
const errors = [];

function frontmatter(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) { errors.push(`${file}: missing YAML frontmatter`); return {}; }
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    out[kv[1]] = value;
  }
  return { ...out, bodyStart: m[0].length };
}

const links = (text) => [...text.matchAll(/\[[^\]\n]*\]\(([^\s)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1])
  .filter((href) => !/^[a-z][a-z\d+.-]*:/i.test(href));

for (const name of (await readdir(skillsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)) {
  const dir = join(skillsDir, name);
  const file = `.agents/skills/${name}/SKILL.md`;
  if (!existsSync(join(dir, 'SKILL.md'))) { errors.push(`${file}: missing`); continue; }
  const text = await readFile(join(dir, 'SKILL.md'), 'utf8');
  const fm = frontmatter(text, file);
  if (fm.name !== name) errors.push(`${file}: name "${fm.name}" must match its folder "${name}"`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name ?? '') || (fm.name ?? '').length > 64) errors.push(`${file}: name must be lowercase words joined by single hyphens, at most 64 characters`);
  const description = fm.description ?? '';
  if (!description || description.length > 1024) errors.push(`${file}: description must be 1 to 1024 characters (has ${description.length})`);
  if (/<[a-z]/i.test(description)) errors.push(`${file}: description must not contain XML tags`);
  if (!/\buse (it )?(when|for|whenever)\b/i.test(description)) errors.push(`${file}: description must say when to use the skill ("Use when ...")`);
  if (fm.compatibility && fm.compatibility.length > 500) errors.push(`${file}: compatibility must be at most 500 characters`);
  const lines = text.split('\n').length;
  if (lines > 500) errors.push(`${file}: ${lines} lines, keep SKILL.md under 500 and move detail into references/`);

  const linked = new Set();
  for (const href of links(text)) {
    const target = posix.normalize(href);
    linked.add(target);
    if (!existsSync(join(dir, target))) errors.push(`${file}: link to a missing file: ${href}`);
  }
  const refDir = join(dir, 'references');
  if (existsSync(refDir)) {
    for (const ref of (await readdir(refDir)).filter((f) => f.endsWith('.md'))) {
      const rel = `references/${ref}`;
      if (!linked.has(rel)) errors.push(`${file}: ${rel} is never linked from SKILL.md, so no agent will read it`);
      const body = await readFile(join(refDir, ref), 'utf8');
      const refLines = body.split('\n').length;
      if (refLines > 100 && !/^## Contents$/m.test(body)) errors.push(`.agents/skills/${name}/${rel}: ${refLines} lines, add a "## Contents" list at the top`);
      for (const href of links(body)) {
        const target = posix.normalize(posix.join('references', href));
        if (!existsSync(join(dir, target))) errors.push(`.agents/skills/${name}/${rel}: link to a missing file: ${href}`);
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Agent skills follow the format: names, descriptions, sizes and links are valid.');
}
