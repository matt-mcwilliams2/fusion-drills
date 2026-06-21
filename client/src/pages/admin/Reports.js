import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';

function formatDate(dateStr) {
  const d = new Date((dateStr || '').split('T')[0] + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function daysAgo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${diff}d ago`;
}

export default function Reports() {
  const { apiFetch } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('overview');

  useEffect(() => {
    apiFetch('/api/admin/reports')
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [apiFetch]);

  if (loading) return <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>;

  if (data?.noSeason) {
    return (
      <div className="admin-page">
        <h1 className="page-title">Reports</h1>
        <div className="no-season-msg">No active challenge. Activate a challenge to see reports.</div>
      </div>
    );
  }

  if (!data) return <div className="admin-page"><div className="no-season-msg">Failed to load reports.</div></div>;

  const inactivePlayers = data.player_stats.filter(p => p.inactive);
  const maxWeekly = Math.max(...data.weekly_trend.map(w => w.completions), 1);

  return (
    <div className="admin-page">
      <div className="flex-between mb-16">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Reports</h1>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{data.season.name}</span>
      </div>

      {/* Sub-nav */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {['overview', 'players', 'drills'].map(tab => (
          <button key={tab} onClick={() => setView(tab)}
            style={{ background: view === tab ? 'var(--orange)' : 'var(--card-bg)', color: view === tab ? '#fff' : 'var(--text-muted)', border: '1px solid var(--card-border)', borderRadius: 6, padding: '6px 12px', fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit', fontWeight: view === tab ? 700 : 400 }}>
            {tab === 'overview' ? 'Overview' : tab === 'players' ? 'Players' : 'Drills'}
          </button>
        ))}
      </div>

      {view === 'overview' && (
        <>
          {/* This week summary */}
          <div className="card" style={{ marginBottom: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>This Week</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>
              <span style={{ color: 'var(--orange)' }}>{data.active_this_week}</span>
              <span style={{ fontSize: '0.9rem', fontWeight: 400, color: 'var(--text-muted)' }}> of {data.total_players} players active</span>
            </div>
          </div>

          {/* Inactive players warning */}
          {inactivePlayers.length > 0 && (
            <div style={{ background: 'rgba(243,156,18,0.1)', border: '1px solid rgba(243,156,18,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: '0.82rem' }}>
              <div style={{ fontWeight: 700, color: '#f39c12', marginBottom: 4 }}>Inactive Players ({inactivePlayers.length})</div>
              <div style={{ color: 'var(--text-muted)' }}>
                No activity in 10+ days: {inactivePlayers.map(p => `${p.first_name} ${p.last_name}`).join(', ')}
              </div>
            </div>
          )}

          {/* Weekly trend */}
          <div className="card" style={{ marginBottom: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 10 }}>Weekly Completions</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
              {data.weekly_trend.map((w, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{w.completions || ''}</div>
                  <div style={{ width: '100%', background: i === data.weekly_trend.length - 1 ? 'var(--orange)' : 'var(--card-border)', borderRadius: 3, height: `${Math.max((w.completions / maxWeekly) * 60, 2)}px` }} />
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{formatDate(w.week_start)}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {view === 'players' && (
        <>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8 }}>{data.player_stats.length} players</div>
          {data.player_stats.map(p => (
            <div key={p.id} className="card" style={{ marginBottom: 6, padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontWeight: 600 }}>{p.first_name} {p.last_name}</span>
                  {p.inactive && <span style={{ marginLeft: 8, fontSize: '0.7rem', padding: '1px 6px', borderRadius: 4, background: 'rgba(243,156,18,0.15)', color: '#f39c12' }}>Inactive</span>}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {p.last_active ? daysAgo(p.last_active) : 'Never'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                <span>{p.current_streak > 0 ? `${p.current_streak} day streak` : 'No streak'}</span>
                <span>{p.completions} completions</span>
                <span>{p.completion_rate}% rate</span>
              </div>
            </div>
          ))}
        </>
      )}

      {view === 'drills' && (
        <>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8 }}>Recent drills</div>
          {data.recent_drills.map(d => (
            <div key={d.id} className="card" style={{ marginBottom: 6, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{d.title}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{formatDate(d.date)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, color: 'var(--orange)' }}>{d.completion_count}<span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>/{d.total_players}</span></div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>completed</div>
              </div>
            </div>
          ))}
          {data.recent_drills.length === 0 && <div className="no-season-msg">No drills yet this season.</div>}
        </>
      )}
    </div>
  );
}
