// Build the React content bundle from the same markdown sources Astro uses.
// No frontend duplication: notes/ and reports/ remain the source of truth.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const outDir = join(root, 'react/src/generated');
mkdirSync(outDir, { recursive: true });

function parse(file, dir) {
  const raw = readFileSync(join(root, 'src/content', dir, file), 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const hit = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (!hit) continue;
      let v = hit[2].trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
      fm[hit[1]] = v;
    }
  }
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const words = body.split(/\s+/).filter(Boolean).length;
  return {
    slug: file.replace(/\.md$/, ''),
    title: fm.title || file.replace(/\.md$/, ''),
    description: fm.description || fm.summary || '',
    summary: fm.summary || '',
    category: fm.category || (dir === 'reports' ? 'Daily report' : 'Note'),
    pubDate: fm.pubDate || new Date().toISOString(),
    body,
    minutes: Math.max(1, Math.round(words / 220)),
  };
}

const notes = readdirSync(join(root, 'src/content/notes')).filter((f) => f.endsWith('.md')).map((f) => parse(f, 'notes'));
const reports = readdirSync(join(root, 'src/content/reports')).filter((f) => f.endsWith('.md')).map((f) => parse(f, 'reports'));
writeFileSync(join(outDir, 'content.json'), JSON.stringify({ notes, reports }, null, 2));
console.log(`content: ${notes.length} notes, ${reports.length} reports`);
