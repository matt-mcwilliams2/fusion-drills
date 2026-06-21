import React, { useState, useEffect } from 'react';

const LOGO = '/dailyreps3.png';
const API_BASE = process.env.REACT_APP_API_URL || '';

export default function MfaSetup({ token, onComplete }) {
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/mfa/setup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setError(data.error);
        } else {
          setQrCode(data.qr_code);
          setSecret(data.secret);
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to set up MFA. Please try again.');
        setLoading(false);
      });
  }, [token]);

  const handleVerify = async (e) => {
    e.preventDefault();
    setError('');
    setVerifying(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/mfa/verify-setup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Verification failed');
        setVerifying(false);
        return;
      }
      onComplete(data);
    } catch (err) {
      setError('Verification failed. Please try again.');
      setVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="login-page">
        <img src={LOGO} alt="Daily Reps" className="login-logo" />
        <div className="loading"><div className="spinner" /></div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <img src={LOGO} alt="Daily Reps" className="login-logo" />
      <h1 className="login-title">
        <span>Set Up</span> Two-Factor Authentication
      </h1>
      <p style={{ textAlign: 'center', color: '#666', marginBottom: 16, maxWidth: 400 }}>
        Your role requires two-factor authentication. Scan the QR code below with an authenticator app (Google Authenticator, Authy, etc.).
      </p>

      {qrCode && (
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <img src={qrCode} alt="MFA QR Code" style={{ width: 200, height: 200, borderRadius: 8 }} />
        </div>
      )}

      {secret && (
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <p style={{ color: '#666', fontSize: '0.85em', marginBottom: 4 }}>Or enter this code manually:</p>
          <code style={{ background: '#f5f5f5', padding: '8px 12px', borderRadius: 6, fontSize: '0.9em', wordBreak: 'break-all' }}>
            {secret}
          </code>
        </div>
      )}

      <form className="login-form" onSubmit={handleVerify} style={{ maxWidth: 320 }}>
        {error && <div className="login-error">{error}</div>}
        <input
          type="text"
          placeholder="Enter 6-digit code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={6}
          required
          style={{ textAlign: 'center', fontSize: '1.2em', letterSpacing: '0.3em' }}
        />
        <button className="btn btn-orange" type="submit" disabled={verifying || code.length !== 6}>
          {verifying ? 'Verifying...' : 'Verify & Enable MFA'}
        </button>
      </form>
    </div>
  );
}
