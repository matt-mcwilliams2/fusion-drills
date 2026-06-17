import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

export default function Me() {
  const { apiFetch, user } = useAuth();
  const [stats, setStats] = useState(null);
  const [badges, setBadges] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/me/stats'),
      apiFetch('/api/me/badges'),
    ])
      .then(([statsData, badgesData]) => {
        setStats(statsData);
        setBadges(badgesData.badges || []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [apiFetch]);

  if (loading) {
    return <div className="page"><div className="loading"><div className="spinner" /></div></div>;
  }

  return (
    <div className="page">
      <h1 className="page-title">
        {user.first_name} {user.last_name}
      </h1>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats?.current_streak || 0}</div>
          <div className="stat-label">Current Streak</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats?.longest_streak || 0}</div>
          <div className="stat-label">Longest Streak</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats?.total_completions || 0}</div>
          <div className="stat-label">Completions</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats?.total_points || 0}</div>
          <div className="stat-label">Total Points</div>
        </div>
      </div>

      <h2 className="page-title">Badges</h2>
      <div className="badge-shelf">
        {badges.map((b) => (
          <div key={b.id} className={`badge-item ${b.earned_at ? 'earned' : 'unearned'}`}>
            <div className="badge-emoji">{b.icon_emoji}</div>
            <div className="badge-name">{b.name}</div>
            <div className="badge-desc">{b.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
