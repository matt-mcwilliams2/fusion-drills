import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

export default function InviteCoach() {
  const { apiFetch } = useAuth();
  const [form, setForm] = useState({ email: '' });
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
      if (data.linked) {
        setSuccess(`${data.coach.first_name} ${data.coach.last_name} has been added to your team.`);
      } else {
        setSuccess(`Invitation sent to ${form.email}. They'll receive an email to set up their account.`);
      }
      setForm({ email: '' });
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
            <label className="form-label">Email</label>
            <input className="form-input" type="email" value={form.email} onChange={(e) => setForm({...form, email: e.target.value})} autoCapitalize="none" required />
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 16 }}>
            If this email is already registered, they'll be added to your team. Otherwise, they'll receive an invitation email to set up their account.
          </div>
          <button className="btn btn-orange" type="submit" disabled={saving} style={{ width: '100%' }}>
            {saving ? 'Inviting...' : 'Invite Coach'}
          </button>
        </form>
      </div>
    </div>
  );
}
