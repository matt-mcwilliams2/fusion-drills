import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import LevelShield from '../../components/LevelShield';
import Avatar from '../../components/Avatar';

export default function AdminLeaderboard() {
  const { apiFetch } = useAuth();
  const [players, setPlayers] = useState([]);
  const [season, setSeason] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/leaderboard')
      .then((data) => {
        setPlayers(data.players || []);
        setSeason(data.season || null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [apiFetch]);

  if (loading) {
    return <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>;
  }

  if (!season) {
    return (
      <div className="admin-page">
        <h1 className="page-title">Leaderboard</h1>
        <div className="no-season-msg">No active challenge set. Go to Challenges to activate one.</div>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <div className="flex-between mb-16">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Leaderboard</h1>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{season.name}</span>
      </div>
      <div className="leaderboard-list">
        {players.map((p, i) => (
          <div key={p.id} className="leaderboard-row">
            <div className={`lb-rank ${i < 3 ? 'top-3' : ''}`}>{i + 1}</div>
            <Avatar firstName={p.first_name} lastName={p.last_name} level={p.level} latestBadgeEmoji={p.latest_badge_emoji} size={38} />
            <div className="lb-info">
              <div className="lb-name">
                {p.level && <LevelShield name={p.level.name} color={p.level.color} textColor={p.level.textColor} size="small" />}
                {p.first_name} {p.last_name}
              </div>
              <div className="lb-streak">
                {p.current_streak > 0 ? `\uD83D\uDD25 ${p.current_streak} day streak` : 'No streak'}
              </div>
            </div>
            <div className="lb-points">
              {p.points || 0} <span className="lb-pts-label">pts</span>
            </div>
          </div>
        ))}
        {players.length === 0 && (
          <div className="no-season-msg">No players yet.</div>
        )}
      </div>
    </div>
  );
}
