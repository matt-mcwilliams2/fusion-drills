import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import LevelShield from '../components/LevelShield';
import Avatar from '../components/Avatar';

export default function Me() {
  const { apiFetch, user } = useAuth();
  const [stats, setStats] = useState(null);
  const [badges, setBadges] = useState([]);
  const [pastSeasons, setPastSeasons] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      apiFetch('/api/me/stats'),
      apiFetch('/api/me/badges'),
      apiFetch('/api/seasons/past'),
    ])
      .then(([statsResult, badgesResult, seasonsResult]) => {
        if (statsResult.status === 'fulfilled') setStats(statsResult.value);
        if (badgesResult.status === 'fulfilled') setBadges(badgesResult.value.badges || []);
        if (seasonsResult.status === 'fulfilled') setPastSeasons(seasonsResult.value.seasons || []);
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
          <LevelShield name={level.name} color={level.color} textColor={level.textColor} isPrestige={level.isPrestige} subtitle={level.subtitle} size="large" />
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
          <div className="stat-label">Season Points</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12, padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 2 }}>Career Total</div>
          <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--orange)' }}>{stats?.lifetime_points || 0}</div>
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', maxWidth: 180, textAlign: 'right' }}>
          All the points you've earned across every season
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

      {pastSeasons.length > 0 && (
        <>
          <h2 className="page-title" style={{ marginTop: 24 }}>Past Challenges</h2>
          {pastSeasons.map((s) => (
            <div key={s.id} className="card" style={{ marginBottom: 10, padding: '12px 16px' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.name}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                {new Date(s.start_date?.split('T')[0] + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {' — '}
                {new Date(s.end_date?.split('T')[0] + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </div>
              {s.my_stats ? (
                <div style={{ display: 'flex', gap: 16, fontSize: '0.85rem' }}>
                  <div><span style={{ fontWeight: 700, color: 'var(--orange)' }}>{s.my_stats.season_points}</span> pts</div>
                  <div>Best streak: <span style={{ fontWeight: 600 }}>{s.my_stats.longest_streak}</span></div>
                </div>
              ) : (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No stats recorded</div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
