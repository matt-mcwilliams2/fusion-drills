import React from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const LOGO = '/dailyreps3.png';

export default function AdminLayout() {
  const { logout, teams, activeTeamId, activeTeam, setActiveTeam } = useAuth();

  return (
    <div className="admin-layout">
      <header className="header">
        <div className="header-left">
          <img src={LOGO} alt="Daily Reps" className="header-logo" />
          <div className="header-title">
            <span>Daily Reps</span> Coach
            {activeTeam && (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: 6 }}>
                {activeTeam.name}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {teams.length > 1 && (
            <select
              value={activeTeamId || ''}
              onChange={(e) => setActiveTeam(e.target.value)}
              style={{
                background: 'var(--card-bg)',
                color: 'var(--white)',
                border: '1px solid var(--card-border)',
                borderRadius: 8,
                padding: '6px 8px',
                fontSize: '0.8rem',
                fontFamily: 'inherit',
                outline: 'none',
              }}
            >
              {teams.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          <button className="header-logout" onClick={logout}>Log out</button>
        </div>
      </header>
      <nav className="admin-nav">
        <NavLink to="/admin" end className={({ isActive }) => `admin-nav-item ${isActive ? 'active' : ''}`}>
          Roster
        </NavLink>
        <NavLink to="/admin/drills" className={({ isActive }) => `admin-nav-item ${isActive ? 'active' : ''}`}>
          Drills
        </NavLink>
        <NavLink to="/admin/seasons" className={({ isActive }) => `admin-nav-item ${isActive ? 'active' : ''}`}>
          Challenges
        </NavLink>
        <NavLink to="/admin/leaderboard" className={({ isActive }) => `admin-nav-item ${isActive ? 'active' : ''}`}>
          Leaderboard
        </NavLink>
        <NavLink to="/admin/invite" className={({ isActive }) => `admin-nav-item ${isActive ? 'active' : ''}`}>
          Invite Coach
        </NavLink>
      </nav>
      {activeTeam && activeTeam.join_code && (
        <div style={{
          background: 'var(--card-bg)',
          borderBottom: '1px solid var(--card-border)',
          padding: '8px 16px',
          fontSize: '0.8rem',
          color: 'var(--text-muted)',
          textAlign: 'center',
        }}>
          Player join link: <a href={`${window.location.origin}/t/${activeTeam.join_code}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--orange)', fontWeight: 700 }}>{window.location.origin}/t/{activeTeam.join_code}</a>
        </div>
      )}
      <Outlet />
    </div>
  );
}
