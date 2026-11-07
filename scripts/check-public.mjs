#!/usr/bin/env node
// Check the files that a commit would publish, including untracked additions.
// Ignored installation data is never read. Gitleaks handles credential detection.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
const published = new Set(files);
const errors = [];
const privatePath = /(?:^|\/)(?:\.env(?:\..*)?|\.local|\.ssh|backups|node_modules|dist|var)(?:\/|$)|\.(?:pem|key|sql\.gz|tgz|zip)$|^caddy\/conf\.d\/.*\.caddy$/;
const homePath = /\/(?:Users|home)\/(?!node(?:\/|\b)|<|\$)[A-Za-z0-9_.-]+/g;
const directories = new Set(['.']);
for (const file of files) {
  for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) directories.add(dir);
}

for (const file of files) {
  if (privatePath.test(file) && !/(?:^|\/)\.env\.example$/.test(file)) {
    errors.push(`${file}: installation data or credentials must not be published`);
  }
  let bytes;
  try { bytes = await readFile(resolve(root, file)); }
  catch (error) {
    if (error.code === 'ENOENT') continue; // a deletion in the working tree
    throw error;
  }
  if (bytes.includes(0)) continue;
  const source = bytes.toString('utf8');
  if (file === '.env.example' && /^[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|KEY)[A-Z0-9_]*=.+$/m.test(source)) {
    errors.push(`${file}: leave secret values empty; the installer generates them locally`);
  }
  if (homePath.test(source)) errors.push(`${file}: replace an absolute home-directory path with a configurable path`);
  homePath.lastIndex = 0;
  if (!file.endsWith('.md')) continue;
  const links = [...source.matchAll(/\[[^\]\n]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)].map((m) => m[1]);
  links.push(...[...source.matchAll(/<(?:img|source)\b[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]));
  for (const href of links) {
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) continue;
    const path = decodeURIComponent(href.split(/[?#]/)[0].replace(/^<|>$/g, ''));
    if (!path) continue;
    const target = posix.normalize(posix.join(dirname(file), path));
    if (!published.has(target) && !directories.has(target)) {
      errors.push(`${file}: link points outside the published files: ${href}`);
    }
  }
}

for (const file of ['LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', '.env.example']) {
  if (!published.has(file)) errors.push(`${file}: missing community file`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Public-file checks passed (${files.length} files): no private paths/data files or broken relative documentation links.`);
}
