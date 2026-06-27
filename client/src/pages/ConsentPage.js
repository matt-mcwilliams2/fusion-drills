import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

const LOGO = '/dailyreps3.png';
const API_BASE = process.env.REACT_APP_API_URL || '';

export default function ConsentPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [parentName, setParentName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/consent/${token}`)
      .then(r => r.json().then(d => ({ ok: r.ok, data: d })))
      .then(({ ok, data: d }) => {
        if (!ok) {
          setError(d.error || 'Invalid consent link');
        } else {
          setData(d);
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load consent information. The link may have expired.');
        setLoading(false);
      });
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!agreed) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/consent/${token}/grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_name: parentName }),
      });
      const result = await res.json();
      if (!res.ok) {
        setError(result.error || 'Failed to grant consent');
        setSubmitting(false);
        return;
      }
      setSuccess(true);
    } catch (err) {
      setError('Something went wrong. Please try again.');
      setSubmitting(false);
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

  if (error && !data) {
    return (
      <div className="login-page">
        <img src={LOGO} alt="Daily Reps" className="login-logo" />
        <h1 className="login-title"><span>Daily Reps</span> Consent</h1>
        <div className="login-error" style={{ fontSize: '1rem', marginTop: 20, maxWidth: 400 }}>
          {error}
        </div>
      </div>
    );
  }

  if (data?.already_granted || success) {
    return (
      <div className="login-page">
        <img src={LOGO} alt="Daily Reps" className="login-logo" />
        <h1 className="login-title"><span>Daily Reps</span> Consent</h1>
        <div style={{ textAlign: 'center', maxWidth: 400, marginTop: 20 }}>
          <div style={{ fontSize: '2em', marginBottom: 12 }}>&#10003;</div>
          <h2 style={{ color: '#28a745', marginBottom: 8 }}>Consent Granted</h2>
          <p style={{ color: '#666' }}>
            {success
              ? `Thank you! ${data.player_name}'s account is now active. They can log in and start training!`
              : `Consent has already been provided for ${data.player_name}.`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", maxWidth: 700, margin: '0 auto', padding: 20, color: '#000000' }}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <img src={LOGO} alt="Daily Reps" style={{ width: 60, height: 60 }} />
        <h1 style={{ color: '#1348e5', marginBottom: 4 }}>Parental Consent</h1>
        <p style={{ color: '#666' }}>
          Consent required for <strong>{data.player_name}</strong> on <strong>{data.team_name}</strong>
        </p>
      </div>

      <div
        style={{ background: '#f9f9f9', padding: 24, borderRadius: 8, marginBottom: 24, lineHeight: 1.6 }}
        dangerouslySetInnerHTML={{ __html: data.consent_language }}
      />

      <p style={{ fontSize: '0.85em', color: '#666', marginBottom: 24 }}>
        <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: '#1348e5' }}>
          View our Privacy Policy (v{data.privacy_policy_version})
        </a>
      </p>

      <form onSubmit={handleSubmit}>
        {error && <div className="login-error" style={{ marginBottom: 16 }}>{error}</div>}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Your Name (Parent/Guardian)</label>
          <input
            type="text"
            value={parentName}
            onChange={(e) => setParentName(e.target.value)}
            placeholder="Full name"
            style={{ width: '100%', padding: '10px 12px', border: '1px solid #ccc', borderRadius: 6, fontSize: '1em', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              style={{ marginTop: 3, width: 18, height: 18 }}
            />
            <span>
              I agree and give permission for my child to use Daily Reps. I have read the consent notice above and the Privacy Policy.
            </span>
          </label>
        </div>
        <button
          type="submit"
          disabled={!agreed || submitting}
          style={{
            width: '100%', padding: '14px 24px', background: agreed ? '#1348e5' : '#ccc',
            color: 'white', border: 'none', borderRadius: 8, fontSize: '1.1em', fontWeight: 700,
            cursor: agreed ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Submitting...' : 'I Consent — Activate My Child\'s Account'}
        </button>
      </form>
    </div>
  );
}
