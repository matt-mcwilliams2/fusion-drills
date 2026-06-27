import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const LOGO = '/dailyreps3.png';
const API_BASE = process.env.REACT_APP_API_URL || '';

export default function PlayerRegister() {
  const { joinCode } = useParams();
  const navigate = useNavigate();
  const { completePlayerLogin } = useAuth();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [isUnder13, setIsUnder13] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [teamName, setTeamName] = useState('');
  const [teamColor, setTeamColor] = useState('#f77c00');
  const [teamNotFound, setTeamNotFound] = useState(false);

  const [success, setSuccess] = useState(null);

  useEffect(() => {
    if (joinCode) {
      fetch(`${API_BASE}/api/teams/by-code/${joinCode}`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => {
          setTeamName(data.team.name);
          if (data.team.primary_color) setTeamColor(data.team.primary_color);
        })
        .catch(() => setTeamNotFound(true));
    }
  }, [joinCode]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/teams/${joinCode}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: firstName,
          last_name: lastName,
          email,
          password,
          is_under_13: isUnder13,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      if (data.consent_required) {
        setSuccess({ username: data.username, consentRequired: true });
      } else {
        completePlayerLogin(data);
        navigate(`/t/${joinCode}`);
      }
    } catch (err) {
      setError(err.message);
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
          Team not found. Check the link and try again.
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="login-page">
        <img src={LOGO} alt="Daily Reps" className="login-logo" />
        <h1 className="login-title">
          <span style={{ color: teamColor }}>Daily Reps</span> Training
        </h1>
        {teamName && (
          <div style={{ color: teamColor, fontWeight: 700, fontSize: '1.1rem', marginBottom: 16, textAlign: 'center' }}>
            {teamName}
          </div>
        )}
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <div style={{ background: '#d4edda', border: '1px solid #c3e6cb', padding: '20px 24px', borderRadius: 12, color: '#155724', marginBottom: 16 }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 8 }}>Account Created!</div>
            <p style={{ margin: '8px 0' }}>Your username is: <strong>{success.username}</strong></p>
            <p style={{ margin: '8px 0', fontSize: '0.9em' }}>
              A consent email has been sent to your parent. You can log in after they approve.
            </p>
          </div>
          <a href={`/t/${joinCode}`} style={{ color: teamColor, fontSize: '0.9em' }}>Go to login page</a>
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
        <div style={{ color: teamColor, fontWeight: 700, fontSize: '1.1rem', marginBottom: 16, textAlign: 'center' }}>
          {teamName}
        </div>
      )}
      <div style={{ textAlign: 'center', marginBottom: 16, fontSize: '0.95rem', color: '#aaa' }}>
        Player Registration
      </div>
      <form className="login-form" onSubmit={handleSubmit}>
        {error && <div className="login-error">{error}</div>}
        <input
          type="text"
          placeholder="First Name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="Last Name"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          required
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: '0.9rem', color: '#ccc', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={isUnder13}
            onChange={(e) => setIsUnder13(e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          Is this player 12 or younger?
        </label>
        <input
          type="email"
          placeholder={isUnder13 ? 'Parent Email' : 'Parent or Player Email'}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Choose a Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
        />
        <input
          type="password"
          placeholder="Confirm Password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={6}
        />
        <button className="btn btn-orange" type="submit" disabled={loading} style={{ background: teamColor }}>
          {loading ? 'Creating Account...' : 'Create Account'}
        </button>
      </form>
      <div style={{ marginTop: 16, textAlign: 'center' }}>
        <a href={`/t/${joinCode}`} style={{ color: teamColor, fontSize: '0.85em', textDecoration: 'none' }}>
          Already have an account? Sign in
        </a>
      </div>
    </div>
  );
}
