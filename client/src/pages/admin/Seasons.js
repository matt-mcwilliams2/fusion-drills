import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';

export default function Seasons() {
  const { apiFetch } = useAuth();
  const [seasons, setSeasons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingSeason, setEditingSeason] = useState(null);
  const [form, setForm] = useState({ name: '', start_date: '', end_date: '' });
  const [editForm, setEditForm] = useState({ name: '', start_date: '', end_date: '' });
  const [saving, setSaving] = useState(false);
  const [pastLeaderboard, setPastLeaderboard] = useState(null);
  const [viewingSeason, setViewingSeason] = useState(null);

  const loadSeasons = async () => {
    try {
      const data = await apiFetch('/api/admin/seasons');
      setSeasons(data.seasons);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadSeasons(); }, []);

  // Auto-fill end date ~11 months after start
  const handleStartDateChange = (startDate) => {
    setForm({ ...form, start_date: startDate });
    if (startDate && !form.end_date) {
      const start = new Date(startDate);
      start.setMonth(start.getMonth() + 11);
      setForm(prev => ({ ...prev, start_date: startDate, end_date: start.toISOString().split('T')[0] }));
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch('/api/admin/seasons', { method: 'POST', body: JSON.stringify(form) });
      setShowAdd(false);
      setForm({ name: '', start_date: '', end_date: '' });
      loadSeasons();
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const handleActivate = async (id) => {
    const activeSeason = seasons.find(s => s.active);
    if (activeSeason) {
      if (!window.confirm(
        `Starting this season will end "${activeSeason.name}". Player season stats will reset for the new season (lifetime points are preserved). Continue?`
      )) return;
    }
    try {
      await apiFetch(`/api/admin/seasons/${id}/activate`, { method: 'PUT' });
      loadSeasons();
    } catch (err) { alert(err.message); }
  };

  const handleArchive = async (id) => {
    const season = seasons.find(s => s.id === id);
    if (!window.confirm(`End and archive "${season?.name}"? The final standings will be preserved.`)) return;
    try {
      await apiFetch(`/api/admin/seasons/${id}/archive`, { method: 'POST' });
      loadSeasons();
    } catch (err) { alert(err.message); }
  };

  const handleDelete = async (season) => {
    if (!window.confirm(`Delete the "${season.name}" challenge? This cannot be undone.`)) return;
    try {
      await apiFetch(`/api/admin/seasons/${season.id}`, { method: 'DELETE' });
      loadSeasons();
    } catch (err) { alert(err.message); }
  };

  const openEdit = (season) => {
    setEditingSeason(season);
    setEditForm({
      name: season.name,
      start_date: (season.start_date || '').split('T')[0],
      end_date: (season.end_date || '').split('T')[0],
    });
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch(`/api/admin/seasons/${editingSeason.id}`, {
        method: 'PUT',
        body: JSON.stringify(editForm),
      });
      setEditingSeason(null);
      loadSeasons();
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const viewStandings = async (season) => {
    setViewingSeason(season);
    try {
      const data = await apiFetch(`/api/admin/seasons/${season.id}/leaderboard`);
      setPastLeaderboard(data.leaderboard);
    } catch (err) {
      console.error(err);
      setPastLeaderboard([]);
    }
  };

  const formatDate = (dateStr) => {
    const d = new Date((dateStr || '').split('T')[0] + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) return <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>;

  const activeSeasons = seasons.filter(s => s.active);
  const archivedSeasons = seasons.filter(s => !s.active);

  return (
    <div className="admin-page">
      <div className="flex-between mb-16">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Challenges</h1>
        <button className="btn btn-orange btn-sm" onClick={() => setShowAdd(true)}>+ New Challenge</button>
      </div>

      {/* Active season */}
      {activeSeasons.map((s) => (
        <div key={s.id} className="season-row active-season">
          <div className="season-info">
            <h3>{s.name}</h3>
            <div className="season-dates">{formatDate(s.start_date)} &mdash; {formatDate(s.end_date)}</div>
          </div>
          <div className="player-actions">
            <span className="season-active-badge">Active</span>
            <button className="btn btn-outline btn-sm" onClick={() => openEdit(s)}>Edit</button>
            <button className="btn btn-danger btn-sm" onClick={() => handleArchive(s.id)}>End Season</button>
          </div>
        </div>
      ))}

      {activeSeasons.length === 0 && (
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 20, marginBottom: 16 }}>
          No active challenge. Create one and set it active to start tracking.
        </div>
      )}

      {/* Archived seasons */}
      {archivedSeasons.length > 0 && (
        <>
          <h2 style={{ fontSize: '0.95rem', marginTop: 24, marginBottom: 12, color: 'var(--text-muted)' }}>Past Challenges</h2>
          {archivedSeasons.map((s) => (
            <div key={s.id} className="season-row">
              <div className="season-info">
                <h3>{s.name}</h3>
                <div className="season-dates">{formatDate(s.start_date)} &mdash; {formatDate(s.end_date)}</div>
              </div>
              <div className="player-actions">
                <button className="btn btn-blue btn-sm" onClick={() => viewStandings(s)}>View Standings</button>
                <button className="btn btn-blue btn-sm" onClick={() => handleActivate(s.id)}>Set Active</button>
                <button className="btn btn-outline btn-sm" onClick={() => openEdit(s)}>Edit</button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(s)}>Delete</button>
              </div>
            </div>
          ))}
        </>
      )}

      {seasons.length === 0 && <div className="no-season-msg">No challenges created yet.</div>}

      {/* Add Season Modal */}
      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New Challenge</h2>
            <form onSubmit={handleAdd}>
              <div className="form-group">
                <label className="form-label">Challenge Name</label>
                <input className="form-input" value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} placeholder="e.g. Summer 2026" required />
              </div>
              <div className="form-group">
                <label className="form-label">Start Date</label>
                <input className="form-input" type="date" value={form.start_date} onChange={(e) => handleStartDateChange(e.target.value)} required />
              </div>
              <div className="form-group">
                <label className="form-label">End Date</label>
                <input className="form-input" type="date" value={form.end_date} onChange={(e) => setForm({...form, end_date: e.target.value})} />
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  We recommend seasons of about 11 months. You can run a season longer, but a fresh season keeps the leaderboard competitive. Leave blank for the default.
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Creating...' : 'Create Challenge'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Season Modal */}
      {editingSeason && (
        <div className="modal-overlay" onClick={() => setEditingSeason(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Edit Challenge</h2>
            <form onSubmit={handleEdit}>
              <div className="form-group">
                <label className="form-label">Challenge Name</label>
                <input className="form-input" value={editForm.name} onChange={(e) => setEditForm({...editForm, name: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Start Date</label>
                <input className="form-input" type="date" value={editForm.start_date} onChange={(e) => setEditForm({...editForm, start_date: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">End Date</label>
                <input className="form-input" type="date" value={editForm.end_date} onChange={(e) => setEditForm({...editForm, end_date: e.target.value})} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setEditingSeason(null)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Past Season Standings Modal */}
      {viewingSeason && (
        <div className="modal-overlay" onClick={() => { setViewingSeason(null); setPastLeaderboard(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <h2>{viewingSeason.name} &mdash; Final Standings</h2>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 12 }}>
              {formatDate(viewingSeason.start_date)} &mdash; {formatDate(viewingSeason.end_date)}
            </div>
            {!pastLeaderboard ? (
              <div className="loading"><div className="spinner" /></div>
            ) : pastLeaderboard.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>No player data for this season.</p>
            ) : (
              <div>
                {pastLeaderboard.map((p, i) => (
                  <div key={p.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 0', borderBottom: i < pastLeaderboard.length - 1 ? '1px solid var(--card-border)' : 'none',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', width: 24 }}>#{i + 1}</span>
                      <div>
                        <div style={{ fontWeight: 600 }}>{p.first_name} {p.last_name}</div>
                        <div style={{ fontSize: '0.75rem', color: p.level?.color || 'var(--text-muted)' }}>{p.level?.name}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, color: 'var(--orange)' }}>{p.season_points} pts</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Best streak: {p.longest_streak}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button className="btn btn-outline btn-sm" onClick={() => { setViewingSeason(null); setPastLeaderboard(null); }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
