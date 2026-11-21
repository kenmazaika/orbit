import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import NavMenu from '../components/NavMenu';

type Tab = 'account' | 'workspaces' | 'keys' | 'connections';
const TABS: { id: Tab; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'keys', label: 'API keys' },
  { id: 'connections', label: 'Connections' },
];

const fmt = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function Settings() {
  const [tab, setTab] = React.useState<Tab>(() => (location.hash.replace('#', '') as Tab) || 'account');
  React.useEffect(() => { history.replaceState(null, '', `#${tab}`); }, [tab]);
  return <div className="set-wrap">
    <header className="set-head">
      <h1>Settings</h1>
      <NavMenu />
    </header>
    <nav className="set-tabs" aria-label="Settings sections">
      {TABS.map((t) => <button key={t.id} type="button" className={tab === t.id ? 'on' : ''}
        aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
    </nav>
    {tab === 'account' && <Account />}
    {tab === 'workspaces' && <Workspaces />}
    {tab === 'keys' && <Keys />}
    {tab === 'connections' && <Connections />}
  </div>;
}

function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api('/auth/me') as Promise<any>, retry: 1 });
}

function Account() {
  const me = useMe();
  if (me.isLoading) return <p className="set-empty">Loading…</p>;
  if (me.error) return <p className="set-empty">This build has no account API — self-hosted installs use the password gate.</p>;
  const u = me.data?.user || {};
  return <section className="set-sec">
    <h2>Signed in</h2>
    <dl className="set-kv">
      <dt>Name</dt><dd>{u.name || '—'}</dd>
      <dt>Email</dt><dd>{u.email}</dd>
    </dl>
    <p className="set-note">Sessions are HttpOnly cookies; signing out revokes this session server-side.</p>
    <form method="post" action="/__cloud/logout"><button className="set-btn" type="submit">Sign out</button></form>
  </section>;
}

function Workspaces() {
  const qc = useQueryClient();
  const me = useMe();
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const ws = me.data?.workspaces || [];
  const active = me.data?.activeWorkspaceId;
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await api('/workspaces', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); setName(''); qc.invalidateQueries({ queryKey: ['me'] }); }
    finally { setBusy(false); }
  };
  return <section className="set-sec">
    <h2>Your workspaces</h2>
    <ul className="set-list">{ws.map((w: any) => <li key={w.id}>
      <div><b>{w.name}</b><span className="set-meta">{w.role} · {w.id}</span></div>
      {w.id === active ? <span className="set-chip">Current</span>
        : <button className="set-btn ghost small" type="button" onClick={async () => {
            await api(`/workspaces/${w.id}/switch`, { method: 'POST', body: '{}' });
            window.location.reload();
          }}>Use</button>}
    </li>)}</ul>
    <p className="set-note">Removing a member disconnects their personal agent keys and signs out that workspace. Shared service connections keep running.</p>
    <div className="set-row">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New workspace name" />
      <button className="set-btn" type="button" onClick={create} disabled={busy || !name.trim()}>Create</button>
    </div>
  </section>;
}

function Keys() {
  const qc = useQueryClient();
  const me = useMe();
  const role = (me.data?.workspaces || []).find((w: any) => w.id === me.data?.activeWorkspaceId)?.role;
  const isAdmin = role === 'owner' || role === 'admin';
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => api('/keys') as Promise<any>, retry: 1 });
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<'runner' | 'integration'>('runner');
  const [scopes, setScopes] = React.useState<string[]>(['agent:run']);
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const opts = kind === 'runner' ? ['agent:run', 'objects:read'] : ['inbox:write', 'artifacts:write', 'work:write', 'objects:read'];
  const toggle = (s: string) => setScopes((p) => p.includes(s) ? p.filter((x) => x !== s) : [...p, s]);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setToken('');
    try {
      const res: any = await api('/keys', { method: 'POST', body: JSON.stringify({ name: name.trim(), kind, scopes }) });
      setToken(res.token); setName(''); qc.invalidateQueries({ queryKey: ['keys'] }); qc.invalidateQueries({ queryKey: ['connections'] });
    } finally { setBusy(false); }
  };
  const act = async (id: string, what: 'revoke' | 'rotate') => {
    const res: any = await api(`/keys/${id}/${what}`, { method: 'POST', body: '{}' });
    if (res?.token) setToken(res.token);
    qc.invalidateQueries({ queryKey: ['keys'] });
  };
  if (keys.error) return <p className="set-empty">No key API on this build.</p>;
  return <section className="set-sec">
    <h2>Create a key</h2>
    <div className="set-row">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name — e.g. OpenClaw" />
      <select value={kind} onChange={(e) => { const k = e.target.value as any; setKind(k); setScopes(k === 'runner' ? ['agent:run'] : ['inbox:write']); }}>
        <option value="runner">Runner</option><option value="integration">Integration</option>
      </select>
    </div>
    <div className="set-scopes">{opts.map((s) => <label key={s}>
      <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} /> <code>{s}</code></label>)}</div>
    <button className="set-btn" type="button" onClick={create} disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create key'}</button>
    {token && <div className="set-once">
      <b>Copy this now — it is shown once.</b>
      <code>{token}</code>
      <button type="button" className="set-btn ghost" onClick={() => navigator.clipboard?.writeText(token)}>Copy</button>
    </div>}
    <h2>Existing keys</h2>
    {keys.isLoading ? <p className="set-empty">Loading…</p> : (keys.data?.keys || []).length === 0 ? <p className="set-empty">No keys yet.</p> :
      <ul className="set-list">{keys.data.keys.map((k: any) => <li key={k.id}>
        <div>
          <b>{k.name}</b>
          <span className="set-meta">
            {k.ownership === 'workspace' ? 'Workspace service connection' : `Personal${k.owner_email ? ` · ${k.owner_email}` : ''}`}
            {' · '}{k.kind} · {k.prefix}… · created {fmt(k.created_at)}{k.last_used_at ? ` · used ${fmt(k.last_used_at)}` : ''}
          </span>
          <span className="set-meta">{k.scopes}</span>
        </div>
        <div className="set-actions">
          {k.revoked_at ? <span className="set-chip off">revoked</span> : <>
            {isAdmin && k.ownership !== 'workspace' && <button type="button" title="Keeps working if the creator leaves"
              onClick={async () => { await api(`/keys/${k.id}/transfer`, { method: 'POST', body: JSON.stringify({ ownership: 'workspace' }) }); qc.invalidateQueries({ queryKey: ['keys'] }); }}>Make shared</button>}
            <button type="button" onClick={() => act(k.id, 'rotate')}>Rotate</button>
            <button type="button" className="danger" onClick={() => act(k.id, 'revoke')}>Revoke</button></>}
        </div>
      </li>)}</ul>}
  </section>;
}

function Connections() {
  const qc = useQueryClient();
  const conns = useQuery({ queryKey: ['connections'], queryFn: () => api('/connections') as Promise<any>, retry: 1, refetchInterval: 15000 });
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const res: any = await api('/keys', { method: 'POST', body: JSON.stringify({ name: 'OpenClaw runner', kind: 'runner' }) });
      setToken(res.token); qc.invalidateQueries({ queryKey: ['connections'] });
    } finally { setBusy(false); }
  };
  const list = conns.data?.connections || [];
  return <section className="set-sec">
    <h2>Connect an agent</h2>
    <p className="set-note">Create a runner key, then point your OpenClaw install at this workspace. The bridge polls, claims, and completes actions — no inbound ports.</p>
    <button className="set-btn" type="button" onClick={connect} disabled={busy}>{busy ? 'Creating…' : 'Create runner key'}</button>
    {token && <div className="set-once">
      <b>Setup — run once, then keep the key secret.</b>
      <pre>{`export ORBIT_BASE=${window.location.origin}\nexport ORBIT_ARTIFACT_BRIDGE_TOKEN=${token}\nnode bin/orbit-bridge.mjs`}</pre>
      <button type="button" className="set-btn ghost" onClick={() => navigator.clipboard?.writeText(token)}>Copy key</button>
    </div>}
    <h2>Status</h2>
    {conns.isLoading ? <p className="set-empty">Loading…</p> : list.length === 0 ? <p className="set-empty">No runner keys yet.</p> :
      <ul className="set-list">{list.map((c: any) => <li key={c.id}>
        <div><b>{c.name}</b><span className="set-meta">{c.prefix}… · last activity {c.lastUsedAt ? fmt(c.lastUsedAt) : 'never'}</span></div>
        <span className={`set-chip ${c.status === 'connected' ? 'ok' : c.status === 'revoked' ? 'off' : ''}`}>{c.status.replace(/_/g, ' ')}</span>
      </li>)}</ul>}
  </section>;
}
