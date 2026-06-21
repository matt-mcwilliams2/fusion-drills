import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

const LOGO = '/dailyreps3.png';
const API_BASE = process.env.REACT_APP_API_URL || '';

export default function ParentPortal() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const loadData = () => {
    fetch(`${API_BASE}/api/parent-portal/${token}`)
      .then(r => r.json().then(d => ({ ok: r.ok, data: d })))
      .then(({ ok, data: d }) => {
        if (!ok) {
          setError(d.error || 'Invalid or expired link');
        } else {
          setData(d);
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load portal. The link may have expired.');
        setLoading(false);
      });
  };

  useEffect(() => { loadData(); }, [token]);

  const handleRevoke = async (playerId, playerName) => {
    if (!window.confirm(`Are you sure you want to revoke consent for ${playerName}? Their account will be deactivated and they will no longer be able to log in.`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/parent-portal/${token}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: playerId }),
      });
      const result = await res.json();
      if (!res.ok) {
        setActionMsg(result.error || 'Failed to revoke consent');
        return;
      }
      setActionMsg('Consent revoked. Account deactivated.');
      loadData();
    } catch (err) {
      setActionMsg('Something went wrong. Please try again.');
    }
  };

  const handleDelete = async (playerId, playerName) => {
    if (!window.confirm(`Are you sure you want to request deletion of ${playerName}'s data? This cannot be undone. Their personal information will be permanently removed.`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/parent-portal/${token}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: playerId }),
      });
      const result = await res.json();
      if (!res.ok) {
        setActionMsg(result.error || 'Failed to request deletion');
        return;
      }
      setActionMsg('Deletion request received. Data will be removed within the retention period.');
      loadData();
    } catch (err) {
      setActionMsg('Something went wrong. Please try again.');
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

  if (error) {
    return (
      <div className="login-page">
        <img src={LOGO} alt="Daily Reps" className="login-logo" />
        <h1 className="login-title"><span>Daily Reps</span> Parent Portal</h1>
        <div className="login-error" style={{ fontSize: '1rem', marginTop: 20, maxWidth: 400 }}>
          {error}
        </div>
        <a href="/parent-portal" style={{ color: '#1348e5', marginTop: 16, display: 'block', textAlign: 'center' }}>
          Request a new link
        </a>
      </div>
    );
  }

  const consentStatusLabel = (status) => {
    switch (status) {
      case 'granted': return { text: 'Consent Granted', color: '#28a745' };
      case 'awaiting': return { text: 'Awaiting Consent', color: '#ffc107' };
      case 'revoked': return { text: 'Consent Revoked', color: '#dc3545' };
      case 'not_required': return { text: 'No Consent Required', color: '#6c757d' };
      default: return { text: status || 'Unknown', color: '#6c757d' };
    }
  };

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", maxWidth: 700, margin: '0 auto', padding: 20 }}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <img src={LOGO} alt="Daily Reps" style={{ width: 60, height: 60 }} />
        <h1 style={{ color: '#1348e5', marginBottom: 4 }}>Parent Portal</h1>
        <p style={{ color: '#666' }}>Review your child's data and manage consent.</p>
      </div>

      {actionMsg && (
        <div style={{ background: '#e8f5e9', border: '1px solid #c8e6c9', padding: '12px 16px', borderRadius: 8, marginBottom: 20, textAlign: 'center' }}>
          {actionMsg}
        </div>
      )}

      {data.children.map(child => {
        const cs = consentStatusLabel(child.consent_status);
        return (
          <div key={child.id} style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0 }}>{child.first_name} {child.last_name}</h3>
                <p style={{ margin: '4px 0 0', color: '#666', fontSize: '0.9em' }}>{child.team_name}</p>
              </div>
              <span style={{ color: cs.color, fontWeight: 600, fontSize: '0.85em', padding: '4px 10px', border: `1px solid ${cs.color}`, borderRadius: 12 }}>
                {cs.text}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 16 }}>
              <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: '0.75em', color: '#666', marginBottom: 2 }}>Total Points</div>
                <div style={{ fontSize: '1.2em', fontWeight: 700 }}>{child.lifetime_points}</div>
              </div>
              <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: '0.75em', color: '#666', marginBottom: 2 }}>Current Streak</div>
                <div style={{ fontSize: '1.2em', fontWeight: 700 }}>{child.current_streak}</div>
              </div>
              <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: '0.75em', color: '#666', marginBottom: 2 }}>Longest Streak</div>
                <div style={{ fontSize: '1.2em', fontWeight: 700 }}>{child.longest_streak}</div>
              </div>
              <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: '0.75em', color: '#666', marginBottom: 2 }}>Drills Done</div>
                <div style={{ fontSize: '1.2em', fontWeight: 700 }}>{child.total_completions}</div>
              </div>
              <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: '0.75em', color: '#666', marginBottom: 2 }}>Level</div>
                <div style={{ fontSize: '1.2em', fontWeight: 700 }}>{child.level?.name || 'N/A'}</div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {child.consent_status === 'granted' && (
                <button
                  onClick={() => handleRevoke(child.id, `${child.first_name} ${child.last_name}`)}
                  style={{ padding: '8px 16px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.9em' }}
                >
                  Revoke Consent
                </button>
              )}
              {child.status !== 'inactive' && (
                <button
                  onClick={() => handleDelete(child.id, `${child.first_name} ${child.last_name}`)}
                  style={{ padding: '8px 16px', background: 'white', color: '#dc3545', border: '1px solid #dc3545', borderRadius: 6, cursor: 'pointer', fontSize: '0.9em' }}
                >
                  Request Data Deletion
                </button>
              )}
            </div>
          </div>
        );
      })}

      {data.consent_records.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <h3 style={{ color: '#333' }}>Consent History</h3>
          {data.consent_records.map(cr => (
            <div key={cr.id} style={{ padding: '8px 12px', borderBottom: '1px solid #eee', fontSize: '0.9em', color: '#666' }}>
              <span style={{ fontWeight: 600, color: cr.status === 'granted' ? '#28a745' : '#dc3545' }}>
                {cr.status === 'granted' ? 'Granted' : 'Revoked'}
              </span>
              {' via '}
              {cr.consent_source === 'parent_email' ? 'email' : 'document'}
              {' — '}
              {cr.status === 'granted'
                ? new Date(cr.granted_at).toLocaleDateString()
                : new Date(cr.revoked_at).toLocaleDateString()}
              {' (Policy v'}
              {cr.privacy_policy_version}
              {')'}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 32, textAlign: 'center', paddingTop: 16, borderTop: '1px solid #eee' }}>
        <a href="/privacy" style={{ color: '#666', fontSize: '0.85em' }}>Privacy Policy</a>
        <span style={{ color: '#ccc', margin: '0 8px' }}>|</span>
        <a href="/parent-portal" style={{ color: '#666', fontSize: '0.85em' }}>Request New Link</a>
      </div>
    </div>
  );
}
