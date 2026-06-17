import React from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const LOGO = 'https://cdn3.sportngin.com/attachments/logo_graphic/d91e-173552562/Fusion_Badgex2_medium.png';

export default function PlayerLayout() {
  const { logout } = useAuth();

  return (
    <div className="app-layout">
      <header className="header">
        <div className="header-left">
          <img src={LOGO} alt="Fusion FC" className="header-logo" />
          <div className="header-title"><span>Fusion FC</span> Training</div>
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
