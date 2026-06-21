import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import MfaSetup from './MfaSetup';

const LOGO = '/dailyreps3.png';
const API_BASE = process.env.REACT_APP_API_URL || '';

export default function InviteAccept() {
  const { token: urlToken } = useParams();
  const navigate = useNavigate();
  const { completeMfaLogin } = useAuth();

  const [step, setStep] = useState('loading'); // loading, invalid, form, mfa, done
  const [invitation, setInvitation] = useState(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', password: '', confirm_password: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [mfaToken, setMfaToken] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/invitations/${urlToken}/validate`)
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          setError(data.error || 'Invalid invitation');
          setStep('invalid');
        } else {
          setInvitation(data);
          setStep('form');
        }
      })
      .catch(() => {
        setError('Failed to validate invitation');
        setStep('invalid');
      });
  }, [urlToken]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (form.password !== form.confirm_password) {
      setError('Passwords do not match');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/invitations/${urlToken}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: form.password,
          first_name: form.first_name,
          last_name: form.last_name,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to accept invitation');
        setSaving(false);
        return;
      }

      if (data.mfa_setup_required) {
        setMfaToken(data.token);
        setStep('mfa');
        return;
      }

      // Coach: got full token, log in
      completeMfaLogin(data);
      navigate(data.user.role === 'club_admin' ? '/club' : '/admin');
    } catch (err) {
      setError('Failed to accept invitation');
      setSaving(false);
    }
  };

  const handleMfaComplete = (data) => {
    completeMfaLogin(data);
    navigate('/club');
  };

  if (step === 'loading') {
    return (
      <div className="login-page">
        <img src={LOGO} alt="Daily Reps" className="login-logo" />
        <div className="loading"><div className="spinner" /></div>
      </div>
    );
  }

  if (step === 'invalid') {
    return (
      <div className="login-page">
        <img src={LOGO} alt="Daily Reps" className="login-logo" />
        <h1 className="login-title"><span>Invitation</span></h1>
        <div className="card" style={{ textAlign: 'center', maxWidth: 400 }}>
          <p style={{ color: '#e74c3c', marginBottom: 16 }}>{error}</p>
          <a href="/login" className="btn btn-orange" style={{ display: 'inline-block', textDecoration: 'none' }}>Go to Login</a>
        </div>
      </div>
    );
  }

  if (step === 'mfa') {
    return <MfaSetup token={mfaToken} onComplete={handleMfaComplete} />;
  }

  return (
    <div className="login-page">
      <img src={LOGO} alt="Daily Reps" className="login-logo" />
      <h1 className="login-title"><span>Accept</span> Invitation</h1>
      <div className="card" style={{ maxWidth: 420, width: '100%' }}>
        <div style={{ marginBottom: 16, textAlign: 'center' }}>
          <p>You've been invited to join <strong>{invitation.club_name}</strong> as a <strong>{invitation.role === 'club_admin' ? 'Club Administrator' : 'Coach'}</strong>.</p>
          {invitation.team_name && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Team: {invitation.team_name}</p>}
        </div>
        {error && <div style={{ color: '#e74c3c', marginBottom: 12, textAlign: 'center' }}>{error}</div>}
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
            <input className="form-input" type="email" value={invitation.email} disabled style={{ opacity: 0.6 }} />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input className="form-input" type="password" value={form.password} onChange={(e) => setForm({...form, password: e.target.value})} required minLength={12} />
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
              At least 12 characters with letters, numbers, and a special character
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Confirm Password</label>
            <input className="form-input" type="password" value={form.confirm_password} onChange={(e) => setForm({...form, confirm_password: e.target.value})} required />
          </div>
          <button className="btn btn-orange" type="submit" disabled={saving} style={{ width: '100%' }}>
            {saving ? 'Setting up...' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
