import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const LOGO = '/dailyreps3.png';
const API_BASE = process.env.REACT_APP_API_URL || '';

export default function PlayerLogin() {
  const { joinCode } = useParams();
  const { loginPlayer } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [consentMsg, setConsentMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [teamColor, setTeamColor] = useState('#f77c00');
  const [teamNotFound, setTeamNotFound] = useState(false);

  useEffect(() => {
    if (joinCode) {
      fetch(`${API_BASE}/api/teams/by-code/${joinCode}`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => {
          setTeamName(data.team.name);
          if (data.team.primary_color) setTeamColor(data.team.primary_color);
        })
        .catch(() => setTeamNotFound(true));

      // Update manifest link for team-scoped PWA
      const manifestLink = document.querySelector('link[rel="manifest"]');
      if (manifestLink) {
        manifestLink.href = `/t/${joinCode}/manifest.json`;
      }
    }
  }, [joinCode]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await loginPlayer(username, password, joinCode);
    } catch (err) {
      if (err.message && err.message.toLowerCase().includes('parent') && err.message.toLowerCase().includes('consent')) {
        setError('consent_blocked');
        setConsentMsg(err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  if (teamNotFound) {
    return (
      <div className="login-page">
        <img src={LOGO} alt="Daily Reps" className="login-logo" />
        <h1 className="login-title">
          <span>Daily Reps</span> Training
        </h1>
        <div className="login-error" style={{ fontSize: '1rem', marginTop: 20 }}>
          Team not found. Check your join code and try again.
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <img src={LOGO} alt="Daily Reps" className="login-logo" />
      <h1 className="login-title">
        <span style={{ color: teamColor }}>Daily Reps</span> Training
      </h1>
      {teamName && (
        <div style={{ color: teamColor, fontWeight: 700, fontSize: '1.1rem', marginBottom: 24, textAlign: 'center' }}>
          {teamName}
        </div>
      )}
      {error === 'consent_blocked' && (
        <div style={{ textAlign: 'center', maxWidth: 400, marginBottom: 16 }}>
          <div style={{ background: '#fff3cd', border: '1px solid #ffc107', padding: '16px 20px', borderRadius: 8, color: '#856404', fontSize: '0.95em', lineHeight: 1.5 }}>
            {consentMsg}
          </div>
          <button
            onClick={() => { setError(''); setConsentMsg(''); }}
            style={{ background: 'none', border: 'none', color: teamColor, cursor: 'pointer', marginTop: 12, fontSize: '0.9em' }}
          >
            Try again
          </button>
        </div>
      )}
      <form className="login-form" onSubmit={handleSubmit} style={{ display: error === 'consent_blocked' ? 'none' : undefined }}>
        {error && error !== 'consent_blocked' && <div className="login-error">{error}</div>}
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="btn btn-orange" type="submit" disabled={loading} style={{ background: teamColor }}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
