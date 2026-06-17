import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';

export default function Drills() {
  const { apiFetch } = useAuth();
  const [drills, setDrills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ date: '', title: '', description: '', youtube_url: '' });
  const [saving, setSaving] = useState(false);

  const loadDrills = async () => {
    try {
      const data = await apiFetch('/api/admin/drills');
      setDrills(data.drills);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadDrills(); }, []);

  const openAdd = () => {
    setEditing(null);
    setForm({ date: '', title: '', description: '', youtube_url: '' });
    setShowModal(true);
  };

  const openEdit = (drill) => {
    setEditing(drill);
    setForm({ date: drill.date, title: drill.title, description: drill.description || '', youtube_url: drill.youtube_url || '' });
    setShowModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await apiFetch(`/api/admin/drills/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
      } else {
        await apiFetch('/api/admin/drills', { method: 'POST', body: JSON.stringify(form) });
      }
      setShowModal(false);
      loadDrills();
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this drill? Completions for this drill will also be removed.')) return;
    try {
      await apiFetch(`/api/admin/drills/${id}`, { method: 'DELETE' });
      loadDrills();
    } catch (err) { alert(err.message); }
  };

  const formatDate = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) return <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>;

  return (
    <div className="admin-page">
      <div className="flex-between mb-16">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Drills</h1>
        <button className="btn btn-orange btn-sm" onClick={openAdd}>+ Add Drill</button>
      </div>

      {drills.map((d) => (
        <div key={d.id} className="drill-row">
          <div className="drill-row-header">
            <span className="drill-row-date">{formatDate(d.date)}</span>
          </div>
          <div className="drill-row-title">{d.title}</div>
          <div className="drill-row-actions">
            <button className="btn btn-outline btn-sm" onClick={() => openEdit(d)}>Edit</button>
            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(d.id)}>Delete</button>
          </div>
        </div>
      ))}

      {drills.length === 0 && <div className="no-season-msg">No drills scheduled yet.</div>}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing ? 'Edit Drill' : 'Add Drill'}</h2>
            <form onSubmit={handleSave}>
              <div className="form-group">
                <label className="form-label">Date</label>
                <input className="form-input" type="date" value={form.date} onChange={(e) => setForm({...form, date: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Title</label>
                <input className="form-input" value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea className="form-textarea" value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} />
              </div>
              <div className="form-group">
                <label className="form-label">YouTube URL</label>
                <input className="form-input" value={form.youtube_url} onChange={(e) => setForm({...form, youtube_url: e.target.value})} placeholder="https://youtube.com/watch?v=..." />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Saving...' : (editing ? 'Update' : 'Add Drill')}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
