import React from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const LOGO = '/icon.png';

export default function AdminLayout() {
  const { logout } = useAuth();

  return (
    <div className="admin-layout">
      <header className="header">
        <div className="header-left">
          <img src={LOGO} alt="Daily Reps" className="header-logo" />
          <div className="header-title"><span>Daily Reps</span> Coach</div>
        </div>
        <button className="header-logout" onClick={logout}>Log out</button>
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
      <Outlet />
    </div>
  );
}
