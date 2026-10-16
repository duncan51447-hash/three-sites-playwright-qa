import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Reporting/documentation changes can reuse real completed browser evidence.
// Interaction rules, pacing, browser dependencies or configuration changes cannot.
export const ENGINE_VERSION = createHash('sha256').update([
  'qa/audit.ts', 'qa/config.mjs', 'qa/engine-version.mjs',
  'tests/three-sites.spec.ts', 'playwright.config.ts', 'package-lock.json'
].map(path => readFileSync(resolve(root,path),'utf8')).join('\n')).digest('hex');
