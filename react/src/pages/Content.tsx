import React from 'react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import content from '../generated/content.json';
import { api } from '../api';
import { startWorkFromSource } from './Work';
import { Markdown, fmtDate, useSaved } from '../lib';

const notes: any[] = (content as any).notes || [];
const reports: any[] = (content as any).reports || [];

type DispatchRow = {
  slug: string; title: string; summary?: string; tags?: string[];
  published_at?: string | null; created_at?: string; minutes?: number;
};

// Published dispatches live in D1 (see worker/objects); the Astro feed merged them client-side.
// React must do the same, or published dispatches silently never appear in the feed.
function useDispatches() {
  const [list, setList] = React.useState<DispatchRow[] | null>(null);
  React.useEffect(() => {
    let alive = true;
    fetch('/api/v1/dispatches?limit=100', { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setList(Array.isArray(d.dispatches) ? d.dispatches : []); })
      .catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, []);
  return list;
}

export default function Feed() {
  const dispatches = useDispatches();
  const rows: any[] = [
    ...reports.map((r) => ({ ...r, kind: 'report', pubDate: r.pubDate })),
    ...notes.map((n) => ({ ...n, kind: 'note', pubDate: n.pubDate })),
    ...(dispatches || []).map((d) => ({
      slug: d.slug,
      title: d.title,
      description: d.summary || '',
      summary: d.summary || '',
      category: (Array.isArray(d.tags) && d.tags[0]) || 'Dispatch',
      pubDate: d.published_at || d.created_at || '',
      minutes: Number(d.minutes || 1),
      kind: 'dispatch',
    })),
  ];
  // Dispatch rows win over a markdown note with the same slug (same content, DB is canonical).
  const bySlug = new Map<string, any>();
  for (const r of rows) {
    const prev = bySlug.get(r.slug);
    if (!prev || r.kind === 'dispatch' || prev.kind !== 'dispatch') bySlug.set(r.slug, r);
  }
  const items = [...bySlug.values()].sort((a, b) => +new Date(b.pubDate) - +new Date(a.pubDate));
  return <div className="wrap"><section className="intro"><h1>Your Orbit</h1><p className="intro-sub">A quiet stream of things worth reading.</p></section>
    <div className="feed">{items.map((n) => (
      <Link className="feed-item" key={n.slug} to={n.kind === 'report' ? `/report/${n.slug}` : `/notes/${n.slug}`}>
        <div className="feed-meta"><span>{fmtDate(n.pubDate)} <span className="sep">·</span> {n.category || 'Note'}</span></div>
        <h2 className="feed-title">{n.title}</h2><p className="feed-excerpt">{n.description || n.summary || ''}</p>
        <span className="read-time">{n.minutes} min read</span>
      </Link>))}</div></div>;
}

export function Archive() {
  return <div className="wrap"><section className="intro compact"><h1>Archive</h1></section><div className="feed">
    {notes.map((n) => <Link className="feed-item" key={n.slug} to={`/notes/${n.slug}`}>
      <div className="feed-meta"><span>{fmtDate(n.pubDate)} <span className="sep">·</span> {n.category}</span></div>
      <h2 className="feed-title">{n.title}</h2></Link>)}</div></div>;
}

export function Saved() {
  const { saved, toggle } = useSaved();
  const dispatches = useDispatches();
  const bySlug = new Map<string, any>();
  for (const n of notes) bySlug.set(n.slug, { ...n, kind: 'note' });
  for (const d of dispatches || []) {
    bySlug.set(d.slug, {
      slug: d.slug, title: d.title, description: d.summary || '', category: (Array.isArray(d.tags) && d.tags[0]) || 'Dispatch',
      pubDate: d.published_at || d.created_at || '', minutes: Number(d.minutes || 1), kind: 'dispatch',
    });
  }
  const rows = [...bySlug.values()].filter((n) => saved.has(n.slug))
    .sort((a, b) => +new Date(b.pubDate) - +new Date(a.pubDate));
  return <div className="wrap"><section className="intro compact"><h1>Saved</h1></section><div className="feed">
    {rows.length === 0 ? <p className="empty">Nothing saved yet. Open a note and choose Save for later.</p> :
      rows.map((n) => <div className="feed-item" key={n.slug}>
        <Link to={`/notes/${n.slug}`}><h2 className="feed-title">{n.title}</h2>
          <div className="feed-meta"><span>{fmtDate(n.pubDate)} <span className="sep">·</span> {n.category || 'Note'}</span></div></Link>
        <button className="save-btn is-saved" onClick={() => toggle(n.slug)}>Remove</button></div>)}</div></div>;
}


const FB_TYPES = [
  { id: 'useful', label: 'Useful' },
  { id: 'already_knew', label: 'Already knew this' },
  { id: 'not_relevant', label: 'Not relevant' },
  { id: 'acted_on', label: 'Acted on it' },
] as const;

function fbKey(slug: string) { return `orbit-fb:${slug}`; }

function NoteFeedback({ slug }: { slug: string }) {
  const [sent, setSent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(fbKey(slug)) || '[]'); } catch { return []; }
  });
  const [pending, setPending] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(type: string) {
    setBusy(true); setErr(null);
    const eventId = (crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await api(`/dispatches/${encodeURIComponent(slug)}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ type, comment: comment.trim() || null, event_id: eventId, source: 'orbit-web' }),
      });
      const next = Array.from(new Set([...sent, type]));
      setSent(next); localStorage.setItem(fbKey(slug), JSON.stringify(next));
      setPending(null); setComment('');
    } catch (e: any) {
      setErr(e?.status === 401 ? 'Sign in to save feedback.' : 'Could not save — try again.');
    }
    setBusy(false);
  }

  return (
    <div className="fb-strip">
      <span className="fb-q">Was this useful?</span>
      <div className="fb-chips">
        {FB_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`fb-chip${sent.includes(t.id) ? ' is-sent' : ''}${pending === t.id ? ' is-picked' : ''}`}
            disabled={busy}
            onClick={() => setPending(pending === t.id ? null : t.id)}
          >
            {sent.includes(t.id) ? '\u2713 ' : ''}{t.label}
          </button>
        ))}
      </div>
      {pending && (
        <div className="fb-comment">
          <input
            className="fb-input"
            placeholder="Add a note (optional)"
            value={comment}
            maxLength={500}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) send(pending); }}
          />
          <button className="fb-send" type="button" disabled={busy} onClick={() => send(pending)}>
            {busy ? 'Saving…' : 'Send'}
          </button>
        </div>
      )}
      {err && <span className="fb-err">{err}</span>}
    </div>
  );
}

export function NotePage() {
  const { slug } = useParams();
  const nav = useNavigate();
  const [working, setWorking] = useState(false);
  const [workErr, setWorkErr] = useState('');
  const local = notes.find((n) => n.slug === slug);
  const [remote, setRemote] = React.useState<any>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (local || !slug) return;
    let alive = true;
    setRemote(null); setFailed(false);
    fetch(`/api/v1/dispatches/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setRemote(d.dispatch || null); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [slug, local]);
  const note = local || (remote ? {
    slug: remote.slug, title: remote.title, description: remote.summary,
    category: (Array.isArray(remote.tags) && remote.tags[0]) || 'Dispatch',
    pubDate: remote.published_at || remote.created_at, body: remote.content || '', minutes: remote.minutes,
  } : null);
  const { saved, toggle } = useSaved();
  const workOnThis = async () => {
    if (!note || working) return;
    setWorking(true); setWorkErr('');
    try {
      const id = await startWorkFromSource({
        type: 'note', ref: note.slug, title: note.title,
        url: `${window.location.origin}/notes/${note.slug}`,
        snapshot: `${note.description || ''}\n\n${note.body || ''}`,
        summary: note.description || '',
      });
      nav(`/work/${id}`);
    } catch (e: any) { setWorkErr(e.message); } finally { setWorking(false); }
  };
  if (!note) return <div className="wrap"><p className="empty">{failed ? 'Dispatch not found.' : 'Loading dispatch…'}</p></div>;
  return <article className="wrap article"><Link className="back" to="/"><span>←</span> Back to Orbit</Link>
    <div className="article-meta"><span className="cat-pill">{note.category}</span><span>{fmtDate(note.pubDate)}</span></div>
    <h1 className="article-title">{note.title}</h1>{note.description && <p className="dek">{note.description}</p>}
    <Markdown body={note.body} />
    <div className="article-foot"><button className={`save-btn${saved.has(note.slug) ? ' is-saved' : ''}`} aria-pressed={saved.has(note.slug)} onClick={() => toggle(note.slug)}>{saved.has(note.slug) ? 'Saved' : 'Save for later'}</button>
      <button className="work-on" type="button" onClick={workOnThis} disabled={working}>{working ? 'Starting…' : 'Work on this →'}</button>
      {workErr && <span className="work-err">{workErr}</span>}</div>
    <NoteFeedback slug={note.slug} />
  </article>;
}

export function ReportPage() {
  const { slug } = useParams();
  // content.json is built in directory order (oldest first); /report/ must open the newest.
  const newest = [...reports].sort((a, b) => +new Date(b.pubDate) - +new Date(a.pubDate))[0];
  const report = slug ? reports.find((r) => r.slug === slug) : newest;
  if (!report) return <div className="wrap"><p className="empty">Report not found.</p></div>;
  return <article className="wrap article"><Link className="back" to="/"><span>←</span> Back to Orbit</Link>
    <h1 className="article-title">{report.title}</h1><Markdown body={report.body} /></article>;
}
