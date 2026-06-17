import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';

export default function Seasons() {
  const { apiFetch } = useAuth();
  const [seasons, setSeasons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', start_date: '', end_date: '' });
  const [saving, setSaving] = useState(false);

  const loadSeasons = async () => {
    try {
      const data = await apiFetch('/api/admin/seasons');
      setSeasons(data.seasons);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadSeasons(); }, []);

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
    try {
      await apiFetch(`/api/admin/seasons/${id}/activate`, { method: 'PUT' });
      loadSeasons();
    } catch (err) { alert(err.message); }
  };

  const formatDate = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) return <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>;

  return (
    <div className="admin-page">
      <div className="flex-between mb-16">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Seasons</h1>
        <button className="btn btn-orange btn-sm" onClick={() => setShowAdd(true)}>+ Add Season</button>
      </div>

      {seasons.map((s) => (
        <div key={s.id} className={`season-row ${s.active ? 'active-season' : ''}`}>
          <div className="season-info">
            <h3>{s.name}</h3>
            <div className="season-dates">{formatDate(s.start_date)} — {formatDate(s.end_date)}</div>
          </div>
          {s.active ? (
            <span className="season-active-badge">Active</span>
          ) : (
            <button className="btn btn-blue btn-sm" onClick={() => handleActivate(s.id)}>Set Active</button>
          )}
        </div>
      ))}

      {seasons.length === 0 && <div className="no-season-msg">No seasons created yet.</div>}

      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Season</h2>
            <form onSubmit={handleAdd}>
              <div className="form-group">
                <label className="form-label">Season Name</label>
                <input className="form-input" value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} placeholder="e.g. Summer 2025" required />
              </div>
              <div className="form-group">
                <label className="form-label">Start Date</label>
                <input className="form-input" type="date" value={form.start_date} onChange={(e) => setForm({...form, start_date: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">End Date</label>
                <input className="form-input" type="date" value={form.end_date} onChange={(e) => setForm({...form, end_date: e.target.value})} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Creating...' : 'Create Season'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
