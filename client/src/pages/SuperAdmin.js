import React from 'react';
import { useAuth } from '../context/AuthContext';

const LOGO = '/daily-reps.png';

export default function SuperAdmin() {
  const { user, logout } = useAuth();

  return (
    <div className="admin-layout">
      <header className="header">
        <div className="header-left">
          <img src={LOGO} alt="Daily Reps" className="header-logo" />
          <div className="header-title"><span>Daily Reps</span> Super Admin</div>
        </div>
        <button className="header-logout" onClick={logout}>Log out</button>
      </header>
      <div className="admin-page" style={{ textAlign: 'center', paddingTop: 60 }}>
        <h1 className="page-title">Super Admin Dashboard</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
          Coming in Build 6
        </p>
        <div className="card" style={{ textAlign: 'left' }}>
          <div style={{ marginBottom: 8 }}><strong>Logged in as:</strong></div>
          <div>{user?.first_name} {user?.last_name}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{user?.email}</div>
          <div style={{ color: 'var(--orange)', fontSize: '0.85rem', marginTop: 4 }}>Role: {user?.role}</div>
        </div>
      </div>
    </div>
  );
}
