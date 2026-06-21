import React, { useState } from 'react';

const LOGO = '/dailyreps3.png';
const API_BASE = process.env.REACT_APP_API_URL || '';

export default function MfaVerify({ mfaSession, onComplete, onBack }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setVerifying(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/mfa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfa_session: mfaSession, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Invalid code');
        setCode('');
        setVerifying(false);
        return;
      }
      onComplete(data);
    } catch (err) {
      setError('Verification failed. Please try again.');
      setCode('');
      setVerifying(false);
    }
  };

  return (
    <div className="login-page">
      <img src={LOGO} alt="Daily Reps" className="login-logo" />
      <h1 className="login-title">
        <span>Two-Factor</span> Authentication
      </h1>
      <p style={{ textAlign: 'center', color: '#666', marginBottom: 16 }}>
        Enter the 6-digit code from your authenticator app.
      </p>
      <form className="login-form" onSubmit={handleSubmit} style={{ maxWidth: 320 }}>
        {error && <div className="login-error">{error}</div>}
        <input
          type="text"
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          required
          style={{ textAlign: 'center', fontSize: '1.4em', letterSpacing: '0.4em' }}
        />
        <button className="btn btn-orange" type="submit" disabled={verifying || code.length !== 6}>
          {verifying ? 'Verifying...' : 'Verify'}
        </button>
      </form>
      <button
        onClick={onBack}
        style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', marginTop: 16, fontSize: '0.9em' }}
      >
        Back to login
      </button>
    </div>
  );
}
