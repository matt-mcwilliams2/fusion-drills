import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

const LOGO = '/dailyreps3.png';

export default function ClubAdmin() {
  const { user, logout, apiFetch } = useAuth();
  const [activeTab, setActiveTab] = useState('teams');
  const [dashboard, setDashboard] = useState(null);
  const [coaches, setCoaches] = useState([]);
  const [loading, setLoading] = useState(true);

  // Modals
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [showInviteCoach, setShowInviteCoach] = useState(false);
  const [showMovePlayer, setShowMovePlayer] = useState(false);
  const [showImport, setShowImport] = useState(false);

  // Forms
  const [teamForm, setTeamForm] = useState({ name: '', age_group: '', has_under_13: false, coach_ids: [] });
  const [inviteForm, setInviteForm] = useState({ email: '', team_id: '' });
  const [moveForm, setMoveForm] = useState({ player_id: '', destination_team_id: '' });

  // Import
  const [csvText, setCsvText] = useState('');
  const [importPreview, setImportPreview] = useState(null);
  const [importResult, setImportResult] = useState(null);

  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  // Reports
  const [clubReports, setClubReports] = useState(null);
  const [reportsLoading, setReportsLoading] = useState(false);

  // Players for move (loaded when a team is selected)
  const [teamPlayers, setTeamPlayers] = useState([]);
  const [moveSourceTeam, setMoveSourceTeam] = useState('');

  const loadDashboard = useCallback(async () => {
    try {
      const data = await apiFetch('/api/club/dashboard');
      setDashboard(data);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [apiFetch]);

  const loadCoaches = useCallback(async () => {
    try {
      const data = await apiFetch('/api/club/coaches');
      setCoaches(data.coaches);
    } catch (err) { console.error(err); }
  }, [apiFetch]);

  const loadClubReports = useCallback(async () => {
    setReportsLoading(true);
    try {
      const data = await apiFetch('/api/club/reports');
      setClubReports(data);
    } catch (err) { console.error(err); }
    finally { setReportsLoading(false); }
  }, [apiFetch]);

  useEffect(() => { loadDashboard(); loadCoaches(); }, [loadDashboard, loadCoaches]);

  const loadTeamPlayers = async (teamId) => {
    setMoveSourceTeam(teamId);
    try {
      const data = await apiFetch('/api/admin/players', {
        headers: { 'x-team-id': teamId },
      });
      setTeamPlayers(data.players);
    } catch (err) { console.error(err); }
  };

  // Create team
  const handleCreateTeam = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await apiFetch('/api/club/teams', {
        method: 'POST',
        body: JSON.stringify(teamForm),
      });
      setShowCreateTeam(false);
      setTeamForm({ name: '', age_group: '', has_under_13: false, coach_ids: [] });
      setSuccess('Team created successfully.');
      loadDashboard();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  // Invite coach
  const handleInviteCoach = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const data = await apiFetch('/api/club/invitations', {
        method: 'POST',
        body: JSON.stringify(inviteForm),
      });
      setShowInviteCoach(false);
      setInviteForm({ email: '', team_id: '' });
      setSuccess(data.linked ? data.message : `Invitation sent to ${inviteForm.email}.`);
      loadDashboard();
      loadCoaches();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  // Move player
  const handleMovePlayer = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const data = await apiFetch(`/api/club/players/${moveForm.player_id}/move`, {
        method: 'POST',
        body: JSON.stringify({ destination_team_id: moveForm.destination_team_id }),
      });
      setShowMovePlayer(false);
      setMoveForm({ player_id: '', destination_team_id: '' });
      setSuccess(data.message);
      loadDashboard();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  // CSV Import
  const parseCSV = (text) => {
    const lines = text.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return [];
    // Skip header if it looks like one
    let start = 0;
    const firstLine = lines[0].toLowerCase();
    if (firstLine.includes('team') && firstLine.includes('name')) start = 1;

    return lines.slice(start).map(line => {
      const cells = line.split(',').map(c => c.trim());
      return {
        team_name: cells[0] || '',
        under_13: cells[1] || '',
        type: cells[2] || '',
        first_name: cells[3] || '',
        last_name: cells[4] || '',
        email: cells[5] || '',
      };
    });
  };

  const handleImportPreview = async () => {
    setError('');
    setImportResult(null);
    const rows = parseCSV(csvText);
    if (rows.length === 0) { setError('No data to import'); return; }
    setSaving(true);
    try {
      const data = await apiFetch('/api/club/import', {
        method: 'POST',
        body: JSON.stringify({ rows, preview: true }),
      });
      setImportPreview(data);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleImportCommit = async () => {
    setError('');
    const rows = parseCSV(csvText);
    setSaving(true);
    try {
      const data = await apiFetch('/api/club/import', {
        method: 'POST',
        body: JSON.stringify({ rows, preview: false }),
      });
      setImportResult(data);
      setImportPreview(null);
      loadDashboard();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const downloadCredentials = (credentials) => {
    const header = 'Team,First Name,Last Name,Username,Password';
    const csvRows = credentials.map(c =>
      `${c.team_name},${c.first_name},${c.last_name},${c.username},${c.password}`
    );
    const csv = [header, ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'player-credentials.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setCsvText(ev.target.result);
    reader.readAsText(file);
  };

  const ageGroups = ['U6','U7','U8','U9','U10','U11','U12','U13','U14','U15','U16','U17','U18','U19'];

  if (loading) {
    return (
      <div className="admin-layout">
        <header className="header">
          <div className="header-left">
            <img src={LOGO} alt="Daily Reps" className="header-logo" />
            <div className="header-title"><span>Daily Reps</span> Club Admin</div>
          </div>
          <button className="header-logout" onClick={logout}>Log out</button>
        </header>
        <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>
      </div>
    );
  }

  return (
    <div className="admin-layout">
      <header className="header">
        <div className="header-left">
          <img src={LOGO} alt="Daily Reps" className="header-logo" />
          <div className="header-title"><span>Daily Reps</span> {dashboard?.club?.name || 'Club Admin'}</div>
        </div>
        <button className="header-logout" onClick={logout}>Log out</button>
      </header>

      <nav className="admin-nav">
        {['teams','reports','import','billing'].map(tab => (
          <button key={tab} className={`admin-nav-item ${activeTab === tab ? 'active' : ''}`}
            onClick={() => { setActiveTab(tab); setSuccess(''); setError(''); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
            {tab === 'teams' ? 'Teams' : tab === 'reports' ? 'Reports' : tab === 'import' ? 'Import' : 'Billing'}
          </button>
        ))}
      </nav>

      <div className="admin-page">
        {/* Plan usage */}
        <div className="card" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>Players</strong>
            <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
              {dashboard?.total_players || 0}
              {dashboard?.club?.player_limit ? ` of ${dashboard.club.player_limit}` : ''} players
            </span>
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {dashboard?.teams?.length || 0} team{(dashboard?.teams?.length || 0) !== 1 ? 's' : ''}
          </div>
        </div>

        {success && <div style={{ color: 'var(--success)', marginBottom: 12, padding: '10px 14px', background: 'rgba(46,204,113,0.1)', borderRadius: 8 }}>{success}</div>}
        {error && <div style={{ color: '#e74c3c', marginBottom: 12, padding: '10px 14px', background: 'rgba(231,76,60,0.1)', borderRadius: 8 }}>{error}</div>}

        {/* TEAMS TAB */}
        {activeTab === 'teams' && (
          <>
            <div className="flex-between mb-16">
              <h2 className="page-title" style={{ marginBottom: 0, fontSize: '1.1rem' }}>Teams</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline btn-sm" onClick={() => { setShowMovePlayer(true); setMoveForm({ player_id: '', destination_team_id: '' }); setMoveSourceTeam(''); setTeamPlayers([]); }}>Move Player</button>
                <button className="btn btn-outline btn-sm" onClick={() => { setShowInviteCoach(true); setInviteForm({ email: '', team_id: '' }); }}>Invite Coach</button>
                <button className="btn btn-orange btn-sm" onClick={() => { setShowCreateTeam(true); setTeamForm({ name: '', age_group: '', has_under_13: false, coach_ids: [] }); }}>+ Create Team</button>
              </div>
            </div>

            {(!dashboard?.teams || dashboard.teams.length === 0) && (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No teams yet. Create your first team.</div>
            )}

            {dashboard?.teams?.map(team => (
              <div key={team.id} className="card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <strong>{team.name}</strong>
                    {team.age_group && <span style={{ marginLeft: 8, fontSize: '0.8rem', color: 'var(--text-muted)' }}>{team.age_group}</span>}
                    {team.has_under_13 && <span style={{ marginLeft: 8, fontSize: '0.7rem', padding: '1px 6px', borderRadius: 4, background: 'rgba(241,196,15,0.15)', color: '#f1c40f' }}>Under-13</span>}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {team.join_code}
                  </div>
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 6 }}>
                  {team.player_count} player{parseInt(team.player_count) !== 1 ? 's' : ''}
                  {team.active_season_name && <span> &middot; {team.active_season_name}</span>}
                </div>
                {team.coaches && team.coaches.length > 0 && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
                    Coach{team.coaches.length !== 1 ? 'es' : ''}: {team.coaches.map(c => `${c.first_name} ${c.last_name}`).join(', ')}
                  </div>
                )}
              </div>
            ))}

            {/* Pending invitations */}
            {dashboard?.invitations?.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <h3 style={{ fontSize: '0.95rem', marginBottom: 8 }}>Pending Invitations</h3>
                {dashboard.invitations.map(inv => (
                  <div key={inv.id} className="card" style={{ marginBottom: 6, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span>{inv.email}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: 8 }}>{inv.role}</span>
                      {inv.team_name && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: 8 }}>&middot; {inv.team_name}</span>}
                    </div>
                    <span style={{ fontSize: '0.7rem', color: 'var(--orange)' }}>pending</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* REPORTS TAB */}
        {activeTab === 'reports' && (
          <>
            <h2 className="page-title" style={{ fontSize: '1.1rem' }}>Club Reports</h2>
            {!clubReports && !reportsLoading && (
              <button className="btn btn-orange btn-sm" onClick={loadClubReports}>Load Reports</button>
            )}
            {reportsLoading && <div className="loading"><div className="spinner" /></div>}
            {clubReports && (
              <>
                {/* Club-wide summary */}
                <div className="card" style={{ marginBottom: 12, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>This Week</div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>
                        <span style={{ color: 'var(--orange)' }}>{clubReports.active_this_week}</span>
                        <span style={{ fontSize: '0.85rem', fontWeight: 400, color: 'var(--text-muted)' }}> of {clubReports.total_players} active</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Completion Rate</div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--orange)' }}>{clubReports.club_completion_rate}%</div>
                    </div>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 6 }}>
                    {clubReports.total_teams} team{clubReports.total_teams !== 1 ? 's' : ''} &middot; {clubReports.total_players} players
                  </div>
                </div>

                {/* Dormant teams warning */}
                {clubReports.team_stats.some(t => t.dormant) && (
                  <div style={{ background: 'rgba(243,156,18,0.1)', border: '1px solid rgba(243,156,18,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: '0.82rem' }}>
                    <div style={{ fontWeight: 700, color: '#f39c12', marginBottom: 4 }}>Dormant Teams</div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      No activity in 10+ days: {clubReports.team_stats.filter(t => t.dormant).map(t => t.name).join(', ')}
                    </div>
                  </div>
                )}

                {/* Weekly trend */}
                {(() => {
                  const maxW = Math.max(...clubReports.weekly_trend.map(w => w.completions), 1);
                  return (
                    <div className="card" style={{ marginBottom: 12, padding: '14px 16px' }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 10 }}>Weekly Completions (Club-wide)</div>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
                        {clubReports.weekly_trend.map((w, i) => {
                          const fmtDate = (ds) => { const d = new Date((ds||'').split('T')[0] + 'T00:00:00'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
                          return (
                            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{w.completions || ''}</div>
                              <div style={{ width: '100%', background: i === clubReports.weekly_trend.length - 1 ? 'var(--orange)' : 'var(--card-border)', borderRadius: 3, height: `${Math.max((w.completions / maxW) * 60, 2)}px` }} />
                              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{fmtDate(w.week_start)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Per-team stats */}
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 8 }}>Teams</div>
                {clubReports.team_stats.map(t => (
                  <div key={t.id} className="card" style={{ marginBottom: 6, padding: '10px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <span style={{ fontWeight: 600 }}>{t.name}</span>
                        {t.dormant && <span style={{ marginLeft: 8, fontSize: '0.7rem', padding: '1px 6px', borderRadius: 4, background: 'rgba(243,156,18,0.15)', color: '#f39c12' }}>Dormant</span>}
                        {!t.has_season && <span style={{ marginLeft: 8, fontSize: '0.7rem', padding: '1px 6px', borderRadius: 4, background: 'rgba(108,108,108,0.15)', color: 'var(--text-muted)' }}>No season</span>}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {t.last_activity ? (() => {
                          const d = new Date(t.last_activity);
                          const diff = Math.floor((new Date() - d) / (1000*60*60*24));
                          return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : `${diff}d ago`;
                        })() : 'Never'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      <span>{t.player_count} players</span>
                      <span>{t.active_percent}% active this week</span>
                      <span>{t.completion_rate}% completion rate</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {/* IMPORT TAB */}
        {activeTab === 'import' && (
          <>
            <h2 className="page-title" style={{ fontSize: '1.1rem' }}>Bulk Team Import</h2>
            <div className="card" style={{ marginBottom: 16 }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                Upload a CSV to create teams, coaches, and players in one pass. Columns (comma-separated):
              </p>
              <code style={{ display: 'block', fontSize: '0.8rem', background: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 6, marginBottom: 12, color: 'var(--orange)' }}>
                Team Name, Under 13?, Coach or Player, First Name, Last Name, Email
              </code>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                Email is required for coaches. For players on under-13 teams, email is the parent email for consent. A header row is optional.
              </p>
              <div style={{ marginBottom: 12 }}>
                <input type="file" accept=".csv,.txt" onChange={handleFileUpload} style={{ marginBottom: 8 }} />
              </div>
              <textarea
                className="form-input"
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="Or paste CSV data here..."
                rows={8}
                style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}
              />
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button className="btn btn-blue btn-sm" onClick={handleImportPreview} disabled={saving || !csvText.trim()}>
                  {saving ? 'Validating...' : 'Preview Import'}
                </button>
                {importPreview && importPreview.summary.errors.length === 0 && (
                  <button className="btn btn-orange btn-sm" onClick={handleImportCommit} disabled={saving}>
                    {saving ? 'Importing...' : 'Commit Import'}
                  </button>
                )}
              </div>
            </div>

            {importPreview && (
              <div className="card" style={{ marginBottom: 16 }}>
                <h3 style={{ fontSize: '0.95rem', marginBottom: 8 }}>Preview</h3>
                <div style={{ fontSize: '0.85rem', marginBottom: 8 }}>
                  <div>Teams to create: <strong>{importPreview.summary.teams_to_create}</strong></div>
                  <div>Existing teams: <strong>{importPreview.summary.teams_existing}</strong></div>
                  <div>Coaches: <strong>{importPreview.summary.coaches}</strong></div>
                  <div>Players: <strong>{importPreview.summary.players}</strong></div>
                </div>
                {importPreview.errors.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {importPreview.errors.map((err, i) => (
                      <div key={i} style={{ fontSize: '0.8rem', color: err.error ? '#e74c3c' : '#f39c12', marginBottom: 4 }}>
                        Row {err.row}: {err.error || err.warning}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {importResult && (
              <div className="card">
                <h3 style={{ fontSize: '0.95rem', marginBottom: 8, color: 'var(--success)' }}>Import Complete</h3>
                <div style={{ fontSize: '0.85rem', marginBottom: 12 }}>
                  <div>Teams created: <strong>{importResult.summary.teams_created}</strong></div>
                  <div>Coaches processed: <strong>{importResult.summary.coaches_processed}</strong></div>
                  <div>Players created: <strong>{importResult.summary.players_created}</strong></div>
                </div>
                {importResult.credentials.length > 0 && (
                  <button className="btn btn-blue btn-sm" onClick={() => downloadCredentials(importResult.credentials)}>
                    Download Player Credentials CSV
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* BILLING TAB */}
        {activeTab === 'billing' && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <h2 className="page-title" style={{ fontSize: '1.1rem' }}>Billing</h2>
            <p style={{ color: 'var(--text-muted)' }}>Billing is managed elsewhere. Coming in Build 5.</p>
          </div>
        )}

        {/* CREATE TEAM MODAL */}
        {showCreateTeam && (
          <div className="modal-overlay" onClick={() => setShowCreateTeam(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>Create Team</h2>
              {error && <div style={{ color: '#e74c3c', marginBottom: 12 }}>{error}</div>}
              <form onSubmit={handleCreateTeam}>
                <div className="form-group">
                  <label className="form-label">Team Name</label>
                  <input className="form-input" value={teamForm.name} onChange={(e) => setTeamForm({...teamForm, name: e.target.value})} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Age Group</label>
                  <select className="form-input" value={teamForm.age_group} onChange={(e) => setTeamForm({...teamForm, age_group: e.target.value})}>
                    <option value="">Select age group</option>
                    {ageGroups.map(ag => <option key={ag} value={ag}>{ag}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={teamForm.has_under_13} onChange={(e) => setTeamForm({...teamForm, has_under_13: e.target.checked})} />
                    <span className="form-label" style={{ marginBottom: 0 }}>Are there any players under the age of 13 on this team?</span>
                  </label>
                </div>
                {coaches.length > 0 && (
                  <div className="form-group">
                    <label className="form-label">Assign Coaches</label>
                    {coaches.map(c => (
                      <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer' }}>
                        <input type="checkbox"
                          checked={teamForm.coach_ids.includes(c.id)}
                          onChange={(e) => {
                            setTeamForm({...teamForm,
                              coach_ids: e.target.checked
                                ? [...teamForm.coach_ids, c.id]
                                : teamForm.coach_ids.filter(id => id !== c.id)
                            });
                          }}
                        />
                        <span style={{ fontSize: '0.9rem' }}>{c.first_name} {c.last_name} ({c.email})</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="modal-actions">
                  <button type="button" className="btn btn-outline" onClick={() => setShowCreateTeam(false)}>Cancel</button>
                  <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Creating...' : 'Create Team'}</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* INVITE COACH MODAL */}
        {showInviteCoach && (
          <div className="modal-overlay" onClick={() => setShowInviteCoach(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>Invite Coach</h2>
              {error && <div style={{ color: '#e74c3c', marginBottom: 12 }}>{error}</div>}
              <form onSubmit={handleInviteCoach}>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" value={inviteForm.email} onChange={(e) => setInviteForm({...inviteForm, email: e.target.value})} autoCapitalize="none" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Assign to Team (optional)</label>
                  <select className="form-input" value={inviteForm.team_id} onChange={(e) => setInviteForm({...inviteForm, team_id: e.target.value})}>
                    <option value="">No team assignment</option>
                    {dashboard?.teams?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                  If this email is already registered, they'll be added to the team immediately. Otherwise, they'll receive an invitation email.
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-outline" onClick={() => setShowInviteCoach(false)}>Cancel</button>
                  <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Inviting...' : 'Invite Coach'}</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MOVE PLAYER MODAL */}
        {showMovePlayer && (
          <div className="modal-overlay" onClick={() => setShowMovePlayer(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>Move Player</h2>
              {error && <div style={{ color: '#e74c3c', marginBottom: 12 }}>{error}</div>}
              <form onSubmit={handleMovePlayer}>
                <div className="form-group">
                  <label className="form-label">From Team</label>
                  <select className="form-input" value={moveSourceTeam} onChange={(e) => { loadTeamPlayers(e.target.value); setMoveForm({...moveForm, player_id: ''}); }}>
                    <option value="">Select source team</option>
                    {dashboard?.teams?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                {moveSourceTeam && (
                  <div className="form-group">
                    <label className="form-label">Player</label>
                    <select className="form-input" value={moveForm.player_id} onChange={(e) => setMoveForm({...moveForm, player_id: e.target.value})} required>
                      <option value="">Select player</option>
                      {teamPlayers.map(p => <option key={p.id} value={p.id}>{p.first_name} {p.last_name} ({p.username})</option>)}
                    </select>
                  </div>
                )}
                <div className="form-group">
                  <label className="form-label">To Team</label>
                  <select className="form-input" value={moveForm.destination_team_id} onChange={(e) => setMoveForm({...moveForm, destination_team_id: e.target.value})} required>
                    <option value="">Select destination team</option>
                    {dashboard?.teams?.filter(t => t.id !== moveSourceTeam).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                  The player keeps their lifetime points. Season stats reset on the new team. If the destination team is under-13 and the player hasn't consented, they'll need parental consent.
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-outline" onClick={() => setShowMovePlayer(false)}>Cancel</button>
                  <button type="submit" className="btn btn-orange" disabled={saving || !moveForm.player_id || !moveForm.destination_team_id}>{saving ? 'Moving...' : 'Move Player'}</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
