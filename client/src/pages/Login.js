import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import MfaVerify from './MfaVerify';
import MfaSetup from './MfaSetup';

const LOGO = '/dailyreps3.png';

export default function Login() {
  const { loginStaff, completeMfaLogin } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // MFA states
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaSession, setMfaSession] = useState(null);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);
  const [setupToken, setSetupToken] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await loginStaff(email, password);

      if (data.mfa_required) {
        setMfaRequired(true);
        setMfaSession(data.mfa_session);
        setLoading(false);
        return;
      }

      if (data.mfa_setup_required) {
        setMfaSetupRequired(true);
        setSetupToken(data.token);
        setLoading(false);
        return;
      }

      // Normal login completed via AuthContext
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleMfaComplete = (data) => {
    completeMfaLogin(data);
  };

  const handleMfaBack = () => {
    setMfaRequired(false);
    setMfaSession(null);
    setEmail('');
    setPassword('');
  };

  if (mfaRequired) {
    return <MfaVerify mfaSession={mfaSession} onComplete={handleMfaComplete} onBack={handleMfaBack} />;
  }

  if (mfaSetupRequired) {
    return <MfaSetup token={setupToken} onComplete={handleMfaComplete} />;
  }

  return (
    <div className="login-page">
      <img src={LOGO} alt="Daily Reps" className="login-logo" />
      <h1 className="login-title">
        <span>Daily Reps</span> Coach Login
      </h1>
      <form className="login-form" onSubmit={handleSubmit}>
        {error && <div className="login-error">{error}</div>}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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
        <button className="btn btn-orange" type="submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
