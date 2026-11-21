import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export default function Welcome() {
  const nav = useNavigate();
  const [agent, setAgent] = React.useState<'OpenClaw' | 'Hermes'>('OpenClaw');
  const [instruction, setInstruction] = React.useState('');
  const [expires, setExpires] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [copied, setCopied] = React.useState(false);

  const ob = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api('/onboarding') as Promise<any>,
    refetchInterval: 5000,
    retry: 1,
  });
  const connected = !!ob.data?.connected;

  const generate = async () => {
    setBusy(true); setErr(''); setCopied(false);
    try {
      const res: any = await api('/pairings', { method: 'POST', body: JSON.stringify({ runner: agent }) });
      setInstruction(res.instruction); setExpires(res.expiresAt);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(instruction);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  const skip = async () => {
    try { await api('/onboarding/skip', { method: 'POST', body: '{}' }); } catch {}
    nav('/');
  };

  return <div className="wel-wrap">
    <div className="wel-card">
      <p className="wel-kicker">Orbit Cloud</p>
      <h1>{connected ? 'Your agent is connected.' : 'Welcome to Orbit.'}</h1>
      {connected ? <>
        <p className="wel-sub">Orbit is a shared workspace where you and your AI agent plan, write, and finish work together.</p>
        <ul className="wel-list">
          {(ob.data?.runners || []).map((r: any) => <li key={r.id}><b>{r.name}</b><span>{r.lastUsedAt ? `last active ${new Date(r.lastUsedAt).toLocaleString()}` : 'connected'}</span></li>)}
        </ul>
        <button className="wel-btn" type="button" onClick={() => nav('/')}>Enter Orbit</button>
      </> : <>
        <p className="wel-sub">Your personal workspace is ready. Connect your agent once, then start working.</p>
        <div className="wel-pick" role="group" aria-label="Agent">
          {(['OpenClaw', 'Hermes'] as const).map((a) => <button key={a} type="button" className={agent === a ? 'on' : ''} onClick={() => setAgent(a)}>{a}</button>)}
        </div>
        {!instruction ? <button className="wel-btn" type="button" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate setup instruction'}</button>
          : <>
            <p className="wel-note">Paste this into your {agent} conversation. It expires at {new Date(expires).toLocaleTimeString()}.</p>
            <pre className="wel-pre">{instruction}</pre>
            <div className="wel-row">
              <button className="wel-btn" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy instruction'}</button>
              <button className="wel-btn ghost" type="button" onClick={generate} disabled={busy}>New code</button>
            </div>
            <p className="wel-status"><span className={connected ? 'dot ok' : 'dot'} />{connected ? 'Connected' : 'Waiting for your agent to connect…'}</p>
          </>}
        {err && <p className="wel-err">{err}</p>}
        <button className="wel-skip" type="button" onClick={skip}>Skip for now</button>
      </>}
    </div>
  </div>;
}
