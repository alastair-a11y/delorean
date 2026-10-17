import { NavLink, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import Chat from './pages/Chat.tsx';
import Schedule from './pages/Schedule.tsx';
import Jobs from './pages/Jobs.tsx';
import Job from './pages/Job.tsx';
import Inbox from './pages/Inbox.tsx';
import People from './pages/People.tsx';
import Money from './pages/Money.tsx';
import Settings from './pages/Settings.tsx';

export default function App() {
  const [counts, setCounts] = useState<{ pending_intakes: number; unanswered_nudges: number } | null>(null);
  useEffect(() => {
    const load = () => api.get('/reports/today').then(setCounts).catch(() => undefined);
    load(); const t = setInterval(load, 30000); return () => clearInterval(t);
  }, []);
  const inboxBadge = (counts?.pending_intakes ?? 0) + (counts?.unanswered_nudges ?? 0);
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">⚡ DeLorean</div>
        <NavLink to="/" end>Ask</NavLink>
        <NavLink to="/schedule">Schedule</NavLink>
        <NavLink to="/jobs">Jobs</NavLink>
        <NavLink to="/inbox">Inbox {inboxBadge > 0 && <span className="pill warn">{inboxBadge}</span>}</NavLink>
        <NavLink to="/people">People & rooms</NavLink>
        <NavLink to="/money">Money</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <div className="foot">Type what you need. DeLorean books it, quotes it, and chases the hours.</div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Chat />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/jobs/:id" element={<Job />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/inbox/:id" element={<Inbox />} />
          <Route path="/people" element={<People />} />
          <Route path="/money" element={<Money />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
