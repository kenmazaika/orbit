// Inline the React build into a staging-only worker module.
// Never writes worker/assets.generated.js (production's Astro bundle).
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../react/dist/', import.meta.url).pathname;
const OUT = new URL('../worker/react-prod-assets.generated.js', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
const out = {};
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const rel = '/' + p.slice(DIST.length).replaceAll('\\', '/');
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    const mime = TYPES[ext] || 'application/octet-stream';
    out[rel] = [mime, readFileSync(p).toString('base64')];
  }
}
walk(DIST);
writeFileSync(OUT, `// Generated from react/dist — do not edit.\nexport default ${JSON.stringify(out)};\n`);
console.log(`react-prod assets: ${Object.keys(out).length} files -> worker/react-prod-assets.generated.js`);
