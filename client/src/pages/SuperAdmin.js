import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const LOGO = '/dailyreps3.png';

export default function SuperAdmin() {
  const { user, logout, apiFetch } = useAuth();
  const [clubs, setClubs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ club_name: '', admin_email: '', admin_first_name: '', admin_last_name: '' });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const loadClubs = async () => {
    try {
      const data = await apiFetch('/api/super/clubs');
      setClubs(data.clubs);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadClubs(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      await apiFetch('/api/super/clubs', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setSuccess(`Club "${form.club_name}" created. Invitation sent to ${form.admin_email}.`);
      setForm({ club_name: '', admin_email: '', admin_first_name: '', admin_last_name: '' });
      setShowCreate(false);
      loadClubs();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-layout">
      <header className="header">
        <div className="header-left">
          <img src={LOGO} alt="Daily Reps" className="header-logo" />
          <div className="header-title"><span>Daily Reps</span> Super Admin</div>
        </div>
        <button className="header-logout" onClick={logout}>Log out</button>
      </header>
      <div className="admin-page">
        <div className="flex-between mb-16">
          <h1 className="page-title" style={{ marginBottom: 0 }}>Clubs</h1>
          <button className="btn btn-orange btn-sm" onClick={() => setShowCreate(true)}>+ Create Club</button>
        </div>

        {success && <div style={{ color: 'var(--success)', marginBottom: 16, padding: '12px 16px', background: 'rgba(46,204,113,0.1)', borderRadius: 8 }}>{success}</div>}

        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: 16 }}>
          Full super admin dashboard coming in Build 6. Use this page to create clubs and their first administrators.
        </p>

        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : (
          <>
            {clubs.length === 0 && <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No clubs created yet.</div>}
            {clubs.map(club => (
              <div key={club.id} className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong style={{ fontSize: '1.1rem' }}>{club.name}</strong>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 4 }}>
                      {club.team_count} team{club.team_count !== 1 ? 's' : ''} &middot; {club.player_count} player{club.player_count !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <span style={{
                    fontSize: '0.75rem',
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: club.status === 'active' ? 'rgba(46,204,113,0.15)' : 'rgba(255,165,0,0.15)',
                    color: club.status === 'active' ? '#2ecc71' : '#f39c12',
                  }}>{club.status}</span>
                </div>
              </div>
            ))}
          </>
        )}

        <div className="card" style={{ textAlign: 'left', marginTop: 24 }}>
          <div style={{ marginBottom: 8 }}><strong>Logged in as:</strong></div>
          <div>{user?.first_name} {user?.last_name}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{user?.email}</div>
          <div style={{ color: 'var(--orange)', fontSize: '0.85rem', marginTop: 4 }}>Role: {user?.role}</div>
        </div>

        {showCreate && (
          <div className="modal-overlay" onClick={() => setShowCreate(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>Create Club</h2>
              {error && <div style={{ color: '#e74c3c', marginBottom: 12 }}>{error}</div>}
              <form onSubmit={handleCreate}>
                <div className="form-group">
                  <label className="form-label">Club Name</label>
                  <input className="form-input" value={form.club_name} onChange={(e) => setForm({...form, club_name: e.target.value})} placeholder="e.g. Lightning FC" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Club Admin Email</label>
                  <input className="form-input" type="email" value={form.admin_email} onChange={(e) => setForm({...form, admin_email: e.target.value})} autoCapitalize="none" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Admin First Name</label>
                  <input className="form-input" value={form.admin_first_name} onChange={(e) => setForm({...form, admin_first_name: e.target.value})} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Admin Last Name</label>
                  <input className="form-input" value={form.admin_last_name} onChange={(e) => setForm({...form, admin_last_name: e.target.value})} required />
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 16 }}>
                  The club admin will receive an email invitation to set their password and complete MFA setup.
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
                  <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Creating...' : 'Create Club'}</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
