import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import LevelShield from '../components/LevelShield';
import Avatar from '../components/Avatar';

export default function Me() {
  const { apiFetch, user } = useAuth();
  const [stats, setStats] = useState(null);
  const [badges, setBadges] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      apiFetch('/api/me/stats'),
      apiFetch('/api/me/badges'),
    ])
      .then(([statsResult, badgesResult]) => {
        if (statsResult.status === 'fulfilled') setStats(statsResult.value);
        if (badgesResult.status === 'fulfilled') setBadges(badgesResult.value.badges || []);
      })
      .finally(() => setLoading(false));
  }, [apiFetch]);

  if (loading) {
    return <div className="page"><div className="loading"><div className="spinner" /></div></div>;
  }

  const level = stats?.level;
  const earnedBadges = badges.filter(b => b.earned_at);
  const latestBadge = earnedBadges.length > 0
    ? earnedBadges.reduce((a, b) => new Date(a.earned_at) > new Date(b.earned_at) ? a : b)
    : null;

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
        <Avatar firstName={user.first_name} lastName={user.last_name} level={level} latestBadgeEmoji={latestBadge?.icon_emoji} size={56} />
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          {user.first_name} {user.last_name}
        </h1>
      </div>

      {level && (
        <div className="level-section">
          <LevelShield name={level.name} color={level.color} textColor={level.textColor} size="large" />
          <div className="level-info">
            <div className="level-label">Level</div>
            <div className="level-name">{level.name}</div>
            {level.nextLevelName && (
              <div className="level-next">Next: {level.nextLevelName}</div>
            )}
          </div>
        </div>
      )}

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
