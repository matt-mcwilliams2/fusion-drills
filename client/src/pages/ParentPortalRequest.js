import React, { useState } from 'react';

const LOGO = '/dailyreps3.png';
const API_BASE = process.env.REACT_APP_API_URL || '';

export default function ParentPortalRequest() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch(`${API_BASE}/api/parent-portal/request-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch (err) {
      // Always show success to prevent email enumeration
    }
    setSubmitted(true);
    setLoading(false);
  };

  return (
    <div className="login-page">
      <img src={LOGO} alt="Daily Reps" className="login-logo" />
      <h1 className="login-title">
        <span>Daily Reps</span> Parent Portal
      </h1>

      {submitted ? (
        <div style={{ textAlign: 'center', maxWidth: 400, color: '#666' }}>
          <p style={{ fontSize: '1.1em', marginBottom: 16 }}>
            If that email is on file, we sent you a link. Please check your inbox.
          </p>
          <p style={{ fontSize: '0.9em' }}>
            The link will expire in 1 hour. If you don't see the email, check your spam folder.
          </p>
          <button
            onClick={() => { setSubmitted(false); setEmail(''); }}
            style={{ background: 'none', border: 'none', color: '#1348e5', cursor: 'pointer', marginTop: 16, fontSize: '0.9em' }}
          >
            Try a different email
          </button>
        </div>
      ) : (
        <>
          <p style={{ textAlign: 'center', color: '#666', marginBottom: 16, maxWidth: 400 }}>
            Enter the email address your child's coach has on file. We'll send you a link to review your child's data and manage consent.
          </p>
          <form className="login-form" onSubmit={handleSubmit}>
            <input
              type="email"
              placeholder="Parent email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
            <button className="btn btn-orange" type="submit" disabled={loading} style={{ background: '#1348e5' }}>
              {loading ? 'Sending...' : 'Send Portal Link'}
            </button>
          </form>
        </>
      )}

      <div style={{ marginTop: 32, textAlign: 'center' }}>
        <a href="/privacy" style={{ color: '#666', fontSize: '0.85em' }}>Privacy Policy</a>
      </div>
    </div>
  );
}
