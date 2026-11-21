import React from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ArtifactState, Action, Asset, Review, Revision } from '../api';
import { Markdown, fmtDateTime, fmtDate, esc } from '../lib';
import { startWorkFromSource } from './Work';
import NavMenu from '../components/NavMenu';

const TERMINAL = ['completed', 'failed', 'stale', 'cancelled'];
const WORKFLOWS = [
  ['blog-author', 'Blog author'], ['blog-critic', 'Blog critic'],
  ['seo-retrofit', 'SEO retrofit'], ['signup-retrofit', 'Sign-up retrofit'], ['', 'Feedback only'],
];
const draftKey = (id: string) => `orbit:draft:${id}`;
const wfKey = (id: string) => `orbit:workflow:${id}`;

function splitBlocks(md: string): string[] {
  const out: string[] = []; let buf: string[] = []; let fence = false;
  for (const line of String(md || '').split(/\r?\n/)) {
    if (/^```/.test(line.trim())) fence = !fence;
    if (!fence && !line.trim()) { if (buf.length) { out.push(buf.join('\n')); buf = []; } continue; }
    buf.push(line);
  }
  if (buf.length) out.push(buf.join('\n'));
  return out;
}

function frontMatter(md: string) {
  const m = String(md || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  return m[1].split(/\r?\n/).map((line) => {
    const hit = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    return hit ? [hit[1], hit[2].replace(/^['"]|['"]$/g, '')] : null;
  }).filter(Boolean) as [string, string][];
}

function diffLines(prev: string, cur: string) {
  const a = String(prev || '').split('\n'), b = String(cur || '').split('\n');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: [' ' | '-' | '+', string][] = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

function NoteEditor({ review, finding, onSaved }: { review: Review; finding: any; onSaved: () => void }) {
  const [text, setText] = React.useState(review.notes?.[finding.id] || '');
  const [state, setState] = React.useState('');
  React.useEffect(() => setText(review.notes?.[finding.id] || ''), [review.id, finding.id]);
  const save = async () => {
    setState('Saving…');
    try {
      await api(`/reviews/${review.id}/findings/${finding.id}/note`, {
        method: text.trim() ? 'PUT' : 'DELETE', body: JSON.stringify({ note: text }),
      });
      setState('Saved'); onSaved();
    } catch (e: any) { setState(`Failed: ${e.message}`); }
  };
  return <div className="notewrap"><textarea rows={1} placeholder="Add a note about this finding…" value={text}
    onChange={(e) => setText(e.target.value)} /><div className="nrow"><span className="nstat">{state}</span>
    <span className="spacer" /><button type="button" className="primary" onClick={save}>Save note</button></div></div>;
}

function FindingCard({ review, finding, order, extras, onSaved }: any) {
  const [open, setOpen] = React.useState(true);
  const quote = (finding.anchors || []).find((a: any) => a.exact)?.exact || '';
  return <div className={`find${open ? ' open' : ''}`} id={`find-${finding.id}`} data-fid={finding.id}>
    <button className="find-head" type="button" onClick={() => setOpen(!open)}>
      <span className="find-num">{order[finding.id] || '•'}</span>
      <span className="find-cat">{finding.category}</span><span className="find-chev">⌄</span>
    </button>
    <div className="find-body">
      <p className="find-sum">{finding.summary}</p>
      {finding.explanation && <p className="find-exp">{finding.explanation}</p>}
      {quote && <p className="find-quote">{quote}</p>}
      {extras?.length > 0 && <p className="find-quote">Also anchored to {extras.length} other passage{extras.length > 1 ? 's' : ''}.</p>}
      <NoteEditor review={review} finding={finding} onSaved={onSaved} />
    </div>
  </div>;
}

function DiffView({ prev, cur }: { prev: string; cur: string }) {
  const ops = React.useMemo(() => diffLines(prev, cur), [prev, cur]);
  const edits = ops.filter(([t]) => t !== ' ').length;
  if (!edits) return <div className="diffwrap"><div className="dl empty">No line changes between these revisions.</div></div>;
  return <div className="diffwrap">{ops.map(([t, line], i) => (
    <div key={i} className={`dl${t === '-' ? ' del' : t === '+' ? ' ins' : ''}`}>
      <span className="g">{t === ' ' ? '' : t === '-' ? '−' : '+'}</span><span className="t">{line || '\u00a0'}</span>
    </div>))}</div>;
}

function Critique({ markdown, review, loading, onSaved }: any) {
  const blocks = React.useMemo(() => splitBlocks(markdown), [markdown]);
  const ref = React.useRef<HTMLDivElement>(null);
  const findings = review?.findings || [];
  const order: Record<string, number> = {}; findings.forEach((f: any, i: number) => { order[f.id] = i + 1; });
  const anchorBlock = (f: any) => {
    for (const a of f.anchors || []) {
      if (typeof a.blockIndex === 'number' && a.blockIndex >= 0 && a.blockIndex < blocks.length) return a.blockIndex;
      if (a.exact) { const idx = blocks.findIndex((b) => b.includes(a.exact)); if (idx >= 0) return idx; }
    }
    return -1;
  };
  const first: Record<number, any> = {};
  findings.forEach((f: any) => { const b = anchorBlock(f); if (b >= 0 && first[b] === undefined) first[b] = f; });
  React.useEffect(() => {
    if (!ref.current) return;
    findings.forEach((f: any) => {
      const a = (f.anchors || []).find((x: any) => x.exact);
      if (!a) return;
      const walker = document.createTreeWalker(ref.current!, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const idx = (node.textContent || '').indexOf(a.exact);
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(node, idx); range.setEnd(node, idx + a.exact.length);
          const mark = document.createElement('mark'); mark.className = 'hit'; mark.title = f.category || 'finding';
          try { range.surroundContents(mark); } catch {}
          break;
        }
      }
    });
  }, [markdown, review?.id]);
  if (loading) return <p className="empty">Loading critique…</p>;
  if (!review) return <div className="crit-more">No critique for this revision.</div>;
  const unanchored = findings.filter((f: any) => anchorBlock(f) < 0);
  return <div ref={ref}><p className="find-sum" style={{ marginBottom: 12 }}>{review.summary}</p>
    {blocks.map((block, i) => <React.Fragment key={i}>
      <div className={`blk${first[i] ? ' flag' : ''}`}><Markdown body={block} /></div>
      {first[i] && <FindingCard review={review} finding={first[i]} order={order} extras={[]} onSaved={onSaved} />}
    </React.Fragment>)}
    {unanchored.length > 0 && <div className="crit-more"><b>Not anchored to a passage</b>
      {unanchored.map((f: any) => <FindingCard key={f.id} review={review} finding={f} order={order} extras={[]} onSaved={onSaved} />)}</div>}
  </div>;
}

export default function ArtifactDetail() {
  const { id = '' } = useParams();
  const loc = useLocation();
  // Where the reader came from (tab + scroll), so the menu returns them there.
  const backTo = (loc.state as any)?.from || '/artifacts';
  const backLabel = 'All artifacts';
  const nav = useNavigate();
  const qc = useQueryClient();
  const [workBusy, setWorkBusy] = React.useState(false);
  const [workErr, setWorkErr] = React.useState('');
  const workOnThis = async (title: string, markdown: string) => {
    if (workBusy) return;
    setWorkBusy(true); setWorkErr('');
    try {
      const workId = await startWorkFromSource({
        type: 'artifact', ref: id, title,
        url: `${window.location.origin}/artifacts/${id}`,
        snapshot: markdown, summary: `Artifact: ${title}`,
      });
      nav(`/work/${workId}`);
    } catch (e: any) { setWorkErr(e.message); } finally { setWorkBusy(false); }
  };
  const [mode, setMode] = React.useState<'read' | 'diff' | 'critique'>('read');
  const [selectedRevId, setSelectedRevId] = React.useState<string | null>(null);
  const [text, setText] = React.useState(() => sessionStorage.getItem(draftKey(id)) || '');
  const [workflow, setWorkflow] = React.useState(() => sessionStorage.getItem(wfKey(id)) || 'blog-author');
  const [actionId, setActionId] = React.useState<string | null>(null);
  const [lastAction, setLastAction] = React.useState<Action | null>(null);
  const [dismissedActionId, setDismissedActionId] = React.useState<string | null>(null);
  const [panelMode, setPanelMode] = React.useState<'min' | 'mid' | 'max'>('min');
  const sheetOpen = panelMode !== 'min';
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [now, setNow] = React.useState(Date.now());
  const applied = React.useRef<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [uploadMasthead, setUploadMasthead] = React.useState(false);
  const [trayOpen, setTrayOpen] = React.useState(false);
  const [mastheadOpen, setMastheadOpen] = React.useState(false);
  const sheetRef = React.useRef<HTMLElement | null>(null);
  const sheetLock = React.useRef(0);
  const state = useQuery({ queryKey: ['artifact', id], queryFn: () => api(`/artifacts/${encodeURIComponent(id)}`) as Promise<ArtifactState>, retry: 2 });
  const expandPanel = () => setPanelMode((m) => m === 'min' ? 'mid' : m === 'mid' ? 'max' : 'max');
  const minimizePanel = () => setPanelMode((m) => m === 'max' ? 'mid' : m === 'mid' ? 'min' : 'min');
  React.useEffect(() => {
    document.body.classList.add('artifact-body');
    const root = document.documentElement;
    const composer = document.querySelector('.composer') as HTMLElement | null;
    const sheet = document.querySelector('.sheet') as HTMLElement | null;
    const measure = () => {
      const dockH = 0;
      const composerH = composer?.offsetHeight || 0;
      const kb = parseFloat(getComputedStyle(root).getPropertyValue('--kb')) || 0;
      if (composer) { root.style.setProperty('--composer', composerH + 'px'); composer.style.bottom = (dockH + kb) + 'px'; }
      if (sheet) { root.style.setProperty('--sheet', sheet.offsetHeight + 'px'); sheet.style.bottom = (dockH + composerH + kb) + 'px'; }
      root.style.setProperty('--dock', '0px');
    };
    const ro = 'ResizeObserver' in window ? new ResizeObserver(measure) : null;
    if (ro) { if (composer) ro.observe(composer); if (sheet) ro.observe(sheet); }
    measure();
    requestAnimationFrame(measure);
    const t1 = setTimeout(measure, 120);
    const t2 = setTimeout(measure, 400);
    window.addEventListener('resize', measure);
    const vv = window.visualViewport;
    const onViewport = () => {
      const height = vv ? vv.height : window.innerHeight;
      const offset = vv ? vv.offsetTop : 0;
      root.style.setProperty('--kb', Math.max(0, window.innerHeight - height - offset) + 'px');
      measure();
    };
    window.addEventListener('resize', onViewport);
    vv?.addEventListener('resize', onViewport);
    vv?.addEventListener('scroll', onViewport);
    return () => {
      document.body.classList.remove('artifact-body');
      ro?.disconnect(); clearTimeout(t1); clearTimeout(t2); window.removeEventListener('resize', measure);
      window.removeEventListener('resize', onViewport);
      vv?.removeEventListener('resize', onViewport); vv?.removeEventListener('scroll', onViewport);
      root.style.removeProperty('--composer'); root.style.removeProperty('--sheet');
      root.style.removeProperty('--dock'); root.style.removeProperty('--kb');
    };
  }, [panelMode, state.data]);

  React.useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    return () => clearTimeout(t);
  }, [panelMode, mode, text, workflow]);
  React.useEffect(() => {
    if (panelMode === 'min') setTrayOpen(false);
    if (panelMode === 'max') setTrayOpen(true);
  }, [panelMode]);
  React.useEffect(() => { sessionStorage.setItem(draftKey(id), text); }, [id, text]);
  React.useEffect(() => { sessionStorage.setItem(wfKey(id), workflow); }, [id, workflow]);
  React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const s = state.data;
  const revisions = React.useMemo(() => [...(s?.revisions || [])].sort((a, b) => a.number - b.number), [s]);
  const currentId = s?.currentRevisionId || '';
  const revId = selectedRevId || currentId;
  const revQuery = useQuery({
    queryKey: ['revision', id, revId], enabled: !!revId,
    queryFn: () => api(`/revisions/${encodeURIComponent(revId)}`) as Promise<any>,
  });
  const markdown: string = revQuery.data?.content || '';
  const selected = revisions.find((r) => r.id === revId);
  const currentNumber = s?.currentNumber || 0;
  const prevRev = revisions.find((r) => r.number === (selected?.number || 0) - 1);
  const prevQuery = useQuery({
    queryKey: ['revision', id, prevRev?.id], enabled: !!prevRev,
    queryFn: () => api(`/revisions/${encodeURIComponent(prevRev!.id)}`) as Promise<any>,
  });
  const reviewSummary = React.useMemo(() => {
    const list = [...(s?.reviews || [])].filter((r) => r.targetRevisionId === revId);
    return (list[0] || (s?.reviews || [])[0] || null) as any;
  }, [s, revId]);
  const reviewQuery = useQuery({
    queryKey: ['review', reviewSummary?.id], enabled: !!reviewSummary?.id,
    queryFn: () => api(`/reviews/${encodeURIComponent(reviewSummary!.id)}`) as Promise<{ review: Review }>,
  });
  const action = useQuery({
    queryKey: ['action', actionId], enabled: !!actionId,
    queryFn: () => api(`/agent/actions/${encodeURIComponent(actionId!)}`) as Promise<{ action: Action }>,
    refetchInterval: (q) => { const a = q.state.data?.action; return a && TERMINAL.includes(a.status) ? false : 1200; },
    refetchIntervalInBackground: true, retry: 4,
  });

  React.useEffect(() => {
    const a = action.data?.action; if (!a) return;
    if (!TERMINAL.includes(a.status)) { setLastAction(a); return; }
    if (applied.current === a.id) return;
    applied.current = a.id; setLastAction(a); setActionId(null);
    if (s && a.article_id === s.article.id) {
      (async () => {
        await qc.invalidateQueries({ queryKey: ['artifact', id] });
        await qc.refetchQueries({ queryKey: ['artifact', id] });
        if (a.result_kind === 'review') setMode('critique');
        else if (a.revision_id) { setMode('diff'); setSelectedRevId(null); }
        setPanelMode('mid');
      })();
      setBusy(false);
    } else setBusy(false);
  }, [action.data]);

  if (state.isLoading) return <div className="wrap"><p className="empty">Loading artifact…</p></div>;
  if (state.error || !s) return <div className="wrap"><p className="empty">Could not load artifact.</p></div>;

  const persistedFailure = [lastAction, s.lastRequest].find((a) => a && a.id !== dismissedActionId && (a.status === 'failed' || a.status === 'stale')) || null;
  const active = (actionId ? action.data?.action : null)
    || (s.activeRequest && !TERMINAL.includes(s.activeRequest.status) ? s.activeRequest : null)
    || persistedFailure;
  const isCurrent = revId === currentId;
  const fm = frontMatter(markdown);
  const bodyMarkdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const wordCount = bodyMarkdown.trim() ? bodyMarkdown.trim().split(/\s+/).length : 0;
  const send = async (retry = false) => {
    if (busy) return;
    const useWorkflow = !!workflow;
    if (!useWorkflow && !text.trim()) { setNotice('Write feedback or pick a workflow.'); return; }
    if (!isCurrent) { setNotice('Viewing an older revision — switch to the current one to submit.'); return; }
    setBusy(true); setNotice(''); setDismissedActionId(null);
    let fresh = s;
    try { fresh = await api(`/artifacts/${encodeURIComponent(id)}`) as ArtifactState; qc.setQueryData(['artifact', id], fresh); }
    catch (e: any) { setBusy(false); setNotice(`Could not refresh: ${e.message}`); return; }
    const payload = { articleId: id, baseRevisionId: fresh.currentRevisionId, text, kind: useWorkflow ? 'workflow' : 'feedback',
      workflow: useWorkflow ? workflow : undefined, idempotencyKey: crypto.randomUUID(),
      imageIds: (fresh.images || []).filter((i) => i.include_flag && !(i as any).request_id).map((i) => i.id) };
    try {
      const res: any = await api(`/artifacts/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: JSON.stringify(payload) });
      if (res.requestId) { setActionId(res.requestId); setPanelMode('mid'); }
      if (!retry) setText('');
    } catch (e: any) {
      setBusy(false); setNotice(e.message === 'stale_base' ? 'A newer revision exists — reloading.' : `Submit failed: ${e.message}`);
      if (e.message === 'stale_base') qc.invalidateQueries({ queryKey: ['artifact', id] });
    }
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const b64 = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(file); });
      await api(`/artifacts/${encodeURIComponent(id)}/images`, { method: 'POST', body: JSON.stringify({
        filename: file.name, mime: file.type, dataBase64: b64,
        role: uploadMasthead ? 'masthead' : undefined, assetState: uploadMasthead ? 'candidate' : undefined,
        instruction: 'Uploaded from React staging',
      }) });
    }
    setUploadMasthead(false); setTrayOpen(true); qc.invalidateQueries({ queryKey: ['artifact', id] });
  };
  const toggleAsset = async (asset: Asset) => {
    await api(`/artifacts/${encodeURIComponent(id)}/images`, { method: 'PATCH', body: JSON.stringify({ ids: [asset.id], include: !asset.include_flag }) });
    qc.invalidateQueries({ queryKey: ['artifact', id] });
  };
  const removeAsset = async (asset: Asset) => {
    await api(`/images/${asset.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['artifact', id] });
  };
  const useMasthead = async (asset: Asset) => {
    try {
      await api(`/artifacts/${encodeURIComponent(id)}/masthead`, { method: 'POST', body: JSON.stringify({ assetId: asset.id }) });
      qc.setQueryData(['artifact', id], (old: any) => old ? {
        ...old,
        masthead: { ...asset, state: 'active' },
        mastheadCandidates: (old.mastheadCandidates || []).map((a: Asset) =>
          a.id === asset.id ? { ...a, state: 'active' } : { ...a, state: 'historical' }),
      } : old);
      setNotice('Masthead updated');
      await qc.refetchQueries({ queryKey: ['artifact', id] });
    } catch (e: any) { setNotice(`Masthead: ${e.message}`); }
  };
  const downloadMarkdown = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (s.article.title || 'artifact').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.md';
    a.click(); URL.revokeObjectURL(a.href);
  };
  const copyMarkdown = async () => {
    try { await navigator.clipboard.writeText(markdown); setNotice('Markdown copied'); }
    catch { setNotice('Copy failed'); }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(location.href); setNotice('Link copied'); }
    catch { setNotice('Copy failed'); }
  };
  const shareArtifact = async () => {
    const url = location.href;
    if (navigator.share) { try { await navigator.share({ title: s.article.title, url }); } catch {} }
    else { try { await navigator.clipboard.writeText(url); setNotice('Link copied'); } catch {} }
  };
  const toggleClosed = async () => {
    setWorkErr('');
    try {
      await api(`/artifacts/${encodeURIComponent(id)}/close`, {
        method: 'POST',
        body: JSON.stringify({ closed: !s.article.closed_at }),
      });
      qc.invalidateQueries({ queryKey: ['artifact', id] });
      qc.invalidateQueries({ queryKey: ['artifacts'] });
    } catch (e: any) {
      setWorkErr(`Could not ${s.article.closed_at ? 'reopen' : 'close'}: ${e.message}`);
    }
  };
  const artifactActions = [
    { label: s.article.closed_at ? 'Reopen artifact' : 'Close artifact', run: toggleClosed },
    { label: 'Work on this artifact', run: () => workOnThis(s.article.title, markdown) },
    { label: 'Copy link', run: copyLink },
    { label: 'Share', run: shareArtifact },
    { label: 'Download', run: downloadMarkdown },
  ];
  const candidates = (s as any).mastheadCandidates || [];
  const tray = [...(s.images || []), ...candidates];
  const elapsed = active ? Math.max(0, Math.round((now - +new Date(active.claimed_at || active.created_at || now)) / 1000)) : 0;
  const statusView = (() => {
    if (active && !TERMINAL.includes(active.status)) {
      if (active.status === 'pending') return { cls: 'working', text: 'Queued — waiting for pickup', timing: '' };
      if (active.status === 'claimed') return { cls: 'working', text: 'Agent starting…', timing: '' };
      if (active.status === 'working') return { cls: 'working', text: `Working on V${currentNumber}`, timing: `${elapsed}s` };
      return { cls: '', text: 'Submitted — waiting for pickup', timing: '' };
    }
    if (lastAction?.status === 'stale') return { cls: 'working', text: 'Retrying…', timing: '' };
    if (lastAction?.status === 'failed') return { cls: 'failed', text: 'Failed', timing: '' };
    return { cls: 'ready', text: 'Ready', timing: '' };
  })();

  return <div className="artifact-page">
    <header className="top"><div className="top-in">
      <div className="brandrow"><Link to="/" aria-label="Orbit home"><svg className="mark" viewBox="0 0 34 24" fill="none" aria-hidden="true"><ellipse cx="17" cy="12" rx="15" ry="6.4" stroke="#6D35C5" strokeWidth="1.5" transform="rotate(-18 17 12)"/><ellipse cx="17" cy="12" rx="10.5" ry="10" stroke="#72D7B8" strokeWidth="1.3"/><circle cx="17" cy="12" r="2.4" fill="#171619"/></svg></Link><span className="word">Orbit</span><NavMenu className="navmenu-mobile" actions={artifactActions} back={{ to: backTo, label: backLabel }} /><span className="private">Private</span></div>
      <div className="crumbs"><Link to="/artifacts">Artifacts</Link><span>/</span><b>{s.article.closed_at ? 'Closed' : 'Drafts'}</b>{s.article.closed_at && <span className="closed-pill">Closed</span>}</div>
      <div className="toolrow">
        <span className="revpill"><span>V{selected?.number || currentNumber}</span><span className="upd">· {fmtDate(selected?.created_at)}</span></span>
        <span className="spacer" />
        <select className="select" value={revId} onChange={(e) => { setSelectedRevId(e.target.value); setMode('read'); }}>
          {[...revisions].reverse().map((r) => <option key={r.id} value={r.id}>V{r.number}{r.id === currentId ? ' · current' : ''}</option>)}
        </select>
        <button className="iconbtn" type="button" title="Download Markdown" aria-label="Download Markdown" onClick={downloadMarkdown}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg></button>
        <button className="iconbtn" type="button" title="Share" aria-label="Share" onClick={shareArtifact}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 15V4m0 0 4 4m-4-4L8 8M5 13v6h14v-6"/></svg></button>
        <button className="iconbtn" type="button" title="Copy Markdown" aria-label="Copy Markdown" onClick={copyMarkdown}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/></svg></button>
        <button className="work-on" type="button" title="Work on this" onClick={() => workOnThis(s.article.title, markdown)} disabled={workBusy}>{workBusy ? 'Starting…' : 'Work on this'}</button>
        {workErr && <span className="work-err">{workErr}</span>}
        <NavMenu className="navmenu-desktop" actions={artifactActions} back={{ to: backTo, label: backLabel }} />
      </div>
    </div></header>

    <main className="wrap">
      <h1 id="title">{s.article.title}</h1>
      <div className="metarow"><span className="chip">V{selected?.number || currentNumber}</span>
        <span>{fmtDateTime(selected?.created_at)}</span><span>{wordCount.toLocaleString()} words</span></div>
      {s.masthead && <figure className={`mhead${mastheadOpen ? ' open' : ''}`}>
        <button className="mhead-toggle" type="button" onClick={() => setMastheadOpen((v) => !v)} aria-expanded={mastheadOpen} aria-label={mastheadOpen ? 'Collapse masthead' : 'Expand masthead'}>
          <img src={`/api/v1/images/${s.masthead.id}`} alt="Masthead" />
        </button>
        <figcaption><span className="mh-label">Current masthead</span>
          <span className="mh-meta">· {s.masthead.provider ? `generated with ${s.masthead.provider}` : s.masthead.filename}</span>
          <span className="spacer" />
          <button className="mh-btn" type="button" onClick={() => { setUploadMasthead(true); fileRef.current?.click(); }}>Replace</button>
          <a className="mh-btn" href={`/api/v1/images/${s.masthead.id}`} target="_blank" rel="noreferrer">View image</a>
        </figcaption>
      </figure>}
      {fm.length > 0 && <details className="front"><summary>Front matter</summary><div className="fm"><dl>
        {fm.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl></div></details>}
      <div className="modebar"><div className="modes">
        <button className={`mode${mode === 'read' ? ' on' : ''}`} onClick={() => setMode('read')} aria-selected={mode === 'read'}>Read</button>
        <button className={`mode${mode === 'diff' ? ' on' : ''}`} onClick={() => setMode('diff')} aria-selected={mode === 'diff'} disabled={!prevRev}>Diff</button>
        <button className={`mode${mode === 'critique' ? ' on' : ''}`} onClick={() => setMode('critique')} aria-selected={mode === 'critique'}>Critique</button>
      </div><span className="diffmeta">{mode === 'diff' && selected ? `V${selected.number - 1} → V${selected.number}` : ''}</span></div>
      <article id="article">
        {mode === 'read' && (revQuery.isLoading ? <p className="empty">Loading revision…</p> : <Markdown body={markdown} />)}
        {mode === 'diff' && <DiffView prev={prevQuery.data?.content || ''} cur={markdown} />}
        {mode === 'critique' && <Critique markdown={markdown} review={reviewQuery.data?.review} loading={reviewQuery.isLoading} onSaved={() => qc.invalidateQueries({ queryKey: ['review', reviewSummary?.id] })} />}
      </article>
    </main>

    <section ref={sheetRef} className={`sheet ${panelMode}`} data-open={sheetOpen ? 'true' : 'false'} data-mode={panelMode} aria-label="Conversation">
      <div className="sheet-head" data-mode={panelMode}>
        <span className="grab" />
        <span className="sheet-title">Conversation ({(s.events || []).length})</span>
        <div className="sheet-controls" role="group" aria-label="Conversation panel size">
          <button type="button" className="sheet-arrow" onClick={expandPanel} disabled={panelMode === 'max'} aria-label="Expand conversation" title="Expand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 15 6-6 6 6"/></svg>
          </button>
          <button type="button" className="sheet-arrow" onClick={minimizePanel} disabled={panelMode === 'min'} aria-label="Minimize conversation" title="Minimize">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
          </button>
        </div>
        {lastAction?.status === 'completed' && <span className="sheet-cta show">V{currentNumber} ready</span>}
      </div>
      <div className="sheet-list">
        {(s.events || []).map((e) => <div className="msg" key={e.id}><div className="who">{e.role}</div><div className="body">{e.text}</div></div>)}
        {active && <div className={`msg ${active.status}`}><div className="who">{active.status}</div><div className="body">{active.reply || active.error || 'Working…'}</div></div>}
      </div>
    </section>

    <div className="composer"><div className="composer-in">
      <div className="statusline"><span className={`dot ${statusView.cls}`} /><span>{statusView.text}</span><span className="spacer" /><span className="timing">{statusView.timing}</span>{notice && <span>{notice}</span>}</div>
      {active && TERMINAL.includes(active.status) && active.status === 'failed' && <div className="actionbar">
        <span className="actionbar-text">Failed: {active.error || 'unknown error'}</span>
        <button className="actionbar-btn" type="button" onClick={() => send(true)}>Retry</button>
        <button className="actionbar-btn ghost" type="button" onClick={() => { setDismissedActionId(active.id); setLastAction(null); }}>Dismiss</button></div>}
      {trayOpen && <div className={`tray${tray.length ? ' show' : ''}`}>
        {tray.map((a) => {
          const isMasthead = a.role === 'masthead';
          const isCurrent = s.masthead?.id === a.id;
          return <div key={a.id} className={`thumb${!isMasthead && a.include_flag === 0 ? ' off' : ''}`} title={a.filename}>
            <div className="thumb-media">
              <img src={`/api/v1/images/${a.id}`} alt={a.filename} />
              <button type="button" className="thumb-remove" onClick={() => removeAsset(a)} aria-label="Remove image">×</button>
            </div>
            <small>{a.filename}</small>
            <div className="thumb-actions">
              {isMasthead ? (isCurrent
                ? <span className="thumb-badge current">Current masthead</span>
                : <button type="button" className="thumb-action" onClick={() => useMasthead(a)}>Set as masthead</button>)
                : <label className="thumb-include"><input type="checkbox" checked={a.include_flag !== 0}
                    onChange={() => toggleAsset(a)} /> Include in article</label>}
            </div>
            {!isMasthead && a.include_flag === 0 && <span className="thumb-badge muted">Reference only</span>}
          </div>;
        })}
      </div>}
      <div className="inputrow">
        <button className="plus" type="button" title="Attach image" onClick={() => { setUploadMasthead(false); fileRef.current?.click(); }}>+</button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => upload(e.target.files)} />
        <textarea rows={1} placeholder={`Feedback on V${currentNumber}…`} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }} disabled={!!s.article.closed_at} />
        <button className="send" type="button" aria-label="Send feedback" onClick={() => send()} disabled={busy || !!s.article.closed_at || (!text.trim() && !workflow)}>→</button>
      </div>
      <div className="subrow">
        <select className="wf" value={workflow} onChange={(e) => setWorkflow(e.target.value)} disabled={!!s.article.closed_at}>
          {WORKFLOWS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <span className={`wfchip${workflow && workflow !== 'blog-author' ? ' show' : ''}`}>{workflow ? `runs ${workflow}` : ''}</span>
        <span className="spacer" />
        <button type="button" className="tray-toggle" onClick={() => setTrayOpen((v) => !v)} aria-expanded={trayOpen}>
          {tray.length} image{tray.length === 1 ? '' : 's'} · {tray.filter((a) => a.include_flag).length} included
        </button>
      </div>
    </div>
      <nav className="nav" aria-label="Orbit">
        <NavLink to="/" end><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 10.5 12 4l8 6.5V20H14v-6h-4v6H4z"/></svg>Feed</NavLink>
        <NavLink to="/inbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6.5h16v11H4z"/><path d="M4 13h4l1.5 2h5L16 13h4"/></svg>Inbox</NavLink>
        <NavLink to="/artifacts"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>Artifacts</NavLink>
        <NavLink to="/work"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 7h14M5 12h9M5 17h11"/><circle cx="3" cy="7" r=".8"/><circle cx="3" cy="12" r=".8"/><circle cx="3" cy="17" r=".8"/></svg>Work</NavLink>
      </nav>
    </div>
  </div>;
}
