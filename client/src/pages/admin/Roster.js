import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import Avatar from '../../components/Avatar';

export default function Roster() {
  const { apiFetch } = useAuth();
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [resetPlayer, setResetPlayer] = useState(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', username: '', password: '', parent_email: '' });
  const [resetPw, setResetPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [teamInfo, setTeamInfo] = useState(null);
  const [consentPlayer, setConsentPlayer] = useState(null);
  const [consentForm, setConsentForm] = useState({ parent_name: '', document_reference: '' });
  const [actionMsg, setActionMsg] = useState('');

  const loadPlayers = async () => {
    try {
      const data = await apiFetch('/api/admin/players');
      setPlayers(data.players);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  const loadTeamInfo = async () => {
    try {
      const data = await apiFetch('/api/admin/teams/current');
      setTeamInfo(data.team);
    } catch (err) { console.error(err); }
  };

  useEffect(() => { loadPlayers(); loadTeamInfo(); }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { ...form };
      if (!teamInfo?.has_under_13) delete body.parent_email;
      await apiFetch('/api/admin/players', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setForm({ first_name: '', last_name: '', username: '', password: '', parent_email: '' });
      setShowAdd(false);
      loadPlayers();
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const handleToggle = async (id, active) => {
    try {
      await apiFetch(`/api/admin/players/${id}/${active ? 'deactivate' : 'activate'}`, { method: 'PUT' });
      loadPlayers();
    } catch (err) { alert(err.message); }
  };

  const handleDelete = async (player) => {
    if (!window.confirm(`Permanently delete ${player.first_name} ${player.last_name}? This removes all their completions and badges.`)) return;
    try {
      await apiFetch(`/api/admin/players/${player.id}`, { method: 'DELETE' });
      loadPlayers();
    } catch (err) { alert(err.message); }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch(`/api/admin/players/${resetPlayer.id}/reset-password`, {
        method: 'PUT',
        body: JSON.stringify({ password: resetPw }),
      });
      setResetPlayer(null);
      setResetPw('');
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const handleUnder13Toggle = async () => {
    const newVal = !teamInfo?.has_under_13;
    const msg = newVal
      ? 'Enable under-13 consent? Players without granted consent will be locked until a parent consents.'
      : 'Disable under-13 consent? All awaiting players will be unlocked.';
    if (!window.confirm(msg)) return;
    try {
      await apiFetch(`/api/admin/teams/${teamInfo.id}/under-13`, {
        method: 'PUT',
        body: JSON.stringify({ has_under_13: newVal }),
      });
      setActionMsg(newVal ? 'Under-13 consent enabled. Consent emails sent to parents on file.' : 'Under-13 consent disabled. Players unlocked.');
      loadTeamInfo();
      loadPlayers();
      setTimeout(() => setActionMsg(''), 5000);
    } catch (err) { alert(err.message); }
  };

  const handleSendConsent = async (player) => {
    if (!player.parent_email) {
      const email = window.prompt(`Enter parent email for ${player.first_name} ${player.last_name}:`);
      if (!email) return;
      try {
        await apiFetch(`/api/admin/players/${player.id}/update-parent-email`, {
          method: 'PUT',
          body: JSON.stringify({ parent_email: email }),
        });
      } catch (err) { alert(err.message); return; }
    }
    try {
      await apiFetch(`/api/admin/players/${player.id}/send-consent`, { method: 'POST' });
      setActionMsg(`Consent email sent for ${player.first_name}.`);
      setTimeout(() => setActionMsg(''), 5000);
    } catch (err) { alert(err.message); }
  };

  const handleRecordConsent = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch(`/api/admin/players/${consentPlayer.id}/record-consent`, {
        method: 'POST',
        body: JSON.stringify(consentForm),
      });
      setConsentPlayer(null);
      setConsentForm({ parent_name: '', document_reference: '' });
      setActionMsg('Consent recorded. Player activated.');
      loadPlayers();
      setTimeout(() => setActionMsg(''), 5000);
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const consentBadge = (status) => {
    switch (status) {
      case 'granted': return { text: 'Consented', bg: '#d4edda', color: '#155724' };
      case 'awaiting': return { text: 'Awaiting Consent', bg: '#fff3cd', color: '#856404' };
      case 'revoked': return { text: 'Revoked', bg: '#f8d7da', color: '#721c24' };
      case 'not_required': return null;
      default: return null;
    }
  };

  if (loading) return <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>;

  return (
    <div className="admin-page">
      <div className="flex-between mb-16">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Roster</h1>
        <button className="btn btn-orange btn-sm" onClick={() => setShowAdd(true)}>+ Add Player</button>
      </div>

      {teamInfo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '10px 14px', background: '#f5f5f5', borderRadius: 8, justifyContent: 'flex-start' }}>
          <input
            type="checkbox"
            checked={!!teamInfo.has_under_13}
            onChange={handleUnder13Toggle}
            style={{ width: 18, height: 18, cursor: 'pointer' }}
          />
          <span style={{ fontSize: '0.8em', color: '#666' }}>
            {teamInfo.has_under_13 ? 'Players need parental consent to log in' : 'Check this box if you have players under age 13.'}
          </span>
        </div>
      )}

      {actionMsg && (
        <div style={{ background: '#e8f5e9', border: '1px solid #c8e6c9', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '0.9em', textAlign: 'center' }}>
          {actionMsg}
        </div>
      )}

      {players.map((p) => {
        const badge = consentBadge(p.consent_status);
        return (
          <div key={p.id} className={`player-row ${!p.active ? 'inactive' : ''}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar firstName={p.first_name} lastName={p.last_name} level={p.level} latestBadgeEmoji={p.latest_badge_emoji} size={34} />
              <div className="player-info">
                <div className="player-name">
                  {p.first_name} {p.last_name}
                  {badge && (
                    <span style={{ fontSize: '0.7em', fontWeight: 600, padding: '2px 6px', borderRadius: 4, marginLeft: 8, background: badge.bg, color: badge.color }}>
                      {badge.text}
                    </span>
                  )}
                </div>
                <div className="player-username">
                  @{p.username}{!p.active ? ' (inactive)' : ''}
                  {p.parent_email && <span style={{ color: '#999', marginLeft: 6, fontSize: '0.85em' }}>· {p.parent_email}</span>}
                </div>
              </div>
            </div>
            <div className="player-actions">
              {p.consent_status === 'awaiting' && (
                <>
                  <button className="btn btn-blue btn-sm" onClick={() => handleSendConsent(p)}>
                    Send Consent
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => { setConsentPlayer(p); setConsentForm({ parent_name: '', document_reference: '' }); }}>
                    Record Consent
                  </button>
                </>
              )}
              {p.active ? (
                <>
                  <button className="btn btn-outline btn-sm" onClick={() => { setResetPlayer(p); setResetPw(''); }}>
                    Reset PW
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => handleToggle(p.id, true)}>
                    Deactivate
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(p)}>
                    Delete
                  </button>
                </>
              ) : (
                <>
                  <button className="btn btn-blue btn-sm" onClick={() => handleToggle(p.id, false)}>
                    Activate
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(p)}>
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}

      {players.length === 0 && <div className="no-season-msg">No players added yet.</div>}

      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Player</h2>
            <form onSubmit={handleAdd}>
              <div className="form-group">
                <label className="form-label">First Name</label>
                <input className="form-input" value={form.first_name} onChange={(e) => setForm({...form, first_name: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Last Name</label>
                <input className="form-input" value={form.last_name} onChange={(e) => setForm({...form, last_name: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Username</label>
                <input className="form-input" value={form.username} onChange={(e) => setForm({...form, username: e.target.value})} autoCapitalize="none" required />
              </div>
              <div className="form-group">
                <label className="form-label">Password</label>
                <input className="form-input" type="password" value={form.password} onChange={(e) => setForm({...form, password: e.target.value})} required />
              </div>
              {teamInfo?.has_under_13 && (
                <div className="form-group">
                  <label className="form-label">Parent Email <span style={{ fontWeight: 400, color: '#666' }}>(required for consent)</span></label>
                  <input className="form-input" type="email" value={form.parent_email} onChange={(e) => setForm({...form, parent_email: e.target.value})} required />
                </div>
              )}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Adding...' : 'Add Player'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {resetPlayer && (
        <div className="modal-overlay" onClick={() => setResetPlayer(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Reset Password for {resetPlayer.first_name}</h2>
            <form onSubmit={handleReset}>
              <div className="form-group">
                <label className="form-label">New Password</label>
                <input className="form-input" type="password" value={resetPw} onChange={(e) => setResetPw(e.target.value)} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setResetPlayer(null)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Saving...' : 'Reset Password'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {consentPlayer && (
        <div className="modal-overlay" onClick={() => setConsentPlayer(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Record Consent for {consentPlayer.first_name} {consentPlayer.last_name}</h2>
            <p style={{ color: '#666', fontSize: '0.9em', marginBottom: 16 }}>
              Use this if consent was provided via a signed paper form or other document.
            </p>
            <form onSubmit={handleRecordConsent}>
              <div className="form-group">
                <label className="form-label">Parent/Guardian Name</label>
                <input className="form-input" value={consentForm.parent_name} onChange={(e) => setConsentForm({...consentForm, parent_name: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Document Reference <span style={{ fontWeight: 400, color: '#666' }}>(e.g. "Signed form 6/20/2026")</span></label>
                <input className="form-input" value={consentForm.document_reference} onChange={(e) => setConsentForm({...consentForm, document_reference: e.target.value})} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setConsentPlayer(null)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Saving...' : 'Record Consent'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
