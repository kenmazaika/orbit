import type { CollectionEntry } from 'astro:content';

export function readingTime(body: string | undefined): number {
  const words = (body || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 210));
}

export function excerptFor(entry: CollectionEntry<'notes'>, limit = 168): string {
  if (entry.data.description) return entry.data.description;
  const raw = (entry.body || '')
    .replace(/^---[\s\S]*?---/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (raw.length <= limit) return raw;
  const cut = raw.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (stop > 80 ? cut.slice(0, stop + 1) : cut.trimEnd() + '…');
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export async function sortedNotes(collection: CollectionEntry<'notes'>[]) {
  return collection
    .filter((n) => !n.data.draft)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export function slugOf(entry: CollectionEntry<'notes'>): string {
  return entry.id.replace(/\.md$/, '');
}
