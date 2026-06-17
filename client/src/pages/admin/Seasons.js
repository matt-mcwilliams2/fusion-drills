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

  const handleDelete = async (season) => {
    if (!window.confirm(`Delete the "${season.name}" challenge?`)) return;
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

  const formatDate = (dateStr) => {
    const d = new Date((dateStr || '').split('T')[0] + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) return <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>;

  return (
    <div className="admin-page">
      <div className="flex-between mb-16">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Challenges</h1>
        <button className="btn btn-orange btn-sm" onClick={() => setShowAdd(true)}>+ Add Challenge</button>
      </div>

      {seasons.map((s) => (
        <div key={s.id} className={`season-row ${s.active ? 'active-season' : ''}`}>
          <div className="season-info">
            <h3>{s.name}</h3>
            <div className="season-dates">{formatDate(s.start_date)} — {formatDate(s.end_date)}</div>
          </div>
          <div className="player-actions">
            {s.active ? (
              <span className="season-active-badge">Active</span>
            ) : (
              <button className="btn btn-blue btn-sm" onClick={() => handleActivate(s.id)}>Set Active</button>
            )}
            <button className="btn btn-outline btn-sm" onClick={() => openEdit(s)}>Edit</button>
            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(s)}>Delete</button>
          </div>
        </div>
      ))}

      {seasons.length === 0 && <div className="no-season-msg">No challenges created yet.</div>}

      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Challenge</h2>
            <form onSubmit={handleAdd}>
              <div className="form-group">
                <label className="form-label">Challenge Name</label>
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
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Creating...' : 'Create Challenge'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

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
    </div>
  );
}
