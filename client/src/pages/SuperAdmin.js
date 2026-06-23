import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

const LOGO = '/dailyreps3.png';

function formatCurrency(amount) {
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function StatusBadge({ status, comped, manuallySuspended }) {
  let label = status;
  let cls = 'status-badge';
  if (comped) { label = 'comped'; cls += ' status-comped'; }
  else if (manuallySuspended) { label = 'suspended (manual)'; cls += ' status-suspended'; }
  else if (status === 'active') cls += ' status-active';
  else if (status === 'trialing') cls += ' status-trialing';
  else if (status === 'past_due') cls += ' status-pastdue';
  else if (status === 'suspended') cls += ' status-suspended';
  else if (status === 'canceled') cls += ' status-canceled';
  return <span className={cls}>{label}</span>;
}

// ============================================================
// ACCOUNTS LIST VIEW
// ============================================================
function AccountsList({ accounts, totals, onSelect, loading }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dormantFilter, setDormantFilter] = useState(false);

  const filtered = accounts.filter(a => {
    if (search && !a.account_name.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter !== 'all') {
      if (statusFilter === 'comped') { if (!a.comped) return false; }
      else if (a.status !== statusFilter) return false;
    }
    if (dormantFilter && !a.dormant) return false;
    return true;
  });

  return (
    <div>
      <div className="super-totals">
        <div className="super-total-card">
          <div className="super-total-value">{totals.active_accounts}</div>
          <div className="super-total-label">Active + Trialing</div>
        </div>
        <div className="super-total-card">
          <div className="super-total-value">{formatCurrency(totals.mrr)}</div>
          <div className="super-total-label">Monthly-Equivalent Revenue</div>
        </div>
      </div>

      <div className="super-filters">
        <input
          className="form-input"
          placeholder="Search by name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <select
          className="form-input"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          style={{ maxWidth: 180 }}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="trialing">Trialing</option>
          <option value="past_due">Past due</option>
          <option value="suspended">Suspended</option>
          <option value="canceled">Canceled</option>
          <option value="comped">Comped</option>
        </select>
        <label className="super-dormant-toggle">
          <input type="checkbox" checked={dormantFilter} onChange={e => setDormantFilter(e.target.checked)} />
          Dormant only
        </label>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No accounts match your filters.</div>
      ) : (
        <div className="super-table-wrap">
          <table className="super-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Plan</th>
                <th>Amount</th>
                <th>Mo. Equiv.</th>
                <th>Status</th>
                <th>Players</th>
                <th>Active %</th>
                <th>Last Activity</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(a => (
                <tr key={a.id} onClick={() => onSelect(a)} className="super-table-row">
                  <td>
                    <div className="super-account-name">{a.account_name}</div>
                    <div className="super-account-type">{a.owner_type === 'club' ? 'Club' : 'Standalone Team'}</div>
                  </td>
                  <td>
                    <div>{a.plan_name}</div>
                    <div className="super-account-type">{a.billing_interval}</div>
                  </td>
                  <td>{a.comped ? 'Comped' : `${formatCurrency(a.amount)}/${a.billing_interval === 'annual' ? 'yr' : 'mo'}`}</td>
                  <td>{formatCurrency(a.monthly_equivalent)}</td>
                  <td><StatusBadge status={a.status} comped={a.comped} manuallySuspended={a.manually_suspended} /></td>
                  <td>{a.no_subscription ? a.player_count : `${a.player_count} of ${a.player_cap}`}</td>
                  <td>{a.active_percent}%</td>
                  <td>
                    <div>{formatDate(a.last_activity)}</div>
                    {a.dormant && <span className="dormant-flag">DORMANT</span>}
                  </td>
                  <td><span className="super-arrow">&rsaquo;</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================
// ACCOUNT DETAIL VIEW
// ============================================================
function AccountDetail({ accountId, onBack, apiFetch }) {
  const { startImpersonation } = useAuth();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [actionMsg, setActionMsg] = useState('');
  const [actionError, setActionError] = useState('');
  const [trialDays, setTrialDays] = useState(14);
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountForm, setDiscountForm] = useState({ type: 'percent_off', value: '', duration: 'once', duration_in_months: 3 });

  const loadDetail = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/super/accounts/${accountId}`);
      setDetail(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [accountId, apiFetch]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const doAction = async (path, body, msg) => {
    setActionLoading(path);
    setActionMsg('');
    setActionError('');
    try {
      const data = await apiFetch(`/api/super/accounts/${accountId}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setActionMsg(data.message || msg || 'Done.');
      loadDetail();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionLoading('');
    }
  };

  const handleImpersonate = async (userId) => {
    try {
      const data = await apiFetch('/api/super/impersonate', {
        method: 'POST',
        body: JSON.stringify({ user_id: userId }),
      });
      startImpersonation(data.token, data.user, data.teams);
      // Navigate to the appropriate page for the impersonated role
      if (data.user.role === 'club_admin') {
        navigate('/club');
      } else {
        navigate('/admin');
      }
    } catch (err) {
      setActionError(err.message);
    }
  };

  const handleDiscount = async (e) => {
    e.preventDefault();
    await doAction('discount', discountForm, 'Discount applied.');
    setShowDiscount(false);
  };

  if (loading) return <div className="loading"><div className="spinner" /></div>;
  if (!detail) return <div style={{ color: 'var(--text-muted)', padding: 40 }}>Failed to load account.</div>;

  const { billing, teams, engagement, impersonatable_users } = detail;

  return (
    <div>
      <button className="btn btn-outline btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>&larr; Back to accounts</button>
      <h2 className="page-title" style={{ marginBottom: 16 }}>{detail.account_name}</h2>

      {actionMsg && <div className="super-action-msg success">{actionMsg}</div>}
      {actionError && <div className="super-action-msg error">{actionError}</div>}

      {/* Billing Summary */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>Billing</h3>
        <div className="super-detail-grid">
          <div><span className="detail-label">Plan:</span> {billing.plan_name} ({billing.billing_interval})</div>
          <div><span className="detail-label">Amount:</span> {billing.comped ? 'Comped' : formatCurrency(billing.amount)}{!billing.comped && `/${billing.billing_interval === 'annual' ? 'yr' : 'mo'}`}</div>
          <div><span className="detail-label">Status:</span> <StatusBadge status={billing.status} comped={billing.comped} manuallySuspended={billing.manually_suspended} /></div>
          <div><span className="detail-label">Next billing:</span> {formatDate(billing.current_period_end)}</div>
          <div><span className="detail-label">Card:</span> {billing.card_brand ? `${billing.card_brand} ****${billing.card_last4}` : '—'}</div>
          <div><span className="detail-label">Player cap:</span> {billing.player_cap}{billing.addon_quantity > 0 && ` (${billing.addon_quantity} add-on)`}</div>
          {billing.comped && <div><span className="detail-label">Comped since:</span> {formatDate(billing.comped_at)}</div>}
          {billing.status === 'trialing' && <div><span className="detail-label">Trial ends:</span> {formatDate(billing.trial_end)}</div>}
        </div>
      </div>

      {/* Engagement Summary */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>Engagement</h3>
        <div className="super-detail-grid">
          <div><span className="detail-label">Total players:</span> {engagement.total_players}</div>
          <div><span className="detail-label">Active this week:</span> {engagement.active_this_week} ({engagement.active_percent}%)</div>
          <div><span className="detail-label">Completion rate:</span> {engagement.completion_rate}%</div>
          <div><span className="detail-label">Dormant teams:</span> {engagement.dormant_teams}</div>
        </div>
      </div>

      {/* Teams */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>Teams ({teams.length})</h3>
        {teams.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No teams.</div>
        ) : (
          <table className="super-table super-table-compact">
            <thead>
              <tr>
                <th>Team</th>
                <th>Players</th>
                <th>Active</th>
                <th>Completion</th>
                <th>Last Activity</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {teams.map(t => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.player_count}</td>
                  <td>{t.active_this_week}</td>
                  <td>{t.completion_rate}%</td>
                  <td>
                    {formatDate(t.last_activity)}
                    {t.dormant && <span className="dormant-flag" style={{ marginLeft: 8 }}>DORMANT</span>}
                  </td>
                  <td><span className={`team-status-dot ${t.status}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Impersonation */}
      {impersonatable_users.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>View As (Read-Only)</h3>
          <div className="super-impersonate-list">
            {impersonatable_users.map(u => (
              <div key={u.id} className="super-impersonate-item">
                <div>
                  <strong>{u.first_name} {u.last_name}</strong>
                  <span className="super-account-type" style={{ marginLeft: 8 }}>{u.role === 'club_admin' ? 'Club Admin' : 'Coach'}</span>
                </div>
                <button className="btn btn-sm btn-outline" onClick={() => handleImpersonate(u.id)}>View as</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Management Actions */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>Actions</h3>
        {billing.no_subscription && (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: 12 }}>
            This account has no billing subscription. Billing actions (trial, discount) are not available until a plan is selected.
          </div>
        )}
        <div className="super-actions">
          {/* Extend Trial */}
          {!billing.no_subscription && (billing.status === 'trialing' || billing.trial_end) && (
            <div className="super-action-row">
              <label className="detail-label">Extend trial by</label>
              <input type="number" className="form-input" value={trialDays} onChange={e => setTrialDays(e.target.value)} min={1} max={365} style={{ width: 80 }} />
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>days</span>
              <button
                className="btn btn-sm btn-orange"
                onClick={() => doAction('extend-trial', { days: parseInt(trialDays) })}
                disabled={!!actionLoading}
              >
                {actionLoading === 'extend-trial' ? 'Extending...' : 'Extend'}
              </button>
            </div>
          )}

          {/* Comp / Remove Comp */}
          {!billing.no_subscription && <div className="super-action-row">
            {billing.comped ? (
              <button
                className="btn btn-sm btn-outline"
                onClick={() => doAction('remove-comp', {})}
                disabled={!!actionLoading}
              >
                {actionLoading === 'remove-comp' ? 'Removing...' : 'Remove Comp'}
              </button>
            ) : (
              <button
                className="btn btn-sm btn-orange"
                onClick={() => doAction('comp', {})}
                disabled={!!actionLoading}
              >
                {actionLoading === 'comp' ? 'Comping...' : 'Comp Account'}
              </button>
            )}
          </div>}

          {/* Discount */}
          {!billing.no_subscription && !billing.comped && (
            <div className="super-action-row">
              {showDiscount ? (
                <form onSubmit={handleDiscount} className="super-discount-form">
                  <select
                    className="form-input"
                    value={discountForm.type}
                    onChange={e => setDiscountForm({ ...discountForm, type: e.target.value })}
                    style={{ width: 140 }}
                  >
                    <option value="percent_off">% off</option>
                    <option value="amount_off">$ off</option>
                  </select>
                  <input
                    className="form-input"
                    type="number"
                    placeholder={discountForm.type === 'percent_off' ? '10' : '5.00'}
                    value={discountForm.value}
                    onChange={e => setDiscountForm({ ...discountForm, value: e.target.value })}
                    min={1}
                    step={discountForm.type === 'amount_off' ? '0.01' : '1'}
                    required
                    style={{ width: 80 }}
                  />
                  <select
                    className="form-input"
                    value={discountForm.duration}
                    onChange={e => setDiscountForm({ ...discountForm, duration: e.target.value })}
                    style={{ width: 130 }}
                  >
                    <option value="once">One-time</option>
                    <option value="repeating">Repeating</option>
                    <option value="forever">Forever</option>
                  </select>
                  {discountForm.duration === 'repeating' && (
                    <>
                      <input
                        className="form-input"
                        type="number"
                        value={discountForm.duration_in_months}
                        onChange={e => setDiscountForm({ ...discountForm, duration_in_months: e.target.value })}
                        min={1}
                        style={{ width: 60 }}
                      />
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>months</span>
                    </>
                  )}
                  <button type="submit" className="btn btn-sm btn-orange" disabled={!!actionLoading}>
                    {actionLoading === 'discount' ? 'Applying...' : 'Apply'}
                  </button>
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => setShowDiscount(false)}>Cancel</button>
                </form>
              ) : (
                <button className="btn btn-sm btn-outline" onClick={() => setShowDiscount(true)}>Apply Discount</button>
              )}
            </div>
          )}

          {/* Suspend / Reactivate */}
          <div className="super-action-row">
            {billing.status === 'suspended' || billing.manually_suspended ? (
              <button
                className="btn btn-sm btn-orange"
                onClick={() => doAction('reactivate', {})}
                disabled={!!actionLoading}
              >
                {actionLoading === 'reactivate' ? 'Reactivating...' : 'Reactivate'}
              </button>
            ) : (
              <button
                className="btn btn-sm btn-danger"
                onClick={() => { if (window.confirm('Suspend this account? It will become read-only.')) doAction('suspend', {}); }}
                disabled={!!actionLoading}
              >
                {actionLoading === 'suspend' ? 'Suspending...' : 'Suspend'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CREATE CLUB FORM (preserved from Build 3)
// ============================================================
function CreateClubModal({ apiFetch, onClose, onSuccess }) {
  const [form, setForm] = useState({ club_name: '', admin_email: '', admin_first_name: '', admin_last_name: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await apiFetch('/api/super/clubs', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      onSuccess(`Club "${form.club_name}" created. Invitation sent to ${form.admin_email}.`);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Create Club</h2>
        {error && <div style={{ color: '#e74c3c', marginBottom: 12 }}>{error}</div>}
        <form onSubmit={handleCreate}>
          <div className="form-group">
            <label className="form-label">Club Name</label>
            <input className="form-input" value={form.club_name} onChange={e => setForm({ ...form, club_name: e.target.value })} placeholder="e.g. Lightning FC" required />
          </div>
          <div className="form-group">
            <label className="form-label">Club Admin Email</label>
            <input className="form-input" type="email" value={form.admin_email} onChange={e => setForm({ ...form, admin_email: e.target.value })} autoCapitalize="none" required />
          </div>
          <div className="form-group">
            <label className="form-label">Admin First Name</label>
            <input className="form-input" value={form.admin_first_name} onChange={e => setForm({ ...form, admin_first_name: e.target.value })} required />
          </div>
          <div className="form-group">
            <label className="form-label">Admin Last Name</label>
            <input className="form-input" value={form.admin_last_name} onChange={e => setForm({ ...form, admin_last_name: e.target.value })} required />
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 16 }}>
            The club admin will receive an email invitation to set their password and complete MFA setup.
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Creating...' : 'Create Club'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// MAIN SUPER ADMIN COMPONENT
// ============================================================
export default function SuperAdmin() {
  const { user, logout, apiFetch } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [totals, setTotals] = useState({ active_accounts: 0, mrr: 0 });
  const [loading, setLoading] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [success, setSuccess] = useState('');

  const loadAccounts = useCallback(async () => {
    try {
      const data = await apiFetch('/api/super/accounts');
      setAccounts(data.accounts);
      setTotals(data.totals);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  return (
    <div className="admin-layout">
      <header className="header">
        <div className="header-left">
          <img src={LOGO} alt="Daily Reps" className="header-logo" />
          <div className="header-title"><span>Daily Reps</span> Super Admin</div>
        </div>
        <button className="header-logout" onClick={logout}>Log out</button>
      </header>
      <div className="admin-page">
        {!selectedAccountId && (
          <div className="flex-between mb-16">
            <h1 className="page-title" style={{ marginBottom: 0 }}>Accounts</h1>
            <button className="btn btn-orange btn-sm" onClick={() => setShowCreate(true)}>+ Create Club</button>
          </div>
        )}

        {success && <div style={{ color: 'var(--success)', marginBottom: 16, padding: '12px 16px', background: 'rgba(46,204,113,0.1)', borderRadius: 8 }}>{success}</div>}

        {selectedAccountId ? (
          <AccountDetail
            accountId={selectedAccountId}
            onBack={() => { setSelectedAccountId(null); loadAccounts(); }}
            apiFetch={apiFetch}
          />
        ) : (
          <AccountsList
            accounts={accounts}
            totals={totals}
            onSelect={a => setSelectedAccountId(a.id)}
            loading={loading}
          />
        )}

        {!selectedAccountId && (
          <div className="card" style={{ textAlign: 'left', marginTop: 24 }}>
            <div style={{ marginBottom: 8 }}><strong>Logged in as:</strong></div>
            <div>{user?.first_name} {user?.last_name}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{user?.email}</div>
            <div style={{ color: 'var(--orange)', fontSize: '0.85rem', marginTop: 4 }}>Role: {user?.role}</div>
          </div>
        )}

        {showCreate && (
          <CreateClubModal
            apiFetch={apiFetch}
            onClose={() => setShowCreate(false)}
            onSuccess={(msg) => { setSuccess(msg); loadAccounts(); }}
          />
        )}
      </div>
    </div>
  );
}
