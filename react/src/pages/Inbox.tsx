import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, InboxItem } from '../api';
import { startWorkFromSource } from './Work';
import { sanitizeHtml } from '../lib';
import { useNavigate } from 'react-router-dom';

/* Ported 1:1 from src/pages/inbox.astro — same markup, same mdLite renderer,
   same sort/chip/submit behaviour, so the React inbox matches Astro exactly. */

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const fmt = (iso?: string | null, precision?: string) => {
  if (!iso) return '—';
  if (precision === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' });
  }
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return esc(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

const ts = (card: InboxItem) => {
  if (!card.created_at) return 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(card.created_at)) return new Date(card.created_at + 'T00:00:00-08:00').valueOf();
  return new Date(card.created_at).valueOf() || 0;
};

function inlineMd(text: string): string {
  return esc(text)
    .replace(/\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)/g, (_m, label, path) => `[[${path}|${label}]]`)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, path, label) => {
      const shown = (label || String(path).split('/').pop() || path).trim();
      return `<span class="wl" title="${esc(path)}">${esc(shown)}</span>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/|\/)[^)\s]*\)/g, (m, _label) => {
      const href = m.slice(m.indexOf('](') + 2, -1);
      return `<a href="${href}" target="_blank" rel="noopener">${m.slice(1, m.indexOf(']('))}</a>`;
    })
    .replace(/https?:\/\/[^\s<]+/g, (url) => {
      const clean = url.replace(/[.,;:!?]+$/, '');
      return `<a href="${clean}" target="_blank" rel="noopener">${clean}</a>${url.slice(clean.length)}`;
    });
}

function mdLite(text: string): string {
  const lines = String(text || '').split(/\r?\n/);
  let html = '';
  let list: 'ul' | 'ol' | null = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { close(); continue; }
    if (/^---+$/.test(line.trim())) { close(); html += '<hr>'; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^#{1,6}\s+(.+)$/))) { close(); html += `<p class="md-h">${inlineMd(m[1])}</p>`; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { close(); html += `<blockquote>${inlineMd(m[1])}</blockquote>`; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.+)$/))) {
      if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inlineMd(m[1])}</li>`; continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.+)$/))) {
      if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inlineMd(m[1])}</li>`; continue;
    }
    close(); html += `<p>${inlineMd(line)}</p>`;
  }
  close();
  return html;
}

function statusChip(status?: string) {
  const map: Record<string, [string, string]> = {
    pending: ['Pending', 'pending'],
    submitted: ['Submitted', 'submitted'],
    processing: ['Processing', 'processing'],
    blocked: ['Blocked', 'blocked'],
    completed: ['Completed', 'completed'],
    outbox: ['Outboxed', 'completed'],
  };
  const [label, cls] = map[status || ''] || [status || '', 'pending'];
  return <span className={`chip chip-${cls}`}>{label}</span>;
}

const actionsOf = (card: InboxItem) => (Array.isArray(card.actions) ? card.actions : []);

export default function Inbox() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [workBusy, setWorkBusy] = React.useState<string | null>(null);
  const [workErr, setWorkErr] = React.useState('');
  const workOnThis = async (item: InboxItem, body: string, summary: string) => {
    if (workBusy) return;
    setWorkBusy(item.orbit_id); setWorkErr('');
    try {
      const id = await startWorkFromSource({
        type: 'inbox', ref: item.orbit_id, title: item.title,
        url: `${window.location.origin}/inbox/`,
        snapshot: `${summary || ''}\n\n${body || ''}`, summary: summary || item.title,
      });
      nav(`/work/${id}`);
    } catch (e: any) { setWorkErr(e.message); } finally { setWorkBusy(null); }
  };
  const [selected, setSelected] = React.useState<Record<string, Set<string>>>({});
  const [instruction, setInstruction] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<Set<string>>(new Set());
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [sort, setSort] = React.useState<{ active: string; outbox: string }>({ active: 'newest', outbox: 'newest' });

  const q = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api('/inbox'),
    refetchInterval: () =>
      typeof document !== 'undefined' && document.visibilityState === 'visible' ? 2000 : false,
  });

  if (q.isLoading) return <div className="wrap"><p className="empty">Loading…</p></div>;
  if (q.error) return <div className="wrap"><p className="empty">Could not load inbox.</p></div>;

  const allActive: InboxItem[] = q.data?.active || [];
  const completed = allActive.filter((c) => c.status === 'completed');
  const activeCards = allActive.filter((c) => c.status !== 'completed');
  const outboxCards: InboxItem[] = [...completed, ...(q.data?.outbox || [])];

  const ordered = (list: InboxItem[], mode: string) => {
    const copy = [...list];
    copy.sort((a, b) => {
      if (mode === 'completed') {
        const av = a.completed_at ? new Date(a.completed_at).valueOf() : 0;
        const bv = b.completed_at ? new Date(b.completed_at).valueOf() : 0;
        return bv - av || String(a.orbit_id).localeCompare(String(b.orbit_id));
      }
      const d = ts(a) - ts(b);
      return (mode === 'oldest' ? d : -d) || String(a.orbit_id).localeCompare(String(b.orbit_id));
    });
    return copy;
  };

  const all = ordered(activeCards, sort.active);
  const progress = all.filter((c) => c.status === 'processing');
  const active = all.filter((c) => c.status !== 'processing');
  const outbox = ordered(outboxCards, sort.outbox);

  const key = (card: InboxItem) => card.orbit_id || card.id;

  const toggleChoice = (card: InboxItem, label: string) => {
    const k = key(card);
    setSelected((prev) => {
      const cur = new Set(prev[k] || []);
      cur.has(label) ? cur.delete(label) : cur.add(label);
      return { ...prev, [k]: cur };
    });
  };

  const setNote = (k: string, text: string) => setNotes((prev) => ({ ...prev, [k]: text }));

  const submit = async (card: InboxItem) => {
    const k = key(card);
    setBusy((prev) => new Set(prev).add(k));
    setNote(k, 'Submitting…');
    try {
      let ts2: string | null = null;
      await api(`/inbox/${encodeURIComponent(k)}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          choices: [...(selected[k] || [])],
          instruction: instruction[k] || '',
          idempotencyKey: `inbox-ui-${k}`,
        }),
      }).then((data: any) => {
        ts2 = data?.submittedAt || new Date().toISOString();
      });
      setSelected((prev) => ({ ...prev, [k]: new Set() }));
      setInstruction((prev) => ({ ...prev, [k]: '' }));
      const when = ts2
        ? new Date(ts2).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })
        : new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' });
      setNote(k, `Submitted ${when} — waiting for the vault.`);
      qc.invalidateQueries({ queryKey: ['inbox'] });
    } catch (err: any) {
      setNote(k, 'Failed: ' + (err?.message || 'error'));
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(k); return n; });
    }
  };

  const dismiss = async (card: InboxItem) => {
    const k = key(card);
    setBusy((prev) => new Set(prev).add(k));
    try {
      await api(`/inbox/${encodeURIComponent(k)}/dismiss`, { method: 'POST', body: '{}' });
      qc.invalidateQueries({ queryKey: ['inbox'] });
    } catch {
      setBusy((prev) => { const n = new Set(prev); n.delete(k); return n; });
    }
  };

  const toggleOpen = (k: string, isOpen: boolean) => setOpen((prev) => {
    const n = new Set(prev);
    isOpen ? n.add(k) : n.delete(k);
    return n;
  });

  const card = (item: InboxItem, isOutbox = false) => {
    const k = key(item);
    const actions = actionsOf(item);
    const actionable = actions.length > 0 || Boolean(String(item.instruction || '').trim());
    const body = item.body || '';
    const summary = item.summary || body.split(/\n/).find((l) => l.trim() && !/^#/.test(l)) || '';
    const showInstruction = !isOutbox
      && (item.instruction || actions.some((a: any) => /something else|comments|feedback/i.test(a.label)));
    const meta = [
      item.kind,
      `created ${fmt(item.created_at, (item as any).created_precision)}`,
      item.submitted_at ? `submitted ${fmt(item.submitted_at)}` : '',
      item.processed_at ? `processed ${fmt(item.processed_at)}` : '',
      isOutbox && item.completed_at ? `completed ${fmt(item.completed_at)}` : '',
    ].filter(Boolean).join(' · ');

    return (
      <article className={`card ${isOutbox ? 'card-outbox' : ''}`} data-orbit-id={k} key={k}>
        <header className="card-head">
          <h3>{item.title}</h3>
          <div className="card-meta">{meta}</div>
          <div className="card-chips">
            {actionable ? statusChip(item.status) : <span className="chip chip-fyi">FYI</span>}
            {item.instruction ? <span className="chip chip-slot">feedback slot</span> : null}
            {!isOutbox && <button className="work-on" type="button" disabled={workBusy === item.orbit_id}
              onClick={() => workOnThis(item, body || '', summary || '')}>
              {workBusy === item.orbit_id ? 'Starting…' : 'Work on this'}</button>}
            {workErr && workBusy === null ? <span className="work-err">{workErr}</span> : null}
          </div>
        </header>

        {body ? (
          <details
            className="card-body"
            open={open.has(k)}
            onToggle={(e) => toggleOpen(k, (e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              <span className="card-summary-inline">{summary}</span>
              <span className="collapse-label">Collapse</span>
            </summary>
            <div className="card-prose" dangerouslySetInnerHTML={{ __html: sanitizeHtml(mdLite(body)) }} />
          </details>
        ) : summary ? <p className="card-summary">{summary}</p> : null}

        {actions.length ? (
          <div className="card-actions">
            {actions.map((a: any, i: number) => {
              const label = String(a.label ?? a.text ?? a.value ?? '');
              return (
                <label className="action-row" key={i}>
                  <input
                    type="checkbox"
                    checked={(selected[k] || new Set()).has(label)}
                    disabled={isOutbox}
                    onChange={() => toggleChoice(item, label)}
                  />
                  <span>
                    {label}
                    {a.checked ? ' ' : ''}
                    {a.checked ? <em className="already">already applied</em> : null}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}

        {showInstruction ? (
          <>
            <label className="instruction-label" htmlFor={`i-${k}`}>
              Note back to the agent <span>(optional)</span>
            </label>
            <textarea
              id={`i-${k}`}
              rows={2}
              placeholder="Anything the checkboxes don't cover…"
              value={instruction[k] || ''}
              onChange={(e) => setInstruction((prev) => ({ ...prev, [k]: e.target.value }))}
            />
          </>
        ) : null}

        {isOutbox ? (
          item.disposition ? <p className="disposition">{item.disposition}</p> : null
        ) : !actionable ? (
          <div className="card-submit">
            <button type="button" className="submit-btn ghost" disabled={busy.has(k)} onClick={() => dismiss(item)}>
              Dismiss
            </button>
            <span className="submit-note">FYI — no decision needed.</span>
          </div>
        ) : item.status === 'processing' ? (
          <p className="progress-note">Waiting for the vault — applied {fmt(item.processed_at)}.</p>
        ) : (
          <div className="card-submit">
            <button type="button" className="submit-btn" disabled={busy.has(k)} onClick={() => submit(item)}>
              Submit decision
            </button>
            <span className="submit-note">
              {notes[k] || (item.status === 'submitted'
                ? `Submitted ${fmt(item.submitted_at)} — waiting for the vault.`
                : item.status === 'blocked'
                  ? 'Blocked — the note changed since you submitted. Review and resubmit.'
                  : '')}
            </span>
          </div>
        )}
      </article>
    );
  };

  const sortButton = (scope: 'active' | 'outbox', order: string, label: string) => (
    <button
      type="button"
      className="sort-btn"
      aria-pressed={sort[scope] === order}
      onClick={() => setSort((prev) => ({ ...prev, [scope]: order }))}
    >
      {label}
    </button>
  );

  return (
    <div className="wrap inbox-wrap">
      <section className="intro compact">
        <h1>Inbox</h1>
        <p className="intro-sub">Messages synchronized from the vault. Choosing an action is not submitting it.</p>
        <div className="inbox-stat" aria-live="polite">
          <span className="inbox-stat-num">{active.length}</span>
          <span className="inbox-stat-label">
            active messages<em>{outbox.length} outboxed</em>
          </span>
        </div>
      </section>

      <section className="inbox-section" aria-labelledby="active-heading">
        <div className="inbox-section-head">
          <h2 id="active-heading">Active</h2>
          <div className="inbox-controls">
            {sortButton('active', 'newest', 'Newest')}
            {sortButton('active', 'oldest', 'Oldest')}
          </div>
        </div>
        <div className="inbox-list">
          {active.length ? active.map((c) => card(c)) : <p className="inbox-empty">Nothing active. Good.</p>}
        </div>
      </section>

      {progress.length ? (
        <section className="inbox-section" aria-labelledby="progress-heading">
          <div className="inbox-section-head">
            <h2 id="progress-heading">In progress</h2>
            <span className="progress-hint">Waiting for the vault</span>
          </div>
          <div className="inbox-list">{progress.map((c) => card(c))}</div>
        </section>
      ) : null}

      <details className="inbox-section outbox-details">
        <summary className="inbox-section-head outbox-summary">
          <h2 id="outbox-heading">
            Outbox {outbox.length ? <span className="outbox-num">({outbox.length})</span> : null}
          </h2>
          <span className="outbox-hint" aria-hidden="true" />
        </summary>
        <div className="inbox-controls outbox-controls">
          {sortButton('outbox', 'newest', 'Newest')}
          {sortButton('outbox', 'oldest', 'Oldest')}
          {sortButton('outbox', 'completed', 'Recently completed')}
        </div>
        <div className="inbox-list">
          {outbox.length ? outbox.map((c) => card(c, true)) : <p className="inbox-empty">No outbox history yet.</p>}
        </div>
      </details>
    </div>
  );
}
