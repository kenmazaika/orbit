import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ArtifactRow } from '../api';
import { fmtDate } from '../lib';

export default function Artifacts() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') === 'closed' ? 'closed' : 'open') as 'open' | 'closed';
  const setTab = (next: 'open' | 'closed') => {
    const p = new URLSearchParams(params);
    next === 'closed' ? p.set('tab', 'closed') : p.delete('tab');
    setParams(p, { replace: true });
  };
  const { data, isLoading } = useQuery({ queryKey: ['artifacts'], queryFn: () => api('/artifacts') });
  const rows: ArtifactRow[] = data?.artifacts || [];
  const shown = rows.filter((a) => tab === 'open' ? !a.closed_at : !!a.closed_at);
  const create = async () => {
    if (!title.trim() || creating) return;
    setCreating(true); setErr('');
    try {
      // The working primitive is the Objects API; no parallel /artifacts create route.
      const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
        + '-' + Math.random().toString(36).slice(2, 6);
      await api('/objects', { method: 'POST', body: JSON.stringify({
        kind: 'orbit.artifact', title: title.trim(), externalId: slug, data: {},
      }) });
      setTitle('');
      qc.invalidateQueries({ queryKey: ['artifacts'] });
      nav(`/artifacts/${slug}`);
    } catch (e: any) { setErr(e.message); } finally { setCreating(false); }
  };

  return <div className="awrap"><div className="ahead"><h1>Artifacts</h1>
    <p>Drafts you can read, review, and revise. Feedback starts a revision; close one when it ships.</p></div>
    <div className="anew">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New artifact title"
        onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
      <button type="button" onClick={create} disabled={creating || !title.trim()}>{creating ? 'Creating…' : 'Create'}</button>
    </div>
    {err && <p className="aerror">{err}</p>}
    <div className="atabs"><button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Open</button>
      <button className={tab === 'closed' ? 'on' : ''} onClick={() => setTab('closed')}>Closed</button></div>
    <div className="alist">{isLoading ? <p className="aempty">Loading…</p> : shown.length === 0 ? <p className="aempty">No {tab} artifacts.</p> :
      shown.map((a) => <article className="acard" key={a.id}><Link className="amain" to={`/artifacts/${a.id}`} state={{ from: `/artifacts${tab === 'closed' ? '?tab=closed' : ''}`, scroll: window.scrollY }}>
        <span className="atitle">{a.title}</span><span className="ameta"><span className="achip">V{a.current_number || 1}</span>
          <span>{fmtDate(a.updated_at)}</span></span></Link></article>)}</div></div>;
}
