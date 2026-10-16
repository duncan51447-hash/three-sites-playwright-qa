import { existsSync, readdirSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const visit = directory => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name.endsWith('.json') && path.includes('/qa-results/')) {
      const relative = path.slice(path.indexOf('/qa-results/') + '/qa-results/'.length);
      const destination = join('qa-results', relative);
      if (existsSync(destination)) {
        const old = JSON.parse(readFileSync(destination, 'utf8'));
        const incoming = JSON.parse(readFileSync(path, 'utf8'));
        if (old.startedAt > incoming.startedAt) continue;
      }
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
    }
  }
};
visit('downloaded-results');
