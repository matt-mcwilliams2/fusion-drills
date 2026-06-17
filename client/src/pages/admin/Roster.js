import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';

export default function Roster() {
  const { apiFetch } = useAuth();
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [resetPlayer, setResetPlayer] = useState(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', username: '', password: '' });
  const [resetPw, setResetPw] = useState('');
  const [saving, setSaving] = useState(false);

  const loadPlayers = async () => {
    try {
      const data = await apiFetch('/api/admin/players');
      setPlayers(data.players);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadPlayers(); }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch('/api/admin/players', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm({ first_name: '', last_name: '', username: '', password: '' });
      setShowAdd(false);
      loadPlayers();
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const handleToggle = async (id, active) => {
    try {
      await apiFetch(`/api/admin/players/${id}/${active ? 'deactivate' : 'activate'}`, { method: 'PUT' });
      loadPlayers();
    } catch (err) { alert(err.message); }
  };

  const handleDelete = async (player) => {
    if (!window.confirm(`Permanently delete ${player.first_name} ${player.last_name}? This removes all their completions and badges.`)) return;
    try {
      await apiFetch(`/api/admin/players/${player.id}`, { method: 'DELETE' });
      loadPlayers();
    } catch (err) { alert(err.message); }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch(`/api/admin/players/${resetPlayer.id}/reset-password`, {
        method: 'PUT',
        body: JSON.stringify({ password: resetPw }),
      });
      setResetPlayer(null);
      setResetPw('');
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>;

  return (
    <div className="admin-page">
      <div className="flex-between mb-16">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Roster</h1>
        <button className="btn btn-orange btn-sm" onClick={() => setShowAdd(true)}>+ Add Player</button>
      </div>

      {players.map((p) => (
        <div key={p.id} className={`player-row ${!p.active ? 'inactive' : ''}`}>
          <div className="player-info">
            <div className="player-name">{p.first_name} {p.last_name}</div>
            <div className="player-username">@{p.username}{!p.active ? ' (inactive)' : ''}</div>
          </div>
          <div className="player-actions">
            {p.active ? (
              <>
                <button className="btn btn-outline btn-sm" onClick={() => { setResetPlayer(p); setResetPw(''); }}>
                  Reset PW
                </button>
                <button className="btn btn-outline btn-sm" onClick={() => handleToggle(p.id, true)}>
                  Deactivate
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(p)}>
                  Delete
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-blue btn-sm" onClick={() => handleToggle(p.id, false)}>
                  Activate
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(p)}>
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      ))}

      {players.length === 0 && <div className="no-season-msg">No players added yet.</div>}

      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Player</h2>
            <form onSubmit={handleAdd}>
              <div className="form-group">
                <label className="form-label">First Name</label>
                <input className="form-input" value={form.first_name} onChange={(e) => setForm({...form, first_name: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Last Name</label>
                <input className="form-input" value={form.last_name} onChange={(e) => setForm({...form, last_name: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Username</label>
                <input className="form-input" value={form.username} onChange={(e) => setForm({...form, username: e.target.value})} autoCapitalize="none" required />
              </div>
              <div className="form-group">
                <label className="form-label">Password</label>
                <input className="form-input" type="password" value={form.password} onChange={(e) => setForm({...form, password: e.target.value})} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Adding...' : 'Add Player'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {resetPlayer && (
        <div className="modal-overlay" onClick={() => setResetPlayer(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Reset Password for {resetPlayer.first_name}</h2>
            <form onSubmit={handleReset}>
              <div className="form-group">
                <label className="form-label">New Password</label>
                <input className="form-input" type="password" value={resetPw} onChange={(e) => setResetPw(e.target.value)} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setResetPlayer(null)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Saving...' : 'Reset Password'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
