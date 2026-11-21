import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';

const LINKS: { to: string; label: string; end?: boolean }[] = [
  { to: '/saved', label: 'Saved' },
  { to: '/settings', label: 'Settings' },
];

export type NavMenuAction = { label: string; run: () => void | Promise<void> };
export type NavMenuBack = { to: string; label: string };

export default function NavMenu({ actions = [], back, className = '' }: { actions?: NavMenuAction[]; back?: NavMenuBack; className?: string } = {}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  const loc = useLocation();
  React.useEffect(() => { setOpen(false); }, [loc.pathname]);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return <div className={`navmenu ${className}`.trim()} ref={ref}>
    <button className="navmenu-btn" type="button" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
    {open && <div className="navmenu-panel" role="menu">
      {actions.length > 0 && <>
        <div className="navmenu-section">Artifact actions</div>
        {actions.map((a) => <button key={a.label} className="navmenu-action" type="button" role="menuitem"
          onClick={async () => { setOpen(false); await a.run(); }}>{a.label}</button>)}
        <div className="navmenu-section">Navigation</div>
      </>}
      {!actions.length && back && <div className="navmenu-section">Navigation</div>}
      {back && <NavLink to={back.to} className="navmenu-link" role="menuitem">{back.label}</NavLink>}
      {LINKS.map((l) => <NavLink key={l.to} to={l.to} end={l.end} className="navmenu-link" role="menuitem">{l.label}</NavLink>)}
      <form method="post" action="/__orbit/logout">
        <button className="navmenu-logout" type="submit" role="menuitem">Lock Orbit</button>
      </form>
    </div>}
  </div>;
}
