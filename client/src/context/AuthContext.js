import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

const API_BASE = process.env.REACT_APP_API_URL || '';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState([]);
  const [activeTeamId, setActiveTeamIdState] = useState(localStorage.getItem('activeTeamId'));
  const [teamInfo, setTeamInfo] = useState(null); // For player: their team info
  const [impersonating, setImpersonating] = useState(null); // { name, real_token }

  useEffect(() => {
    if (token) {
      fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((data) => {
          setUser(data.user);
          if (data.teams) {
            setTeams(data.teams);
            // Auto-select first team if no active team set
            if (!activeTeamId && data.teams.length > 0) {
              setActiveTeamIdState(data.teams[0].id);
              localStorage.setItem('activeTeamId', data.teams[0].id);
            }
          }
          if (data.team) {
            setTeamInfo(data.team);
          }
          // Track impersonation state from server response
          if (data.impersonating) {
            setImpersonating(prev => prev ? { ...prev, real_user_name: data.real_user_name } : null);
          }
          setLoading(false);
        })
        .catch(() => {
          localStorage.removeItem('token');
          localStorage.removeItem('activeTeamId');
          setToken(null);
          setUser(null);
          setTeams([]);
          setTeamInfo(null);
          setImpersonating(null);
          setLoading(false);
        });
    } else {
      setLoading(false);
    }
  }, [token]); // activeTeamId intentionally excluded — only re-fetch on token change

  const loginStaff = async (email, password) => {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    // MFA flow: return data without setting token/user
    if (data.mfa_required || data.mfa_setup_required) {
      return data;
    }

    localStorage.setItem('token', data.token);
    setToken(data.token);
    setUser(data.user);
    if (data.teams) {
      setTeams(data.teams);
      if (data.teams.length > 0) {
        setActiveTeamIdState(data.teams[0].id);
        localStorage.setItem('activeTeamId', data.teams[0].id);
      }
    }
    return data;
  };

  const completeMfaLogin = (data) => {
    localStorage.setItem('token', data.token);
    setToken(data.token);
    setUser(data.user);
    if (data.teams) {
      setTeams(data.teams);
      if (data.teams.length > 0) {
        setActiveTeamIdState(data.teams[0].id);
        localStorage.setItem('activeTeamId', data.teams[0].id);
      }
    }
  };

  const loginPlayer = async (username, password, joinCode) => {
    const res = await fetch(`${API_BASE}/api/auth/player-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, join_code: joinCode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Login failed');
    if (data.must_change_password) {
      return data;
    }
    localStorage.setItem('token', data.token);
    setToken(data.token);
    setUser(data.user);
    if (data.team) {
      setTeamInfo(data.team);
    }
    return data;
  };

  const completePlayerLogin = (data) => {
    localStorage.setItem('token', data.token);
    setToken(data.token);
    setUser(data.user);
    if (data.team) {
      setTeamInfo(data.team);
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('activeTeamId');
    setToken(null);
    setUser(null);
    setTeams([]);
    setTeamInfo(null);
    setActiveTeamIdState(null);
    setImpersonating(null);
  };

  // Start impersonation: save real token, switch to impersonation token
  const startImpersonation = (impersonationToken, targetUser, targetTeams) => {
    const realToken = token;
    setImpersonating({
      name: `${targetUser.first_name} ${targetUser.last_name}`,
      real_token: realToken,
      impersonated_user_id: targetUser.id,
    });
    localStorage.setItem('token', impersonationToken);
    setToken(impersonationToken);
    setUser(targetUser);
    setTeams(targetTeams || []);
    if (targetTeams && targetTeams.length > 0) {
      setActiveTeamIdState(targetTeams[0].id);
      localStorage.setItem('activeTeamId', targetTeams[0].id);
    }
  };

  // End impersonation: restore real token and navigate back
  const endImpersonation = async () => {
    if (!impersonating) return;
    const realToken = impersonating.real_token;
    const impersonatedUserId = impersonating.impersonated_user_id;

    // Log end of impersonation
    try {
      await fetch(`${API_BASE}/api/super/impersonate/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${realToken}`,
        },
        body: JSON.stringify({ impersonated_user_id: impersonatedUserId }),
      });
    } catch (err) {
      console.error('End impersonation audit error:', err);
    }

    setImpersonating(null);
    localStorage.setItem('token', realToken);
    setToken(realToken);
    // The useEffect on token change will re-fetch /api/auth/me and restore user/teams
  };

  const setActiveTeam = (teamId) => {
    setActiveTeamIdState(teamId);
    localStorage.setItem('activeTeamId', teamId);
  };

  const apiFetch = useCallback(async (url, options = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    };
    // For coaches: add x-team-id header
    if (activeTeamId && user && user.role !== 'player') {
      headers['x-team-id'] = activeTeamId;
    }
    const res = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  }, [token, activeTeamId, user]);

  const activeTeam = teams.find(t => t.id === activeTeamId) || teams[0] || null;

  return (
    <AuthContext.Provider value={{
      user, token, loading,
      loginStaff, loginPlayer, completePlayerLogin, logout,
      completeMfaLogin,
      apiFetch,
      teams, activeTeamId, activeTeam, setActiveTeam,
      teamInfo,
      impersonating, startImpersonation, endImpersonation,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
