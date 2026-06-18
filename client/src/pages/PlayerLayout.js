import React from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const LOGO = '/icon.png';

export default function PlayerLayout() {
  const { logout } = useAuth();

  return (
    <div className="app-layout">
      <header className="header">
        <div className="header-left">
          <img src={LOGO} alt="Daily Reps" className="header-logo" />
          <div className="header-title"><span>Daily Reps</span> Training</div>
        </div>
        <button className="header-logout" onClick={logout}>Log out</button>
      </header>
      <Outlet />
      <nav className="bottom-nav">
        <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">⚽</span>
          Today
        </NavLink>
        <NavLink to="/leaderboard" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">🏆</span>
          Leaderboard
        </NavLink>
        <NavLink to="/me" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">👤</span>
          Me
        </NavLink>
      </nav>
    </div>
  );
}
