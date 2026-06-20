import React, { useEffect } from 'react';
import { Outlet, NavLink, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const LOGO = '/dailyreps3.png';

export default function PlayerLayout() {
  const { logout, teamInfo } = useAuth();
  const { joinCode } = useParams();
  const basePath = `/t/${joinCode}`;

  // Update manifest link for team-scoped PWA
  useEffect(() => {
    if (joinCode) {
      const manifestLink = document.querySelector('link[rel="manifest"]');
      if (manifestLink) {
        manifestLink.href = `/t/${joinCode}/manifest.json`;
      }
    }
  }, [joinCode]);

  const teamColor = teamInfo?.primary_color || '#f77c00';

  return (
    <div className="app-layout">
      <header className="header">
        <div className="header-left">
          <img src={LOGO} alt="Daily Reps" className="header-logo" />
          <div className="header-title">
            <span style={{ color: teamColor }}>{teamInfo?.name || 'Daily Reps'}</span>
            {' '}Training
          </div>
        </div>
        <button className="header-logout" onClick={logout}>Log out</button>
      </header>
      <Outlet />
      <nav className="bottom-nav">
        <NavLink to={basePath} end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">{'\u26BD'}</span>
          Today
        </NavLink>
        <NavLink to={`${basePath}/leaderboard`} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">{'\uD83C\uDFC6'}</span>
          Leaderboard
        </NavLink>
        <NavLink to={`${basePath}/me`} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">{'\uD83D\uDC64'}</span>
          Me
        </NavLink>
      </nav>
    </div>
  );
}
