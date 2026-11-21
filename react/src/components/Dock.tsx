import React from 'react';
import { NavLink } from 'react-router-dom';

export default function Dock() {
  return (
    <nav className="dock dock-standard" aria-label="Orbit">
      <div className="dock-in">
        <NavLink to="/" end>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/></svg>
          <span>Feed</span>
        </NavLink>
        <NavLink to="/inbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 6.5h16v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><path d="M4 13h4l1.5 2h5L16 13h4"/></svg>
          <span>Inbox</span>
        </NavLink>
        <NavLink to="/artifacts">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>
          <span>Artifacts</span>
        </NavLink>
        <NavLink to="/work">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 7h14M5 12h9M5 17h11"/><circle cx="3" cy="7" r=".8"/><circle cx="3" cy="12" r=".8"/><circle cx="3" cy="17" r=".8"/></svg>
          <span>Work</span>
        </NavLink>
      </div>
    </nav>
  );
}
