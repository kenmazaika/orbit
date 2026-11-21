import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { sortedNotes, readingTime, excerptFor, formatDate, slugOf } from '../lib/notes';

export const GET: APIRoute = async () => {
  const notes = await sortedNotes(await getCollection('notes'));
  const body = notes.map((n) => ({
    slug: slugOf(n),
    title: n.data.title,
    excerpt: excerptFor(n),
    date: formatDate(n.data.pubDate),
    category: n.data.category,
    minutes: readingTime(n.body),
  }));
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
