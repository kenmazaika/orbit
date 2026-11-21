import React from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Markdown, fmtDate, fmtDateTime, normalizeContent, plainSummary, readManual, readDecision } from '../lib';
import NavMenu from '../components/NavMenu';

type WorkMode = 'guided' | 'explore';
type WorkRow = {
  id: string; title: string; goal?: string; state: string; attention?: boolean;
  mode?: WorkMode; pendingMode?: WorkMode | null; briefId?: string | null;
  lastActivity?: string; lastLine?: string; updatedAt?: string; createdAt?: string;
  genesis?: { type?: string; ref?: string; title?: string; url?: string } | null;
};
type WorkBrief = {
  id: string; revision: number; createdAt?: string;
  content: {
    current_direction?: string; emerging_thesis?: string; working_thesis?: string;
    tension?: string; angle?: string; reader_takeaway?: string;
    decisions?: ({ text: string; status?: string } | string)[];
    evidence?: string[]; context?: string[];
    unresolved?: string[]; open_questions?: string[];
    not_pursuing?: string[]; boundaries?: string[]; constraints?: string[];
  };
};
type WorkMessage = { id: string; role: string; text: string; kind?: string; createdAt: string };
type WorkStep = { id?: string; title: string; detail?: string; status?: string };
type WorkPlan = { id: string; revision: number; goal: string; rationale?: string; status: string; steps: WorkStep[]; createdAt?: string };
type WorkInteraction = {
  id: string; type: string; prompt: string; context?: string; state: string;
  options?: { id: string; label: string }[]; payload?: any; response?: any;
};
type WorkState = {
  work: WorkRow & { result?: any; feedbackPending?: boolean; planId?: string };
  messages: WorkMessage[];
  plans: WorkPlan[];
  currentPlan: WorkPlan | null;
  interactions: WorkInteraction[];
  brief?: WorkBrief | null;
  briefRevision?: number;
  activeAction?: { id: string; status: string; mode?: string; createdAt?: string } | null;
  lastAction?: { id: string; status: string; reply?: string; error?: string } | null;
};

const STATE_LABEL: Record<string, string> = {
  preparing: 'Preparing', awaiting_direction: 'Plan ready', working: 'Working', exploring: 'Exploring',
  awaiting_feedback: 'Needs your input', awaiting_authorization: 'Authorization needed',
  awaiting_manual: 'Manual step', blocked: 'Blocked', completed: 'Completed', cancelled: 'Stopped',
};
const TERMINAL = ['completed', 'cancelled'];

// Deterministic one-line description for the index: the brief when it says
// something the title does not, otherwise the latest turn cleaned of markdown.
function summaryOf(w: WorkRow): string {
  const goal = plainSummary(w.goal || '', 170);
  if (goal && goal.toLowerCase() !== String(w.title || '').toLowerCase()) return goal;
  return plainSummary(w.lastLine || '', 170);
}

export function WorkList() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [showClosed, setShowClosed] = React.useState(false);
  const [mode, setMode] = React.useState<WorkMode>('guided');
  const { data, isLoading } = useQuery({ queryKey: ['work'], queryFn: () => api('/work') as Promise<{ work: WorkRow[] }> });

  const start = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const res: any = await api('/work', {
        method: 'POST',
        body: JSON.stringify({ message: text.trim(), mode, idempotencyKey: crypto.randomUUID() }),
      });
      setText('');
      qc.invalidateQueries({ queryKey: ['work'] });
      nav(`/work/${res.work.id}`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const rows = data?.work || [];
  const isClosed = (w: WorkRow) => w.state === 'completed' || w.state === 'cancelled';
  const openRows = rows.filter((w) => !isClosed(w));
  const closed = rows.filter(isClosed);
  const visible = showClosed ? [...openRows, ...closed] : openRows;
  return <div className="wrap work-list">
    <section className="intro"><h1>Work</h1>
      <p className="intro-sub">Hand the agent an observation. It plans, works, and brings you in when your judgment matters.</p></section>

    <div className="work-new">
      <div className="work-mode-pick" role="group" aria-label="Work mode">
        <button type="button" className={mode === 'guided' ? 'on' : ''} aria-pressed={mode === 'guided'} onClick={() => setMode('guided')}>Guided</button>
        <button type="button" className={mode === 'explore' ? 'on' : ''} aria-pressed={mode === 'explore'} onClick={() => setMode('explore')}>Explore</button>
      </div>
      <textarea rows={2} placeholder={mode === 'explore' ? "What’s on your mind? Dictate an idea, question, or rough thought…" : "Start from a rough idea, a note, or a problem…"} value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') start(); }} />
      <div className="work-new-row"><span className="work-hint">⌘↵ to start</span><span className="spacer" />
        <button className="primary" type="button" onClick={start} disabled={busy || !text.trim()}>{busy ? 'Starting…' : 'Start work'}</button></div>
      {error && <p className="work-error">{error}</p>}
    </div>
    <div className="feed work-feed">
      {isLoading ? <p className="empty">Loading…</p> : visible.length === 0 ? <p className="empty">{closed.length ? 'No open sessions. Use “Show completed” to see closed ones.' : 'No sessions yet. Start one above, or press “Work on this” on a note.'}</p> :
        visible.map((w) => <Link className="feed-item work-item" key={w.id} to={`/work/${w.id}`}>
          <div className="feed-meta"><span>{fmtDate(w.lastActivity || w.updatedAt)} <span className="sep">·</span> {STATE_LABEL[w.state] || w.state}</span>
            {w.attention && <span className="work-dot" aria-label="Needs attention" />}</div>
          <h2 className="feed-title">{w.title}</h2>
          {summaryOf(w) && <p className="feed-excerpt">{summaryOf(w)}</p>}
        </Link>)}
      {closed.length > 0 && <p className="work-more">
        <button className="work-more-link" type="button" onClick={() => setShowClosed((v) => !v)} aria-pressed={showClosed}>
          {showClosed ? 'Hide completed' : `Show completed (${closed.length})`}
        </button>
      </p>}
    </div>
  </div>;
}

function BriefCard({ brief }: { brief: WorkBrief }) {
  const c = brief.content || {};
  const decisions = Array.isArray(c.decisions) ? c.decisions : [];
  const thesis = c.working_thesis || c.emerging_thesis;
  const tension = c.tension;
  const angle = c.angle || c.current_direction;
  const evidence = c.evidence || c.context || [];
  const unresolved = c.unresolved || c.open_questions || [];
  const notPursuing = c.not_pursuing || [];
  const boundaries = c.boundaries || c.constraints || [];
  const has = thesis || tension || angle || c.reader_takeaway || decisions.length || evidence.length || unresolved.length || notPursuing.length || boundaries.length;
  if (!has) return null;
  const statusLabel = (status: string) => status === 'rejected' ? 'rejected' : status === 'tentative' || status === 'hypothesis' ? 'tentative' : '';
  return <details className="wbrief">
    <summary>Current thinking <span className="wbrief-rev">rev {brief.revision}</span></summary>
    <div className="wbrief-body">
      {thesis && <p><b>Thesis.</b> {thesis}</p>}
      {tension && <p><b>Tension.</b> {tension}</p>}
      {angle && <p><b>Angle.</b> {angle}</p>}
      {decisions.length > 0 && <div><b>Decisions</b><ul>{decisions.map((d, i) => {
        const text = typeof d === 'string' ? d : d.text;
        const status = typeof d === 'string' ? '' : statusLabel(d.status || '');
        return <li key={i}>{text}{status ? <em className="wbrief-hyp"> {status}</em> : null}</li>;
      })}</ul></div>}
      {!!evidence.length && <div><b>Evidence</b><ul>{evidence.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
      {!!unresolved.length && <div><b>Unresolved</b><ul>{unresolved.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
      {!!notPursuing.length && <div><b>Not pursuing</b><ul>{notPursuing.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
      {c.reader_takeaway && <p><b>Reader takeaway.</b> {c.reader_takeaway}</p>}
      {!!boundaries.length && <div><b>Boundaries</b><ul>{boundaries.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
    </div>
  </details>;
}

function PlanCard({ plan, onAccept, onChange, busy, canAccept }: {
  plan: WorkPlan; onAccept: () => void; onChange: () => void; busy: boolean; canAccept: boolean;
}) {
  return <section className="wplan" aria-label="Proposed plan">
    <div className="wplan-head"><span className="wplan-kicker">Plan · rev {plan.revision}</span>
      <span className={`wplan-status ${plan.status}`}>{plan.status}</span></div>
    {plan.goal && <h2 className="wplan-goal">{plan.goal}</h2>}
    <ol className="wplan-steps">{plan.steps.map((s, i) => <li key={s.id || i} className={`wstep ${s.status || 'pending'}`}>
      <span className="wstep-dot" aria-hidden="true" />
      <div><b>{s.title}</b>{s.detail && <span className="wstep-detail">{s.detail}</span>}</div>
    </li>)}</ol>
    {plan.rationale && <p className="wplan-why">{plan.rationale}</p>}
    {canAccept && <div className="wplan-actions">
      <button type="button" className="primary" onClick={onAccept} disabled={busy}>Sounds good</button>
      <button type="button" className="ghost" onClick={onChange} disabled={busy}>Change approach</button>
    </div>}
  </section>;
}

function ManualPayload({ payload }: { payload: any }) {
  const m = readManual(payload);
  const usable = m.steps.length > 0 || !!m.why || !!m.url || m.verify.length > 0 || m.title !== 'Manual step';
  if (!usable) {
    const d = readDecision(payload);
    if (!d) return <pre className="wint-payload">{JSON.stringify(payload, null, 2)}</pre>;
    return <div className="wint-task">
      {d.lines.map((l, i) => <div className="wdec-row" key={i}>
        <span className="wdec-label">{l.label}</span>
        <p className="wdec-text">{l.text}</p>
      </div>)}
      {d.steps.length > 0 && <ol className="wint-steps">{d.steps.map((x, i) => <li key={i}>{x}</li>)}</ol>}
      <details className="wint-tech"><summary>Technical details</summary>
        <pre>{JSON.stringify(payload, null, 2)}</pre></details>
    </div>;
  }
  let host = 'link';
  try { host = new URL(m.url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
  return <div className="wint-task">
    <h3 className="wint-task-title">{m.title}</h3>
    {m.why && <p className="wint-task-why">{m.why}</p>}
    {m.steps.length > 0 && <ol className="wint-steps">{m.steps.map((x, i) => <li key={i}>{x}</li>)}</ol>}
    {m.verify.length > 0 && <div className="wint-verify"><span>Looks right when</span>
      <ul>{m.verify.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
    {m.url && <a className="wint-open" href={m.url} target="_blank" rel="noreferrer">Open {host} ↗</a>}
    <details className="wint-tech"><summary>Technical details</summary>
      <pre>{JSON.stringify(payload, null, 2)}</pre></details>
  </div>;
}

function maybeLink(value: any, key: number) {
  const text = typeof value === 'string' ? value : String(value?.label || value?.url || '');
  const url = typeof value === 'string' ? (/(^|\s)(https?:\/\/\S+)/.test(value) ? value.match(/https?:\/\/\S+/)![0] : '') : value?.url;
  if (!url) return <span key={key}>{text}</span>;
  const [before, after] = text.split(url);
  return <span key={key}>{before}<a href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, '')}</a>{after}</span>;
}

function ResultBlock({ result, title }: { result: any; title: string }) {
  const r = result || {};
  const summary = normalizeContent(r.summary || r.outcome || '');
  const dedupe = summary.trim().toLowerCase() === String(title || '').trim().toLowerCase();
  const changes: any[] = Array.isArray(r.changes) ? r.changes : [];
  const evidence: any[] = [...(r.verified || []), ...((r.links || []).map((l: any) => l && (l.label || l.url)) || [])].filter(Boolean);
  const remaining: any[] = Array.isArray(r.remaining) ? r.remaining : (r.remaining ? [r.remaining] : []);
  return <section className="wresult">
    <h2>Result</h2>
    {summary && !dedupe && <Markdown body={summary} className="wresult-outcome" />}
    {changes.length > 0 && <div className="wresult-sec"><h3>Changes</h3>
      <Markdown body={changes.map((c: any) => `- ${typeof c === 'string' ? c : (c.text || c.label || '')}`).join('\n')} /></div>}
    {evidence.length > 0 && <div className="wresult-sec"><h3>Evidence</h3>
      <ul className="wresult-list">{evidence.map((e, i) => <li key={i}>{maybeLink(e, i)}</li>)}</ul></div>}
    {remaining.length > 0 && <div className="wresult-sec"><h3>Remaining</h3>
      <ul className="wresult-list">{remaining.map((e, i) => <li key={i}>{maybeLink(e, i)}</li>)}</ul></div>}
  </section>;
}

function InteractionCard({ item, onRespond, onCustom, busy }: { item: WorkInteraction; onRespond: (option: string | null, text: string) => void; onCustom: () => void; busy: boolean }) {
  const typeLabel = item.type === 'authorization' ? 'Authorization' : item.type === 'manual' ? 'Manual step' : 'Your call';
  return <section className={`wint ${item.type}`} aria-label={typeLabel}>
    <div className="wint-head"><span className="wint-kicker">{typeLabel}</span>
      {item.type === 'authorization' && <span className="wint-test">staging — nothing is sent</span>}</div>
    <p className="wint-prompt">{item.prompt}</p>
    {item.context && <p className="wint-context">{item.context}</p>}
    {item.payload && <ManualPayload payload={item.payload} />}
    {(item.options || []).length > 0 && <div className="wint-options">
      {(item.options || []).map((o) => <button key={o.id} type="button" className={item.type === 'authorization' ? 'primary' : 'ghost'}
        onClick={() => onRespond(o.id, '')} disabled={busy}>{o.label}</button>)}
    </div>}
    <button type="button" className="wint-custom" disabled={busy} onClick={onCustom}>Answer in your own words</button>
  </section>;
}

export default function WorkThread() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [modeMenu, setModeMenu] = React.useState(false);
  const [pendingInteraction, setPendingInteraction] = React.useState<WorkInteraction | null>(null);
  const [atBottom, setAtBottom] = React.useState(true);
  const [now, setNow] = React.useState(Date.now());
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const input = React.useRef<HTMLTextAreaElement | null>(null);
  const state = useQuery({
    queryKey: ['work', id],
    queryFn: () => api(`/work/${encodeURIComponent(id)}`) as Promise<WorkState>,
    refetchInterval: (q) => {
      const s = q.state.data?.work?.state || '';
      return TERMINAL.includes(s) ? false : 1600;
    },
  });
  const s = state.data;
  const running = !!s?.activeAction && !['completed', 'failed', 'stale', 'cancelled'].includes(s.activeAction.status);
  const elapsed = s?.activeAction ? Math.max(0, Math.round((now - +new Date(s.activeAction.createdAt || now)) / 1000)) : 0;

  React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const jumpToBottom = React.useCallback(() => {
    const el = scroller.current; if (!el) return;
    el.scrollTop = el.scrollHeight; setAtBottom(true);
  }, []);
  // Opening a session starts at the latest turn, like a chat.
  const initialized = React.useRef('');
  React.useEffect(() => { initialized.current = ''; }, [id]);
  React.useEffect(() => {
    if (!s || initialized.current === id) return;
    initialized.current = id;
    const jump = () => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; };
    requestAnimationFrame(jump); const t = setTimeout(jump, 180); return () => clearTimeout(t);
  }, [s, id]);
  React.useEffect(() => {
    if (!atBottom) return;
    const el = scroller.current; if (el) el.scrollTop = el.scrollHeight;
  }, [s?.messages?.length, s?.currentPlan?.id, s?.interactions?.length, atBottom]);

  React.useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    const onViewport = () => {
      const kb = vv ? Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0)) : 0;
      root.style.setProperty('--work-kb', `${kb}px`);
    };
    onViewport();
    vv?.addEventListener('resize', onViewport);
    vv?.addEventListener('scroll', onViewport);
    return () => { vv?.removeEventListener('resize', onViewport); vv?.removeEventListener('scroll', onViewport); root.style.removeProperty('--work-kb'); };
  }, []);

  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['work', id] });

  const answerInComposer = (item: WorkInteraction) => {
    setPendingInteraction(item);
    setText('');
    input.current?.focus();
  };

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setNotice('');
    const body = text.trim();
    if (pendingInteraction) {
      try {
        await api(`/work/${encodeURIComponent(id)}/interactions/${encodeURIComponent(pendingInteraction.id)}/respond`, {
          method: 'POST', body: JSON.stringify({ option: null, text: body, idempotencyKey: crypto.randomUUID() }),
        });
        setText(''); setPendingInteraction(null); refresh();
      } catch (e: any) { setNotice(`Not sent: ${e.message}`); } finally { setBusy(false); }
      return;
    }
    try {
      const res: any = await api(`/work/${encodeURIComponent(id)}/messages`, {
        method: 'POST', body: JSON.stringify({ text: body, idempotencyKey: crypto.randomUUID() }),
      });
      setText('');
      setNotice(res.queued ? 'Feedback received — applying after the current step.' : '');
      setAtBottom(true);
      refresh();
    } catch (e: any) { setNotice(`Not sent: ${e.message}`); } finally { setBusy(false); }
  };
  const accept = async () => {
    if (busy || !s?.currentPlan) return;
    setBusy(true); setNotice('');
    try { await api(`/work/${encodeURIComponent(id)}/plan/accept`, { method: 'POST', body: JSON.stringify({ planId: s.currentPlan.id, idempotencyKey: crypto.randomUUID() }) }); refresh(); }
    catch (e: any) { setNotice(`Could not accept: ${e.message}`); } finally { setBusy(false); }
  };
  const changeApproach = () => {
    setText('Change approach: ');
    input.current?.focus();
  };
  const respond = async (item: WorkInteraction, option: string | null, answer: string) => {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      await api(`/work/${encodeURIComponent(id)}/interactions/${encodeURIComponent(item.id)}/respond`, {
        method: 'POST', body: JSON.stringify({ option, text: answer, idempotencyKey: crypto.randomUUID() }),
      });
      refresh();
    } catch (e: any) { setNotice(`Could not respond: ${e.message}`); } finally { setBusy(false); }
  };
  const switchMode = async (target: WorkMode) => {
    if (busy || !s) return;
    setModeMenu(false); setBusy(true); setNotice('');
    try {
      const res: any = await api(`/work/${encodeURIComponent(id)}/mode`, {
        method: 'POST', body: JSON.stringify({ mode: target, idempotencyKey: crypto.randomUUID() }),
      });
      setNotice(res.pending ? `Switching to ${target === 'explore' ? 'Explore' : 'Guided'} after the current step.` : '');
      refresh();
    } catch (e: any) { setNotice(`Could not switch: ${e.message}`); } finally { setBusy(false); }
  };
  const closeWork = async () => {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await api(`/work/${encodeURIComponent(id)}/close`, { method: 'POST', body: '{}' }); refresh(); }
    catch (e: any) { setNotice(`Could not close: ${e.message}`); } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!confirm('Stop this Work session? Queued actions will not run.')) return;
    setBusy(true);
    try { await api(`/work/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }); refresh(); }
    catch (e: any) { setNotice(e.message); } finally { setBusy(false); }
  };

  if (state.isLoading) return <div className="work-page"><div className="work-main"><p className="empty">Loading…</p></div></div>;
  if (state.error || !s) return <div className="work-page"><div className="work-main"><p className="empty">Could not load this session.</p></div></div>;

  const w = s.work;
  const explore = w.mode === 'explore';
  const otherMode: WorkMode = explore ? 'guided' : 'explore';
  const openInteractions = s.interactions.filter((i) => i.state === 'open');
  const lastPlanMessage = s.messages.filter((m) => m.kind === 'plan').at(-1)?.id;
  const canAccept = !explore && w.state === 'awaiting_direction' && s.currentPlan?.status === 'proposed';

  return <div className="work-page">
    <header className="work-top"><div className="work-top-in">
      <Link className="work-back" to="/work" aria-label="Back to Work">←</Link>
      <span className="work-word">Work</span>
      <span className="spacer" />
      <div className="work-mode">
        <button className="work-mode-btn" type="button" aria-haspopup="menu" aria-expanded={modeMenu} onClick={() => setModeMenu((v) => !v)}>
          {explore ? 'Explore' : 'Guided'} <span aria-hidden="true">⌄</span>
        </button>
        {modeMenu && <div className="work-mode-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => switchMode(otherMode)}>Switch to {otherMode === 'explore' ? 'Explore' : 'Guided'}</button>
          <button type="button" role="menuitem" className="muted" onClick={() => setModeMenu(false)}>Cancel</button>
        </div>}
      </div>
      {running && <span className="work-live"><i />{elapsed}s</span>}
      <span className={`work-state ${w.state}`}>{STATE_LABEL[w.state] || w.state}</span>
      {!TERMINAL.includes(w.state) && <button className="work-close" type="button" onClick={closeWork} disabled={busy}
        title="Mark this work as closed — stops any queued actions">Close</button>}
      {!TERMINAL.includes(w.state) && <button className="work-stop" type="button" onClick={stop} disabled={busy}>Stop</button>}
      <NavMenu />
    </div></header>

    <div className="work-scroll" ref={scroller} onScroll={onScroll}>
      <main className="work-main">
        <h1 className="work-title">{w.title}</h1>
        {w.genesis && <p className="work-meta">
          {w.genesis.url ? <a href={w.genesis.url} target="_blank" rel="noreferrer">{w.genesis.title || w.genesis.ref}</a> : (w.genesis.title || w.genesis.ref || 'Blank session')}
          {w.genesis.captured_at ? ` · captured ${fmtDate(w.genesis.captured_at)}` : ''}
        </p>}
        {s.brief?.content && <BriefCard brief={s.brief} />}
        {s.messages.map((m) => <React.Fragment key={m.id}>
          {m.role === 'user' ? <div className={`wmsg user${(() => { const t = normalizeContent(m.text); return t.length > 600 || /^#{1,6}\s/m.test(t) ? ' doc' : ''; })()}`}><Markdown className="wmsg-body" body={m.text} /></div>
            : m.role === 'system' ? <div className="wmsg system">{m.text}</div>
              : <article className={`wmsg agent ${m.kind || ''}`}><Markdown body={m.text} /></article>}
          {!explore && m.id === lastPlanMessage && s.currentPlan && <PlanCard plan={s.currentPlan} onAccept={accept} onChange={changeApproach} busy={busy} canAccept={canAccept} />}
        </React.Fragment>)}
        {!explore && s.currentPlan && !lastPlanMessage && <PlanCard plan={s.currentPlan} onAccept={accept} onChange={changeApproach} busy={busy} canAccept={canAccept} />}
        {openInteractions.map((i) => <InteractionCard key={i.id} item={i} busy={busy} onRespond={(o, t) => respond(i, o, t)} onCustom={() => answerInComposer(i)} />)}
        {running && <div className="work-working"><span className="work-spinner" />{s.activeAction?.mode === 'explore' ? 'Thinking this through…' : s.activeAction?.mode === 'plan' ? 'Reading the source and building a plan…' : 'Working — progress will appear here.'}</div>}
        {w.pendingMode && <div className="work-pending">Switching to {w.pendingMode === 'explore' ? 'Explore' : 'Guided'} after the current step.</div>}
        {w.result && <ResultBlock result={w.result} title={w.title} />}
        <div className="work-end" />
      </main>
    </div>

    {!atBottom && <button className="work-jump" type="button" aria-label="Scroll to latest" title="Scroll to latest" onClick={jumpToBottom}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14m0 0 6-6m-6 6-6-6"/></svg>
    </button>}

    {notice && <div className="work-notice">{notice}</div>}
    <div className="work-composer">
      {pendingInteraction && <div className="work-answering">
        <span>Answering: {pendingInteraction.prompt.slice(0, 90)}</span>
        <button type="button" onClick={() => setPendingInteraction(null)} aria-label="Cancel answer">×</button>
      </div>}
      {w.feedbackPending && <div className="work-pending">Feedback queued — applying at the next safe step.</div>}
      <div className="work-inputrow">
        <textarea ref={input} rows={1} value={text} placeholder={TERMINAL.includes(w.state) ? 'This session is closed.' : explore ? 'Add a thought, challenge, or direction…' : running ? 'Redirect or add context — applies after the current step…' : 'Reply, redirect, or add context…'}
          disabled={w.state === 'cancelled'} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }} />
        <button type="button" className="work-send" onClick={send} disabled={busy || !text.trim() || w.state === 'cancelled'} aria-label="Send">→</button>
      </div>
    </div>

    <nav className="dock work-dock" aria-label="Orbit"><div className="dock-in">
      <NavLink to="/" end><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/></svg><span>Feed</span></NavLink>
      <NavLink to="/inbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 6.5h16v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><path d="M4 13h4l1.5 2h5L16 13h4"/></svg><span>Inbox</span></NavLink>
      <NavLink to="/artifacts"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg><span>Artifacts</span></NavLink>
      <NavLink to="/work"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 7h14M5 12h9M5 17h11"/><circle cx="3" cy="7" r=".8"/><circle cx="3" cy="12" r=".8"/><circle cx="3" cy="17" r=".8"/></svg><span>Work</span></NavLink>
    </div></nav>
  </div>;
}

export async function startWorkFromSource(input: {
  type: string; ref: string; title: string; url: string; snapshot: string; summary?: string; mode?: WorkMode;
}): Promise<string> {
  const res: any = await api('/work', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      goal: input.summary || input.title,
      mode: input.mode || 'guided',
      genesis: { type: input.type, ref: input.ref, title: input.title, url: input.url, snapshot: input.snapshot, summary: input.summary || '' },
      idempotencyKey: crypto.randomUUID(),
    }),
  });
  return res.work.id;
}
