import React from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import Feed from './pages/Content';
import { Archive, NotePage, ReportPage, Saved } from './pages/Content';
import Artifacts from './pages/Artifacts';
import ArtifactDetail from './pages/ArtifactDetail';
import Inbox from './pages/Inbox';
import WorkThread, { WorkList } from './pages/Work';
import Settings from './pages/Settings';
import Welcome from './pages/Welcome';
import Dock from './components/Dock';
import NavMenu from './components/NavMenu';

function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const on = (p: string) => p === '/' ? pathname === '/' : pathname.startsWith(p);
  return (
    <>
      <header className="masthead"><div className="masthead-in">
        <Link className="brand" to="/" aria-label="Orbit home">
          <svg className="brand-mark" viewBox="0 0 34 24" fill="none" aria-hidden="true">
            <ellipse cx="17" cy="12" rx="15" ry="6.4" stroke="#6D35C5" strokeWidth="1.5" transform="rotate(-18 17 12)" />
            <ellipse cx="17" cy="12" rx="10.5" ry="10" stroke="#72D7B8" strokeWidth="1.3" />
            <circle cx="17" cy="12" r="2.4" fill="#171619" />
          </svg>
          <span className="brand-word">Orbit</span>
        </Link>
        <NavMenu />
        <span className="private-pill">Private</span>
      </div></header>
      <main>{children}</main>
      <Dock />
      <span data-route={on('/') ? 'home' : 'other'} hidden />
    </>
  );
}

export default function App() {
  const { pathname } = useLocation();
  if (/^\/artifacts\/[^/]+\/?$/.test(pathname)) return (
    <Routes><Route path="/artifacts/:id" element={<ArtifactDetail />} /></Routes>
  );
  if (/^\/work\/[^/]+\/?$/.test(pathname)) return (
    <Routes><Route path="/work/:id" element={<WorkThread />} /></Routes>
  );
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Feed />} />
        <Route path="/archive" element={<Archive />} />
        <Route path="/saved" element={<Saved />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/report/:slug" element={<ReportPage />} />
        <Route path="/notes/:slug" element={<NotePage />} />
        <Route path="/artifacts" element={<Artifacts />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/work" element={<WorkList />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/welcome" element={<Welcome />} />
        <Route path="*" element={<p className="empty">Not found.</p>} />
      </Routes>
    </Layout>
  );
}
