import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

export default function InviteCoach() {
  const { apiFetch } = useAuth();
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', password: '' });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSuccess('');
    try {
      const data = await apiFetch('/api/admin/coaches', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setSuccess(`Coach ${data.coach.first_name} ${data.coach.last_name} has been added.`);
      setForm({ first_name: '', last_name: '', email: '', password: '' });
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="admin-page">
      <h1 className="page-title">Invite Coach</h1>
      <div className="card">
        {success && <div style={{ color: 'var(--success)', marginBottom: 16, fontWeight: 600 }}>{success}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">First Name</label>
            <input className="form-input" value={form.first_name} onChange={(e) => setForm({...form, first_name: e.target.value})} required />
          </div>
          <div className="form-group">
            <label className="form-label">Last Name</label>
            <input className="form-input" value={form.last_name} onChange={(e) => setForm({...form, last_name: e.target.value})} required />
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input className="form-input" type="email" value={form.email} onChange={(e) => setForm({...form, email: e.target.value})} autoCapitalize="none" required />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input className="form-input" type="password" value={form.password} onChange={(e) => setForm({...form, password: e.target.value})} required />
          </div>
          <button className="btn btn-orange" type="submit" disabled={saving} style={{ width: '100%' }}>
            {saving ? 'Adding Coach...' : 'Add Coach'}
          </button>
        </form>
      </div>
    </div>
  );
}
