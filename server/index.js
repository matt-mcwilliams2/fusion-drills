require('dotenv').config({ path: '../.env' });
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { Resend } = require('resend');
const { TOTP, Secret } = require('otpauth');
const QRCode = require('qrcode');
const cron = require('node-cron');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) console.warn('WARNING: Stripe not configured (STRIPE_SECRET_KEY missing). Billing features disabled.');

const app = express();
const dbUrl = process.env.DATABASE_URL || '';
const isInternalRailway = dbUrl.includes('.railway.internal');

// SSL/TLS configuration:
// - In production (non-internal Railway): pg client connects via SSL
// - Railway managed Postgres provides encryption at rest via disk-level encryption
// - Internal Railway connections use private networking (*.railway.internal) which does not require SSL
// NOTE: Railway database backups should be set to expire on a schedule in the Railway dashboard,
// since backups outlive the live data and may contain personal information subject to retention policy.
const pool = new Pool({
  connectionString: dbUrl,
  ssl: (!isInternalRailway && process.env.NODE_ENV === 'production') ? { rejectUnauthorized: false } : false,
});
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/api/billing/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.static(path.join(__dirname, '../client/build')));

// ============================================================
// LEVELS SYSTEM
// ============================================================

const LEVELS = [
  { name: 'Infantil',         threshold: 0,    color: '#0d1b4c', textColor: '#d4af37', isPrestige: false },
  { name: 'Neymar',           threshold: 89,   color: '#ffd400', textColor: '#000000', isPrestige: false },
  { name: 'Mbappe',           threshold: 230,  color: '#1348e5', textColor: '#000000', isPrestige: false },
  { name: 'Salah',            threshold: 394,  color: '#e11d2a', textColor: '#000000', isPrestige: false },
  { name: 'Yamal',            threshold: 622,  color: '#cd7f32', textColor: '#000000', isPrestige: false },
  { name: 'Iniesta',          threshold: 841,  color: '#e11d2a', textColor: '#ffd400', isPrestige: false },
  { name: 'Haaland',          threshold: 1083, color: '#5bb8e8', textColor: '#000000', isPrestige: false },
  { name: 'Kane',             threshold: 1355, color: '#ffffff', textColor: '#e11d2a', isPrestige: false },
  { name: 'Maradona',         threshold: 1627, color: '#cd7f32', textColor: '#000000', isPrestige: false },
  { name: 'Cruyff',           threshold: 1976, color: '#f77c00', textColor: '#000000', isPrestige: false },
  { name: 'Zlatan',           threshold: 2122, color: '#2f6fed', textColor: '#ffd400', isPrestige: false },
  { name: 'Xavi',             threshold: 2455, color: '#ffffff', textColor: '#e11d2a', isPrestige: false },
  { name: 'Zico',             threshold: 2833, color: '#c0c0c0', textColor: '#000000', isPrestige: false },
  { name: 'Lewandowski',      threshold: 3209, color: '#000000', textColor: '#ffd400', isPrestige: false },
  { name: 'Beckham',          threshold: 3551, color: '#f06ea9', textColor: '#000000', isPrestige: false },
  { name: 'Di Stefano',       threshold: 3839, color: '#5bb8e8', textColor: '#b8860b', isPrestige: false },
  { name: 'Zidane',           threshold: 4203, color: '#e11d2a', textColor: '#5bb8e8', isPrestige: false },
  { name: 'Pele',             threshold: 4534, color: '#1f9d4d', textColor: '#ffd400', isPrestige: false },
  { name: 'Messi',            threshold: 4899, color: '#ff4fa3', textColor: '#000000', isPrestige: false },
  { name: 'Ronaldo',          threshold: 5225, color: '#d4af37', textColor: '#000000', isPrestige: false },
  { name: 'Ronaldo, Man U',   threshold: 5488, color: '#e11d2a', textColor: '#ffffff', isPrestige: true, subtitle: 'Man U' },
  { name: 'Ronaldo, Real Madrid', threshold: 5833, color: '#ffd400', textColor: '#2f6fed', isPrestige: true, subtitle: 'Real Madrid' },
  { name: 'Ronaldo, Juventus', threshold: 6300, color: '#000000', textColor: '#ffffff', isPrestige: true, subtitle: 'Juventus' },
  { name: 'Ronaldo, National Team', threshold: 6745, color: '#e11d2a', textColor: '#8fe388', isPrestige: true, subtitle: 'National Team' },
];

function getLevelInfo(points) {
  let current = LEVELS[0];
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (points >= LEVELS[i].threshold) {
      current = LEVELS[i];
      const next = i < LEVELS.length - 1 ? LEVELS[i + 1] : null;
      return {
        name: current.name,
        color: current.color,
        textColor: current.textColor,
        isPrestige: current.isPrestige || false,
        subtitle: current.subtitle || null,
        nextLevelName: next ? next.name : null,
      };
    }
  }
  return {
    name: current.name,
    color: current.color,
    textColor: current.textColor,
    isPrestige: current.isPrestige || false,
    subtitle: current.subtitle || null,
    nextLevelName: LEVELS[1] ? LEVELS[1].name : null,
  };
}

// ============================================================
// SEASON HELPER
// ============================================================

function effectiveEndDate(season) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const end = season.end_date instanceof Date ? season.end_date : new Date(season.end_date);
  return end >= today ? season.end_date : today;
}

async function getActiveSeasonForTeam(teamId) {
  const result = await pool.query(
    "SELECT * FROM seasons WHERE team_id = $1 AND status = 'active' LIMIT 1",
    [teamId]
  );
  return result.rows[0] || null;
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    req.role = decoded.role;
    // For players, set teamId from JWT
    if (decoded.role === 'player') {
      req.teamId = decoded.team_id;
    }
    // Handle impersonation tokens
    if (decoded.impersonating) {
      // Block writes server-side during impersonation
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return res.status(403).json({ error: 'Read-only mode: writes are blocked during impersonation.' });
      }
      req.isImpersonating = true;
      req.realUser = { id: decoded.real_user_id, role: 'super_admin' };
      // Set role to the impersonated user's role for RBAC
      req.role = decoded.impersonated_role;
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ============================================================
// RBAC MIDDLEWARE
// ============================================================

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Resolve team context for coaches (from x-team-id header) and validate access
async function requireTeamAccess(req, res, next) {
  try {
    if (req.role === 'player') {
      // Player's team is set from JWT
      req.teamId = req.user.team_id;
      return next();
    }

    if (req.role === 'super_admin') {
      // Super admin can pass any team_id
      req.teamId = req.headers['x-team-id'] || null;
      return next();
    }

    if (req.role === 'club_admin') {
      const teamId = req.headers['x-team-id'];
      if (!teamId) return res.status(400).json({ error: 'Team ID required' });
      // Validate team belongs to club_admin's club
      const check = await pool.query(
        'SELECT id FROM teams WHERE id = $1 AND club_id = $2',
        [teamId, req.user.club_id]
      );
      if (check.rows.length === 0) return res.status(403).json({ error: 'Team not in your club' });
      req.teamId = teamId;
      return next();
    }

    if (req.role === 'coach') {
      const teamId = req.headers['x-team-id'];
      if (!teamId) return res.status(400).json({ error: 'Team ID required' });
      // Validate coach has access to this team
      const check = await pool.query(
        'SELECT id FROM coach_teams WHERE user_id = $1 AND team_id = $2',
        [req.user.id, teamId]
      );
      if (check.rows.length === 0) return res.status(403).json({ error: 'No access to this team' });
      req.teamId = teamId;
      return next();
    }

    return res.status(403).json({ error: 'Insufficient permissions' });
  } catch (err) {
    console.error('Team access check error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Club-scoped access for club_admin and super_admin (no x-team-id needed)
async function requireClubAccess(req, res, next) {
  try {
    if (req.role === 'super_admin') {
      req.clubId = req.headers['x-club-id'] || null;
      return next();
    }
    if (req.role === 'club_admin') {
      if (!req.user.club_id) {
        return res.status(403).json({ error: 'No club assigned' });
      }
      req.clubId = req.user.club_id;
      return next();
    }
    return res.status(403).json({ error: 'Club access required' });
  } catch (err) {
    console.error('Club access check error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ============================================================
// EMAIL SERVICE
// ============================================================

const resendClient = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

if (!resendClient) {
  console.warn('WARNING: Email not configured (RESEND_API_KEY missing). Emails will be queued to the database.');
}

async function sendEmail(toEmail, subject, htmlBody) {
  const from = process.env.EMAIL_FROM || 'noreply@dailyreps.app';
  if (resendClient) {
    try {
      await resendClient.emails.send({ from, to: toEmail, subject, html: htmlBody });
      return true;
    } catch (err) {
      console.error('Email send error:', err.message);
      // Fall through to queue
    }
  }

  // Queue to pending_emails table
  try {
    await pool.query(
      'INSERT INTO pending_emails (to_email, subject, html_body) VALUES ($1, $2, $3)',
      [toEmail, subject, htmlBody]
    );
    console.log(`Email queued for ${toEmail}: ${subject}`);
  } catch (err) {
    console.error('Email queue error:', err.message);
  }
  return false;
}

async function processEmailQueue() {
  if (!resendClient) return;
  const from = process.env.EMAIL_FROM || 'noreply@dailyreps.app';
  try {
    const pending = await pool.query(
      "SELECT * FROM pending_emails WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50"
    );
    for (const email of pending.rows) {
      try {
        await resendClient.emails.send({
          from,
          to: email.to_email,
          subject: email.subject,
          html: email.html_body,
        });
        await pool.query(
          "UPDATE pending_emails SET status = 'sent', sent_at = NOW() WHERE id = $1",
          [email.id]
        );
      } catch (err) {
        await pool.query(
          "UPDATE pending_emails SET attempts = attempts + 1, last_error = $1 WHERE id = $2",
          [err.message, email.id]
        );
      }
    }
    if (pending.rows.length > 0) {
      console.log(`Processed ${pending.rows.length} queued emails.`);
    }
  } catch (err) {
    console.error('Email queue processing error:', err.message);
  }
}

// ============================================================
// AUDIT LOGGING
// ============================================================

async function auditLog(actorType, actorId, action, targetType, targetId, metadata = {}, req = null) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        actorType,
        actorId,
        action,
        targetType,
        targetId,
        JSON.stringify(metadata),
        req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : null,
        req ? req.headers['user-agent'] : null,
      ]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

// ============================================================
// BILLING HELPERS
// ============================================================

// Plan definitions (player caps)
const PLAN_CAPS = { team: 20, small_club: 200, large_club: 500, mega_club: 1000 };

// Resolve subscription for a given owner (club or standalone team)
async function getSubscription(ownerType, ownerId) {
  const result = await pool.query(
    "SELECT * FROM subscriptions WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at DESC LIMIT 1",
    [ownerType, ownerId]
  );
  return result.rows[0] || null;
}

// Resolve the billing owner context from a team_id
async function resolveBillingOwner(teamId) {
  const team = await pool.query('SELECT club_id FROM teams WHERE id = $1', [teamId]);
  if (!team.rows[0]) return null;
  if (team.rows[0].club_id) {
    return { ownerType: 'club', ownerId: team.rows[0].club_id };
  }
  return { ownerType: 'team', ownerId: teamId };
}

// Resolve subscription from request context
async function getSubscriptionForRequest(req) {
  if (req.user && req.user.club_id) {
    return getSubscription('club', req.user.club_id);
  }
  const teamId = req.teamId || req.headers['x-team-id'];
  if (teamId) {
    const owner = await resolveBillingOwner(teamId);
    if (owner) return getSubscription(owner.ownerType, owner.ownerId);
  }
  return null;
}

// Get current active player count for a subscription owner
async function getActivePlayerCount(ownerType, ownerId) {
  if (ownerType === 'club') {
    const result = await pool.query(
      "SELECT COUNT(*) as count FROM players p JOIN teams t ON t.id = p.team_id WHERE t.club_id = $1 AND p.status != 'inactive'",
      [ownerId]
    );
    return parseInt(result.rows[0].count);
  } else {
    const result = await pool.query(
      "SELECT COUNT(*) as count FROM players WHERE team_id = $1 AND status != 'inactive'",
      [ownerId]
    );
    return parseInt(result.rows[0].count);
  }
}

// Check if adding N players would exceed the player cap
async function checkPlayerCap(ownerType, ownerId, additionalPlayers = 1) {
  const sub = await getSubscription(ownerType, ownerId);
  if (!sub) return { allowed: true }; // No subscription = no cap enforced
  const effectiveCap = sub.player_cap + sub.addon_quantity;
  const currentCount = await getActivePlayerCount(ownerType, ownerId);
  if (currentCount + additionalPlayers > effectiveCap) {
    // Get add-on price for the error message
    const addonKey = sub.billing_interval === 'annual' ? 'addon_player_annual' : 'addon_player_monthly';
    const addonRow = await pool.query("SELECT value FROM billing_config WHERE key = $1", [addonKey]);
    const addonPrice = sub.billing_interval === 'annual' ? '$4.99' : '$0.59';
    return {
      allowed: false,
      current: currentCount,
      cap: effectiveCap,
      addon_price: addonPrice,
      error: `You've reached your plan limit of ${effectiveCap} players. Add more players for ${addonPrice} each, or upgrade your plan.`
    };
  }
  return { allowed: true, current: currentCount, cap: effectiveCap };
}

// Find billing contact email for a subscription owner
async function getBillingContact(ownerType, ownerId) {
  if (ownerType === 'club') {
    const admin = await pool.query(
      "SELECT email FROM users WHERE club_id = $1 AND role = 'club_admin' AND status = 'active' LIMIT 1",
      [ownerId]
    );
    return admin.rows[0]?.email || null;
  } else {
    const coach = await pool.query(
      "SELECT u.email FROM users u JOIN coach_teams ct ON ct.user_id = u.id WHERE ct.team_id = $1 AND u.status = 'active' LIMIT 1",
      [ownerId]
    );
    return coach.rows[0]?.email || null;
  }
}

// Billing email functions
async function sendPaymentFailedEmail(subscription) {
  const email = await getBillingContact(subscription.owner_type, subscription.owner_id);
  if (!email) return;
  const html = `<h2>Payment Failed</h2>
<p>We were unable to process your payment for Daily Reps.</p>
<p>Please update your payment method to avoid service interruption.</p>
<p><a href="${APP_URL}/club?tab=billing">Update Payment Method</a></p>`;
  await sendEmail(email, 'Daily Reps: Payment Failed - Action Required', html);
}

async function sendTrialEndingEmail(subscription) {
  const email = await getBillingContact(subscription.owner_type, subscription.owner_id);
  if (!email) return;
  const daysLeft = subscription.trial_end
    ? Math.max(1, Math.ceil((new Date(subscription.trial_end) - new Date()) / (1000 * 60 * 60 * 24)))
    : 3;
  const html = `<h2>Your Trial is Ending Soon</h2>
<p>Your Daily Reps free trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.</p>
<p>Add a payment method to continue using Daily Reps without interruption.</p>
<p><a href="${APP_URL}/club?tab=billing">Manage Billing</a></p>`;
  await sendEmail(email, `Daily Reps: Your trial ends in ${daysLeft} days`, html);
}

async function sendCardExpiryReminderEmail(subscription, daysUntilExpiry) {
  const email = await getBillingContact(subscription.owner_type, subscription.owner_id);
  if (!email) return;
  const html = `<h2>Card Expiring Soon</h2>
<p>The card ending in ${subscription.card_last4} on your Daily Reps account expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}.</p>
<p>Please update your payment method to avoid service interruption.</p>
<p><a href="${APP_URL}/club?tab=billing">Update Payment Method</a></p>`;
  await sendEmail(email, `Daily Reps: Card expires in ${daysUntilExpiry} days`, html);
}

// ============================================================
// IMPERSONATION MIDDLEWARE
// ============================================================

// Reject impersonation tokens on super admin routes
function rejectImpersonation(req, res, next) {
  if (req.user && req.user.impersonating) {
    return res.status(403).json({ error: 'Cannot access super admin routes while impersonating.' });
  }
  next();
}

// Middleware: block write operations when subscription is suspended or canceled
async function requireActiveSubscription(req, res, next) {
  try {
    const sub = await getSubscriptionForRequest(req);
    if (!sub) return next(); // No subscription = no restriction
    if (sub.status === 'suspended') {
      return res.status(403).json({
        error: 'This account is paused due to unpaid subscription. Please update your payment method.',
        subscription_status: 'suspended'
      });
    }
    if (sub.status === 'canceled') {
      return res.status(403).json({
        error: 'This account has been canceled. Please resubscribe to continue.',
        subscription_status: 'canceled'
      });
    }
    req.subscription = sub;
    next();
  } catch (err) {
    console.error('Subscription check error:', err);
    next(); // Fail open
  }
}

// ============================================================
// PASSWORD STRENGTH (STAFF ONLY)
// ============================================================

const COMMON_PASSWORDS = [
  'password', 'password1', 'password12', 'password123', 'password1234', 'password12345',
  'password123456', '123456', '12345678', '1234567890', '123456789012', 'qwerty', 'qwerty123',
  'qwerty123456', 'letmein', 'letmein1234', 'letmein12345', 'welcome', 'welcome123',
  'welcome1234', 'welcome12345', 'admin', 'admin123', 'admin1234', 'admin12345',
  'admin123456', 'changeme', 'changeme123', 'changeme1234', 'iloveyou', 'iloveyou123',
  'iloveyou1234', 'sunshine', 'sunshine123', 'sunshine1234', 'princess', 'princess123',
  'princess1234', 'football', 'football123', 'football1234', 'baseball', 'baseball123',
  'baseball1234', 'shadow', 'shadow123', 'shadow1234', 'shadow12345', 'master', 'master123',
  'master1234', 'master12345', 'dragon', 'dragon123', 'dragon1234', 'dragon12345',
  'monkey', 'monkey123', 'monkey1234', 'monkey12345', 'abc123', 'abc1234', 'abc12345',
  'abc123456', 'abc1234567890', 'trustno1', 'trustno123', 'trustno1234', 'soccer',
  'soccer123', 'soccer1234', 'soccer12345', 'hockey', 'hockey123', 'hockey1234',
  'ranger', 'ranger123', 'ranger1234', 'buster', 'buster123', 'buster1234',
  'killer', 'killer123', 'killer1234', 'george', 'george123', 'george1234',
  'pepper', 'pepper123', 'pepper1234', 'daniel', 'daniel123', 'daniel1234',
  'access', 'access123', 'access1234', 'joshua', 'joshua123', 'joshua1234',
  'michael', 'michael123', 'michael1234', 'starwars', 'starwars123', 'starwars1234',
  'dallas', 'dallas123', 'dallas1234', 'yankees', 'yankees123', 'yankees1234',
  'jordan', 'jordan123', 'jordan1234', 'taylor', 'taylor123', 'taylor1234',
  'abcdefghijkl', 'abcdef123456', '123456abcdef', 'aaaaaaaaaaaa', '111111111111',
  '121212121212', 'password2024', 'password2025', 'password2026', 'qwertyuiop12',
  'baseball12345', 'football12345', 'superman', 'superman123', 'superman1234',
  'batman', 'batman1234', 'batman12345', 'whatever', 'whatever123', 'whatever1234',
  'passw0rd', 'passw0rd1234', 'p@ssword', 'p@ssword123', 'p@ssword1234',
  'test', 'test1234', 'test12345', 'test123456', 'guest', 'guest1234', 'guest12345',
  'dailyreps123', 'dailyreps1234', 'coaching1234', 'coaching12345',
];

function validateStaffPassword(password) {
  if (!password || password.length < 12) {
    return 'Password must be at least 12 characters long';
  }
  if (!/[a-zA-Z]/.test(password)) {
    return 'Password must contain at least one letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  if (COMMON_PASSWORDS.includes(password.toLowerCase())) {
    return 'This password is too common. Please choose a stronger password';
  }
  return null;
}

// ============================================================
// CONSENT TOKENS
// ============================================================

const CONSENT_SECRET = JWT_SECRET + '-consent';

function generateConsentToken(playerId, parentEmail, purpose = 'consent') {
  return jwt.sign(
    { player_id: playerId, parent_email: parentEmail, purpose },
    CONSENT_SECRET,
    { expiresIn: '48h' }
  );
}

function verifyConsentToken(token, expectedPurpose = 'consent') {
  try {
    const decoded = jwt.verify(token, CONSENT_SECRET);
    if (decoded.purpose !== expectedPurpose) return null;
    return decoded;
  } catch (err) {
    return null;
  }
}

function generateParentPortalToken(parentEmail) {
  return jwt.sign(
    { parent_email: parentEmail, purpose: 'parent_portal' },
    CONSENT_SECRET,
    { expiresIn: '1h' }
  );
}

// Helper to build consent email HTML
async function sendConsentEmail(player, teamName, parentEmail) {
  const settings = await pool.query('SELECT consent_language, privacy_policy_version FROM app_settings WHERE id = 1');
  const appSettings = settings.rows[0];
  const token = generateConsentToken(player.id, parentEmail);
  const consentUrl = `${APP_URL}/consent/${token}`;
  const portalUrl = `${APP_URL}/parent-portal`;

  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #222;">
      <h2 style="color: #1348e5;">Daily Reps — Parental Consent Required</h2>
      <p>Hello,</p>
      <p>Your child <strong>${player.first_name} ${player.last_name}</strong> has been added to the
      <strong>${teamName}</strong> team on Daily Reps, a soccer training app.</p>
      <p>Because this team includes players under 13, we need your consent before your child can use the app.</p>
      <p>Please review the information below and click the button to give consent:</p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
      ${appSettings.consent_language}
      <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
      <p style="text-align: center;">
        <a href="${consentUrl}" style="display: inline-block; padding: 14px 28px; background: #1348e5; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
          Review &amp; Give Consent
        </a>
      </p>
      <p style="font-size: 0.85em; color: #666; margin-top: 24px;">
        This link expires in 48 hours. If it expires, ask the coach to resend it.<br>
        <a href="${APP_URL}/privacy">View our Privacy Policy (v${appSettings.privacy_policy_version})</a><br>
        <a href="${portalUrl}">Parent Portal</a> — Review your child's data or manage consent at any time.
      </p>
    </div>
  `;

  await sendEmail(parentEmail, `Daily Reps: Consent required for ${player.first_name}`, emailHtml);
}

async function sendWelcomeEmail(player, teamName, joinCode, parentEmail, coachName, username, password) {
  const loginUrl = `${APP_URL}/t/${joinCode}`;
  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #222;">
      <h2 style="color: #1348e5;">Daily Reps &mdash; You've Been Invited</h2>
      <p>Hello,</p>
      <p><strong>${coachName}</strong> has invited you to join <strong>${teamName}</strong> as a player on Daily Reps.</p>
      <p>Here are the login details:</p>
      <div style="background: #f5f5f5; padding: 16px 20px; border-radius: 8px; margin: 16px 0;">
        <div style="margin-bottom: 8px;"><strong>Team Code:</strong> ${joinCode}</div>
        <div style="margin-bottom: 8px;"><strong>Username:</strong> ${username}</div>
        <div><strong>Password:</strong> ${password}</div>
      </div>
      <p style="font-size: 0.9em; color: #666;">You will be asked to choose a new password the first time you log in.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${loginUrl}" style="display: inline-block; padding: 14px 28px; background: #1348e5; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
          Accept Invitation
        </a>
      </p>
    </div>
  `;
  await sendEmail(parentEmail, `${player.first_name} has been invited to Daily Reps`, emailHtml);
}

// ============================================================
// INVITATION TOKENS
// ============================================================

const INVITATION_SECRET = JWT_SECRET + '-invitation';

function generateInvitationToken(invitationId, email, role) {
  return jwt.sign(
    { invitation_id: invitationId, email, role, purpose: 'invitation' },
    INVITATION_SECRET,
    { expiresIn: '48h' }
  );
}

function verifyInvitationToken(token) {
  try {
    const decoded = jwt.verify(token, INVITATION_SECRET);
    if (decoded.purpose !== 'invitation') return null;
    return decoded;
  } catch (err) {
    return null;
  }
}

async function sendInvitationEmail(email, role, clubName, inviterName, token) {
  const acceptUrl = `${APP_URL}/invite/${token}`;
  const roleName = role === 'club_admin' ? 'Club Administrator' : 'Coach';
  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #222;">
      <h2 style="color: #1348e5;">Daily Reps &mdash; You've Been Invited</h2>
      <p>Hello,</p>
      <p><strong>${inviterName}</strong> has invited you to join <strong>${clubName}</strong> as a <strong>${roleName}</strong> on Daily Reps.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${acceptUrl}" style="display: inline-block; padding: 14px 28px; background: #1348e5; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
          Accept Invitation
        </a>
      </p>
      <p style="font-size: 0.85em; color: #666;">This link expires in 48 hours.</p>
    </div>
  `;
  await sendEmail(email, `Daily Reps: You've been invited to ${clubName}`, emailHtml);
}

// ============================================================
// USERNAME & PASSWORD GENERATION
// ============================================================

function generateUsername(firstName, lastName, existingUsernames) {
  const base = (firstName.toLowerCase() + lastName.charAt(0).toLowerCase()).replace(/[^a-z0-9]/g, '');
  if (!base) return 'player1';
  if (!existingUsernames.has(base)) return base;
  let counter = 2;
  while (existingUsernames.has(base + counter)) counter++;
  return base + counter;
}

function generatePlayerPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 8; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

// ============================================================
// STREAK CALCULATION HELPERS
// ============================================================

async function getSeasonDrills(playerId, teamId, seasonStartDate, seasonEndDate) {
  const result = await pool.query(
    `SELECT d.id, d.date, d.completion_points, d.extra_points,
            c.id as completion_id, c.did_extra
     FROM drills d
     LEFT JOIN completions c ON c.drill_id = d.id AND c.player_id = $1
     WHERE d.team_id = $2
       AND d.date BETWEEN $3 AND $4
       AND d.date <= CURRENT_DATE
     ORDER BY d.date ASC`,
    [playerId, teamId, seasonStartDate, seasonEndDate]
  );
  return result.rows;
}

async function calculateCurrentStreak(playerId, teamId, seasonStartDate, seasonEndDate) {
  const today = new Date().toISOString().split('T')[0];

  const drillsResult = await pool.query(
    `SELECT d.id, d.date,
            EXISTS(SELECT 1 FROM completions c WHERE c.player_id = $1 AND c.drill_id = d.id) as completed
     FROM drills d
     WHERE d.team_id = $2
       AND d.date BETWEEN $3 AND $4
       AND d.date <= CURRENT_DATE
     ORDER BY d.date DESC`,
    [playerId, teamId, seasonStartDate, seasonEndDate]
  );

  const drills = drillsResult.rows;
  if (drills.length === 0) return 0;

  let streak = 0;
  let startIndex = 0;

  if (drills[0].date.toISOString().split('T')[0] === today && !drills[0].completed) {
    startIndex = 1;
  }

  for (let i = startIndex; i < drills.length; i++) {
    if (drills[i].completed) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

async function calculateLongestStreak(playerId, teamId, seasonStartDate, seasonEndDate) {
  const drillsResult = await pool.query(
    `SELECT d.id, d.date,
            EXISTS(SELECT 1 FROM completions c WHERE c.player_id = $1 AND c.drill_id = d.id) as completed
     FROM drills d
     WHERE d.team_id = $2
       AND d.date BETWEEN $3 AND $4
       AND d.date <= CURRENT_DATE
     ORDER BY d.date ASC`,
    [playerId, teamId, seasonStartDate, seasonEndDate]
  );

  const drills = drillsResult.rows;
  let longest = 0;
  let current = 0;

  for (const drill of drills) {
    if (drill.completed) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }

  return longest;
}

// ============================================================
// POINTS CALCULATION
// ============================================================

async function calculatePlayerPoints(playerId, teamId, seasonStartDate, seasonEndDate) {
  const drills = await getSeasonDrills(playerId, teamId, seasonStartDate, seasonEndDate);

  let totalPoints = 0;
  let totalCompletions = 0;
  let extraCount = 0;
  let streak = 0;

  for (const drill of drills) {
    if (drill.completion_id) {
      let base = (drill.completion_points != null ? drill.completion_points : 10)
               + (drill.did_extra ? (drill.extra_points != null ? drill.extra_points : 5) : 0);

      if (streak >= 3) {
        base = Math.round(base * 1.2);
      }

      totalPoints += base;
      totalCompletions++;
      if (drill.did_extra) extraCount++;
      streak++;
    } else {
      streak = 0;
    }
  }

  // Perfect week bonus
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const weekMap = {};
  for (const drill of drills) {
    const d = drill.date instanceof Date ? drill.date : new Date(drill.date);
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + mondayOffset);
    const weekKey = monday.toISOString().split('T')[0];

    if (!weekMap[weekKey]) {
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      weekMap[weekKey] = { total: 0, completed: 0, sunday };
    }
    weekMap[weekKey].total++;
    if (drill.completion_id) weekMap[weekKey].completed++;
  }

  for (const week of Object.values(weekMap)) {
    if (week.sunday <= today && week.total > 0 && week.completed === week.total) {
      totalPoints += 10;
    }
  }

  // Question bonus points
  const questionPointsResult = await pool.query(
    `SELECT COALESCE(SUM(qr.points_earned), 0) as question_points
     FROM question_responses qr
     JOIN questions q ON q.id = qr.question_id
     JOIN drills d ON d.id = q.drill_id
     WHERE qr.player_id = $1 AND d.team_id = $2 AND d.date BETWEEN $3 AND $4 AND d.date <= CURRENT_DATE`,
    [playerId, teamId, seasonStartDate, seasonEndDate]
  );
  totalPoints += parseInt(questionPointsResult.rows[0].question_points, 10);

  return { totalPoints, totalCompletions, extraCount };
}

// ============================================================
// BADGE CHECKING HELPER
// ============================================================

async function checkAndAwardBadges(playerId, teamId) {
  const season = await getActiveSeasonForTeam(teamId);
  if (!season) return [];

  const endDate = effectiveEndDate(season);
  const { totalPoints, totalCompletions, extraCount } = await calculatePlayerPoints(playerId, teamId, season.start_date, endDate);
  const currentStreak = await calculateCurrentStreak(playerId, teamId, season.start_date, endDate);
  const drills = await getSeasonDrills(playerId, teamId, season.start_date, endDate);

  // Check perfect week
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const weekMap = {};
  for (const drill of drills) {
    const d = drill.date instanceof Date ? drill.date : new Date(drill.date);
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + mondayOffset);
    const weekKey = monday.toISOString().split('T')[0];
    if (!weekMap[weekKey]) {
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      weekMap[weekKey] = { total: 0, completed: 0, sunday };
    }
    weekMap[weekKey].total++;
    if (drill.completion_id) weekMap[weekKey].completed++;
  }
  const hasPerfectWeek = Object.values(weekMap).some(
    w => w.sunday <= today && w.total > 0 && w.completed === w.total
  );

  // Check perfect month
  const monthMap = {};
  for (const drill of drills) {
    const d = drill.date instanceof Date ? drill.date : new Date(drill.date);
    const monthKey = d.toISOString().slice(0, 7);
    if (!monthMap[monthKey]) monthMap[monthKey] = { total: 0, completed: 0 };
    monthMap[monthKey].total++;
    if (drill.completion_id) monthMap[monthKey].completed++;
  }
  const hasPerfectMonth = Object.entries(monthMap).some(([key, m]) => {
    const [year, mon] = key.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, mon, 0));
    return lastDay <= today && m.total > 0 && m.completed === m.total;
  });

  // Check challenge drill completions
  const challengeResult = await pool.query(
    `SELECT COUNT(*) as cnt FROM completions c
     JOIN drills d ON d.id = c.drill_id
     WHERE c.player_id = $1 AND d.is_challenge_day = true
       AND d.team_id = $2 AND d.date BETWEEN $3 AND $4`,
    [playerId, teamId, season.start_date, endDate]
  );
  const challengeCount = parseInt(challengeResult.rows[0].cnt, 10);

  // Check weekly winner
  let isWeeklyWinner = false;
  const allDrillDates = await pool.query(
    `SELECT DISTINCT date FROM drills
     WHERE team_id = $1 AND date BETWEEN $2 AND $3 AND date <= CURRENT_DATE`,
    [teamId, season.start_date, endDate]
  );
  const completedWeekMondays = new Set();
  for (const row of allDrillDates.rows) {
    const d = row.date instanceof Date ? row.date : new Date(row.date);
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + mondayOffset);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    if (sunday <= today) {
      completedWeekMondays.add(monday.toISOString().split('T')[0]);
    }
  }
  for (const mondayStr of completedWeekMondays) {
    const mondayDate = new Date(mondayStr + 'T00:00:00Z');
    const sundayDate = new Date(mondayDate);
    sundayDate.setUTCDate(mondayDate.getUTCDate() + 6);
    const topResult = await pool.query(
      `SELECT c.player_id,
         SUM(COALESCE(d.completion_points, 10) +
             CASE WHEN c.did_extra THEN COALESCE(d.extra_points, 5) ELSE 0 END) as week_points
       FROM completions c
       JOIN drills d ON d.id = c.drill_id
       JOIN players p ON p.id = c.player_id
       WHERE d.date >= $1::date AND d.date <= $2::date
         AND d.team_id = $3
         AND p.status = 'active'
       GROUP BY c.player_id
       ORDER BY week_points DESC
       LIMIT 1`,
      [mondayStr, sundayDate.toISOString().split('T')[0], teamId]
    );
    if (topResult.rows.length > 0 && topResult.rows[0].player_id === playerId) {
      isWeeklyWinner = true;
      break;
    }
  }

  const badgeCriteria = [
    { slug: 'first-touch', condition: totalCompletions >= 1 },
    { slug: 'hat-trick', condition: totalCompletions >= 3 },
    { slug: 'double-digits', condition: totalCompletions >= 10 },
    { slug: 'week-warrior', condition: currentStreak >= 7 },
    { slug: 'above-and-beyond', condition: extraCount >= 5 },
    { slug: 'century', condition: totalPoints >= 100 },
    { slug: 'perfect-week', condition: hasPerfectWeek },
    { slug: 'perfect-month', condition: hasPerfectMonth },
    { slug: 'challenge-accepted', condition: challengeCount >= 5 },
    { slug: 'challenge-master', condition: challengeCount >= 20 },
    { slug: 'weekly-winner', condition: isWeeklyWinner },
    { slug: 'extra-effort-20', condition: extraCount >= 20 },
    { slug: '200-club', condition: totalPoints >= 200 },
    { slug: '500-club', condition: totalPoints >= 500 },
    { slug: '1000-club', condition: totalPoints >= 1000 },
    { slug: '2000-club', condition: totalPoints >= 2000 },
    { slug: '3000-club', condition: totalPoints >= 3000 },
    { slug: '5000-club', condition: totalPoints >= 5000 },
    { slug: '10000-club', condition: totalPoints >= 10000 },
  ];

  const newBadges = [];
  for (const badge of badgeCriteria) {
    if (badge.condition) {
      const result = await pool.query(
        `INSERT INTO player_badges (player_id, badge_id, season_id)
         SELECT $1, b.id, $3 FROM badges b WHERE b.slug = $2
         ON CONFLICT (player_id, badge_id) DO NOTHING
         RETURNING badge_id`,
        [playerId, badge.slug, season.id]
      );
      if (result.rows.length > 0) {
        newBadges.push(badge.slug);
      }
    }
  }
  return newBadges;
}

// Helper to update player_season_stats and lifetime_points
async function updatePlayerStats(playerId, teamId) {
  const season = await getActiveSeasonForTeam(teamId);
  if (!season) return;

  const endDate = effectiveEndDate(season);
  const { totalPoints } = await calculatePlayerPoints(playerId, teamId, season.start_date, endDate);
  const currentStreak = await calculateCurrentStreak(playerId, teamId, season.start_date, endDate);
  const longestStreak = await calculateLongestStreak(playerId, teamId, season.start_date, endDate);

  // Upsert player_season_stats
  await pool.query(
    `INSERT INTO player_season_stats (player_id, season_id, season_points, current_streak, longest_streak, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (player_id, season_id) DO UPDATE SET
       season_points = $3, current_streak = $4, longest_streak = $5, updated_at = NOW()`,
    [playerId, season.id, totalPoints, currentStreak, longestStreak]
  );

  // Update lifetime_points: sum of all season_points
  await pool.query(
    `UPDATE players SET lifetime_points = (
       SELECT COALESCE(SUM(season_points), 0) FROM player_season_stats WHERE player_id = $1
     ) WHERE id = $1`,
    [playerId]
  );
}

// ============================================================
// AUTH ENDPOINTS
// ============================================================

// POST /api/auth/login (staff: super_admin, club_admin, coach)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND status = 'active'",
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // MFA: if already enabled, require TOTP verification
    if (user.mfa_enabled && user.mfa_secret) {
      const mfaSession = jwt.sign(
        { id: user.id, purpose: 'mfa' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ mfa_required: true, mfa_session: mfaSession });
    }

    // MFA: if required role but not yet enrolled, force setup
    const mfaRequiredRoles = ['super_admin', 'club_admin'];
    if (mfaRequiredRoles.includes(user.role) && !user.mfa_enabled) {
      const setupToken = jwt.sign(
        { id: user.id, email: user.email, role: user.role, first_name: user.first_name,
          last_name: user.last_name, club_id: user.club_id, mfa_setup_required: true },
        JWT_SECRET,
        { expiresIn: '15m' }
      );
      return res.json({
        mfa_setup_required: true,
        token: setupToken,
        user: { id: user.id, email: user.email, role: user.role,
                first_name: user.first_name, last_name: user.last_name, club_id: user.club_id },
      });
    }

    const tokenPayload = {
      id: user.id,
      email: user.email,
      role: user.role,
      first_name: user.first_name,
      last_name: user.last_name,
      club_id: user.club_id,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    // If coach, include teams
    let teams = [];
    if (user.role === 'coach') {
      const teamsResult = await pool.query(
        `SELECT t.id, t.name, t.join_code, t.primary_color, t.logo_url
         FROM teams t
         JOIN coach_teams ct ON ct.team_id = t.id
         WHERE ct.user_id = $1 AND t.status = 'active'
         ORDER BY t.name`,
        [user.id]
      );
      teams = teamsResult.rows;
    }

    // Offer MFA to coaches who haven't enabled it
    const mfa_prompt = (user.role === 'coach' && !user.mfa_enabled) ? true : undefined;

    res.json({ token, user: tokenPayload, teams, mfa_prompt });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/player-login (player: team-scoped)
app.post('/api/auth/player-login', async (req, res) => {
  try {
    const { username, password, join_code } = req.body;
    if (!username || !password || !join_code) {
      return res.status(400).json({ error: 'Username, password, and join code are required' });
    }

    // Resolve team from join_code
    const teamResult = await pool.query(
      "SELECT * FROM teams WHERE join_code = $1 AND status = 'active'",
      [join_code.toUpperCase().trim()]
    );

    if (teamResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid team code' });
    }

    const team = teamResult.rows[0];

    const playerResult = await pool.query(
      'SELECT * FROM players WHERE team_id = $1 AND username = $2',
      [team.id, username.trim()]
    );

    if (playerResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const player = playerResult.rows[0];

    // Check player status before password verification
    if (player.status === 'inactive') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (player.status === 'pending') {
      if (player.consent_status === 'awaiting' || player.consent_status === 'revoked') {
        return res.status(403).json({
          error: 'consent_required',
          message: 'Your account is waiting for a parent or guardian to give permission. Ask your coach or parent to check their email.',
        });
      }
      return res.status(401).json({ error: 'Your account is not yet active. Please contact your coach.' });
    }

    const validPassword = await bcrypt.compare(password, player.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Force password change on first login
    if (player.must_change_password) {
      const changeToken = jwt.sign(
        { player_id: player.id, team_id: team.id, purpose: 'password_change' },
        JWT_SECRET,
        { expiresIn: '30m' }
      );
      return res.json({
        must_change_password: true,
        change_session: changeToken,
        team: {
          id: team.id,
          name: team.name,
          join_code: team.join_code,
          primary_color: team.primary_color,
          logo_url: team.logo_url,
        },
      });
    }

    const tokenPayload = {
      id: player.id,
      role: 'player',
      team_id: team.id,
      username: player.username,
      first_name: player.first_name,
      last_name: player.last_name,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: tokenPayload,
      team: {
        id: team.id,
        name: team.name,
        join_code: team.join_code,
        primary_color: team.primary_color,
        logo_url: team.logo_url,
      },
    });
  } catch (err) {
    console.error('Player login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/player-change-password
app.post('/api/auth/player-change-password', async (req, res) => {
  try {
    const { change_session, new_password } = req.body;
    if (!change_session || !new_password) {
      return res.status(400).json({ error: 'Session token and new password are required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    let decoded;
    try {
      decoded = jwt.verify(change_session, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (decoded.purpose !== 'password_change') {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(
      'UPDATE players SET password_hash = $1, must_change_password = false WHERE id = $2',
      [hash, decoded.player_id]
    );

    const playerResult = await pool.query('SELECT * FROM players WHERE id = $1', [decoded.player_id]);
    const player = playerResult.rows[0];
    const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [decoded.team_id]);
    const team = teamResult.rows[0];

    const tokenPayload = {
      id: player.id,
      role: 'player',
      team_id: team.id,
      username: player.username,
      first_name: player.first_name,
      last_name: player.last_name,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: tokenPayload,
      team: {
        id: team.id,
        name: team.name,
        join_code: team.join_code,
        primary_color: team.primary_color,
        logo_url: team.logo_url,
      },
    });
  } catch (err) {
    console.error('Player change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    if (req.role === 'player') {
      const playerResult = await pool.query(
        'SELECT p.*, t.name as team_name, t.join_code, t.primary_color, t.logo_url FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1',
        [req.user.id]
      );
      if (playerResult.rows.length === 0) {
        return res.status(401).json({ error: 'Player not found' });
      }
      const p = playerResult.rows[0];
      return res.json({
        user: {
          id: p.id,
          role: 'player',
          team_id: p.team_id,
          username: p.username,
          first_name: p.first_name,
          last_name: p.last_name,
        },
        team: {
          id: p.team_id,
          name: p.team_name,
          join_code: p.join_code,
          primary_color: p.primary_color,
          logo_url: p.logo_url,
        },
      });
    }

    // Staff
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [req.user.id]
    );
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    const u = userResult.rows[0];
    const userData = {
      id: u.id,
      email: u.email,
      role: u.role,
      first_name: u.first_name,
      last_name: u.last_name,
      club_id: u.club_id,
    };

    let teams = [];
    if (u.role === 'coach') {
      const teamsResult = await pool.query(
        `SELECT t.id, t.name, t.join_code, t.primary_color, t.logo_url
         FROM teams t
         JOIN coach_teams ct ON ct.team_id = t.id
         WHERE ct.user_id = $1 AND t.status = 'active'
         ORDER BY t.name`,
        [u.id]
      );
      teams = teamsResult.rows;
    }

    // Club admin: return all teams in their club (for team switcher on admin pages)
    if (u.role === 'club_admin' && u.club_id) {
      const teamsResult = await pool.query(
        `SELECT t.id, t.name, t.join_code, t.primary_color, t.logo_url, t.age_group, t.has_under_13
         FROM teams t WHERE t.club_id = $1 AND t.status = 'active' ORDER BY t.name`,
        [u.club_id]
      );
      teams = teamsResult.rows;
    }

    const response = { user: userData, teams };

    // Include impersonation info if present
    if (req.isImpersonating) {
      response.impersonating = true;
      response.real_user_id = req.realUser.id;
      response.real_user_name = req.user.real_user_name;
    }

    res.json(response);
  } catch (err) {
    console.error('Auth me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/teams/by-code/:joinCode (public, for login page branding)
app.get('/api/teams/by-code/:joinCode', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, primary_color, logo_url FROM teams WHERE join_code = $1 AND status = 'active'",
      [req.params.joinCode.toUpperCase().trim()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json({ team: result.rows[0] });
  } catch (err) {
    console.error('Get team by code error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// PLAYER SELF-REGISTRATION
// ============================================================

const registrationAttempts = new Map();
function checkRegistrationRateLimit(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 10;
  const attempts = registrationAttempts.get(ip) || [];
  const recent = attempts.filter(t => t > now - windowMs);
  if (recent.length >= maxAttempts) return false;
  recent.push(now);
  registrationAttempts.set(ip, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of registrationAttempts) {
    const recent = attempts.filter(t => t > now - 15 * 60 * 1000);
    if (recent.length === 0) registrationAttempts.delete(ip);
    else registrationAttempts.set(ip, recent);
  }
}, 30 * 60 * 1000);

app.post('/api/teams/:joinCode/register', async (req, res) => {
  try {
    if (!checkRegistrationRateLimit(req)) {
      return res.status(429).json({ error: 'Too many registration attempts. Please try again later.' });
    }

    const { first_name, last_name, email, password, is_under_13 } = req.body;
    if (!first_name || !last_name) {
      return res.status(400).json({ error: 'First name and last name are required.' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    // Resolve team from join code
    const teamResult = await pool.query(
      "SELECT * FROM teams WHERE join_code = $1 AND status = 'active'",
      [req.params.joinCode.toUpperCase().trim()]
    );
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found.' });
    }
    const team = teamResult.rows[0];

    // Check subscription status
    const ownerType = team.club_id ? 'club' : 'team';
    const ownerId = team.club_id || team.id;
    const sub = await getSubscription(ownerType, ownerId);
    if (sub && (sub.status === 'suspended' || sub.status === 'canceled')) {
      return res.status(403).json({ error: 'This team is not currently accepting registrations.' });
    }

    // Player cap enforcement
    const capCheck = await checkPlayerCap(ownerType, ownerId, 1);
    if (!capCheck.allowed) {
      return res.status(403).json({ error: 'This team has reached its player limit. Please contact your coach.' });
    }

    // Generate username
    const existingResult = await pool.query('SELECT username FROM players WHERE team_id = $1', [team.id]);
    const usernameSet = new Set(existingResult.rows.map(p => p.username));
    const username = generateUsername(first_name.trim(), last_name.trim(), usernameSet);

    // Create player
    const passwordHash = await bcrypt.hash(password, 10);
    const playerStatus = is_under_13 ? 'pending' : 'active';
    const consentStatus = is_under_13 ? 'awaiting' : 'not_required';
    const trimmedEmail = email.trim();

    const result = await pool.query(
      `INSERT INTO players (team_id, first_name, last_name, username, password_hash, status, consent_status, parent_email, player_email, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
       RETURNING id, username, first_name, last_name, status, consent_status`,
      [team.id, first_name.trim(), last_name.trim(), username, passwordHash, playerStatus, consentStatus,
       trimmedEmail, is_under_13 ? null : trimmedEmail]
    );
    const newPlayer = result.rows[0];

    await auditLog('player', newPlayer.id, 'player_self_registered', 'player', newPlayer.id,
      { is_under_13, join_code: req.params.joinCode }, req);

    // Under-12: send consent email, return pending
    if (is_under_13) {
      try {
        await sendConsentEmail(
          { id: newPlayer.id, first_name: first_name.trim(), last_name: last_name.trim() },
          team.name,
          trimmedEmail
        );
        await auditLog('system', null, 'consent_email_sent', 'player', newPlayer.id,
          { parent_email: trimmedEmail }, req);
      } catch (emailErr) {
        console.error('Registration consent email error:', emailErr.message);
      }
      return res.status(201).json({
        registered: true,
        consent_required: true,
        username: newPlayer.username,
        message: 'Account created! A consent email has been sent to your parent. You can log in after they approve.',
      });
    }

    // 13+: auto-login
    const tokenPayload = {
      id: newPlayer.id,
      role: 'player',
      team_id: team.id,
      username: newPlayer.username,
      first_name: first_name.trim(),
      last_name: last_name.trim(),
    };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      registered: true,
      consent_required: false,
      token,
      user: tokenPayload,
      team: {
        id: team.id,
        name: team.name,
        join_code: team.join_code,
        primary_color: team.primary_color,
        logo_url: team.logo_url,
      },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A player with this username already exists. Please try again.' });
    }
    console.error('Player registration error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// DRILL ENDPOINTS (Player)
// ============================================================

// GET /api/drills/today
app.get('/api/drills/today', authenticate, requireRole('player'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*,
              c.id as completion_id,
              c.completed_at,
              c.did_extra
       FROM drills d
       LEFT JOIN completions c ON c.drill_id = d.id AND c.player_id = $1
       WHERE d.team_id = $2 AND d.date = CURRENT_DATE`,
      [req.user.id, req.teamId]
    );

    if (result.rows.length === 0) {
      return res.json({ drill: null, completion: null });
    }

    const row = result.rows[0];

    const qCount = await pool.query(
      'SELECT COUNT(*) as cnt FROM questions WHERE drill_id = $1',
      [row.id]
    );

    const drill = {
      id: row.id,
      date: row.date,
      title: row.title,
      description: row.description,
      youtube_url: row.youtube_url,
      target_time: row.target_time,
      is_challenge: row.is_challenge_day,
      completion_points: row.completion_points,
      extra_points: row.extra_points,
      bonus_criteria: row.bonus_criteria,
      created_at: row.created_at,
      has_questions: parseInt(qCount.rows[0].cnt, 10) > 0,
    };

    const completion = row.completion_id
      ? { id: row.completion_id, completed_at: row.completed_at, did_extra: row.did_extra }
      : null;

    res.json({ drill, completion });
  } catch (err) {
    console.error('Get today drill error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/drills/date/:date
app.get('/api/drills/date/:date', authenticate, requireRole('player'), async (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    const result = await pool.query(
      `SELECT d.*,
              c.id as completion_id,
              c.completed_at,
              c.did_extra
       FROM drills d
       LEFT JOIN completions c ON c.drill_id = d.id AND c.player_id = $1
       WHERE d.team_id = $2 AND d.date = $3::date`,
      [req.user.id, req.teamId, date]
    );

    if (result.rows.length === 0) {
      return res.json({ drill: null, completion: null });
    }

    const row = result.rows[0];

    const qCount = await pool.query(
      'SELECT COUNT(*) as cnt FROM questions WHERE drill_id = $1',
      [row.id]
    );

    const drill = {
      id: row.id,
      date: row.date,
      title: row.title,
      description: row.description,
      youtube_url: row.youtube_url,
      target_time: row.target_time,
      is_challenge: row.is_challenge_day,
      completion_points: row.completion_points,
      extra_points: row.extra_points,
      bonus_criteria: row.bonus_criteria,
      created_at: row.created_at,
      has_questions: parseInt(qCount.rows[0].cnt, 10) > 0,
    };

    const completion = row.completion_id
      ? { id: row.completion_id, completed_at: row.completed_at, did_extra: row.did_extra }
      : null;

    res.json({ drill, completion });
  } catch (err) {
    console.error('Get drill by date error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/drills/:id/complete
app.post('/api/drills/:id/complete', authenticate, requireRole('player'), async (req, res) => {
  try {
    const drillId = req.params.id;
    const { did_extra } = req.body;

    // Verify drill exists and belongs to player's team
    const drillCheck = await pool.query(
      'SELECT * FROM drills WHERE id = $1 AND team_id = $2',
      [drillId, req.teamId]
    );
    if (drillCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Drill not found' });
    }

    const drill = drillCheck.rows[0];
    const drillDate = drill.date.toISOString().split('T')[0];
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (drillDate !== todayStr && drillDate !== yesterdayStr) {
      return res.status(403).json({ error: 'You can only complete drills from today or yesterday' });
    }

    // Capture level BEFORE completion
    let levelBefore = null;
    try {
      const season = await getActiveSeasonForTeam(req.teamId);
      if (season) {
        const { totalPoints: ptsBefore } = await calculatePlayerPoints(req.user.id, req.teamId, season.start_date, effectiveEndDate(season));
        levelBefore = getLevelInfo(ptsBefore);
      }
    } catch (levelErr) {
      console.error('Level-before calculation error (non-fatal):', levelErr);
    }

    // INSERT completion
    const result = await pool.query(
      `INSERT INTO completions (player_id, drill_id, did_extra, points_earned)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (player_id, drill_id) DO NOTHING
       RETURNING *`,
      [req.user.id, drillId, did_extra || false]
    );

    if (result.rows.length === 0) {
      const existing = await pool.query(
        'SELECT * FROM completions WHERE player_id = $1 AND drill_id = $2',
        [req.user.id, drillId]
      );
      return res.json({ completion: existing.rows[0] });
    }

    // Update stats and check badges
    let newBadges = [];
    let levelUp = null;
    let level = null;
    try {
      await updatePlayerStats(req.user.id, req.teamId);
      newBadges = await checkAndAwardBadges(req.user.id, req.teamId);

      const season = await getActiveSeasonForTeam(req.teamId);
      if (season) {
        const { totalPoints: ptsAfter } = await calculatePlayerPoints(req.user.id, req.teamId, season.start_date, effectiveEndDate(season));
        level = getLevelInfo(ptsAfter);
        if (levelBefore && level.name !== levelBefore.name) {
          levelUp = level;
        }
      }
    } catch (gamErr) {
      console.error('Gamification error (non-fatal):', gamErr);
    }

    res.json({ completion: result.rows[0], newBadges, levelUp, level });
  } catch (err) {
    console.error('Complete drill error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// PLAYER QUESTION ENDPOINTS
// ============================================================

// GET /api/drills/:id/questions
app.get('/api/drills/:id/questions', authenticate, requireRole('player'), async (req, res) => {
  try {
    const drillId = req.params.id;
    const playerId = req.user.id;

    // Verify drill belongs to player's team
    const drillCheck = await pool.query(
      'SELECT id FROM drills WHERE id = $1 AND team_id = $2',
      [drillId, req.teamId]
    );
    if (drillCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Drill not found' });
    }

    const questionsResult = await pool.query(
      'SELECT id, question_text, type, points, position FROM questions WHERE drill_id = $1 ORDER BY position ASC',
      [drillId]
    );

    const result = [];
    for (const q of questionsResult.rows) {
      // Map type back to input_type for frontend compatibility
      const qData = {
        id: q.id,
        question_text: q.question_text,
        input_type: q.type,
        point_value: q.points,
        sort_order: q.position,
        options: [],
      };

      const responded = await pool.query(
        'SELECT id FROM question_responses WHERE player_id = $1 AND question_id = $2 ORDER BY attempt_number DESC LIMIT 1',
        [playerId, q.id]
      );

      let answered = false;
      if (responded.rows.length > 0) {
        if (q.type === 'checkbox') {
          answered = true;
        } else {
          const attempts = await pool.query(
            'SELECT attempt_number, points_earned FROM question_responses WHERE player_id = $1 AND question_id = $2 ORDER BY attempt_number ASC',
            [playerId, q.id]
          );
          if (attempts.rows.length >= 2) {
            answered = true;
          } else if (attempts.rows.length === 1 && attempts.rows[0].points_earned > 0) {
            answered = true;
          }
        }
      }

      if (!answered) {
        if (q.type === 'radio' || q.type === 'checkbox') {
          const opts = await pool.query(
            'SELECT id, option_text, position AS sort_order FROM question_options WHERE question_id = $1 ORDER BY position ASC',
            [q.id]
          );
          qData.options = opts.rows;
        }
        if (responded.rows.length > 0) {
          qData.is_retry = true;
        }
        result.push(qData);
      }
    }

    res.json({
      questions: result,
      total_count: questionsResult.rows.length,
      remaining_count: result.length,
    });
  } catch (err) {
    console.error('Get player questions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/drills/questions/:questionId/answer
app.post('/api/drills/questions/:questionId/answer', authenticate, requireRole('player'), async (req, res) => {
  try {
    const questionId = req.params.questionId;
    const playerId = req.user.id;
    const { answer, selected_option_ids } = req.body;

    // Get the question and verify it belongs to player's team
    const qResult = await pool.query(
      `SELECT q.*, d.team_id FROM questions q
       JOIN drills d ON d.id = q.drill_id
       WHERE q.id = $1`,
      [questionId]
    );
    if (qResult.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }
    const question = qResult.rows[0];
    if (question.team_id !== req.teamId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const existingAttempts = await pool.query(
      'SELECT * FROM question_responses WHERE player_id = $1 AND question_id = $2 ORDER BY attempt_number ASC',
      [playerId, questionId]
    );

    if (question.type === 'checkbox') {
      if (existingAttempts.rows.length > 0) {
        return res.status(400).json({ error: 'Already answered this question' });
      }

      const optionsResult = await pool.query(
        'SELECT * FROM question_options WHERE question_id = $1 ORDER BY position ASC',
        [questionId]
      );

      const selectedIds = new Set((selected_option_ids || []).map(id => String(id)));
      let correctSelected = 0;
      let wrongSelected = 0;
      const optionResults = [];

      for (const opt of optionsResult.rows) {
        const wasSelected = selectedIds.has(String(opt.id));
        const isCorrect = opt.is_correct;
        if (wasSelected && isCorrect) correctSelected++;
        else if (wasSelected && !isCorrect) wrongSelected++;
        optionResults.push({
          id: opt.id,
          option_text: opt.option_text,
          is_correct: isCorrect,
          was_selected: wasSelected,
        });
      }

      const netCorrect = Math.max(0, correctSelected - wrongSelected);
      const pointsEarned = netCorrect * question.points;

      for (const opt of optionResults) {
        opt.points_earned = (opt.was_selected && opt.is_correct && netCorrect > 0) ? question.points : 0;
      }

      await pool.query(
        `INSERT INTO question_responses (player_id, question_id, response_text, is_correct, points_earned, attempt_number)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [playerId, questionId, JSON.stringify(selected_option_ids), netCorrect > 0, pointsEarned]
      );

      // Update stats after answering
      try { await updatePlayerStats(playerId, req.teamId); } catch (e) { console.error('Stats update error:', e); }

      return res.json({
        correct: null,
        points_earned: pointsEarned,
        option_results: optionResults,
        attempts_used: 1,
      });
    }

    // Text or Radio: up to 2 attempts
    const attemptNumber = existingAttempts.rows.length + 1;
    if (attemptNumber > 2) {
      return res.status(400).json({ error: 'Already used all attempts' });
    }
    if (existingAttempts.rows.length === 1 && existingAttempts.rows[0].points_earned > 0) {
      return res.status(400).json({ error: 'Already answered correctly' });
    }

    let isCorrect = false;

    if (question.type === 'text') {
      // Check for min_char_count mode (stored as question metadata - we use the points field differently)
      // Actually, we need to check question_text_answers or min_char_count
      // For now, check if there are acceptable answers; if none but we have a drill, accept any non-empty
      const acceptableResult = await pool.query(
        'SELECT acceptable_answer FROM question_text_answers WHERE question_id = $1',
        [questionId]
      );

      if (acceptableResult.rows.length > 0) {
        const normalizedAnswer = (answer || '').trim().toLowerCase().replace(/\s+/g, ' ');
        isCorrect = acceptableResult.rows.some(
          a => a.acceptable_answer.trim().toLowerCase().replace(/\s+/g, ' ') === normalizedAnswer
        );
      } else {
        // No acceptable answers defined - accept any non-empty answer (open-ended)
        isCorrect = (answer || '').trim().length > 0;
      }
    } else if (question.type === 'radio') {
      if (selected_option_ids && selected_option_ids.length === 1) {
        const optCheck = await pool.query(
          'SELECT is_correct FROM question_options WHERE id = $1 AND question_id = $2',
          [selected_option_ids[0], questionId]
        );
        isCorrect = optCheck.rows.length > 0 && optCheck.rows[0].is_correct;
      }
    }

    let pointsEarned = 0;
    if (isCorrect) {
      pointsEarned = attemptNumber === 1
        ? question.points
        : Math.floor(question.points / 2);
    }

    await pool.query(
      `INSERT INTO question_responses (player_id, question_id, response_text, is_correct, points_earned, attempt_number)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [playerId, questionId, answer || JSON.stringify(selected_option_ids), isCorrect, pointsEarned, attemptNumber]
    );

    // Update stats after answering
    try { await updatePlayerStats(playerId, req.teamId); } catch (e) { console.error('Stats update error:', e); }

    const responseData = {
      correct: isCorrect,
      points_earned: pointsEarned,
      attempts_used: attemptNumber,
    };

    if (!isCorrect && attemptNumber === 1) {
      responseData.message = 'Not quite, give it another shot!';
      responseData.can_retry = true;
    } else if (!isCorrect && attemptNumber === 2) {
      if (question.type === 'text') {
        const acceptableResult = await pool.query(
          'SELECT acceptable_answer FROM question_text_answers WHERE question_id = $1',
          [questionId]
        );
        responseData.correct_answers = acceptableResult.rows.map(a => a.acceptable_answer);
      } else if (question.type === 'radio') {
        const correctOpt = await pool.query(
          'SELECT option_text FROM question_options WHERE question_id = $1 AND is_correct = true',
          [questionId]
        );
        responseData.correct_answers = correctOpt.rows.map(o => o.option_text);
      }
      responseData.show_answer = true;
    }

    res.json(responseData);
  } catch (err) {
    console.error('Answer question error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// LEADERBOARD ENDPOINT
// ============================================================

app.get('/api/leaderboard', authenticate, async (req, res) => {
  try {
    // Determine team_id based on role
    let teamId;
    if (req.role === 'player') {
      teamId = req.user.team_id;
    } else if (req.role === 'coach' || req.role === 'club_admin' || req.role === 'super_admin') {
      teamId = req.headers['x-team-id'];
      if (!teamId) return res.status(400).json({ error: 'Team ID required' });
      // For coach, validate access
      if (req.role === 'coach') {
        const check = await pool.query(
          'SELECT id FROM coach_teams WHERE user_id = $1 AND team_id = $2',
          [req.user.id, teamId]
        );
        if (check.rows.length === 0) return res.status(403).json({ error: 'No access to this team' });
      }
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }

    const season = await getActiveSeasonForTeam(teamId);
    if (!season) {
      return res.json({ season: null, players: [] });
    }

    const playersResult = await pool.query(
      "SELECT id, first_name, last_name, avatar_color FROM players WHERE team_id = $1 AND status = 'active'",
      [teamId]
    );

    // Get latest badge emoji for each player
    const latestBadgesResult = await pool.query(
      `SELECT DISTINCT ON (pb.player_id) pb.player_id, b.icon_emoji
       FROM player_badges pb
       JOIN badges b ON b.id = pb.badge_id
       WHERE pb.player_id = ANY($1::uuid[])
       ORDER BY pb.player_id, pb.earned_at DESC`,
      [playersResult.rows.map(p => p.id)]
    );
    const latestBadgeMap = {};
    for (const row of latestBadgesResult.rows) {
      latestBadgeMap[row.player_id] = row.icon_emoji;
    }

    const endDate = effectiveEndDate(season);
    const players = [];
    for (const player of playersResult.rows) {
      const { totalPoints, totalCompletions } = await calculatePlayerPoints(player.id, teamId, season.start_date, endDate);
      const current_streak = await calculateCurrentStreak(player.id, teamId, season.start_date, endDate);
      players.push({
        id: player.id,
        first_name: player.first_name,
        last_name: player.last_name,
        avatar_color: player.avatar_color,
        completions: totalCompletions,
        points: totalPoints,
        current_streak,
        level: getLevelInfo(totalPoints),
        latest_badge_emoji: latestBadgeMap[player.id] || null,
      });
    }

    players.sort((a, b) => b.points - a.points || b.completions - a.completions);

    res.json({ season, players });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// USER STATS ENDPOINTS
// ============================================================

app.get('/api/me/stats', authenticate, requireRole('player'), async (req, res) => {
  try {
    const season = await getActiveSeasonForTeam(req.teamId);
    if (!season) {
      return res.json({
        current_streak: 0,
        longest_streak: 0,
        total_completions: 0,
        total_points: 0,
        extra_count: 0,
        level: getLevelInfo(0),
      });
    }

    const endDate = effectiveEndDate(season);
    const { totalPoints, totalCompletions, extraCount } = await calculatePlayerPoints(req.user.id, req.teamId, season.start_date, endDate);
    const currentStreak = await calculateCurrentStreak(req.user.id, req.teamId, season.start_date, endDate);
    const longestStreak = await calculateLongestStreak(req.user.id, req.teamId, season.start_date, endDate);

    // Fetch lifetime points
    const lpResult = await pool.query('SELECT lifetime_points FROM players WHERE id = $1', [req.user.id]);
    const lifetimePoints = lpResult.rows[0]?.lifetime_points || 0;

    res.json({
      current_streak: currentStreak,
      longest_streak: longestStreak,
      total_completions: totalCompletions,
      total_points: totalPoints,
      extra_count: extraCount,
      lifetime_points: lifetimePoints,
      level: getLevelInfo(totalPoints),
    });
  } catch (err) {
    console.error('User stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me/badges', authenticate, requireRole('player'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, pb.earned_at
       FROM badges b
       LEFT JOIN player_badges pb ON pb.badge_id = b.id AND pb.player_id = $1
       ORDER BY b.id`,
      [req.user.id]
    );

    res.json({ badges: result.rows });
  } catch (err) {
    console.error('User badges error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// COACH / ADMIN ENDPOINTS
// ============================================================

// --- Players ---

app.get('/api/admin/players', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, first_name, last_name, avatar_color, status, consent_status, player_email, parent_email, created_at FROM players WHERE team_id = $1 ORDER BY last_name ASC",
      [req.teamId]
    );

    const latestBadgesResult = await pool.query(
      `SELECT DISTINCT ON (pb.player_id) pb.player_id, b.icon_emoji
       FROM player_badges pb
       JOIN badges b ON b.id = pb.badge_id
       WHERE pb.player_id = ANY($1::uuid[])
       ORDER BY pb.player_id, pb.earned_at DESC`,
      [result.rows.map(p => p.id)]
    );
    const latestBadgeMap = {};
    for (const row of latestBadgesResult.rows) {
      latestBadgeMap[row.player_id] = row.icon_emoji;
    }

    const season = await getActiveSeasonForTeam(req.teamId);
    const players = [];
    for (const player of result.rows) {
      let level = getLevelInfo(0);
      if (season) {
        const endDate = effectiveEndDate(season);
        const { totalPoints } = await calculatePlayerPoints(player.id, req.teamId, season.start_date, endDate);
        level = getLevelInfo(totalPoints);
      }
      players.push({
        ...player,
        active: player.status === 'active',
        level,
        latest_badge_emoji: latestBadgeMap[player.id] || null,
      });
    }

    res.json({ players });
  } catch (err) {
    console.error('List players error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/players', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, requireActiveSubscription, async (req, res) => {
  try {
    const { first_name, last_name, username, password, parent_email } = req.body;
    if (!first_name || !last_name || !username || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if team requires consent
    const teamResult = await pool.query('SELECT has_under_13, name, club_id, join_code FROM teams WHERE id = $1', [req.teamId]);
    const requiresConsent = teamResult.rows[0]?.has_under_13 === true;

    if (requiresConsent && !parent_email) {
      return res.status(400).json({ error: 'Parent email is required for teams with under-13 players' });
    }

    // Player cap enforcement
    const ownerType = teamResult.rows[0]?.club_id ? 'club' : 'team';
    const ownerId = teamResult.rows[0]?.club_id || req.teamId;
    const capCheck = await checkPlayerCap(ownerType, ownerId, 1);
    if (!capCheck.allowed) {
      return res.status(403).json({ error: capCheck.error, usage: { current: capCheck.current, cap: capCheck.cap, addon_price: capCheck.addon_price } });
    }

    const playerStatus = requiresConsent ? 'pending' : 'active';
    const consentStatus = requiresConsent ? 'awaiting' : 'not_required';

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO players (team_id, first_name, last_name, username, password_hash, status, consent_status, parent_email, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING id, username, first_name, last_name, avatar_color, status, consent_status, parent_email, created_at`,
      [req.teamId, first_name, last_name, username.trim(), passwordHash, playerStatus, consentStatus, parent_email || null]
    );

    const newPlayer = result.rows[0];
    await auditLog('staff', req.user.id, 'player_created', 'player', newPlayer.id,
      { consent_required: requiresConsent }, req);

    // Auto-send consent email if consent required and parent_email present
    if (requiresConsent && parent_email) {
      try {
        await sendConsentEmail(
          { id: newPlayer.id, first_name, last_name },
          teamResult.rows[0].name,
          parent_email
        );
        await auditLog('system', null, 'consent_email_sent', 'player', newPlayer.id,
          { parent_email }, req);
      } catch (emailErr) {
        console.error('Auto consent email error:', emailErr.message);
      }
    }

    // Send welcome email with credentials if parent_email present
    if (parent_email) {
      try {
        const coachName = `${req.user.first_name} ${req.user.last_name}`;
        await sendWelcomeEmail(
          { first_name },
          teamResult.rows[0].name,
          teamResult.rows[0].join_code,
          parent_email,
          coachName,
          username.trim(),
          password
        );
      } catch (emailErr) {
        console.error('Welcome email error:', emailErr.message);
      }
    }

    res.status(201).json({ ...newPlayer, active: newPlayer.status === 'active' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists on this team' });
    }
    console.error('Create player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/players/:id/deactivate', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE players SET status = 'inactive', deactivated_at = NOW() WHERE id = $1 AND team_id = $2 RETURNING id, username, first_name, last_name, status",
      [req.params.id, req.teamId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    await auditLog('staff', req.user.id, 'player_deactivated', 'player', req.params.id, {}, req);
    res.json({ ...result.rows[0], active: false });
  } catch (err) {
    console.error('Deactivate player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/players/:id/activate', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE players SET status = 'active' WHERE id = $1 AND team_id = $2 RETURNING id, username, first_name, last_name, status",
      [req.params.id, req.teamId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    res.json({ ...result.rows[0], active: true });
  } catch (err) {
    console.error('Activate player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/players/:id/reset-password', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'UPDATE players SET password_hash = $1 WHERE id = $2 AND team_id = $3 RETURNING id',
      [passwordHash, req.params.id, req.teamId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/players/:id', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    // Verify player belongs to team
    const check = await pool.query('SELECT id FROM players WHERE id = $1 AND team_id = $2', [req.params.id, req.teamId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    await pool.query('DELETE FROM question_responses WHERE player_id = $1', [req.params.id]);
    await pool.query('DELETE FROM player_badges WHERE player_id = $1', [req.params.id]);
    await pool.query('DELETE FROM player_season_stats WHERE player_id = $1', [req.params.id]);
    await pool.query('DELETE FROM completions WHERE player_id = $1', [req.params.id]);
    await pool.query('DELETE FROM players WHERE id = $1', [req.params.id]);

    res.json({ message: 'Player deleted' });
  } catch (err) {
    console.error('Delete player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Drills ---

app.get('/api/admin/drills', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM drills WHERE team_id = $1 ORDER BY date DESC',
      [req.teamId]
    );
    // Map column names for frontend compatibility
    const drills = result.rows.map(d => ({
      ...d,
      points_completion: d.completion_points,
      points_extra: d.extra_points,
      is_challenge: d.is_challenge_day,
    }));
    res.json({ drills });
  } catch (err) {
    console.error('List drills error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/drills', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, requireActiveSubscription, async (req, res) => {
  try {
    const { date, title, description, youtube_url, target_time, points_completion, points_extra, is_challenge, bonus_criteria } = req.body;
    if (!date || !title) {
      return res.status(400).json({ error: 'Date and title are required' });
    }

    // Get active season for team
    const season = await getActiveSeasonForTeam(req.teamId);
    const seasonId = season ? season.id : null;

    const result = await pool.query(
      `INSERT INTO drills (team_id, season_id, date, title, description, youtube_url, target_time, completion_points, extra_points, bonus_criteria, is_challenge_day, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [req.teamId, seasonId, date, title, description || null, youtube_url || null,
       target_time ? parseInt(target_time, 10) : null,
       points_completion ? parseInt(points_completion, 10) : 10,
       points_extra ? parseInt(points_extra, 10) : 5,
       bonus_criteria || null,
       is_challenge || false, req.user.id]
    );

    const d = result.rows[0];
    res.status(201).json({
      ...d,
      points_completion: d.completion_points,
      points_extra: d.extra_points,
      is_challenge: d.is_challenge_day,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A drill already exists for this date on this team' });
    }
    console.error('Create drill error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/drills/:id', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { date, title, description, youtube_url, target_time, points_completion, points_extra, is_challenge, bonus_criteria } = req.body;

    const result = await pool.query(
      `UPDATE drills
       SET date = COALESCE($1, date),
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           youtube_url = COALESCE($4, youtube_url),
           target_time = $5,
           completion_points = COALESCE($6, 10),
           extra_points = COALESCE($7, 5),
           bonus_criteria = $8,
           is_challenge_day = $9
       WHERE id = $10 AND team_id = $11
       RETURNING *`,
      [date || null, title || null, description || null, youtube_url || null,
       target_time ? parseInt(target_time, 10) : null,
       points_completion ? parseInt(points_completion, 10) : null,
       points_extra ? parseInt(points_extra, 10) : null,
       bonus_criteria || null,
       is_challenge || false, req.params.id, req.teamId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Drill not found' });

    const d = result.rows[0];
    res.json({
      ...d,
      points_completion: d.completion_points,
      points_extra: d.extra_points,
      is_challenge: d.is_challenge_day,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A drill already exists for this date' });
    }
    console.error('Update drill error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/drills/:id', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM completions WHERE drill_id = $1 AND drill_id IN (SELECT id FROM drills WHERE team_id = $2)',
      [req.params.id, req.teamId]
    );
    const result = await pool.query(
      'DELETE FROM drills WHERE id = $1 AND team_id = $2 RETURNING *',
      [req.params.id, req.teamId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Drill not found' });
    res.json({ message: 'Drill deleted successfully' });
  } catch (err) {
    console.error('Delete drill error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Drill Questions (Admin) ---

app.get('/api/admin/drills/:id/questions', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const drillId = req.params.id;
    // Verify drill belongs to team
    const drillCheck = await pool.query('SELECT id FROM drills WHERE id = $1 AND team_id = $2', [drillId, req.teamId]);
    if (drillCheck.rows.length === 0) return res.status(404).json({ error: 'Drill not found' });

    const questionsResult = await pool.query(
      'SELECT * FROM questions WHERE drill_id = $1 ORDER BY position ASC',
      [drillId]
    );

    const result = [];
    for (const q of questionsResult.rows) {
      const questionData = {
        id: q.id,
        question_text: q.question_text,
        input_type: q.type,
        point_value: q.points,
        sort_order: q.position,
        min_char_count: null,
        options: [],
        acceptable_answers: [],
      };
      if (q.type === 'radio' || q.type === 'checkbox') {
        const opts = await pool.query(
          'SELECT * FROM question_options WHERE question_id = $1 ORDER BY position ASC',
          [q.id]
        );
        questionData.options = opts.rows.map(o => ({
          id: o.id,
          option_text: o.option_text,
          is_correct: o.is_correct,
          sort_order: o.position,
        }));
      } else if (q.type === 'text') {
        const answers = await pool.query(
          'SELECT * FROM question_text_answers WHERE question_id = $1',
          [q.id]
        );
        questionData.acceptable_answers = answers.rows.map(a => ({
          id: a.id,
          answer_text: a.acceptable_answer,
        }));
      }
      result.push(questionData);
    }

    res.json({ questions: result });
  } catch (err) {
    console.error('Get drill questions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/drills/:id/questions', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    const drillId = req.params.id;
    const { questions } = req.body;

    // Verify drill belongs to team
    const drillCheck = await client.query('SELECT id FROM drills WHERE id = $1 AND team_id = $2', [drillId, req.teamId]);
    if (drillCheck.rows.length === 0) return res.status(404).json({ error: 'Drill not found' });

    if (!Array.isArray(questions)) return res.status(400).json({ error: 'Questions must be an array' });
    if (questions.length > 20) return res.status(400).json({ error: 'Maximum 20 questions per drill' });

    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM questions WHERE drill_id = $1', [drillId]);
    const existingIds = new Set(existing.rows.map(r => r.id));
    const incomingIds = new Set(questions.filter(q => q.id).map(q => q.id));

    for (const existId of existingIds) {
      if (!incomingIds.has(existId)) {
        await client.query('DELETE FROM questions WHERE id = $1', [existId]);
      }
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      let questionId;

      if (q.id && existingIds.has(q.id)) {
        await client.query(
          'UPDATE questions SET question_text = $1, type = $2, points = $3, position = $4 WHERE id = $5',
          [q.question_text, q.input_type, parseInt(q.point_value, 10) || 1, i, q.id]
        );
        questionId = q.id;
      } else {
        const insertResult = await client.query(
          'INSERT INTO questions (drill_id, question_text, type, points, position) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [drillId, q.question_text, q.input_type, parseInt(q.point_value, 10) || 1, i]
        );
        questionId = insertResult.rows[0].id;
      }

      if (q.input_type === 'radio' || q.input_type === 'checkbox') {
        await client.query('DELETE FROM question_options WHERE question_id = $1', [questionId]);
        if (q.options && q.options.length > 0) {
          for (let j = 0; j < q.options.length; j++) {
            const opt = q.options[j];
            await client.query(
              'INSERT INTO question_options (question_id, option_text, is_correct, position) VALUES ($1, $2, $3, $4)',
              [questionId, opt.option_text, opt.is_correct || false, j]
            );
          }
        }
      }

      if (q.input_type === 'text') {
        await client.query('DELETE FROM question_text_answers WHERE question_id = $1', [questionId]);
        if (q.acceptable_answers && q.acceptable_answers.length > 0) {
          for (const ans of q.acceptable_answers) {
            const ansText = typeof ans === 'string' ? ans : ans.answer_text;
            await client.query(
              'INSERT INTO question_text_answers (question_id, acceptable_answer) VALUES ($1, $2)',
              [questionId, ansText]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Questions saved' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save drill questions error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// --- Seasons ---

app.get('/api/admin/seasons', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM seasons WHERE team_id = $1 ORDER BY start_date DESC',
      [req.teamId]
    );
    // Map status to active boolean for frontend compatibility
    const seasons = result.rows.map(s => ({ ...s, active: s.status === 'active' }));
    res.json({ seasons });
  } catch (err) {
    console.error('List seasons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/seasons', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, requireActiveSubscription, async (req, res) => {
  try {
    const { name, start_date } = req.body;
    let { end_date } = req.body;
    if (!name || !start_date) {
      return res.status(400).json({ error: 'Name and start_date are required' });
    }

    // Default end_date to ~11 months after start if not provided
    if (!end_date) {
      const start = new Date(start_date);
      start.setMonth(start.getMonth() + 11);
      end_date = start.toISOString().split('T')[0];
    }

    const result = await pool.query(
      `INSERT INTO seasons (team_id, name, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, 'archived')
       RETURNING *`,
      [req.teamId, name, start_date, end_date]
    );

    res.status(201).json({ ...result.rows[0], active: false });
  } catch (err) {
    console.error('Create season error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/seasons/:id', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { name, start_date, end_date } = req.body;

    const result = await pool.query(
      `UPDATE seasons
       SET name = COALESCE($1, name),
           start_date = COALESCE($2, start_date),
           end_date = COALESCE($3, end_date)
       WHERE id = $4 AND team_id = $5
       RETURNING *`,
      [name || null, start_date || null, end_date || null, req.params.id, req.teamId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Season not found' });
    res.json({ ...result.rows[0], active: result.rows[0].status === 'active' });
  } catch (err) {
    console.error('Update season error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/seasons/:id/activate', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    // Archive all seasons for this team (any previously active one)
    await pool.query(
      "UPDATE seasons SET status = 'archived' WHERE team_id = $1 AND status = 'active'",
      [req.teamId]
    );

    // Activate the specified season
    const result = await pool.query(
      "UPDATE seasons SET status = 'active' WHERE id = $1 AND team_id = $2 RETURNING *",
      [req.params.id, req.teamId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Season not found' });

    // Update team's active_season_id
    await pool.query(
      'UPDATE teams SET active_season_id = $1 WHERE id = $2',
      [req.params.id, req.teamId]
    );

    // Create fresh player_season_stats for all active players on this team
    const activePlayers = await pool.query(
      "SELECT id FROM players WHERE team_id = $1 AND status = 'active'",
      [req.teamId]
    );
    for (const player of activePlayers.rows) {
      await pool.query(
        `INSERT INTO player_season_stats (player_id, season_id, season_points, current_streak, longest_streak)
         VALUES ($1, $2, 0, 0, 0)
         ON CONFLICT (player_id, season_id) DO NOTHING`,
        [player.id, req.params.id]
      );
    }

    res.json({ ...result.rows[0], active: true });
  } catch (err) {
    console.error('Activate season error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/seasons/:id', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM seasons WHERE id = $1 AND team_id = $2 RETURNING id',
      [req.params.id, req.teamId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Season not found' });

    // If this was the active season, clear team's active_season_id
    await pool.query(
      'UPDATE teams SET active_season_id = NULL WHERE id = $1 AND active_season_id = $2',
      [req.teamId, req.params.id]
    );

    res.json({ message: 'Season deleted' });
  } catch (err) {
    console.error('Delete season error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Coaches ---

app.post('/api/admin/coaches', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { first_name, last_name, email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if user with this email already exists
    const existing = await pool.query('SELECT id, first_name, last_name FROM users WHERE email = $1', [email.toLowerCase().trim()]);

    if (existing.rows.length > 0) {
      // Link existing user to team
      await pool.query(
        'INSERT INTO coach_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [existing.rows[0].id, req.teamId]
      );
      const coach = await pool.query('SELECT id, email, first_name, last_name, role, status, created_at FROM users WHERE id = $1', [existing.rows[0].id]);
      return res.status(201).json({ coach: coach.rows[0], linked: true });
    }

    // Create invitation for new coach
    // Get the team's club_id for the invitation
    const teamResult = await pool.query('SELECT club_id, name FROM teams WHERE id = $1', [req.teamId]);
    const clubId = teamResult.rows[0]?.club_id;

    const invResult = await pool.query(
      `INSERT INTO invitations (email, role, club_id, team_id, token, invited_by)
       VALUES ($1, 'coach', $2, $3, 'placeholder', $4) RETURNING id`,
      [email.toLowerCase().trim(), clubId, req.teamId, req.user.id]
    );
    const invId = invResult.rows[0].id;
    const token = generateInvitationToken(invId, email.toLowerCase().trim(), 'coach');
    await pool.query('UPDATE invitations SET token = $1 WHERE id = $2', [token, invId]);

    // Send invitation email
    const clubResult = clubId ? await pool.query('SELECT name FROM clubs WHERE id = $1', [clubId]) : { rows: [{ name: teamResult.rows[0]?.name || 'Daily Reps' }] };
    const clubName = clubResult.rows[0]?.name || 'Daily Reps';
    const inviterName = `${req.user.first_name} ${req.user.last_name}`;
    await sendInvitationEmail(email.toLowerCase().trim(), 'coach', clubName, inviterName, token);

    await auditLog('staff', req.user.id, 'invitation_sent', 'invitation', invId,
      { email, role: 'coach' }, req);

    res.status(201).json({ invitation_sent: true, email });
  } catch (err) {
    console.error('Invite coach error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// DYNAMIC MANIFEST FOR TEAM-SCOPED PWA
// ============================================================

app.get('/t/:joinCode/manifest.json', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT name, primary_color FROM teams WHERE join_code = $1 AND status = 'active'",
      [req.params.joinCode.toUpperCase().trim()]
    );

    const team = result.rows[0];
    const teamName = team ? team.name : 'Daily Reps';
    const themeColor = team ? team.primary_color : '#f77c00';

    res.json({
      short_name: 'Daily Reps',
      name: `Daily Reps - ${teamName}`,
      icons: [
        { src: '/dailyreps3.png', type: 'image/png', sizes: '192x192' },
        { src: '/dailyreps3.png', type: 'image/png', sizes: '512x512' },
      ],
      start_url: `/t/${req.params.joinCode.toUpperCase().trim()}`,
      display: 'standalone',
      theme_color: themeColor,
      background_color: '#000000',
      orientation: 'portrait',
    });
  } catch (err) {
    console.error('Dynamic manifest error:', err);
    // Fallback manifest
    res.json({
      short_name: 'Daily Reps',
      name: 'Daily Reps Training',
      icons: [
        { src: '/dailyreps3.png', type: 'image/png', sizes: '192x192' },
        { src: '/dailyreps3.png', type: 'image/png', sizes: '512x512' },
      ],
      start_url: '/',
      display: 'standalone',
      theme_color: '#f77c00',
      background_color: '#000000',
      orientation: 'portrait',
    });
  }
});

// ============================================================
// MFA ENDPOINTS
// ============================================================

// POST /api/auth/mfa/setup - Generate TOTP secret and QR code
app.post('/api/auth/mfa/setup', authenticate, async (req, res) => {
  try {
    if (req.role === 'player') {
      return res.status(403).json({ error: 'MFA not available for players' });
    }

    const user = await pool.query('SELECT id, email, mfa_enabled, mfa_secret FROM users WHERE id = $1', [req.user.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    if (user.rows[0].mfa_enabled) {
      return res.status(400).json({ error: 'MFA already enabled' });
    }

    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: 'Daily Reps',
      label: user.rows[0].email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });

    // Store secret (not yet enabled)
    await pool.query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret.base32, req.user.id]);

    const otpauthUrl = totp.toString();
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    res.json({
      secret: secret.base32,
      qr_code: qrCodeDataUrl,
      otpauth_url: otpauthUrl,
    });
  } catch (err) {
    console.error('MFA setup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/mfa/verify-setup - Confirm MFA setup with TOTP code
app.post('/api/auth/mfa/verify-setup', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });

    const user = await pool.query(
      'SELECT id, email, role, first_name, last_name, club_id, mfa_secret, mfa_enabled FROM users WHERE id = $1',
      [req.user.id]
    );
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (user.rows[0].mfa_enabled) return res.status(400).json({ error: 'MFA already enabled' });
    if (!user.rows[0].mfa_secret) return res.status(400).json({ error: 'MFA setup not initiated' });

    const totp = new TOTP({
      issuer: 'Daily Reps',
      label: user.rows[0].email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(user.rows[0].mfa_secret),
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      return res.status(401).json({ error: 'Invalid code. Please try again.' });
    }

    await pool.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [req.user.id]);
    await auditLog('staff', req.user.id, 'mfa_enabled', 'user', req.user.id, {}, req);

    // Issue full token now that MFA is set up
    const u = user.rows[0];
    const tokenPayload = {
      id: u.id, email: u.email, role: u.role,
      first_name: u.first_name, last_name: u.last_name, club_id: u.club_id,
    };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    let teams = [];
    if (u.role === 'coach') {
      const teamsResult = await pool.query(
        `SELECT t.id, t.name, t.join_code, t.primary_color, t.logo_url FROM teams t
         JOIN coach_teams ct ON ct.team_id = t.id WHERE ct.user_id = $1 AND t.status = 'active' ORDER BY t.name`,
        [u.id]
      );
      teams = teamsResult.rows;
    }

    res.json({ token, user: tokenPayload, teams });
  } catch (err) {
    console.error('MFA verify-setup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/mfa/verify - Verify TOTP during login
app.post('/api/auth/mfa/verify', async (req, res) => {
  try {
    const { mfa_session, code } = req.body;
    if (!mfa_session || !code) {
      return res.status(400).json({ error: 'Session and code are required' });
    }

    let sessionData;
    try {
      sessionData = jwt.verify(mfa_session, JWT_SECRET);
      if (sessionData.purpose !== 'mfa') throw new Error('Invalid session');
    } catch (err) {
      return res.status(401).json({ error: 'MFA session expired. Please log in again.' });
    }

    const user = await pool.query(
      "SELECT * FROM users WHERE id = $1 AND status = 'active'",
      [sessionData.id]
    );
    if (user.rows.length === 0) return res.status(401).json({ error: 'User not found' });

    const u = user.rows[0];
    const totp = new TOTP({
      issuer: 'Daily Reps',
      label: u.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(u.mfa_secret),
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      return res.status(401).json({ error: 'Invalid code' });
    }

    const tokenPayload = {
      id: u.id, email: u.email, role: u.role,
      first_name: u.first_name, last_name: u.last_name, club_id: u.club_id,
    };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    let teams = [];
    if (u.role === 'coach') {
      const teamsResult = await pool.query(
        `SELECT t.id, t.name, t.join_code, t.primary_color, t.logo_url FROM teams t
         JOIN coach_teams ct ON ct.team_id = t.id WHERE ct.user_id = $1 AND t.status = 'active' ORDER BY t.name`,
        [u.id]
      );
      teams = teamsResult.rows;
    }

    res.json({ token, user: tokenPayload, teams });
  } catch (err) {
    console.error('MFA verify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// STAFF PASSWORD CHANGE
// ============================================================

app.put('/api/auth/change-password', authenticate, async (req, res) => {
  try {
    if (req.role === 'player') return res.status(403).json({ error: 'Use player password reset' });

    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }

    const pwError = validateStaffPassword(new_password);
    if (pwError) return res.status(400).json({ error: pwError });

    const user = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// TEAM CONSENT MANAGEMENT
// ============================================================

// PUT /api/admin/teams/:id/under-13
app.put('/api/admin/teams/:id/under-13', authenticate, requireRole('coach', 'super_admin', 'club_admin'), async (req, res) => {
  try {
    const { has_under_13 } = req.body;
    if (typeof has_under_13 !== 'boolean') {
      return res.status(400).json({ error: 'has_under_13 must be a boolean' });
    }

    const teamId = req.params.id;

    // Verify team access
    if (req.role === 'coach') {
      const check = await pool.query('SELECT 1 FROM coach_teams WHERE user_id = $1 AND team_id = $2', [req.user.id, teamId]);
      if (check.rows.length === 0) return res.status(403).json({ error: 'No access to this team' });
    } else if (req.role === 'club_admin') {
      const check = await pool.query('SELECT 1 FROM teams WHERE id = $1 AND club_id = $2', [teamId, req.user.club_id]);
      if (check.rows.length === 0) return res.status(403).json({ error: 'Team not in your club' });
    }

    const teamResult = await pool.query('UPDATE teams SET has_under_13 = $1 WHERE id = $2 RETURNING name', [has_under_13, teamId]);
    if (teamResult.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
    const teamName = teamResult.rows[0].name;

    if (has_under_13) {
      // Lock un-consented players
      const locked = await pool.query(
        `UPDATE players SET status = 'pending', consent_status = 'awaiting'
         WHERE team_id = $1 AND (consent_status IS NULL OR consent_status NOT IN ('granted'))
         AND status = 'active'
         RETURNING id, first_name, last_name, parent_email`,
        [teamId]
      );

      await auditLog('staff', req.user.id, 'team_under13_enabled', 'team', teamId, { has_under_13: true }, req);

      // Auto-send consent emails to locked players with parent_email
      let emailsSent = 0;
      for (const player of locked.rows) {
        if (player.parent_email) {
          try {
            await sendConsentEmail(player, teamName, player.parent_email);
            await auditLog('system', null, 'consent_email_sent', 'player', player.id, { parent_email: player.parent_email }, req);
            emailsSent++;
          } catch (emailErr) {
            console.error(`Consent email error for player ${player.id}:`, emailErr.message);
          }
        }
      }

      res.json({ message: 'Team updated', has_under_13, players_locked: locked.rows.length, emails_sent: emailsSent });
    } else {
      // Activate awaiting players
      await pool.query(
        `UPDATE players SET consent_status = 'not_required', status = 'active'
         WHERE team_id = $1 AND consent_status = 'awaiting' AND status = 'pending'`,
        [teamId]
      );
      await auditLog('staff', req.user.id, 'team_under13_disabled', 'team', teamId, { has_under_13: false }, req);
      res.json({ message: 'Team updated', has_under_13 });
    }
  } catch (err) {
    console.error('Update under-13 error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/teams/current - Get current team info including has_under_13
app.get('/api/admin/teams/current', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, has_under_13, join_code, primary_color, logo_url FROM teams WHERE id = $1', [req.teamId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
    res.json({ team: result.rows[0] });
  } catch (err) {
    console.error('Get team error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// CONSENT FLOW ENDPOINTS
// ============================================================

// POST /api/admin/players/:id/send-consent - Send/resend consent email
app.post('/api/admin/players/:id/send-consent', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const player = await pool.query(
      'SELECT p.*, t.name as team_name FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1 AND p.team_id = $2',
      [req.params.id, req.teamId]
    );
    if (player.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    const p = player.rows[0];
    if (!p.parent_email) return res.status(400).json({ error: 'No parent email on file for this player' });

    await sendConsentEmail(p, p.team_name, p.parent_email);
    await auditLog('staff', req.user.id, 'consent_email_sent', 'player', p.id, { parent_email: p.parent_email }, req);

    res.json({ message: 'Consent email sent' });
  } catch (err) {
    console.error('Send consent error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/players/:id/record-consent - Record uploaded document consent
app.post('/api/admin/players/:id/record-consent', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { parent_name, document_reference } = req.body;
    if (!parent_name) return res.status(400).json({ error: 'Parent name is required' });

    const player = await pool.query(
      'SELECT p.*, t.club_id FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1 AND p.team_id = $2',
      [req.params.id, req.teamId]
    );
    if (player.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    const p = player.rows[0];

    const settings = await pool.query('SELECT privacy_policy_version, consent_language FROM app_settings WHERE id = 1');

    await pool.query(
      `INSERT INTO consent_records (player_id, team_id, club_id, parent_name, parent_email, consent_source,
        consent_language, privacy_policy_version, status, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, 'uploaded_document', $6, $7, 'granted', $8, $9)`,
      [p.id, req.teamId, p.club_id, parent_name, p.parent_email || 'on-file',
       document_reference || 'Paper consent form on file',
       settings.rows[0].privacy_policy_version,
       req.headers['x-forwarded-for'] || req.socket.remoteAddress,
       req.headers['user-agent']]
    );

    await pool.query(
      "UPDATE players SET consent_status = 'granted', status = 'active' WHERE id = $1",
      [p.id]
    );

    await auditLog('staff', req.user.id, 'consent_granted', 'player', p.id,
      { consent_source: 'uploaded_document', parent_name }, req);
    await auditLog('system', null, 'player_activated', 'player', p.id,
      { reason: 'consent_granted_document' }, req);

    res.json({ message: 'Consent recorded and player activated' });
  } catch (err) {
    console.error('Record consent error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/players/:id/update-parent-email - Update parent email and optionally send consent
app.post('/api/admin/players/:id/update-parent-email', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { parent_email, send_consent } = req.body;
    if (!parent_email) return res.status(400).json({ error: 'Parent email is required' });

    const player = await pool.query(
      'SELECT p.*, t.name as team_name FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1 AND p.team_id = $2',
      [req.params.id, req.teamId]
    );
    if (player.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    await pool.query('UPDATE players SET parent_email = $1 WHERE id = $2', [parent_email, req.params.id]);

    const p = player.rows[0];
    if (send_consent && p.consent_status === 'awaiting') {
      await sendConsentEmail({ ...p, parent_email }, p.team_name, parent_email);
      await auditLog('staff', req.user.id, 'consent_email_sent', 'player', p.id, { parent_email }, req);
    }

    res.json({ message: 'Parent email updated' });
  } catch (err) {
    console.error('Update parent email error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/consent/:token - Get consent info for display (public, unauthenticated)
app.get('/api/consent/:token', async (req, res) => {
  try {
    const decoded = verifyConsentToken(req.params.token);
    if (!decoded) return res.status(400).json({ error: 'Invalid or expired consent link. Please ask the coach to resend it.' });

    const player = await pool.query(
      `SELECT p.first_name, p.last_name, p.consent_status, t.name as team_name
       FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1`,
      [decoded.player_id]
    );
    if (player.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    const p = player.rows[0];
    if (p.consent_status === 'granted') {
      return res.json({ already_granted: true, player_name: `${p.first_name} ${p.last_name}`, team_name: p.team_name });
    }

    const settings = await pool.query('SELECT consent_language, privacy_policy_version, privacy_policy_content FROM app_settings WHERE id = 1');

    res.json({
      player_name: `${p.first_name} ${p.last_name}`,
      team_name: p.team_name,
      consent_language: settings.rows[0].consent_language,
      privacy_policy_version: settings.rows[0].privacy_policy_version,
      privacy_policy_content: settings.rows[0].privacy_policy_content,
    });
  } catch (err) {
    console.error('Get consent info error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/consent/:token/grant - Parent grants consent (public, unauthenticated)
app.post('/api/consent/:token/grant', async (req, res) => {
  try {
    const decoded = verifyConsentToken(req.params.token);
    if (!decoded) return res.status(400).json({ error: 'Invalid or expired consent link. Please ask the coach to resend it.' });

    const { parent_name } = req.body;

    const player = await pool.query(
      'SELECT p.*, t.club_id, t.name as team_name FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1',
      [decoded.player_id]
    );
    if (player.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    const p = player.rows[0];

    if (p.consent_status === 'granted') {
      return res.json({ message: 'Consent already granted', already_granted: true });
    }

    const settings = await pool.query('SELECT consent_language, privacy_policy_version FROM app_settings WHERE id = 1');
    const appSettings = settings.rows[0];

    await pool.query(
      `INSERT INTO consent_records (player_id, team_id, club_id, parent_name, parent_email, consent_source,
        consent_language, privacy_policy_version, status, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, 'parent_email', $6, $7, 'granted', $8, $9)`,
      [p.id, p.team_id, p.club_id, parent_name || 'Parent/Guardian',
       decoded.parent_email, appSettings.consent_language,
       appSettings.privacy_policy_version,
       req.headers['x-forwarded-for'] || req.socket.remoteAddress,
       req.headers['user-agent']]
    );

    await pool.query(
      "UPDATE players SET consent_status = 'granted', status = 'active' WHERE id = $1",
      [p.id]
    );

    await auditLog('parent', null, 'consent_granted', 'player', p.id,
      { consent_source: 'parent_email', parent_email: decoded.parent_email }, req);
    await auditLog('system', null, 'player_activated', 'player', p.id,
      { reason: 'consent_granted_email' }, req);

    res.json({ message: 'Consent granted. Your child can now log in and start training!', player_name: `${p.first_name} ${p.last_name}` });
  } catch (err) {
    console.error('Grant consent error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// PARENT PORTAL
// ============================================================

// POST /api/parent-portal/request-link
app.post('/api/parent-portal/request-link', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const genericResponse = { message: 'If that email is on file, we sent a link.' };

    const players = await pool.query(
      'SELECT p.id, p.first_name, p.last_name, t.name as team_name FROM players p JOIN teams t ON t.id = p.team_id WHERE p.parent_email = $1',
      [email.toLowerCase().trim()]
    );

    if (players.rows.length === 0) {
      return res.json(genericResponse);
    }

    const token = generateParentPortalToken(email.toLowerCase().trim());
    const portalUrl = `${APP_URL}/parent-portal/${token}`;

    const playerList = players.rows.map(p => `<li>${p.first_name} ${p.last_name} (${p.team_name})</li>`).join('');

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #222;">
        <h2 style="color: #1348e5;">Daily Reps — Parent Portal Access</h2>
        <p>Hello,</p>
        <p>You requested access to the Parent Portal for the following players:</p>
        <ul>${playerList}</ul>
        <p style="text-align: center;">
          <a href="${portalUrl}" style="display: inline-block; padding: 14px 28px; background: #1348e5; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
            Open Parent Portal
          </a>
        </p>
        <p style="font-size: 0.85em; color: #666; margin-top: 24px;">This link expires in 1 hour.</p>
      </div>
    `;

    await sendEmail(email.toLowerCase().trim(), 'Daily Reps: Parent Portal Access', emailHtml);

    res.json(genericResponse);
  } catch (err) {
    console.error('Parent portal request error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/parent-portal/:token - Get children data
app.get('/api/parent-portal/:token', async (req, res) => {
  try {
    const decoded = verifyConsentToken(req.params.token, 'parent_portal');
    if (!decoded) return res.status(400).json({ error: 'Invalid or expired link. Please request a new one.' });

    const players = await pool.query(
      `SELECT p.id, p.first_name, p.last_name, p.username, p.consent_status, p.status,
              p.lifetime_points, p.created_at, t.name as team_name, t.id as team_id
       FROM players p JOIN teams t ON t.id = p.team_id
       WHERE p.parent_email = $1`,
      [decoded.parent_email]
    );

    // Get stats for each player
    const children = [];
    for (const player of players.rows) {
      // Get season stats
      const statsResult = await pool.query(
        `SELECT pss.season_points, pss.current_streak, pss.longest_streak, s.name as season_name
         FROM player_season_stats pss
         JOIN seasons s ON s.id = pss.season_id
         WHERE pss.player_id = $1
         ORDER BY s.start_date DESC LIMIT 1`,
        [player.id]
      );

      // Get completion count
      const completionResult = await pool.query(
        'SELECT COUNT(*) as total_completions FROM completions WHERE player_id = $1',
        [player.id]
      );

      // Get current level
      const level = getLevelInfo(player.lifetime_points);

      const stats = statsResult.rows[0] || {};
      children.push({
        id: player.id,
        first_name: player.first_name,
        last_name: player.last_name,
        team_name: player.team_name,
        consent_status: player.consent_status,
        status: player.status,
        lifetime_points: player.lifetime_points,
        current_streak: stats.current_streak || 0,
        longest_streak: stats.longest_streak || 0,
        season_points: stats.season_points || 0,
        total_completions: parseInt(completionResult.rows[0].total_completions),
        level: level,
        created_at: player.created_at,
      });
    }

    // Get consent records
    const consentRecords = await pool.query(
      `SELECT cr.id, cr.player_id, cr.consent_source, cr.status, cr.granted_at, cr.revoked_at, cr.privacy_policy_version
       FROM consent_records cr
       WHERE cr.parent_email = $1 ORDER BY cr.created_at DESC`,
      [decoded.parent_email]
    );

    await auditLog('parent', null, 'player_data_viewed', 'player', null,
      { parent_email: decoded.parent_email, players_viewed: players.rows.map(p => p.id) }, req);

    res.json({
      children,
      consent_records: consentRecords.rows,
    });
  } catch (err) {
    console.error('Parent portal get error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/parent-portal/:token/revoke - Revoke consent for a player
app.post('/api/parent-portal/:token/revoke', async (req, res) => {
  try {
    const decoded = verifyConsentToken(req.params.token, 'parent_portal');
    if (!decoded) return res.status(400).json({ error: 'Invalid or expired link. Please request a new one.' });

    const { player_id } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const player = await pool.query(
      'SELECT * FROM players WHERE id = $1 AND parent_email = $2',
      [player_id, decoded.parent_email]
    );
    if (player.rows.length === 0) return res.status(403).json({ error: 'Not authorized for this player' });

    await pool.query(
      "UPDATE consent_records SET status = 'revoked', revoked_at = NOW() WHERE player_id = $1 AND status = 'granted'",
      [player_id]
    );

    await pool.query(
      "UPDATE players SET consent_status = 'revoked', status = 'inactive', deactivated_at = NOW() WHERE id = $1",
      [player_id]
    );

    await auditLog('parent', null, 'consent_revoked', 'player', player_id,
      { parent_email: decoded.parent_email }, req);
    await auditLog('system', null, 'player_deactivated', 'player', player_id,
      { reason: 'consent_revoked' }, req);

    res.json({ message: 'Consent revoked. The player account has been deactivated.' });
  } catch (err) {
    console.error('Revoke consent error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/parent-portal/:token/delete - Request player data deletion
app.post('/api/parent-portal/:token/delete', async (req, res) => {
  try {
    const decoded = verifyConsentToken(req.params.token, 'parent_portal');
    if (!decoded) return res.status(400).json({ error: 'Invalid or expired link. Please request a new one.' });

    const { player_id } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const player = await pool.query(
      'SELECT * FROM players WHERE id = $1 AND parent_email = $2',
      [player_id, decoded.parent_email]
    );
    if (player.rows.length === 0) return res.status(403).json({ error: 'Not authorized for this player' });

    await pool.query(
      "UPDATE players SET deletion_requested_at = NOW(), status = 'inactive', consent_status = 'revoked', deactivated_at = COALESCE(deactivated_at, NOW()) WHERE id = $1",
      [player_id]
    );

    await pool.query(
      "UPDATE consent_records SET status = 'revoked', revoked_at = NOW() WHERE player_id = $1 AND status = 'granted'",
      [player_id]
    );

    await auditLog('parent', null, 'deletion_requested', 'player', player_id,
      { parent_email: decoded.parent_email }, req);

    res.json({ message: 'Deletion request received. Personal data will be removed within the retention period.' });
  } catch (err) {
    console.error('Delete request error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// PRIVACY POLICY (server-rendered, must be before SPA catch-all)
// ============================================================

app.get('/privacy', async (req, res) => {
  try {
    const settings = await pool.query('SELECT privacy_policy_content, privacy_policy_version FROM app_settings WHERE id = 1');
    if (settings.rows.length === 0) {
      return res.status(404).send('Privacy policy not found');
    }
    const { privacy_policy_content, privacy_policy_version } = settings.rows[0];

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Reps — Privacy Policy</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           max-width: 800px; margin: 0 auto; padding: 20px; color: #222; line-height: 1.6; }
    h1 { color: #1348e5; }
    h2 { color: #333; border-bottom: 1px solid #eee; padding-bottom: 8px; margin-top: 32px; }
    ul, ol { padding-left: 24px; }
    li { margin-bottom: 4px; }
    .version { color: #666; font-size: 0.9em; margin-bottom: 24px; }
    a { color: #1348e5; }
  </style>
</head>
<body>
  <div class="version">Privacy Policy Version ${privacy_policy_version}</div>
  ${privacy_policy_content}
  <hr style="margin-top: 40px;">
  <p style="color: #666; font-size: 0.9em;"><a href="/">Back to Daily Reps</a></p>
</body>
</html>`);
  } catch (err) {
    console.error('Privacy policy error:', err);
    res.status(500).send('Server error');
  }
});

app.get('/api/privacy-policy', async (req, res) => {
  try {
    const settings = await pool.query('SELECT privacy_policy_content, privacy_policy_version FROM app_settings WHERE id = 1');
    if (settings.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(settings.rows[0]);
  } catch (err) {
    console.error('Privacy policy API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// SUPER ADMIN ENDPOINTS
// ============================================================

// List all clubs
app.get('/api/super/clubs', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  try {
    const clubs = await pool.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM teams t WHERE t.club_id = c.id AND t.status = 'active') as team_count,
        (SELECT COUNT(*) FROM players p JOIN teams t ON t.id = p.team_id WHERE t.club_id = c.id AND p.status != 'inactive') as player_count
      FROM clubs c ORDER BY c.created_at DESC
    `);
    res.json({ clubs: clubs.rows });
  } catch (err) {
    console.error('List clubs error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create club + invite club admin
app.post('/api/super/clubs', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { club_name, admin_email, admin_first_name, admin_last_name } = req.body;
    if (!club_name || !admin_email || !admin_first_name || !admin_last_name) {
      return res.status(400).json({ error: 'Club name, admin email, first name, and last name are required' });
    }

    await client.query('BEGIN');

    // Check if email already in use
    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [admin_email.toLowerCase().trim()]);
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A user with that email already exists' });
    }

    // Create club
    const clubResult = await client.query(
      "INSERT INTO clubs (name, status) VALUES ($1, 'active') RETURNING *",
      [club_name]
    );
    const club = clubResult.rows[0];

    // Create invitation
    const invResult = await client.query(
      `INSERT INTO invitations (email, role, club_id, token, invited_by)
       VALUES ($1, 'club_admin', $2, 'placeholder', $3) RETURNING id`,
      [admin_email.toLowerCase().trim(), club.id, req.user.id]
    );
    const invId = invResult.rows[0].id;
    const token = generateInvitationToken(invId, admin_email.toLowerCase().trim(), 'club_admin');
    await client.query('UPDATE invitations SET token = $1 WHERE id = $2', [token, invId]);

    await client.query('COMMIT');

    // Send invitation email
    const inviterName = `${req.user.first_name} ${req.user.last_name}`;
    await sendInvitationEmail(admin_email.toLowerCase().trim(), 'club_admin', club_name, inviterName, token);

    await auditLog('staff', req.user.id, 'club_created', 'club', club.id, { club_name }, req);
    await auditLog('staff', req.user.id, 'invitation_sent', 'invitation', invId,
      { email: admin_email, role: 'club_admin' }, req);

    res.status(201).json({ club, invitation_sent: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create club error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ============================================================
// BUILD 6: SUPER ADMIN DASHBOARD ENDPOINTS
// ============================================================

// Plan pricing for display and monthly-equivalent calculation
const PLAN_PRICES = {
  team:       { monthly: 9.99,   annual: 79.99 },
  small_club: { monthly: 74.99,  annual: 649.99 },
  large_club: { monthly: 179.99, annual: 1499.99 },
  mega_club:  { monthly: 349.99, annual: 2899.99 },
};
const ADDON_PRICES = { monthly: 0.59, annual: 4.99 };

const PLAN_NAMES = { team: 'Team', small_club: 'Small Club', large_club: 'Large Club', mega_club: 'Mega Club' };

// Helper: compute activity stats for an owner (club or team)
async function getOwnerActivityStats(ownerType, ownerId, weekStartStr, tenDaysAgo) {
  let activeThisWeek = 0, lastActivity = null;
  if (ownerType === 'club') {
    const activeResult = await pool.query(
      `SELECT COUNT(DISTINCT c.player_id) as cnt
       FROM completions c JOIN drills d ON d.id = c.drill_id
       JOIN players p ON p.id = c.player_id
       JOIN teams t ON t.id = d.team_id
       WHERE t.club_id = $1 AND c.completed_at >= $2 AND p.status = 'active'`,
      [ownerId, weekStartStr]
    );
    activeThisWeek = parseInt(activeResult.rows[0]?.cnt || 0);
    const lastActResult = await pool.query(
      `SELECT MAX(c.completed_at) as last_active
       FROM completions c JOIN drills d ON d.id = c.drill_id
       JOIN teams t ON t.id = d.team_id
       WHERE t.club_id = $1`,
      [ownerId]
    );
    lastActivity = lastActResult.rows[0]?.last_active || null;
  } else {
    const activeResult = await pool.query(
      `SELECT COUNT(DISTINCT c.player_id) as cnt
       FROM completions c JOIN drills d ON d.id = c.drill_id
       JOIN players p ON p.id = c.player_id
       WHERE d.team_id = $1 AND c.completed_at >= $2 AND p.status = 'active'`,
      [ownerId, weekStartStr]
    );
    activeThisWeek = parseInt(activeResult.rows[0]?.cnt || 0);
    const lastActResult = await pool.query(
      `SELECT MAX(c.completed_at) as last_active
       FROM completions c JOIN drills d ON d.id = c.drill_id
       WHERE d.team_id = $1`,
      [ownerId]
    );
    lastActivity = lastActResult.rows[0]?.last_active || null;
  }
  const isDormant = !lastActivity || new Date(lastActivity) < tenDaysAgo;
  return { activeThisWeek, lastActivity, isDormant };
}

// GET /api/super/accounts — Full accounts list with billing + activity data
app.get('/api/super/accounts', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  try {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() + mondayOffset);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const tenDaysAgo = new Date(now);
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

    let totalActiveAccounts = 0;
    let totalMRR = 0;
    const accounts = [];
    const seenOwners = new Set(); // track owner_type:owner_id to avoid duplicates

    // 1. Accounts with subscriptions
    const subsResult = await pool.query(`
      SELECT s.*,
        CASE WHEN s.owner_type = 'club' THEN (SELECT name FROM clubs WHERE id = s.owner_id)
             ELSE (SELECT name FROM teams WHERE id = s.owner_id) END as account_name
      FROM subscriptions s
      ORDER BY s.created_at DESC
    `);

    for (const sub of subsResult.rows) {
      seenOwners.add(`${sub.owner_type}:${sub.owner_id}`);
      const playerCount = await getActivePlayerCount(sub.owner_type, sub.owner_id);
      const effectiveCap = sub.player_cap + sub.addon_quantity;

      const planPrices = PLAN_PRICES[sub.plan] || { monthly: 0, annual: 0 };
      let amount, monthlyEquivalent;
      if (sub.comped_at) {
        amount = 0;
        monthlyEquivalent = 0;
      } else if (sub.billing_interval === 'annual') {
        amount = planPrices.annual + (sub.addon_quantity || 0) * ADDON_PRICES.annual;
        monthlyEquivalent = Math.round((amount / 12) * 100) / 100;
      } else {
        amount = planPrices.monthly + (sub.addon_quantity || 0) * ADDON_PRICES.monthly;
        monthlyEquivalent = amount;
      }

      const { activeThisWeek, lastActivity, isDormant } = await getOwnerActivityStats(sub.owner_type, sub.owner_id, weekStartStr, tenDaysAgo);
      const activePercent = playerCount > 0 ? Math.round((activeThisWeek / playerCount) * 100) : 0;

      if (['active', 'trialing'].includes(sub.status) || sub.comped_at) {
        totalActiveAccounts++;
        totalMRR += monthlyEquivalent;
      }

      accounts.push({
        id: sub.id,
        owner_type: sub.owner_type,
        owner_id: sub.owner_id,
        account_name: sub.account_name || '(unnamed)',
        plan: sub.plan,
        plan_name: PLAN_NAMES[sub.plan] || sub.plan,
        billing_interval: sub.billing_interval,
        status: sub.status,
        amount,
        monthly_equivalent: monthlyEquivalent,
        player_count: playerCount,
        player_cap: effectiveCap,
        active_this_week: activeThisWeek,
        active_percent: activePercent,
        last_activity: lastActivity,
        dormant: isDormant,
        comped: !!sub.comped_at,
        manually_suspended: sub.manually_suspended || false,
        trial_end: sub.trial_end,
        created_at: sub.created_at,
      });
    }

    // 2. Clubs without a subscription row (created via super admin before billing existed)
    const clubsResult = await pool.query("SELECT id, name, status, created_at FROM clubs ORDER BY created_at DESC");
    for (const club of clubsResult.rows) {
      if (seenOwners.has(`club:${club.id}`)) continue;
      const playerCount = await getActivePlayerCount('club', club.id);
      const { activeThisWeek, lastActivity, isDormant } = await getOwnerActivityStats('club', club.id, weekStartStr, tenDaysAgo);
      const activePercent = playerCount > 0 ? Math.round((activeThisWeek / playerCount) * 100) : 0;

      // Clubs without subscriptions count as active if their status is active
      if (club.status === 'active') {
        totalActiveAccounts++;
      }

      accounts.push({
        id: `club_${club.id}`, // synthetic id — no subscription row
        owner_type: 'club',
        owner_id: club.id,
        account_name: club.name,
        plan: null,
        plan_name: 'No plan',
        billing_interval: null,
        status: club.status === 'active' ? 'active' : club.status,
        amount: 0,
        monthly_equivalent: 0,
        player_count: playerCount,
        player_cap: '—',
        active_this_week: activeThisWeek,
        active_percent: activePercent,
        last_activity: lastActivity,
        dormant: isDormant,
        comped: false,
        manually_suspended: false,
        trial_end: null,
        created_at: club.created_at,
        no_subscription: true,
      });
    }

    // 3. Standalone teams without a subscription row and not belonging to any club
    const standaloneTeamsResult = await pool.query(
      "SELECT id, name, status, created_at FROM teams WHERE club_id IS NULL ORDER BY created_at DESC"
    );
    for (const team of standaloneTeamsResult.rows) {
      if (seenOwners.has(`team:${team.id}`)) continue;
      const playerCount = await getActivePlayerCount('team', team.id);
      const { activeThisWeek, lastActivity, isDormant } = await getOwnerActivityStats('team', team.id, weekStartStr, tenDaysAgo);
      const activePercent = playerCount > 0 ? Math.round((activeThisWeek / playerCount) * 100) : 0;

      if (team.status === 'active') {
        totalActiveAccounts++;
      }

      accounts.push({
        id: `team_${team.id}`,
        owner_type: 'team',
        owner_id: team.id,
        account_name: team.name,
        plan: null,
        plan_name: 'No plan',
        billing_interval: null,
        status: team.status === 'active' ? 'active' : team.status,
        amount: 0,
        monthly_equivalent: 0,
        player_count: playerCount,
        player_cap: '—',
        active_this_week: activeThisWeek,
        active_percent: activePercent,
        last_activity: lastActivity,
        dormant: isDormant,
        comped: false,
        manually_suspended: false,
        trial_end: null,
        created_at: team.created_at,
        no_subscription: true,
      });
    }

    totalMRR = Math.round(totalMRR * 100) / 100;

    res.json({ accounts, totals: { active_accounts: totalActiveAccounts, mrr: totalMRR } });
  } catch (err) {
    console.error('Super accounts list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/super/accounts/:id — Account detail with billing summary + teams + engagement
// Handles both real subscription IDs and synthetic IDs (club_<uuid> or team_<uuid>) for accounts without subscriptions
app.get('/api/super/accounts/:id', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  try {
    const paramId = req.params.id;
    let s = null; // subscription row (may be null)
    let ownerType, ownerId, accountName;
    let noSubscription = false;

    // Check if this is a synthetic ID for accounts without subscriptions
    if (paramId.startsWith('club_') || paramId.startsWith('team_')) {
      noSubscription = true;
      ownerType = paramId.startsWith('club_') ? 'club' : 'team';
      ownerId = paramId.replace(/^(club_|team_)/, '');
      if (ownerType === 'club') {
        const club = await pool.query('SELECT name, status FROM clubs WHERE id = $1', [ownerId]);
        if (club.rows.length === 0) return res.status(404).json({ error: 'Club not found' });
        accountName = club.rows[0].name;
      } else {
        const team = await pool.query('SELECT name, status FROM teams WHERE id = $1', [ownerId]);
        if (team.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
        accountName = team.rows[0].name;
      }
    } else {
      const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [paramId]);
      if (sub.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
      s = sub.rows[0];
      ownerType = s.owner_type;
      ownerId = s.owner_id;
      if (ownerType === 'club') {
        const club = await pool.query('SELECT name FROM clubs WHERE id = $1', [ownerId]);
        accountName = club.rows[0]?.name;
      } else {
        const team = await pool.query('SELECT name FROM teams WHERE id = $1', [ownerId]);
        accountName = team.rows[0]?.name;
      }
    }

    // Billing summary
    let billing;
    if (s) {
      const planPrices = PLAN_PRICES[s.plan] || { monthly: 0, annual: 0 };
      let amount;
      if (s.comped_at) {
        amount = 0;
      } else if (s.billing_interval === 'annual') {
        amount = planPrices.annual + (s.addon_quantity || 0) * ADDON_PRICES.annual;
      } else {
        amount = planPrices.monthly + (s.addon_quantity || 0) * ADDON_PRICES.monthly;
      }
      billing = {
        plan: s.plan,
        plan_name: PLAN_NAMES[s.plan] || s.plan,
        billing_interval: s.billing_interval,
        amount,
        status: s.status,
        current_period_end: s.current_period_end,
        trial_end: s.trial_end,
        card_brand: s.card_brand,
        card_last4: s.card_last4,
        comped: !!s.comped_at,
        comped_at: s.comped_at,
        manually_suspended: s.manually_suspended || false,
        addon_quantity: s.addon_quantity,
        player_cap: s.player_cap + s.addon_quantity,
        stripe_customer_id: s.stripe_customer_id,
        stripe_subscription_id: s.stripe_subscription_id,
      };
    } else {
      billing = {
        plan: null,
        plan_name: 'No plan',
        billing_interval: null,
        amount: 0,
        status: 'active',
        current_period_end: null,
        trial_end: null,
        card_brand: null,
        card_last4: null,
        comped: false,
        comped_at: null,
        manually_suspended: false,
        addon_quantity: 0,
        player_cap: '—',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        no_subscription: true,
      };
    }

    // Teams list
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() + mondayOffset);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const tenDaysAgo = new Date(now);
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

    let teams = [];
    const teamQuery = ownerType === 'club'
      ? await pool.query("SELECT id, name, status FROM teams WHERE club_id = $1 ORDER BY name", [ownerId])
      : await pool.query("SELECT id, name, status FROM teams WHERE id = $1", [ownerId]);

    let totalPlayers = 0;
    let totalActiveThisWeek = 0;
    let totalCompletions = 0;
    let totalPossible = 0;

    for (const team of teamQuery.rows) {
      const pcResult = await pool.query(
        "SELECT COUNT(*) as cnt FROM players WHERE team_id = $1 AND status = 'active'",
        [team.id]
      );
      const pc = parseInt(pcResult.rows[0]?.cnt || 0);
      totalPlayers += pc;

      const activeResult = await pool.query(
        `SELECT COUNT(DISTINCT c.player_id) as cnt
         FROM completions c JOIN drills d ON d.id = c.drill_id
         JOIN players p ON p.id = c.player_id
         WHERE d.team_id = $1 AND c.completed_at >= $2 AND p.status = 'active'`,
        [team.id, weekStartStr]
      );
      const activeCount = parseInt(activeResult.rows[0]?.cnt || 0);
      totalActiveThisWeek += activeCount;

      const lastActResult = await pool.query(
        `SELECT MAX(c.completed_at) as last_active FROM completions c JOIN drills d ON d.id = c.drill_id WHERE d.team_id = $1`,
        [team.id]
      );
      const lastAct = lastActResult.rows[0]?.last_active || null;

      const seasonResult = await pool.query(
        "SELECT * FROM seasons WHERE team_id = $1 AND status = 'active' LIMIT 1", [team.id]
      );
      let completionRate = 0;
      if (seasonResult.rows[0]) {
        const season = seasonResult.rows[0];
        const endDate = effectiveEndDate(season);
        const drillsCount = await pool.query(
          'SELECT COUNT(*) as cnt FROM drills WHERE team_id = $1 AND date BETWEEN $2 AND $3 AND date <= CURRENT_DATE',
          [team.id, season.start_date, endDate]
        );
        const dc = parseInt(drillsCount.rows[0]?.cnt || 0);
        totalPossible += dc * pc;
        const compsCount = await pool.query(
          `SELECT COUNT(c.id) as cnt FROM completions c JOIN drills d ON d.id = c.drill_id
           JOIN players p ON p.id = c.player_id
           WHERE d.team_id = $1 AND d.date BETWEEN $2 AND $3 AND p.status = 'active'`,
          [team.id, season.start_date, endDate]
        );
        const cc = parseInt(compsCount.rows[0]?.cnt || 0);
        totalCompletions += cc;
        completionRate = (dc * pc) > 0 ? Math.round((cc / (dc * pc)) * 100) : 0;
      }

      teams.push({
        id: team.id,
        name: team.name,
        status: team.status,
        player_count: pc,
        active_this_week: activeCount,
        last_activity: lastAct,
        dormant: !lastAct || new Date(lastAct) < tenDaysAgo,
        completion_rate: completionRate,
      });
    }

    const engagement = {
      total_players: totalPlayers,
      active_this_week: totalActiveThisWeek,
      active_percent: totalPlayers > 0 ? Math.round((totalActiveThisWeek / totalPlayers) * 100) : 0,
      completion_rate: totalPossible > 0 ? Math.round((totalCompletions / totalPossible) * 100) : 0,
      dormant_teams: teams.filter(t => t.dormant).length,
    };

    // Impersonatable users (club_admin and coaches for this account)
    let impersonatableUsers = [];
    if (ownerType === 'club') {
      const users = await pool.query(
        `SELECT id, email, role, first_name, last_name FROM users
         WHERE club_id = $1 AND status = 'active' AND role IN ('club_admin', 'coach')
         ORDER BY role, last_name`,
        [ownerId]
      );
      impersonatableUsers = users.rows;
    } else {
      const users = await pool.query(
        `SELECT u.id, u.email, u.role, u.first_name, u.last_name
         FROM users u JOIN coach_teams ct ON ct.user_id = u.id
         WHERE ct.team_id = $1 AND u.status = 'active'
         ORDER BY u.last_name`,
        [ownerId]
      );
      impersonatableUsers = users.rows;
    }

    res.json({
      account_name: accountName,
      billing,
      teams,
      engagement,
      impersonatable_users: impersonatableUsers,
      no_subscription: noSubscription,
    });
  } catch (err) {
    console.error('Super account detail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/super/impersonate — Start impersonation session
app.post('/api/super/impersonate', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const targetUser = await pool.query(
      "SELECT id, email, role, first_name, last_name, club_id FROM users WHERE id = $1 AND status = 'active'",
      [user_id]
    );
    if (targetUser.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const target = targetUser.rows[0];

    if (!['club_admin', 'coach'].includes(target.role)) {
      return res.status(400).json({ error: 'Can only impersonate club_admin or coach users' });
    }

    // Get teams for the impersonated user
    let teams = [];
    if (target.role === 'club_admin') {
      const teamsResult = await pool.query(
        "SELECT id, name, join_code, primary_color, logo_url FROM teams WHERE club_id = $1 AND status = 'active' ORDER BY name",
        [target.club_id]
      );
      teams = teamsResult.rows;
    } else {
      const teamsResult = await pool.query(
        `SELECT t.id, t.name, t.join_code, t.primary_color, t.logo_url
         FROM teams t JOIN coach_teams ct ON ct.team_id = t.id
         WHERE ct.user_id = $1 AND t.status = 'active' ORDER BY t.name`,
        [target.id]
      );
      teams = teamsResult.rows;
    }

    // Create short-lived impersonation token (30 minutes)
    const impersonationToken = jwt.sign(
      {
        id: target.id,
        email: target.email,
        role: target.role,
        first_name: target.first_name,
        last_name: target.last_name,
        club_id: target.club_id,
        impersonating: true,
        impersonated_id: target.id,
        impersonated_role: target.role,
        impersonated_club_id: target.club_id,
        real_user_id: req.user.id,
        real_user_name: `${req.user.first_name} ${req.user.last_name}`,
      },
      JWT_SECRET,
      { expiresIn: '30m' }
    );

    await auditLog('staff', req.user.id, 'impersonation_started', 'user', target.id,
      { target_email: target.email, target_role: target.role }, req);

    res.json({
      token: impersonationToken,
      user: {
        id: target.id,
        email: target.email,
        role: target.role,
        first_name: target.first_name,
        last_name: target.last_name,
        club_id: target.club_id,
      },
      teams,
    });
  } catch (err) {
    console.error('Impersonate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/super/impersonate/end — End impersonation session (audit log)
app.post('/api/super/impersonate/end', authenticate, requireRole('super_admin'), async (req, res) => {
  try {
    const { impersonated_user_id } = req.body;
    await auditLog('staff', req.user.id, 'impersonation_ended', 'user', impersonated_user_id || null,
      {}, req);
    res.json({ ok: true });
  } catch (err) {
    console.error('End impersonate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/super/accounts/:id/extend-trial — Extend trial end date
app.post('/api/super/accounts/:id/extend-trial', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  try {
    const { days } = req.body;
    if (!days || days < 1) return res.status(400).json({ error: 'days must be at least 1' });

    const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (sub.rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
    const s = sub.rows[0];

    // Calculate new trial end
    const currentTrialEnd = s.trial_end ? new Date(s.trial_end) : new Date();
    const newTrialEnd = new Date(currentTrialEnd);
    newTrialEnd.setDate(newTrialEnd.getDate() + parseInt(days));

    // Update in Stripe if subscription exists
    if (stripe && s.stripe_subscription_id) {
      try {
        await stripe.subscriptions.update(s.stripe_subscription_id, {
          trial_end: Math.floor(newTrialEnd.getTime() / 1000),
        });
      } catch (stripeErr) {
        console.error('Stripe trial extension error:', stripeErr.message);
        return res.status(500).json({ error: `Stripe error: ${stripeErr.message}` });
      }
    }

    // Update local record
    await pool.query(
      "UPDATE subscriptions SET trial_end = $1, status = 'trialing', updated_at = NOW() WHERE id = $2",
      [newTrialEnd, s.id]
    );

    await auditLog('staff', req.user.id, 'trial_extended', 'subscription', s.owner_id,
      { owner_type: s.owner_type, days, new_trial_end: newTrialEnd.toISOString() }, req);

    res.json({ trial_end: newTrialEnd, message: `Trial extended by ${days} days.` });
  } catch (err) {
    console.error('Extend trial error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/super/accounts/:id/comp — Comp an account (free access)
app.post('/api/super/accounts/:id/comp', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  try {
    const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (sub.rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
    const s = sub.rows[0];

    // Set comped state: mark as active + comped
    await pool.query(
      "UPDATE subscriptions SET status = 'active', comped_at = NOW(), comped_by = $1, manually_suspended = false, updated_at = NOW() WHERE id = $2",
      [req.user.id, s.id]
    );

    // Ensure the club/team is active
    if (s.owner_type === 'club') {
      await pool.query("UPDATE clubs SET status = 'active', subscription_status = 'active' WHERE id = $1", [s.owner_id]);
    } else {
      await pool.query("UPDATE teams SET status = 'active' WHERE id = $1", [s.owner_id]);
    }

    await auditLog('staff', req.user.id, 'account_comped', 'subscription', s.owner_id,
      { owner_type: s.owner_type }, req);

    res.json({ message: 'Account comped. Full access granted without billing.' });
  } catch (err) {
    console.error('Comp account error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/super/accounts/:id/remove-comp — Remove comp (revert to normal billing status)
app.post('/api/super/accounts/:id/remove-comp', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  try {
    const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (sub.rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
    const s = sub.rows[0];

    // Remove comp. If there's a Stripe subscription, sync status from Stripe; otherwise set to trialing.
    let newStatus = 'trialing';
    if (stripe && s.stripe_subscription_id) {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(s.stripe_subscription_id);
        newStatus = mapStripeStatus(stripeSub.status);
      } catch (err) {
        // If Stripe sub doesn't exist, default to trialing
      }
    }

    await pool.query(
      "UPDATE subscriptions SET comped_at = NULL, comped_by = NULL, status = $1, updated_at = NOW() WHERE id = $2",
      [newStatus, s.id]
    );

    await auditLog('staff', req.user.id, 'comp_removed', 'subscription', s.owner_id,
      { owner_type: s.owner_type, new_status: newStatus }, req);

    res.json({ message: 'Comp removed.', status: newStatus });
  } catch (err) {
    console.error('Remove comp error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/super/accounts/:id/discount — Apply Stripe coupon/discount
app.post('/api/super/accounts/:id/discount', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const { type, value, duration, duration_in_months } = req.body;
    if (!type || !value) return res.status(400).json({ error: 'type (percent_off or amount_off) and value are required' });
    if (!['percent_off', 'amount_off'].includes(type)) return res.status(400).json({ error: 'type must be percent_off or amount_off' });

    const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (sub.rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
    const s = sub.rows[0];

    if (!s.stripe_subscription_id) {
      return res.status(400).json({ error: 'No Stripe subscription found. Cannot apply discount without a Stripe subscription.' });
    }

    // Create Stripe coupon
    const couponParams = {
      duration: duration || 'once',
    };
    if (type === 'percent_off') {
      couponParams.percent_off = parseFloat(value);
    } else {
      couponParams.amount_off = Math.round(parseFloat(value) * 100); // Stripe expects cents
      couponParams.currency = 'usd';
    }
    if (duration === 'repeating' && duration_in_months) {
      couponParams.duration_in_months = parseInt(duration_in_months);
    }

    const coupon = await stripe.coupons.create(couponParams);

    // Apply to subscription
    await stripe.subscriptions.update(s.stripe_subscription_id, {
      coupon: coupon.id,
    });

    const discountDesc = type === 'percent_off' ? `${value}% off` : `$${value} off`;

    await auditLog('staff', req.user.id, 'discount_applied', 'subscription', s.owner_id,
      { owner_type: s.owner_type, discount: discountDesc, coupon_id: coupon.id, duration: duration || 'once' }, req);

    res.json({ message: `Discount applied: ${discountDesc}`, coupon_id: coupon.id });
  } catch (err) {
    console.error('Apply discount error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// POST /api/super/accounts/:id/suspend — Manual suspend
app.post('/api/super/accounts/:id/suspend', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  try {
    const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (sub.rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
    const s = sub.rows[0];

    await pool.query(
      "UPDATE subscriptions SET status = 'suspended', manually_suspended = true, updated_at = NOW() WHERE id = $1",
      [s.id]
    );

    // Apply read-only lock to club/team
    if (s.owner_type === 'club') {
      await pool.query("UPDATE clubs SET status = 'suspended', subscription_status = 'suspended' WHERE id = $1", [s.owner_id]);
    } else {
      await pool.query("UPDATE teams SET status = 'suspended' WHERE id = $1", [s.owner_id]);
    }

    await auditLog('staff', req.user.id, 'account_suspended', 'subscription', s.owner_id,
      { owner_type: s.owner_type, reason: req.body.reason || 'manual' }, req);

    res.json({ message: 'Account suspended. All data preserved, access is read-only.' });
  } catch (err) {
    console.error('Suspend error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/super/accounts/:id/reactivate — Reactivate suspended account
app.post('/api/super/accounts/:id/reactivate', authenticate, rejectImpersonation, requireRole('super_admin'), async (req, res) => {
  try {
    const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (sub.rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
    const s = sub.rows[0];

    // Determine what status to restore to
    let newStatus = 'active';
    if (s.comped_at) {
      newStatus = 'active';
    } else if (stripe && s.stripe_subscription_id) {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(s.stripe_subscription_id);
        newStatus = mapStripeStatus(stripeSub.status);
      } catch (err) {
        // Default to active if Stripe lookup fails
      }
    }

    await pool.query(
      "UPDATE subscriptions SET status = $1, manually_suspended = false, updated_at = NOW() WHERE id = $2",
      [newStatus, s.id]
    );

    // Unlock club/team
    if (s.owner_type === 'club') {
      await pool.query("UPDATE clubs SET status = 'active', subscription_status = $1 WHERE id = $2", [newStatus, s.owner_id]);
    } else {
      await pool.query("UPDATE teams SET status = 'active' WHERE id = $1", [s.owner_id]);
    }

    await auditLog('staff', req.user.id, 'account_reactivated', 'subscription', s.owner_id,
      { owner_type: s.owner_type, new_status: newStatus }, req);

    res.json({ message: 'Account reactivated. Full access restored.', status: newStatus });
  } catch (err) {
    console.error('Reactivate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// INVITATION ACCEPT ENDPOINTS (public, unauthenticated)
// ============================================================

// Validate invitation token
app.get('/api/invitations/:token/validate', async (req, res) => {
  try {
    const decoded = verifyInvitationToken(req.params.token);
    if (!decoded) return res.status(400).json({ error: 'Invalid or expired invitation link' });

    const inv = await pool.query(
      'SELECT i.*, c.name as club_name, t.name as team_name FROM invitations i LEFT JOIN clubs c ON c.id = i.club_id LEFT JOIN teams t ON t.id = i.team_id WHERE i.id = $1',
      [decoded.invitation_id]
    );
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Invitation not found' });
    const invitation = inv.rows[0];
    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: invitation.status === 'accepted' ? 'This invitation has already been accepted' : 'This invitation has expired' });
    }

    res.json({
      email: invitation.email,
      role: invitation.role,
      club_name: invitation.club_name,
      team_name: invitation.team_name,
    });
  } catch (err) {
    console.error('Validate invitation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Accept invitation: set password, create user
app.post('/api/invitations/:token/accept', async (req, res) => {
  const client = await pool.connect();
  try {
    const decoded = verifyInvitationToken(req.params.token);
    if (!decoded) return res.status(400).json({ error: 'Invalid or expired invitation link' });

    const inv = await client.query('SELECT * FROM invitations WHERE id = $1', [decoded.invitation_id]);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Invitation not found' });
    const invitation = inv.rows[0];
    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: 'This invitation has already been used or expired' });
    }

    const { password, first_name, last_name } = req.body;
    if (!password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Password, first name, and last name are required' });
    }

    const pwError = validateStaffPassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    await client.query('BEGIN');

    const passwordHash = await bcrypt.hash(password, 10);

    // Check if user with this email already exists
    const existing = await client.query('SELECT id, role FROM users WHERE email = $1', [invitation.email]);
    let userId;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      // Update the user's club_id if they're being made a club_admin
      if (invitation.role === 'club_admin') {
        await client.query('UPDATE users SET club_id = $1, role = $2 WHERE id = $3',
          [invitation.club_id, invitation.role, userId]);
      }
    } else {
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, club_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
        [invitation.email, passwordHash, invitation.role, first_name, last_name, invitation.club_id || null]
      );
      userId = userResult.rows[0].id;
    }

    // Link to team if team_id present (coach invitation)
    if (invitation.team_id) {
      await client.query(
        'INSERT INTO coach_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, invitation.team_id]
      );
    }

    // Mark invitation as accepted
    await client.query(
      "UPDATE invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1",
      [invitation.id]
    );

    await client.query('COMMIT');

    await auditLog('staff', userId, 'invitation_accepted', 'user', userId,
      { role: invitation.role, invitation_id: invitation.id }, req);

    // For club_admin: require MFA setup
    if (invitation.role === 'club_admin') {
      const setupToken = jwt.sign(
        { id: userId, email: invitation.email, role: invitation.role, first_name, last_name, club_id: invitation.club_id, purpose: 'mfa_setup' },
        JWT_SECRET,
        { expiresIn: '15m' }
      );
      return res.json({ mfa_setup_required: true, token: setupToken });
    }

    // For coach: issue full token
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const u = user.rows[0];
    const teamsResult = await pool.query(
      `SELECT t.id, t.name, t.join_code, t.primary_color, t.logo_url
       FROM teams t JOIN coach_teams ct ON ct.team_id = t.id
       WHERE ct.user_id = $1 AND t.status = 'active' ORDER BY t.name`,
      [userId]
    );
    const token = jwt.sign(
      { id: u.id, email: u.email, role: u.role, first_name: u.first_name, last_name: u.last_name, club_id: u.club_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      user: { id: u.id, email: u.email, role: u.role, first_name: u.first_name, last_name: u.last_name, club_id: u.club_id },
      teams: teamsResult.rows,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Accept invitation error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ============================================================
// COACH REPORTING ENDPOINTS
// ============================================================

// GET /api/admin/reports - Coach engagement report for team
app.get('/api/admin/reports', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const teamId = req.teamId;
    const season = await getActiveSeasonForTeam(teamId);
    if (!season) {
      return res.json({ noSeason: true });
    }
    const endDate = effectiveEndDate(season);

    // Get all active players on team
    const playersResult = await pool.query(
      "SELECT id, first_name, last_name, status FROM players WHERE team_id = $1 AND status = 'active' ORDER BY last_name",
      [teamId]
    );
    const players = playersResult.rows;
    const playerIds = players.map(p => p.id);

    // Get week boundary (Monday)
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() + mondayOffset);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    // This week: how many players completed at least one drill
    const thisWeekResult = await pool.query(
      `SELECT COUNT(DISTINCT c.player_id) as active_count
       FROM completions c
       JOIN drills d ON d.id = c.drill_id
       WHERE d.team_id = $1 AND c.completed_at >= $2 AND c.player_id = ANY($3::uuid[])`,
      [teamId, weekStartStr, playerIds]
    );
    const activeThisWeek = parseInt(thisWeekResult.rows[0]?.active_count || 0, 10);

    // Recent drills with completion counts (last 20 drills)
    const recentDrillsResult = await pool.query(
      `SELECT d.id, d.title, d.date,
              COUNT(c.id) as completion_count
       FROM drills d
       LEFT JOIN completions c ON c.drill_id = d.id AND c.player_id = ANY($2::uuid[])
       WHERE d.team_id = $1 AND d.date <= CURRENT_DATE AND d.date >= $3
       GROUP BY d.id, d.title, d.date
       ORDER BY d.date DESC
       LIMIT 20`,
      [teamId, playerIds, season.start_date]
    );

    // Per-player stats
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const tenDaysAgoStr = tenDaysAgo.toISOString().split('T')[0];

    // Get total drills scheduled since each player joined (or season start)
    const playerStats = [];
    for (const player of players) {
      // Player join date - use created_at or season start, whichever is later
      const playerStart = new Date(player.created_at || season.start_date) > new Date(season.start_date)
        ? (player.created_at || season.start_date)
        : season.start_date;

      // Total drills scheduled for this player since they joined
      const drillCountResult = await pool.query(
        `SELECT COUNT(*) as total FROM drills WHERE team_id = $1 AND date BETWEEN $2 AND $3 AND date <= CURRENT_DATE`,
        [teamId, season.start_date, endDate]
      );
      const totalDrills = parseInt(drillCountResult.rows[0]?.total || 0, 10);

      // Completions this season
      const compResult = await pool.query(
        `SELECT COUNT(*) as total FROM completions c JOIN drills d ON d.id = c.drill_id
         WHERE c.player_id = $1 AND d.team_id = $2 AND d.date BETWEEN $3 AND $4`,
        [player.id, teamId, season.start_date, endDate]
      );
      const completions = parseInt(compResult.rows[0]?.total || 0, 10);

      // Last active date
      const lastActiveResult = await pool.query(
        `SELECT MAX(c.completed_at) as last_active FROM completions c JOIN drills d ON d.id = c.drill_id
         WHERE c.player_id = $1 AND d.team_id = $2`,
        [player.id, teamId]
      );
      const lastActive = lastActiveResult.rows[0]?.last_active || null;

      // Current streak
      const currentStreak = await calculateCurrentStreak(player.id, teamId, season.start_date, endDate);

      const completionRate = totalDrills > 0 ? Math.round((completions / totalDrills) * 100) : 0;
      const isInactive = !lastActive || new Date(lastActive) < tenDaysAgo;

      playerStats.push({
        id: player.id,
        first_name: player.first_name,
        last_name: player.last_name,
        last_active: lastActive,
        current_streak: currentStreak,
        completions,
        completion_rate: completionRate,
        inactive: isInactive,
      });
    }

    // Weekly trend: completions per week over last 8 weeks
    const weeklyTrend = [];
    for (let w = 7; w >= 0; w--) {
      const wStart = new Date(now);
      wStart.setUTCDate(now.getUTCDate() + mondayOffset - (w * 7));
      wStart.setUTCHours(0, 0, 0, 0);
      const wEnd = new Date(wStart);
      wEnd.setUTCDate(wStart.getUTCDate() + 6);

      const wStartStr = wStart.toISOString().split('T')[0];
      const wEndStr = wEnd.toISOString().split('T')[0];

      const weekResult = await pool.query(
        `SELECT COUNT(c.id) as completions
         FROM completions c JOIN drills d ON d.id = c.drill_id
         WHERE d.team_id = $1 AND d.date BETWEEN $2 AND $3 AND c.player_id = ANY($4::uuid[])`,
        [teamId, wStartStr, wEndStr, playerIds]
      );

      weeklyTrend.push({
        week_start: wStartStr,
        completions: parseInt(weekResult.rows[0]?.completions || 0, 10),
      });
    }

    res.json({
      season: { id: season.id, name: season.name },
      total_players: players.length,
      active_this_week: activeThisWeek,
      recent_drills: recentDrillsResult.rows.map(d => ({
        id: d.id,
        title: d.title,
        date: d.date,
        completion_count: parseInt(d.completion_count, 10),
        total_players: players.length,
      })),
      player_stats: playerStats,
      weekly_trend: weeklyTrend,
    });
  } catch (err) {
    console.error('Coach reports error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// CLUB ADMIN ENDPOINTS
// ============================================================

// Dashboard data
app.get('/api/club/dashboard', authenticate, requireRole('club_admin'), requireClubAccess, async (req, res) => {
  try {
    // Club info
    const clubResult = await pool.query('SELECT * FROM clubs WHERE id = $1', [req.clubId]);
    if (clubResult.rows.length === 0) return res.status(404).json({ error: 'Club not found' });
    const club = clubResult.rows[0];

    // Teams with enriched data
    const teamsResult = await pool.query(`
      SELECT t.id, t.name, t.age_group, t.has_under_13, t.join_code, t.status, t.active_season_id,
        (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id AND p.status != 'inactive') as player_count,
        (SELECT s.name FROM seasons s WHERE s.id = t.active_season_id) as active_season_name,
        (SELECT json_agg(json_build_object('id', u.id, 'first_name', u.first_name, 'last_name', u.last_name, 'email', u.email))
         FROM users u JOIN coach_teams ct ON ct.user_id = u.id WHERE ct.team_id = t.id) as coaches
      FROM teams t WHERE t.club_id = $1 AND t.status = 'active' ORDER BY t.name
    `, [req.clubId]);

    // Total player count
    const countResult = await pool.query(
      "SELECT COUNT(*) as total FROM players p JOIN teams t ON t.id = p.team_id WHERE t.club_id = $1 AND p.status != 'inactive'",
      [req.clubId]
    );

    // Pending invitations
    const invitations = await pool.query(
      "SELECT i.*, t.name as team_name FROM invitations i LEFT JOIN teams t ON t.id = i.team_id WHERE i.club_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC",
      [req.clubId]
    );

    // Subscription info
    const subResult = await pool.query(
      "SELECT status, plan, player_cap, addon_quantity, current_period_end, trial_end, billing_interval, card_brand, card_last4 FROM subscriptions WHERE owner_type = 'club' AND owner_id = $1 ORDER BY created_at DESC LIMIT 1",
      [req.clubId]
    );
    const subscription = subResult.rows[0] || null;
    const effectiveCap = subscription ? subscription.player_cap + subscription.addon_quantity : club.player_limit;

    res.json({
      club: { id: club.id, name: club.name, status: club.status, player_limit: effectiveCap },
      teams: teamsResult.rows,
      total_players: parseInt(countResult.rows[0].total),
      invitations: invitations.rows,
      subscription: subscription ? {
        status: subscription.status,
        plan: subscription.plan,
        billing_interval: subscription.billing_interval,
        player_cap: subscription.player_cap + subscription.addon_quantity,
        current_period_end: subscription.current_period_end,
        trial_end: subscription.trial_end,
        card_brand: subscription.card_brand,
        card_last4: subscription.card_last4,
      } : null,
    });
  } catch (err) {
    console.error('Club dashboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List coaches in club
app.get('/api/club/coaches', authenticate, requireRole('club_admin'), requireClubAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
       FROM users u
       JOIN coach_teams ct ON ct.user_id = u.id
       JOIN teams t ON t.id = ct.team_id
       WHERE t.club_id = $1 AND u.status = 'active'
       ORDER BY u.last_name`,
      [req.clubId]
    );
    res.json({ coaches: result.rows });
  } catch (err) {
    console.error('List club coaches error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Club reporting
app.get('/api/club/reports', authenticate, requireRole('club_admin'), requireClubAccess, async (req, res) => {
  try {
    const clubId = req.clubId;

    // Get all active teams in club
    const teamsResult = await pool.query(
      "SELECT id, name FROM teams WHERE club_id = $1 AND status = 'active' ORDER BY name",
      [clubId]
    );

    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() + mondayOffset);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const tenDaysAgoStr = tenDaysAgo.toISOString().split('T')[0];

    let clubTotalPlayers = 0;
    let clubActiveThisWeek = 0;
    let clubTotalCompletions = 0;
    let clubTotalDrills = 0;
    const teamStats = [];

    for (const team of teamsResult.rows) {
      // Active season for this team
      const seasonResult = await pool.query(
        "SELECT * FROM seasons WHERE team_id = $1 AND status = 'active' LIMIT 1",
        [team.id]
      );
      const season = seasonResult.rows[0];

      // Player count
      const playerResult = await pool.query(
        "SELECT COUNT(*) as total FROM players WHERE team_id = $1 AND status = 'active'",
        [team.id]
      );
      const playerCount = parseInt(playerResult.rows[0]?.total || 0, 10);
      clubTotalPlayers += playerCount;

      // Players active this week
      const activeResult = await pool.query(
        `SELECT COUNT(DISTINCT c.player_id) as active_count
         FROM completions c JOIN drills d ON d.id = c.drill_id
         JOIN players p ON p.id = c.player_id
         WHERE d.team_id = $1 AND c.completed_at >= $2 AND p.status = 'active'`,
        [team.id, weekStartStr]
      );
      const activeCount = parseInt(activeResult.rows[0]?.active_count || 0, 10);
      clubActiveThisWeek += activeCount;

      // Completion rate (season drills)
      let completionRate = 0;
      let lastActivity = null;
      if (season) {
        const endDate = effectiveEndDate(season);
        const drillsResult = await pool.query(
          'SELECT COUNT(*) as total FROM drills WHERE team_id = $1 AND date BETWEEN $2 AND $3 AND date <= CURRENT_DATE',
          [team.id, season.start_date, endDate]
        );
        const totalDrills = parseInt(drillsResult.rows[0]?.total || 0, 10);
        clubTotalDrills += totalDrills * playerCount;

        const compsResult = await pool.query(
          `SELECT COUNT(c.id) as total FROM completions c JOIN drills d ON d.id = c.drill_id
           JOIN players p ON p.id = c.player_id
           WHERE d.team_id = $1 AND d.date BETWEEN $2 AND $3 AND p.status = 'active'`,
          [team.id, season.start_date, endDate]
        );
        const totalComps = parseInt(compsResult.rows[0]?.total || 0, 10);
        clubTotalCompletions += totalComps;

        completionRate = (totalDrills * playerCount) > 0
          ? Math.round((totalComps / (totalDrills * playerCount)) * 100) : 0;
      }

      // Last activity
      const lastActResult = await pool.query(
        `SELECT MAX(c.completed_at) as last_active FROM completions c JOIN drills d ON d.id = c.drill_id
         WHERE d.team_id = $1`,
        [team.id]
      );
      lastActivity = lastActResult.rows[0]?.last_active || null;

      const isDormant = !lastActivity || new Date(lastActivity) < tenDaysAgo;

      teamStats.push({
        id: team.id,
        name: team.name,
        player_count: playerCount,
        active_this_week: activeCount,
        active_percent: playerCount > 0 ? Math.round((activeCount / playerCount) * 100) : 0,
        completion_rate: completionRate,
        last_activity: lastActivity,
        dormant: isDormant,
        has_season: !!season,
      });
    }

    // Club-wide weekly trend
    const weeklyTrend = [];
    for (let w = 7; w >= 0; w--) {
      const wStart = new Date(now);
      wStart.setUTCDate(now.getUTCDate() + mondayOffset - (w * 7));
      wStart.setUTCHours(0, 0, 0, 0);
      const wEnd = new Date(wStart);
      wEnd.setUTCDate(wStart.getUTCDate() + 6);
      const wStartStr = wStart.toISOString().split('T')[0];
      const wEndStr = wEnd.toISOString().split('T')[0];

      const teamIds = teamsResult.rows.map(t => t.id);
      if (teamIds.length > 0) {
        const weekResult = await pool.query(
          `SELECT COUNT(c.id) as completions
           FROM completions c JOIN drills d ON d.id = c.drill_id
           WHERE d.team_id = ANY($1::uuid[]) AND d.date BETWEEN $2 AND $3`,
          [teamIds, wStartStr, wEndStr]
        );
        weeklyTrend.push({
          week_start: wStartStr,
          completions: parseInt(weekResult.rows[0]?.completions || 0, 10),
        });
      } else {
        weeklyTrend.push({ week_start: wStartStr, completions: 0 });
      }
    }

    const clubCompletionRate = clubTotalDrills > 0 ? Math.round((clubTotalCompletions / clubTotalDrills) * 100) : 0;

    res.json({
      total_teams: teamsResult.rows.length,
      total_players: clubTotalPlayers,
      active_this_week: clubActiveThisWeek,
      club_completion_rate: clubCompletionRate,
      team_stats: teamStats,
      weekly_trend: weeklyTrend,
    });
  } catch (err) {
    console.error('Club reports error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create team
app.post('/api/club/teams', authenticate, requireRole('club_admin'), requireClubAccess, requireActiveSubscription, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, age_group, has_under_13, coach_ids } = req.body;
    if (!name) return res.status(400).json({ error: 'Team name is required' });

    await client.query('BEGIN');

    // Generate unique join code
    let joinCode;
    for (let attempts = 0; attempts < 10; attempts++) {
      joinCode = generateJoinCode();
      const existing = await client.query('SELECT id FROM teams WHERE join_code = $1', [joinCode]);
      if (existing.rows.length === 0) break;
    }

    const teamResult = await client.query(
      `INSERT INTO teams (club_id, name, age_group, has_under_13, join_code, status)
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
      [req.clubId, name, age_group || null, has_under_13 === true ? true : (has_under_13 === false ? false : null), joinCode]
    );
    const team = teamResult.rows[0];

    // Assign coaches if provided
    if (coach_ids && Array.isArray(coach_ids)) {
      for (const coachId of coach_ids) {
        // Validate coach belongs to club
        const coachCheck = await client.query(
          `SELECT u.id FROM users u
           JOIN coach_teams ct ON ct.user_id = u.id
           JOIN teams t ON t.id = ct.team_id
           WHERE u.id = $1 AND t.club_id = $2
           UNION
           SELECT id FROM users WHERE id = $1 AND club_id = $2 AND role = 'coach'`,
          [coachId, req.clubId]
        );
        if (coachCheck.rows.length > 0) {
          await client.query(
            'INSERT INTO coach_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [coachId, team.id]
          );
        }
      }
    }

    await client.query('COMMIT');

    await auditLog('staff', req.user.id, 'team_created', 'team', team.id,
      { name, age_group, has_under_13 }, req);

    res.status(201).json({ team });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create team error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Invite coach to club/team
app.post('/api/club/invitations', authenticate, requireRole('club_admin'), requireClubAccess, async (req, res) => {
  try {
    const { email, team_id, first_name, last_name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // If team_id is provided, validate it belongs to the club
    if (team_id) {
      const teamCheck = await pool.query('SELECT id FROM teams WHERE id = $1 AND club_id = $2', [team_id, req.clubId]);
      if (teamCheck.rows.length === 0) return res.status(400).json({ error: 'Team not found in your club' });
    }

    // Check if user already exists
    const existing = await pool.query('SELECT id, role, first_name, last_name FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      // Link to team if team_id provided
      if (team_id) {
        await pool.query(
          'INSERT INTO coach_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [existing.rows[0].id, team_id]
        );
      }
      return res.json({
        coach: existing.rows[0],
        linked: true,
        message: `${existing.rows[0].first_name} ${existing.rows[0].last_name} has been added to the team.`,
      });
    }

    // Create invitation
    const invResult = await pool.query(
      `INSERT INTO invitations (email, role, club_id, team_id, token, invited_by)
       VALUES ($1, 'coach', $2, $3, 'placeholder', $4) RETURNING id`,
      [email.toLowerCase().trim(), req.clubId, team_id || null, req.user.id]
    );
    const invId = invResult.rows[0].id;
    const token = generateInvitationToken(invId, email.toLowerCase().trim(), 'coach');
    await pool.query('UPDATE invitations SET token = $1 WHERE id = $2', [token, invId]);

    // Get club name for email
    const clubResult = await pool.query('SELECT name FROM clubs WHERE id = $1', [req.clubId]);
    const clubName = clubResult.rows[0]?.name || 'your club';
    const inviterName = `${req.user.first_name} ${req.user.last_name}`;
    await sendInvitationEmail(email.toLowerCase().trim(), 'coach', clubName, inviterName, token);

    await auditLog('staff', req.user.id, 'invitation_sent', 'invitation', invId,
      { email, role: 'coach', team_id }, req);

    res.status(201).json({ invitation_sent: true, email });
  } catch (err) {
    console.error('Club invite error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Move player between teams
app.post('/api/club/players/:id/move', authenticate, requireRole('club_admin'), requireClubAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    const { destination_team_id } = req.body;
    if (!destination_team_id) return res.status(400).json({ error: 'Destination team ID is required' });

    await client.query('BEGIN');

    // Load player, verify belongs to club
    const playerResult = await client.query(
      `SELECT p.*, t.club_id, t.name as source_team_name
       FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1`,
      [req.params.id]
    );
    if (playerResult.rows.length === 0 || playerResult.rows[0].club_id !== req.clubId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Player not found in your club' });
    }
    const player = playerResult.rows[0];

    if (player.team_id === destination_team_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Player is already on that team' });
    }

    // Verify destination team belongs to club
    const destTeam = await client.query(
      'SELECT * FROM teams WHERE id = $1 AND club_id = $2',
      [destination_team_id, req.clubId]
    );
    if (destTeam.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Destination team not in your club' });
    }

    // Username dedup check
    const usernameCheck = await client.query(
      'SELECT id FROM players WHERE team_id = $1 AND username = $2',
      [destination_team_id, player.username]
    );
    let newUsername = player.username;
    if (usernameCheck.rows.length > 0) {
      let counter = 2;
      while (true) {
        const check = await client.query(
          'SELECT id FROM players WHERE team_id = $1 AND username = $2',
          [destination_team_id, player.username + counter]
        );
        if (check.rows.length === 0) { newUsername = player.username + counter; break; }
        counter++;
      }
    }

    // Update player's team_id and username
    await client.query(
      'UPDATE players SET team_id = $1, username = $2 WHERE id = $3',
      [destination_team_id, newUsername, req.params.id]
    );

    // Consent re-check
    if (destTeam.rows[0].has_under_13 && player.consent_status !== 'granted') {
      await client.query(
        "UPDATE players SET status = 'pending', consent_status = 'awaiting' WHERE id = $1",
        [req.params.id]
      );
      if (player.parent_email) {
        await sendConsentEmail(
          { id: player.id, first_name: player.first_name, last_name: player.last_name },
          destTeam.rows[0].name,
          player.parent_email
        );
      }
    } else if (!destTeam.rows[0].has_under_13) {
      // Non-under-13 destination: ensure player is active
      await client.query(
        "UPDATE players SET status = 'active', consent_status = 'not_required' WHERE id = $1 AND status = 'pending'",
        [req.params.id]
      );
    }

    await client.query('COMMIT');

    await auditLog('staff', req.user.id, 'player_moved', 'player', req.params.id,
      { from_team_id: player.team_id, from_team_name: player.source_team_name,
        to_team_id: destination_team_id, to_team_name: destTeam.rows[0].name,
        old_username: player.username, new_username: newUsername }, req);

    res.json({ message: 'Player moved successfully', new_username: newUsername });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Move player error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Bulk team import (club admin)
app.post('/api/club/import', authenticate, requireRole('club_admin'), requireClubAccess, requireActiveSubscription, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows, preview } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided' });
    }

    // Validation pass
    const errors = [];
    const teamMap = new Map(); // team_name -> { under_13, rows }
    const coachEmails = new Set();
    const playerEntries = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;
      const { team_name, under_13, type, first_name, last_name, email } = row;

      if (!team_name || !type || !first_name || !last_name) {
        errors.push({ row: rowNum, error: 'Missing required fields (team_name, type, first_name, last_name)' });
        continue;
      }

      const normType = type.toLowerCase().trim();
      if (normType !== 'coach' && normType !== 'player') {
        errors.push({ row: rowNum, error: `Type must be "Coach" or "Player", got "${type}"` });
        continue;
      }

      // Track team settings
      const normUnder13 = under_13 && under_13.toString().toLowerCase().trim();
      const isUnder13 = normUnder13 === 'yes' || normUnder13 === 'true' || normUnder13 === 'y';
      if (!teamMap.has(team_name)) {
        teamMap.set(team_name, { under_13: isUnder13, firstRow: rowNum });
      } else {
        const existing = teamMap.get(team_name);
        if (existing.under_13 !== isUnder13 && normUnder13 && normUnder13 !== '') {
          errors.push({ row: rowNum, warning: `Under-13 value conflicts with row ${existing.firstRow} for team "${team_name}". Using value from first row.` });
        }
      }

      if (normType === 'coach') {
        if (!email) {
          errors.push({ row: rowNum, error: 'Email is required for coach rows' });
          continue;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.push({ row: rowNum, error: `Invalid email: ${email}` });
          continue;
        }
        coachEmails.add(email.toLowerCase().trim());
      }

      if (normType === 'player') {
        const teamInfo = teamMap.get(team_name);
        if (teamInfo.under_13 && !email) {
          errors.push({ row: rowNum, warning: 'Missing parent email for under-13 team player. Player will be created with consent status "awaiting".' });
        }
      }
    }

    // Check for existing teams in club
    const existingTeams = await pool.query(
      'SELECT name FROM teams WHERE club_id = $1', [req.clubId]
    );
    const existingTeamNames = new Set(existingTeams.rows.map(t => t.name.toLowerCase()));
    const newTeams = [...teamMap.keys()].filter(name => !existingTeamNames.has(name.toLowerCase()));

    const summary = {
      teams_to_create: newTeams.length,
      teams_existing: teamMap.size - newTeams.length,
      coaches: coachEmails.size,
      players: rows.filter(r => r.type && r.type.toLowerCase().trim() === 'player').length,
      errors: errors.filter(e => e.error),
      warnings: errors.filter(e => e.warning),
    };

    if (preview) {
      return res.json({ preview: true, summary, errors });
    }

    // Commit pass — only if no hard errors
    if (summary.errors.length > 0) {
      return res.status(400).json({ error: 'Fix validation errors before importing', summary, errors });
    }

    // Player cap enforcement
    const playerCount = rows.filter(r => r.type && r.type.toLowerCase().trim() === 'player').length;
    if (playerCount > 0) {
      const capCheck = await checkPlayerCap('club', req.clubId, playerCount);
      if (!capCheck.allowed) {
        return res.status(403).json({ error: capCheck.error, usage: { current: capCheck.current, cap: capCheck.cap, addon_price: capCheck.addon_price } });
      }
    }

    await client.query('BEGIN');

    // Create or find teams
    const teamIdMap = new Map(); // team_name -> team_id
    for (const [teamName, info] of teamMap.entries()) {
      const existing = await client.query(
        'SELECT id FROM teams WHERE club_id = $1 AND LOWER(name) = LOWER($2)',
        [req.clubId, teamName]
      );
      if (existing.rows.length > 0) {
        teamIdMap.set(teamName, existing.rows[0].id);
      } else {
        let joinCode;
        for (let a = 0; a < 10; a++) {
          joinCode = generateJoinCode();
          const jcCheck = await client.query('SELECT id FROM teams WHERE join_code = $1', [joinCode]);
          if (jcCheck.rows.length === 0) break;
        }
        const teamResult = await client.query(
          `INSERT INTO teams (club_id, name, has_under_13, join_code, status)
           VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
          [req.clubId, teamName, info.under_13 || false, joinCode]
        );
        teamIdMap.set(teamName, teamResult.rows[0].id);
      }
    }

    // Process coaches
    const coachResults = [];
    const processedCoachEmails = new Set();
    for (const row of rows) {
      if (!row.type || row.type.toLowerCase().trim() !== 'coach' || !row.email) continue;
      const email = row.email.toLowerCase().trim();
      if (processedCoachEmails.has(email)) continue;
      processedCoachEmails.add(email);

      const teamId = teamIdMap.get(row.team_name);
      const existing = await client.query('SELECT id, first_name, last_name FROM users WHERE email = $1', [email]);

      if (existing.rows.length > 0) {
        // Link existing user to team
        await client.query(
          'INSERT INTO coach_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [existing.rows[0].id, teamId]
        );
        coachResults.push({ email, status: 'linked', name: `${existing.rows[0].first_name} ${existing.rows[0].last_name}` });
      } else {
        // Create invitation
        const invResult = await client.query(
          `INSERT INTO invitations (email, role, club_id, team_id, token, invited_by)
           VALUES ($1, 'coach', $2, $3, 'placeholder', $4) RETURNING id`,
          [email, req.clubId, teamId, req.user.id]
        );
        const invId = invResult.rows[0].id;
        const token = generateInvitationToken(invId, email, 'coach');
        await client.query('UPDATE invitations SET token = $1 WHERE id = $2', [token, invId]);

        const clubResult = await client.query('SELECT name FROM clubs WHERE id = $1', [req.clubId]);
        const clubName = clubResult.rows[0]?.name || 'your club';
        const inviterName = `${req.user.first_name} ${req.user.last_name}`;
        await sendInvitationEmail(email, 'coach', clubName, inviterName, token);

        coachResults.push({ email, status: 'invited', name: `${row.first_name} ${row.last_name}` });
      }
    }

    // Process players
    const credentials = [];
    // Get existing usernames per team
    const teamUsernames = new Map();
    for (const [teamName, teamId] of teamIdMap.entries()) {
      const existing = await client.query('SELECT username FROM players WHERE team_id = $1', [teamId]);
      teamUsernames.set(teamId, new Set(existing.rows.map(p => p.username)));
    }

    for (const row of rows) {
      if (!row.type || row.type.toLowerCase().trim() !== 'player') continue;

      const teamId = teamIdMap.get(row.team_name);
      const teamInfo = teamMap.get(row.team_name);
      const usernameSet = teamUsernames.get(teamId);

      const username = generateUsername(row.first_name, row.last_name, usernameSet);
      usernameSet.add(username);
      const tempPassword = generatePlayerPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      const requiresConsent = teamInfo.under_13;
      const playerStatus = requiresConsent ? 'pending' : 'active';
      const consentStatus = requiresConsent ? 'awaiting' : 'not_required';
      const parentEmail = row.email ? row.email.trim() : null;

      const playerResult = await client.query(
        `INSERT INTO players (team_id, first_name, last_name, username, password_hash, status, consent_status, parent_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [teamId, row.first_name, row.last_name, username, passwordHash, playerStatus, consentStatus, parentEmail]
      );

      credentials.push({
        team_name: row.team_name,
        first_name: row.first_name,
        last_name: row.last_name,
        username,
        password: tempPassword,
      });

      // Send consent email if under-13 and parent email
      if (requiresConsent && parentEmail) {
        await sendConsentEmail(
          { id: playerResult.rows[0].id, first_name: row.first_name, last_name: row.last_name },
          row.team_name,
          parentEmail
        );
      }
    }

    await client.query('COMMIT');

    await auditLog('staff', req.user.id, 'bulk_import', 'club', req.clubId,
      { teams_created: newTeams.length, coaches: coachResults.length, players: credentials.length }, req);

    res.json({
      summary: {
        teams_created: newTeams.length,
        coaches_processed: coachResults.length,
        players_created: credentials.length,
      },
      coach_results: coachResults,
      credentials,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Bulk import error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Bulk roster import (coach, team-scoped)
app.post('/api/admin/players/import', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, requireActiveSubscription, async (req, res) => {
  const client = await pool.connect();
  try {
    const { players, preview } = req.body;
    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'No players provided' });
    }

    // Get team info
    const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [req.teamId]);
    const team = teamResult.rows[0];
    const requiresConsent = team.has_under_13 === true;

    // Get existing usernames
    const existingResult = await pool.query('SELECT username FROM players WHERE team_id = $1', [req.teamId]);
    const usernameSet = new Set(existingResult.rows.map(p => p.username));

    // Validation
    const errors = [];
    const validPlayers = [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const rowNum = i + 1;
      if (!p.first_name || !p.last_name) {
        errors.push({ row: rowNum, error: 'First name and last name are required' });
        continue;
      }
      if (requiresConsent && !p.email) {
        errors.push({ row: rowNum, warning: 'Missing parent email for under-13 team. Player will need a parent email added later.' });
      }
      if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
        errors.push({ row: rowNum, error: `Invalid email: ${p.email}` });
        continue;
      }
      const username = generateUsername(p.first_name, p.last_name, usernameSet);
      usernameSet.add(username);
      validPlayers.push({ ...p, username });
    }

    const summary = {
      players_to_create: validPlayers.length,
      errors: errors.filter(e => e.error),
      warnings: errors.filter(e => e.warning),
    };

    if (preview) {
      return res.json({ preview: true, summary, errors, players: validPlayers.map(p => ({ first_name: p.first_name, last_name: p.last_name, username: p.username })) });
    }

    if (summary.errors.length > 0) {
      return res.status(400).json({ error: 'Fix validation errors before importing', summary, errors });
    }

    // Player cap enforcement
    const ownerType = team.club_id ? 'club' : 'team';
    const ownerId = team.club_id || req.teamId;
    const capCheck = await checkPlayerCap(ownerType, ownerId, validPlayers.length);
    if (!capCheck.allowed) {
      return res.status(403).json({ error: capCheck.error, usage: { current: capCheck.current, cap: capCheck.cap, addon_price: capCheck.addon_price } });
    }

    await client.query('BEGIN');

    const credentials = [];
    for (const p of validPlayers) {
      const tempPassword = generatePlayerPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const playerStatus = requiresConsent ? 'pending' : 'active';
      const consentStatus = requiresConsent ? 'awaiting' : 'not_required';
      const parentEmail = p.email ? p.email.trim() : null;

      const result = await client.query(
        `INSERT INTO players (team_id, first_name, last_name, username, password_hash, status, consent_status, parent_email, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING id`,
        [req.teamId, p.first_name, p.last_name, p.username, passwordHash, playerStatus, consentStatus, parentEmail]
      );

      credentials.push({
        team_name: team.name,
        first_name: p.first_name,
        last_name: p.last_name,
        username: p.username,
        password: tempPassword,
      });

      if (requiresConsent && parentEmail) {
        await sendConsentEmail(
          { id: result.rows[0].id, first_name: p.first_name, last_name: p.last_name },
          team.name,
          parentEmail
        );
      }

      // Send welcome email with credentials if parent email present
      if (parentEmail) {
        try {
          const coachName = `${req.user.first_name} ${req.user.last_name}`;
          await sendWelcomeEmail(
            { first_name: p.first_name },
            team.name,
            team.join_code,
            parentEmail,
            coachName,
            p.username,
            tempPassword
          );
        } catch (emailErr) {
          console.error('Welcome email error:', emailErr.message);
        }
      }
    }

    await client.query('COMMIT');

    await auditLog('staff', req.user.id, 'bulk_roster_import', 'team', req.teamId,
      { players_created: credentials.length }, req);

    res.json({
      summary: { players_created: credentials.length },
      credentials,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Bulk roster import error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ============================================================
// ENHANCED SEASON ENDPOINTS
// ============================================================

// Archive/end a season
app.post('/api/admin/seasons/:id/archive', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE seasons SET status = 'archived' WHERE id = $1 AND team_id = $2 RETURNING *",
      [req.params.id, req.teamId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Season not found' });

    // Clear active_season_id if this was the active one
    await pool.query(
      'UPDATE teams SET active_season_id = NULL WHERE id = $1 AND active_season_id = $2',
      [req.teamId, req.params.id]
    );

    await auditLog('staff', req.user.id, 'season_archived', 'season', req.params.id,
      { season_name: result.rows[0].name }, req);

    res.json({ ...result.rows[0], active: false });
  } catch (err) {
    console.error('Archive season error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Past season leaderboard
app.get('/api/admin/seasons/:id/leaderboard', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const season = await pool.query(
      'SELECT * FROM seasons WHERE id = $1 AND team_id = $2',
      [req.params.id, req.teamId]
    );
    if (season.rows.length === 0) return res.status(404).json({ error: 'Season not found' });

    const leaderboard = await pool.query(
      `SELECT p.id, p.first_name, p.last_name, p.avatar_color,
              pss.season_points, pss.current_streak, pss.longest_streak
       FROM player_season_stats pss
       JOIN players p ON p.id = pss.player_id
       WHERE pss.season_id = $1
       ORDER BY pss.season_points DESC`,
      [req.params.id]
    );

    res.json({
      season: season.rows[0],
      leaderboard: leaderboard.rows.map(p => ({
        ...p,
        level: getLevelInfo(p.season_points),
      })),
    });
  } catch (err) {
    console.error('Season leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Past seasons (player-accessible)
app.get('/api/seasons/past', authenticate, async (req, res) => {
  try {
    const teamId = req.role === 'player' ? req.user.team_id : req.headers['x-team-id'];
    if (!teamId) return res.status(400).json({ error: 'Team context required' });

    const seasons = await pool.query(
      "SELECT * FROM seasons WHERE team_id = $1 AND status = 'archived' ORDER BY start_date DESC",
      [teamId]
    );

    // If player, include their stats for each season
    if (req.role === 'player') {
      const result = [];
      for (const season of seasons.rows) {
        const stats = await pool.query(
          'SELECT season_points, current_streak, longest_streak FROM player_season_stats WHERE player_id = $1 AND season_id = $2',
          [req.user.id, season.id]
        );
        result.push({
          ...season,
          my_stats: stats.rows[0] || null,
        });
      }
      return res.json({ seasons: result });
    }

    res.json({ seasons: seasons.rows });
  } catch (err) {
    console.error('Past seasons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// BILLING ROUTES
// ============================================================

// Get current subscription info
app.get('/api/billing/subscription', authenticate, requireRole('club_admin', 'coach', 'super_admin'), async (req, res) => {
  try {
    let ownerType, ownerId;
    if (req.user.club_id) {
      ownerType = 'club'; ownerId = req.user.club_id;
    } else {
      const teamId = req.headers['x-team-id'];
      if (!teamId) return res.status(400).json({ error: 'No billing context' });
      ownerType = 'team'; ownerId = teamId;
    }

    const sub = await getSubscription(ownerType, ownerId);
    const playerCount = await getActivePlayerCount(ownerType, ownerId);
    const effectiveCap = sub ? sub.player_cap + sub.addon_quantity : null;

    res.json({
      subscription: sub ? {
        id: sub.id,
        plan: sub.plan,
        status: sub.status,
        billing_interval: sub.billing_interval,
        player_cap: effectiveCap,
        base_cap: sub.player_cap,
        addon_quantity: sub.addon_quantity,
        card_brand: sub.card_brand,
        card_last4: sub.card_last4,
        card_exp_month: sub.card_exp_month,
        card_exp_year: sub.card_exp_year,
        current_period_end: sub.current_period_end,
        trial_end: sub.trial_end,
        canceled_at: sub.canceled_at,
      } : null,
      usage: { players: playerCount, cap: effectiveCap },
    });
  } catch (err) {
    console.error('Get subscription error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get available plans
app.get('/api/billing/plans', authenticate, async (req, res) => {
  try {
    const config = await pool.query('SELECT key, value FROM billing_config');
    const priceMap = {};
    for (const row of config.rows) {
      priceMap[row.key] = row.value;
    }
    res.json({
      plans: [
        { id: 'team', name: 'Team', player_cap: 20, monthly_price: '$9.99', annual_price: '$79.99', monthly_price_id: priceMap.team_monthly || null, annual_price_id: priceMap.team_annual || null },
        { id: 'small_club', name: 'Small Club', player_cap: 200, monthly_price: '$74.99', annual_price: '$649.99', monthly_price_id: priceMap.small_club_monthly || null, annual_price_id: priceMap.small_club_annual || null },
        { id: 'large_club', name: 'Large Club', player_cap: 500, monthly_price: '$179.99', annual_price: '$1,499.99', monthly_price_id: priceMap.large_club_monthly || null, annual_price_id: priceMap.large_club_annual || null },
        { id: 'mega_club', name: 'Mega Club', player_cap: 1000, monthly_price: '$349.99', annual_price: '$2,899.99', monthly_price_id: priceMap.mega_club_monthly || null, annual_price_id: priceMap.mega_club_annual || null },
      ],
      addon: { per_player_monthly: '$0.59', per_player_annual: '$4.99', monthly_price_id: priceMap.addon_player_monthly || null, annual_price_id: priceMap.addon_player_annual || null },
    });
  } catch (err) {
    console.error('Get plans error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create Stripe Checkout session
app.post('/api/billing/checkout', authenticate, requireRole('club_admin', 'coach'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  try {
    const { plan, interval } = req.body;
    if (!plan || !interval) return res.status(400).json({ error: 'Plan and interval are required' });
    if (!PLAN_CAPS[plan]) return res.status(400).json({ error: 'Invalid plan' });
    if (!['monthly', 'annual'].includes(interval)) return res.status(400).json({ error: 'Invalid interval' });

    let ownerType, ownerId, ownerName;
    if (req.user.club_id) {
      ownerType = 'club'; ownerId = req.user.club_id;
      const club = await pool.query('SELECT name FROM clubs WHERE id = $1', [ownerId]);
      ownerName = club.rows[0]?.name || 'Club';
    } else {
      const teamId = req.headers['x-team-id'];
      if (!teamId) return res.status(400).json({ error: 'No billing context' });
      ownerType = 'team'; ownerId = teamId;
      const team = await pool.query('SELECT name FROM teams WHERE id = $1', [ownerId]);
      ownerName = team.rows[0]?.name || 'Team';
    }

    // Get price ID from billing_config
    const priceKey = `${plan}_${interval}`;
    const configRow = await pool.query('SELECT value FROM billing_config WHERE key = $1', [priceKey]);
    if (!configRow.rows[0]) return res.status(400).json({ error: 'Plan not configured. Run the Stripe setup script.' });
    const priceId = configRow.rows[0].value;

    const playerCap = PLAN_CAPS[plan];

    // Create or update subscription record (incomplete until webhook confirms)
    let sub = await getSubscription(ownerType, ownerId);
    if (!sub || sub.status === 'canceled') {
      const result = await pool.query(
        `INSERT INTO subscriptions (owner_type, owner_id, plan, billing_interval, status, player_cap)
         VALUES ($1, $2, $3, $4, 'trialing', $5) RETURNING *`,
        [ownerType, ownerId, plan, interval, playerCap]
      );
      sub = result.rows[0];
    }

    // Create Stripe Checkout session
    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { owner_type: ownerType, owner_id: ownerId, subscription_id: sub.id },
      subscription_data: {
        metadata: { owner_type: ownerType, owner_id: ownerId },
        trial_period_days: 14,
      },
      success_url: `${APP_URL}/club?billing=success`,
      cancel_url: `${APP_URL}/club?billing=cancel`,
    };

    // If we already have a stripe customer, reuse it
    if (sub.stripe_customer_id) {
      sessionParams.customer = sub.stripe_customer_id;
    } else {
      sessionParams.customer_email = req.user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    await auditLog('staff', req.user.id, 'billing_checkout_started', 'subscription', ownerId,
      { owner_type: ownerType, plan, interval }, req);

    res.json({ checkout_url: session.url });
  } catch (err) {
    console.error('Create checkout error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create Stripe Customer Portal session
app.post('/api/billing/portal', authenticate, requireRole('club_admin', 'coach'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  try {
    let ownerType, ownerId;
    if (req.user.club_id) {
      ownerType = 'club'; ownerId = req.user.club_id;
    } else {
      const teamId = req.headers['x-team-id'];
      if (!teamId) return res.status(400).json({ error: 'No billing context' });
      ownerType = 'team'; ownerId = teamId;
    }

    const sub = await getSubscription(ownerType, ownerId);
    if (!sub || !sub.stripe_customer_id) {
      return res.status(400).json({ error: 'No active subscription. Please subscribe first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${APP_URL}/club?tab=billing`,
    });

    res.json({ portal_url: session.url });
  } catch (err) {
    console.error('Create portal session error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add add-on players
app.post('/api/billing/add-players', authenticate, requireRole('club_admin', 'coach'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  try {
    const { quantity } = req.body;
    if (!quantity || quantity < 1) return res.status(400).json({ error: 'Quantity must be at least 1' });

    let ownerType, ownerId;
    if (req.user.club_id) {
      ownerType = 'club'; ownerId = req.user.club_id;
    } else {
      const teamId = req.headers['x-team-id'];
      if (!teamId) return res.status(400).json({ error: 'No billing context' });
      ownerType = 'team'; ownerId = teamId;
    }

    const sub = await getSubscription(ownerType, ownerId);
    if (!sub || !sub.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found.' });
    }

    // Get the addon price ID for this subscription's interval
    const addonKey = `addon_player_${sub.billing_interval}`;
    const addonRow = await pool.query('SELECT value FROM billing_config WHERE key = $1', [addonKey]);
    if (!addonRow.rows[0]) return res.status(400).json({ error: 'Add-on pricing not configured.' });
    const addonPriceId = addonRow.rows[0].value;

    // Get existing subscription items from Stripe
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
      expand: ['items'],
    });

    // Find existing addon item or create one
    const existingAddon = stripeSub.items.data.find(item => item.price.id === addonPriceId);
    const newTotal = (sub.addon_quantity || 0) + quantity;

    if (existingAddon) {
      // Update quantity on existing item
      await stripe.subscriptionItems.update(existingAddon.id, {
        quantity: newTotal,
        proration_behavior: 'create_prorations',
      });
    } else {
      // Add new subscription item
      await stripe.subscriptionItems.create({
        subscription: sub.stripe_subscription_id,
        price: addonPriceId,
        quantity: newTotal,
        proration_behavior: 'create_prorations',
      });
    }

    // Update local record
    await pool.query(
      'UPDATE subscriptions SET addon_quantity = $1, updated_at = NOW() WHERE id = $2',
      [newTotal, sub.id]
    );

    await auditLog('staff', req.user.id, 'addon_players_added', 'subscription', ownerId,
      { owner_type: ownerType, quantity, new_total: newTotal }, req);

    res.json({
      addon_quantity: newTotal,
      effective_cap: sub.player_cap + newTotal,
      message: `Added ${quantity} player${quantity !== 1 ? 's' : ''} to your plan.`,
    });
  } catch (err) {
    console.error('Add players error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// STRIPE WEBHOOK
// ============================================================

// Map Stripe subscription status to our internal status
function mapStripeStatus(stripeStatus) {
  const map = {
    'trialing': 'trialing',
    'active': 'active',
    'past_due': 'past_due',
    'canceled': 'canceled',
    'unpaid': 'suspended',
    'incomplete': 'trialing',
    'incomplete_expired': 'canceled',
    'paused': 'suspended',
  };
  return map[stripeStatus] || 'active';
}

// Core sync: update local subscription from Stripe's subscription object
async function syncSubscriptionFromStripe(stripeSubscription) {
  const customerId = typeof stripeSubscription.customer === 'string'
    ? stripeSubscription.customer
    : stripeSubscription.customer?.id;

  // Find local subscription by stripe_subscription_id or stripe_customer_id
  let localSub = await pool.query(
    "SELECT * FROM subscriptions WHERE stripe_subscription_id = $1",
    [stripeSubscription.id]
  );
  if (localSub.rows.length === 0) {
    localSub = await pool.query(
      "SELECT * FROM subscriptions WHERE stripe_customer_id = $1",
      [customerId]
    );
  }
  // Try matching via metadata
  if (localSub.rows.length === 0 && stripeSubscription.metadata) {
    const { owner_type, owner_id } = stripeSubscription.metadata;
    if (owner_type && owner_id) {
      localSub = await pool.query(
        "SELECT * FROM subscriptions WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at DESC LIMIT 1",
        [owner_type, owner_id]
      );
    }
  }
  if (localSub.rows.length === 0) {
    console.warn('syncSubscriptionFromStripe: No matching local subscription found for', stripeSubscription.id);
    return;
  }

  const sub = localSub.rows[0];
  const status = mapStripeStatus(stripeSubscription.status);

  // Extract card info from default payment method
  let cardBrand = sub.card_brand, cardLast4 = sub.card_last4,
      cardExpMonth = sub.card_exp_month, cardExpYear = sub.card_exp_year;

  if (stripeSubscription.default_payment_method && typeof stripeSubscription.default_payment_method === 'object') {
    const pm = stripeSubscription.default_payment_method;
    if (pm.card) {
      cardBrand = pm.card.brand;
      cardLast4 = pm.card.last4;
      cardExpMonth = pm.card.exp_month;
      cardExpYear = pm.card.exp_year;
    }
  }

  // Determine plan/cap from subscription items
  const items = stripeSubscription.items?.data || [];
  let plan = sub.plan, playerCap = sub.player_cap, addonQty = sub.addon_quantity;
  const billingInterval = stripeSubscription.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly';

  // Load billing config to match price IDs to plans
  const config = await pool.query('SELECT key, value FROM billing_config');
  const priceToInfo = {};
  for (const row of config.rows) {
    if (row.key.startsWith('addon_player_')) {
      priceToInfo[row.value] = { type: 'addon' };
    } else {
      const parts = row.key.split('_');
      const interval = parts.pop(); // monthly or annual
      const planName = parts.join('_'); // team, small_club, large_club, mega_club
      if (PLAN_CAPS[planName]) {
        priceToInfo[row.value] = { type: 'plan', plan: planName, cap: PLAN_CAPS[planName] };
      }
    }
  }

  for (const item of items) {
    const priceId = item.price?.id;
    const info = priceToInfo[priceId];
    if (info) {
      if (info.type === 'plan') {
        plan = info.plan;
        playerCap = info.cap;
      } else if (info.type === 'addon') {
        addonQty = item.quantity || 0;
      }
    }
  }

  await pool.query(
    `UPDATE subscriptions SET
      stripe_customer_id = $1, stripe_subscription_id = $2, status = $3, plan = $4,
      billing_interval = $5, player_cap = $6, addon_quantity = $7,
      card_brand = $8, card_last4 = $9, card_exp_month = $10, card_exp_year = $11,
      current_period_end = $12, trial_end = $13, updated_at = NOW()
     WHERE id = $14`,
    [
      customerId, stripeSubscription.id, status, plan,
      billingInterval, playerCap, addonQty,
      cardBrand, cardLast4, cardExpMonth, cardExpYear,
      stripeSubscription.current_period_end ? new Date(stripeSubscription.current_period_end * 1000) : null,
      stripeSubscription.trial_end ? new Date(stripeSubscription.trial_end * 1000) : null,
      sub.id
    ]
  );

  // Sync club stub fields for backward compat
  if (sub.owner_type === 'club') {
    await pool.query(
      "UPDATE clubs SET subscription_status = $1, plan = $2, stripe_customer_id = $3, player_limit = $4 WHERE id = $5",
      [status, plan, customerId, playerCap + addonQty, sub.owner_id]
    );
  }
}

// Webhook handler functions
async function handleCheckoutCompleted(session) {
  const { owner_type, owner_id } = session.metadata || {};
  if (!owner_type || !owner_id) return;

  const subscriptionId = session.subscription;
  const customerId = session.customer;

  // Update subscription record with Stripe IDs (most recent unlinked record)
  await pool.query(
    `UPDATE subscriptions SET stripe_customer_id = $1, stripe_subscription_id = $2, updated_at = NOW()
     WHERE id = (
       SELECT id FROM subscriptions
       WHERE owner_type = $3 AND owner_id = $4 AND stripe_subscription_id IS NULL
       ORDER BY created_at DESC LIMIT 1
     )`,
    [customerId, subscriptionId, owner_type, owner_id]
  );

  // Update club record
  if (owner_type === 'club') {
    await pool.query('UPDATE clubs SET stripe_customer_id = $1 WHERE id = $2', [customerId, owner_id]);
  }

  await auditLog('system', null, 'checkout_completed', 'subscription', owner_id,
    { owner_type, stripe_customer_id: customerId, stripe_subscription_id: subscriptionId });

  // Retrieve and sync the full subscription
  if (subscriptionId) {
    try {
      const stripeSub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['default_payment_method'],
      });
      await syncSubscriptionFromStripe(stripeSub);
    } catch (err) {
      console.error('Failed to sync subscription after checkout:', err.message);
    }
  }
}

async function handleSubscriptionCreated(subscription) {
  await syncSubscriptionFromStripe(subscription);
  const { owner_type, owner_id } = subscription.metadata || {};
  if (owner_type && owner_id) {
    await auditLog('system', null, 'subscription_created', 'subscription', owner_id,
      { owner_type, stripe_subscription_id: subscription.id, plan: subscription.items?.data?.[0]?.price?.lookup_key });
  }
}

async function handleSubscriptionUpdated(subscription) {
  await syncSubscriptionFromStripe(subscription);
}

async function handleSubscriptionDeleted(subscription) {
  const result = await pool.query(
    "UPDATE subscriptions SET status = 'canceled', canceled_at = NOW(), updated_at = NOW() WHERE stripe_subscription_id = $1 RETURNING *",
    [subscription.id]
  );

  if (result.rows[0]) {
    const sub = result.rows[0];
    // Update club/team status for read-only lock
    if (sub.owner_type === 'club') {
      await pool.query("UPDATE clubs SET subscription_status = 'canceled', status = 'suspended' WHERE id = $1", [sub.owner_id]);
    } else {
      await pool.query("UPDATE teams SET status = 'suspended' WHERE id = $1", [sub.owner_id]);
    }

    await auditLog('system', null, 'subscription_canceled', 'subscription', sub.owner_id,
      { owner_type: sub.owner_type, stripe_subscription_id: subscription.id });
  }
}

async function handlePaymentFailed(invoice) {
  const subId = invoice.subscription;
  if (!subId) return;

  await pool.query(
    "UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1",
    [subId]
  );

  const sub = await pool.query("SELECT * FROM subscriptions WHERE stripe_subscription_id = $1", [subId]);
  if (sub.rows[0]) {
    if (sub.rows[0].owner_type === 'club') {
      await pool.query("UPDATE clubs SET subscription_status = 'past_due' WHERE id = $1", [sub.rows[0].owner_id]);
    }
    await sendPaymentFailedEmail(sub.rows[0]);
    await auditLog('system', null, 'payment_failed', 'subscription', sub.rows[0].owner_id,
      { owner_type: sub.rows[0].owner_type, invoice_id: invoice.id });
  }
}

async function handlePaymentSucceeded(invoice) {
  const subId = invoice.subscription;
  if (!subId) return;

  const result = await pool.query(
    "UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE stripe_subscription_id = $1 RETURNING *",
    [subId]
  );

  if (result.rows[0]) {
    const sub = result.rows[0];
    // Unlock: reactivate club/team
    if (sub.owner_type === 'club') {
      await pool.query("UPDATE clubs SET subscription_status = 'active', status = 'active' WHERE id = $1", [sub.owner_id]);
    } else {
      await pool.query("UPDATE teams SET status = 'active' WHERE id = $1", [sub.owner_id]);
    }
    await auditLog('system', null, 'payment_succeeded', 'subscription', sub.owner_id,
      { owner_type: sub.owner_type, invoice_id: invoice.id });
  }
}

async function handleTrialWillEnd(subscription) {
  const sub = await pool.query(
    "SELECT * FROM subscriptions WHERE stripe_subscription_id = $1", [subscription.id]
  );
  if (sub.rows[0]) {
    await sendTrialEndingEmail(sub.rows[0]);
    await auditLog('system', null, 'trial_ending_reminder', 'subscription', sub.rows[0].owner_id,
      { owner_type: sub.rows[0].owner_type });
  }
}

app.post('/api/billing/webhook', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object);
        break;
      default:
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
    res.json({ received: true });
  } catch (err) {
    console.error(`Webhook handler error for ${event.type}:`, err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// ============================================================
// SPA CATCH-ALL
// ============================================================

const indexHtml = fs.readFileSync(path.join(__dirname, '../client/build', 'index.html'), 'utf8');

app.get('*', (req, res) => {
  // For player routes, serve index.html with team-scoped manifest
  const match = req.path.match(/^\/t\/([A-Za-z0-9]+)/);
  if (match) {
    const joinCode = match[1].toUpperCase();
    const modified = indexHtml.replace('/manifest.json', `/t/${joinCode}/manifest.json`);
    return res.type('html').send(modified);
  }
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});

// ============================================================
// DATABASE INITIALIZATION & MIGRATION
// ============================================================

function generateJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No O, 0, I, 1 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const NEW_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS clubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'trial')),
  subscription_status VARCHAR(50),
  plan VARCHAR(50),
  stripe_customer_id VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID REFERENCES clubs(id),
  name VARCHAR(200) NOT NULL,
  age_group TEXT,
  has_under_13 BOOLEAN DEFAULT NULL,
  join_code VARCHAR(20) UNIQUE NOT NULL,
  primary_color VARCHAR(20) DEFAULT '#1348e5',
  logo_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  active_season_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_teams_join_code ON teams(join_code);
CREATE INDEX IF NOT EXISTS idx_teams_club_id ON teams(club_id);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('super_admin', 'club_admin', 'coach')),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  club_id UUID REFERENCES clubs(id),
  mfa_secret TEXT,
  mfa_enabled BOOLEAN DEFAULT false,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS coach_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  team_id UUID REFERENCES teams(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, team_id)
);

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) NOT NULL,
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  player_email VARCHAR(255),
  parent_email VARCHAR(255),
  lifetime_points INTEGER DEFAULT 0,
  avatar_color VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'inactive')),
  consent_status VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_id, username)
);
CREATE INDEX IF NOT EXISTS idx_players_team_id ON players(team_id);

CREATE TABLE IF NOT EXISTS seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) NOT NULL,
  name VARCHAR(200) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'archived' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seasons_team_id ON seasons(team_id);

CREATE TABLE IF NOT EXISTS player_season_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) NOT NULL,
  season_id UUID REFERENCES seasons(id) NOT NULL,
  season_points INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  current_level_id UUID,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(player_id, season_id)
);
CREATE INDEX IF NOT EXISTS idx_pss_player_id ON player_season_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_pss_season_id ON player_season_stats(season_id);

CREATE TABLE IF NOT EXISTS drills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) NOT NULL,
  season_id UUID REFERENCES seasons(id),
  date DATE NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  youtube_url VARCHAR(500),
  target_time INTEGER,
  completion_points INTEGER DEFAULT 10,
  extra_points INTEGER DEFAULT 5,
  is_challenge_day BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_id, date)
);
CREATE INDEX IF NOT EXISTS idx_drills_team_id ON drills(team_id);
CREATE INDEX IF NOT EXISTS idx_drills_season_id ON drills(season_id);

CREATE TABLE IF NOT EXISTS completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) NOT NULL,
  drill_id UUID REFERENCES drills(id) NOT NULL,
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  did_extra BOOLEAN DEFAULT false,
  points_earned INTEGER DEFAULT 0,
  UNIQUE(player_id, drill_id)
);
CREATE INDEX IF NOT EXISTS idx_completions_player_id ON completions(player_id);
CREATE INDEX IF NOT EXISTS idx_completions_drill_id ON completions(drill_id);

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_id UUID REFERENCES drills(id) ON DELETE CASCADE NOT NULL,
  question_text TEXT NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('text', 'radio', 'checkbox')),
  points INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_questions_drill_id ON questions(drill_id);

CREATE TABLE IF NOT EXISTS question_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID REFERENCES questions(id) ON DELETE CASCADE NOT NULL,
  option_text VARCHAR(500) NOT NULL,
  is_correct BOOLEAN DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS question_text_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID REFERENCES questions(id) ON DELETE CASCADE NOT NULL,
  acceptable_answer TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE NOT NULL,
  question_id UUID REFERENCES questions(id) ON DELETE CASCADE NOT NULL,
  response_text TEXT,
  is_correct BOOLEAN DEFAULT false,
  points_earned INTEGER NOT NULL DEFAULT 0,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  answered_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(player_id, question_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  threshold INTEGER NOT NULL,
  shield_color VARCHAR(20) NOT NULL,
  text_color VARCHAR(20) NOT NULL,
  sort_order INTEGER NOT NULL,
  is_prestige BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon_emoji VARCHAR(10)
);

CREATE TABLE IF NOT EXISTS player_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) NOT NULL,
  badge_id UUID REFERENCES badges(id) NOT NULL,
  earned_at TIMESTAMPTZ DEFAULT NOW(),
  season_id UUID REFERENCES seasons(id),
  UNIQUE(player_id, badge_id)
);
CREATE INDEX IF NOT EXISTS idx_player_badges_player_id ON player_badges(player_id);

CREATE TABLE IF NOT EXISTS consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) NOT NULL,
  team_id UUID REFERENCES teams(id) NOT NULL,
  club_id UUID REFERENCES clubs(id),
  parent_name VARCHAR(200),
  parent_email VARCHAR(255) NOT NULL,
  consent_source VARCHAR(30) NOT NULL CHECK (consent_source IN ('parent_email', 'uploaded_document')),
  consent_language TEXT,
  privacy_policy_version VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
  ip_address VARCHAR(45),
  user_agent TEXT,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_consent_records_player_id ON consent_records(player_id);
CREATE INDEX IF NOT EXISTS idx_consent_records_parent_email ON consent_records(parent_email);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('staff', 'player', 'parent', 'system')),
  actor_id UUID,
  action TEXT NOT NULL,
  target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('player', 'team', 'club', 'user')),
  target_id UUID,
  metadata JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  privacy_policy_version VARCHAR(20) NOT NULL DEFAULT '1.0',
  privacy_policy_content TEXT NOT NULL DEFAULT '',
  consent_language TEXT NOT NULL DEFAULT '',
  retention_days INTEGER NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  html_body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pending_emails_status ON pending_emails(status);

CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('coach', 'club_admin')),
  club_id UUID REFERENCES clubs(id),
  team_id UUID REFERENCES teams(id),
  token TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired')),
  invited_by UUID REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
`;

const BADGE_SEEDS = [
  ['first-touch',      'First Touch',      'Complete your first drill',     '⚽'],
  ['hat-trick',        'Hat Trick',         'Complete 3 drills',            '🎩'],
  ['week-warrior',     'Week Warrior',      '7-day streak',                '🔥'],
  ['double-digits',    'Double Digits',     '10 completions total',        '🔟'],
  ['above-and-beyond', 'Above and Beyond',  'Do extra time 5 times',       '⭐'],
  ['century',          'Century',           'Earn 100 points',             '💯'],
  ['perfect-week',     'Perfect Week',      'Complete every drill in a week', '📅'],
  ['perfect-month',    'Perfect Month',     'Complete every drill in a month', '🗓️'],
  ['challenge-accepted','Challenge Accepted','Complete 5 challenge drills', '💪'],
  ['challenge-master', 'Challenge Master',  'Complete 20 challenge drills', '🏆'],
  ['weekly-winner',    'Weekly Winner',     'Most points in a completed week', '👑'],
  ['extra-effort-20',  'Extra Effort x20',  'Log extra time 20 times',     '🌟'],
  ['200-club',         '200 Club',          'Earn 200 points',             '🥉'],
  ['500-club',         '500 Club',          'Earn 500 points',             '🥈'],
  ['1000-club',        '1000 Club',         'Earn 1000 points',            '🥇'],
  ['2000-club',        '2000 Club',         'Earn 2000 points',            '💎'],
  ['3000-club',        '3000 Club',         'Earn 3000 points',            '💍'],
  ['5000-club',        '5000 Club',         'Earn 5000 points',            '🏅'],
  ['10000-club',       '10000 Club',        'Earn 10000 points',           '🌠'],
];

async function seedBadges() {
  for (const [slug, name, description, emoji] of BADGE_SEEDS) {
    await pool.query(
      'INSERT INTO badges (slug, name, description, icon_emoji) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING',
      [slug, name, description, emoji]
    );
  }
  console.log('Seeded badges.');
}

async function seedLevels() {
  for (let i = 0; i < LEVELS.length; i++) {
    const l = LEVELS[i];
    await pool.query(
      `INSERT INTO levels (name, threshold, shield_color, text_color, sort_order, is_prestige)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [l.name, l.threshold, l.color, l.textColor, i, l.isPrestige || false]
    );
  }
  console.log('Seeded levels.');
}

async function runBuild2Migrations() {
  // Add deactivated_at column to players if not exists
  const deactivatedCol = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'players' AND column_name = 'deactivated_at'"
  );
  if (deactivatedCol.rows.length === 0) {
    await pool.query('ALTER TABLE players ADD COLUMN deactivated_at TIMESTAMPTZ');
    console.log('Added deactivated_at column to players.');
  }

  // Add deletion_requested_at column to players if not exists
  const deletionCol = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'players' AND column_name = 'deletion_requested_at'"
  );
  if (deletionCol.rows.length === 0) {
    await pool.query('ALTER TABLE players ADD COLUMN deletion_requested_at TIMESTAMPTZ');
    console.log('Added deletion_requested_at column to players.');
  }

  // Create Build 2 tables that may not exist on databases created before Build 2
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      privacy_policy_version VARCHAR(20) DEFAULT '1.0',
      privacy_policy_content TEXT,
      consent_language TEXT DEFAULT 'I consent to my child participating in Daily Reps.',
      retention_days INTEGER DEFAULT 30
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_emails (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      to_email VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      html_body TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pending_emails_status ON pending_emails(status)');

  // Create consent and audit tables if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consent_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id UUID REFERENCES players(id) ON DELETE CASCADE,
      parent_email VARCHAR(255),
      parent_name VARCHAR(255),
      consent_given BOOLEAN DEFAULT FALSE,
      consent_method VARCHAR(50),
      privacy_policy_version VARCHAR(20),
      ip_address VARCHAR(45),
      user_agent TEXT,
      token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      responded_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action VARCHAR(100) NOT NULL,
      actor_id UUID,
      actor_role VARCHAR(20),
      target_type VARCHAR(50),
      target_id UUID,
      team_id UUID REFERENCES teams(id),
      club_id UUID REFERENCES clubs(id),
      details JSONB,
      ip_address VARCHAR(45),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('Build 2 migrations complete.');
}

async function runBuild3Migrations() {
  // Create invitations table if not exists (also in NEW_SCHEMA_SQL for fresh installs)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('coach', 'club_admin')),
      club_id UUID REFERENCES clubs(id),
      team_id UUID REFERENCES teams(id),
      token TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired')),
      invited_by UUID REFERENCES users(id) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      accepted_at TIMESTAMPTZ
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email)');

  // Add player_limit column to clubs if not exists
  const limitCol = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'clubs' AND column_name = 'player_limit'"
  );
  if (limitCol.rows.length === 0) {
    await pool.query('ALTER TABLE clubs ADD COLUMN player_limit INTEGER');
    console.log('Added player_limit column to clubs.');
  }

  // Relax audit_log target_type constraint to include invitation and season
  try {
    await pool.query("ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_target_type_check");
    await pool.query("ALTER TABLE audit_log ADD CONSTRAINT audit_log_target_type_check CHECK (target_type IN ('player', 'team', 'club', 'user', 'invitation', 'season'))");
  } catch (err) {
    // Constraint may already be updated
  }

  console.log('Build 3 migrations complete.');
}

async function runBuild4Migrations() {
  // Build 4: Replace level ladder with 24 tiers and recompute player levels

  // Clear old levels and re-seed with the new 24-tier ladder
  await pool.query('DELETE FROM levels');
  for (let i = 0; i < LEVELS.length; i++) {
    const l = LEVELS[i];
    await pool.query(
      `INSERT INTO levels (name, threshold, shield_color, text_color, sort_order, is_prestige)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [l.name, l.threshold, l.color, l.textColor, i, l.isPrestige || false]
    );
  }
  console.log('Replaced levels with 24-tier ladder.');

  // Recompute every player's current_level_id based on season points
  // Find all players with an active season
  const activeSeasons = await pool.query(
    "SELECT id, team_id, start_date, end_date FROM seasons WHERE status = 'active'"
  );

  let recomputed = 0;
  for (const season of activeSeasons.rows) {
    const players = await pool.query(
      "SELECT id FROM players WHERE team_id = $1 AND status = 'active'",
      [season.team_id]
    );
    for (const player of players.rows) {
      try {
        await updatePlayerStats(player.id, season.team_id);
        recomputed++;
      } catch (err) {
        console.error(`Failed to recompute stats for player ${player.id}:`, err.message);
      }
    }
  }
  console.log(`Build 4: Recomputed stats for ${recomputed} players.`);
  console.log('Build 4 migrations complete.');
}

async function runBuild5Migrations() {
  // Create subscriptions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type VARCHAR(10) NOT NULL CHECK (owner_type IN ('club', 'team')),
      owner_id UUID NOT NULL,
      stripe_customer_id VARCHAR(200),
      stripe_subscription_id VARCHAR(200),
      plan VARCHAR(50) NOT NULL DEFAULT 'team' CHECK (plan IN ('team', 'small_club', 'large_club', 'mega_club')),
      billing_interval VARCHAR(10) NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly', 'annual')),
      status VARCHAR(30) NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing', 'active', 'past_due', 'suspended', 'canceled')),
      player_cap INTEGER NOT NULL DEFAULT 20,
      addon_quantity INTEGER NOT NULL DEFAULT 0,
      card_brand VARCHAR(50),
      card_last4 VARCHAR(4),
      card_exp_month INTEGER,
      card_exp_year INTEGER,
      current_period_end TIMESTAMPTZ,
      trial_end TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_subscriptions_owner ON subscriptions(owner_type, owner_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_cust ON subscriptions(stripe_customer_id)');

  // Create billing_config table (key-value for Stripe price IDs)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_config (
      key VARCHAR(100) PRIMARY KEY,
      value VARCHAR(500) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Relax audit_log target_type constraint to include 'subscription'
  try {
    await pool.query("ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_target_type_check");
    await pool.query("ALTER TABLE audit_log ADD CONSTRAINT audit_log_target_type_check CHECK (target_type IN ('player', 'team', 'club', 'user', 'invitation', 'season', 'subscription'))");
  } catch (err) {
    // Constraint may already be updated
  }

  console.log('Build 5 migrations complete.');
}

async function runBuild6Migrations() {
  // Add comped_at and comped_by columns to subscriptions for comp tracking
  const compedAtCol = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name = 'comped_at'"
  );
  if (compedAtCol.rows.length === 0) {
    await pool.query('ALTER TABLE subscriptions ADD COLUMN comped_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE subscriptions ADD COLUMN comped_by UUID');
    console.log('Added comped_at, comped_by columns to subscriptions.');
  }

  // Add manually_suspended column to subscriptions to distinguish manual suspend from billing suspend
  const manSuspCol = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name = 'manually_suspended'"
  );
  if (manSuspCol.rows.length === 0) {
    await pool.query('ALTER TABLE subscriptions ADD COLUMN manually_suspended BOOLEAN DEFAULT false');
    console.log('Added manually_suspended column to subscriptions.');
  }

  // Relax audit_log actor_type constraint to include 'super_admin'
  try {
    await pool.query("ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_type_check");
    await pool.query("ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('staff', 'player', 'parent', 'system', 'super_admin'))");
  } catch (err) {
    // Constraint may already be updated or not exist
  }

  console.log('Build 6 migrations complete.');
}

async function runBuild7Migrations() {
  const mustChangePwCol = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'players' AND column_name = 'must_change_password'"
  );
  if (mustChangePwCol.rows.length === 0) {
    await pool.query('ALTER TABLE players ADD COLUMN must_change_password BOOLEAN DEFAULT false');
    console.log('Added must_change_password column to players.');
  }

  // Ensure consent_records has the columns needed by the grant endpoint
  // (databases created via Build 2 migration have the old schema)
  const consentTeamCol = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'consent_records' AND column_name = 'team_id'"
  );
  if (consentTeamCol.rows.length === 0) {
    await pool.query('ALTER TABLE consent_records ADD COLUMN team_id UUID REFERENCES teams(id)');
    await pool.query('ALTER TABLE consent_records ADD COLUMN club_id UUID REFERENCES clubs(id)');
    await pool.query('ALTER TABLE consent_records ADD COLUMN consent_source VARCHAR(30)');
    await pool.query('ALTER TABLE consent_records ADD COLUMN consent_language TEXT');
    await pool.query("ALTER TABLE consent_records ADD COLUMN status VARCHAR(20) DEFAULT 'granted'");
    await pool.query('ALTER TABLE consent_records ADD COLUMN granted_at TIMESTAMPTZ DEFAULT NOW()');
    await pool.query('ALTER TABLE consent_records ADD COLUMN revoked_at TIMESTAMPTZ');
    console.log('Added missing columns to consent_records.');
  }

  console.log('Build 7 migrations complete.');
}

async function runBuild8Migrations() {
  const bonusCriteriaCol = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'drills' AND column_name = 'bonus_criteria'"
  );
  if (bonusCriteriaCol.rows.length === 0) {
    await pool.query('ALTER TABLE drills ADD COLUMN bonus_criteria TEXT');
    console.log('Added bonus_criteria column to drills.');
  }

  console.log('Build 8 migrations complete.');
}

async function seedAppSettings() {
  const policyContent = `<h1>Daily Reps privacy policy</h1>
<p>Effective date: June 20, 2026</p>
<p>Daily Reps is a soccer training web app for youth teams, clubs, and coaches. Coaches assign at-home soccer drills, players mark drills complete, and the app tracks points, streaks, levels, and team leaderboard standings.</p>
<p>This privacy policy explains what information we collect, how we use it, who can see it, and how parents or guardians can contact us.</p>
<h2>Who we are</h2>
<p>Daily Reps is operated by Matt McWilliams Consulting, Inc.</p>
<p>Contact:<br>Matt McWilliams Consulting, Inc.<br>803 S. Calhoun Street, Suite 600, Fort Wayne, IN 46802<br>privacy@mattmcwilliams.com</p>
<h2>Information we collect</h2>
<p>Daily Reps is designed to collect as little player information as possible.</p>
<p>For player accounts, we may collect:</p>
<ul>
<li>First and last name</li>
<li>Team or club assignment</li>
<li>Drill completion activity</li>
<li>Points, streaks, levels, and leaderboard position</li>
<li>Login or account information needed to operate the app</li>
<li>Basic technical information, such as IP address, browser type, device type, log files, and security records</li>
</ul>
<p>We do not ask players for date of birth, photos, videos, audio, GPS location, health information, injury notes, personal bios, chat messages, direct messages, or social media profiles.</p>
<p>We may collect a parent or guardian email address if it is needed for consent, account notices, or optional alerts. Parent email addresses are not used for advertising or unrelated marketing.</p>
<h2>How player accounts are created</h2>
<p>Player accounts are created by coaches, team administrators, or club administrators. Players do not create public profiles.</p>
<p>If a player is under 13, we require legally appropriate parent or guardian consent before activating the player account, unless another legally valid consent method applies. Consent may be collected directly from the parent or guardian, or through a process managed by the club or team and approved by Daily Reps.</p>
<p>We may keep records showing when consent was provided, who provided it, the player account covered by the consent, the club or team, the privacy policy version, and related audit information.</p>
<h2>How we use information</h2>
<p>We use player information only to operate Daily Reps, including to:</p>
<ul>
<li>Create and manage team accounts</li>
<li>Let coaches assign drills</li>
<li>Let players mark drills complete</li>
<li>Track points, streaks, levels, and team leaderboard standings</li>
<li>Show coaches and club administrators player progress</li>
<li>Send optional parent alerts or account notices</li>
<li>Provide support</li>
<li>Protect the app, prevent misuse, and maintain security</li>
<li>Improve app performance using limited, aggregated, or de-identified information where possible</li>
</ul>
<p>We do not use player information for targeted advertising, behavioral advertising, ad retargeting, or unrelated marketing.</p>
<h2>Who can see player information</h2>
<p>Daily Reps is team-based.</p>
<p>Players may see the first and last names, points, and leaderboard standings of their current teammates. Players cannot see players from other teams unless they are part of the same team or club view authorized by the club.</p>
<p>Coaches may see information for players on teams they manage.</p>
<p>Club administrators may see information for teams in their club.</p>
<p>Daily Reps personnel may access information only when needed to operate, support, secure, or improve the service.</p>
<h2>What we do not allow</h2>
<p>Daily Reps does not include:</p>
<ul>
<li>Chat</li>
<li>Direct messages</li>
<li>Public profiles</li>
<li>Public leaderboards</li>
<li>Cross-club public rankings</li>
<li>Social posting</li>
<li>Comments</li>
<li>Photos</li>
<li>Videos</li>
<li>Audio uploads</li>
<li>GPS tracking</li>
<li>Health or injury notes</li>
<li>Advertising</li>
<li>Marketing pixels</li>
<li>Sale of player data</li>
</ul>
<h2>Service providers</h2>
<p>We may use trusted service providers to help run Daily Reps, such as hosting, database, authentication, email delivery, logging, security, customer support, and analytics providers.</p>
<p>These providers may process information only to help us provide Daily Reps. They are not allowed to sell player information, use it for their own advertising, or use it to build profiles unrelated to Daily Reps.</p>
<h2>Parent and guardian rights</h2>
<p>Parents and guardians may contact us to:</p>
<ul>
<li>Review the personal information we have about their child</li>
<li>Ask us to correct inaccurate information</li>
<li>Ask us to delete their child's information</li>
<li>Revoke consent</li>
<li>Stop future collection or use of their child's information</li>
</ul>
<p>To make a request, contact us at Matt McWilliams Consulting, Inc.<br>803 S. Calhoun Street, Suite 600, Fort Wayne, IN 46802<br>privacy@mattmcwilliams.com</p>
<p>Before responding, we may take reasonable steps to verify that the requester is the child's parent or guardian.</p>
<p>If a parent or guardian revokes consent or asks us to delete information needed to operate the account, the child may no longer be able to use Daily Reps.</p>
<h2>Data retention</h2>
<p>We keep player information only as long as reasonably needed to provide Daily Reps, support the team or club, comply with legal obligations, resolve disputes, and maintain security.</p>
<p>Our standard retention schedule is:</p>
<ul>
<li>Active player information is kept while the player is part of an active team or club account.</li>
<li>When a player leaves a team, we delete or de-identify the player's personal information within 30 days after we are notified, unless retention is legally required.</li>
<li>When a club cancels, we delete or de-identify player personal information within 30 days after the account closes, unless the club requests a shorter period or retention is legally required.</li>
<li>Backup copies are deleted or overwritten on our regular backup cycle, usually within 30 days.</li>
<li>Aggregated or de-identified information may be kept longer if it cannot reasonably identify a player.</li>
</ul>
<h2>Security</h2>
<p>We use reasonable administrative, technical, and physical safeguards to protect player information. These may include encryption, access controls, role-based permissions, logging, password protections, limited employee access, and vendor controls.</p>
<p>No system is perfectly secure, but Daily Reps is designed to limit the amount of child information collected and to restrict who can access it.</p>
<h2>State privacy rights</h2>
<p>Depending on where a user lives, parents, guardians, or users may have additional privacy rights under state law, such as rights to access, correct, delete, or obtain a copy of personal information.</p>
<p>Daily Reps does not sell personal information. Daily Reps does not share personal information for targeted advertising.</p>
<p>Requests may be sent to Matt McWilliams Consulting, Inc.<br>803 S. Calhoun Street, Suite 600, Fort Wayne, IN 46802<br>privacy@mattmcwilliams.com</p>
<h2>Changes to this policy</h2>
<p>We may update this privacy policy from time to time. If we make material changes to how we collect, use, disclose, or retain children's personal information, we will provide notice and obtain any consent required by law before the changes apply.</p>
<h2>Contact us</h2>
<p>Questions or privacy requests may be sent to:</p>
<p>Matt McWilliams Consulting, Inc.<br>803 S. Calhoun Street, Suite 600, Fort Wayne, IN 46802<br>privacy@mattmcwilliams.com</p>`;

  const consentLanguage = `<h1>Parent/guardian consent for Daily Reps</h1>
<p>Daily Reps is a soccer training app used by youth teams and clubs. Coaches assign at-home soccer drills, players mark drills complete, and the app tracks team-based points, streaks, levels, and leaderboard standings.</p>
<p>Before your child can use Daily Reps, we need your permission to create and operate your child's player account.</p>
<h2>What information Daily Reps collects</h2>
<p>For your child's account, Daily Reps collects and uses only limited team-related information:</p>
<ul>
<li>Child's first and last name</li>
<li>Team and club assignment</li>
<li>Assigned drills</li>
<li>Drill completion activity</li>
<li>Points, streaks, levels, and team leaderboard standing</li>
<li>Login/account information needed to operate the app</li>
<li>Basic technical and security information, such as log records, device/browser type, and IP address</li>
</ul>
<p>Daily Reps does not ask your child for date of birth, photos, videos, audio, GPS location, health information, injury notes, personal bios, chat messages, direct messages, comments, or social media information.</p>
<h2>How the information is used</h2>
<p>Daily Reps uses this information only to:</p>
<ul>
<li>Create and manage your child's player account</li>
<li>Let coaches assign drills</li>
<li>Let your child mark drills complete</li>
<li>Track points, streaks, levels, and team leaderboard standings</li>
<li>Show coaches and club administrators team progress</li>
<li>Provide support</li>
<li>Protect the app and prevent misuse</li>
<li>Improve the app using limited, aggregated, or de-identified information where possible</li>
</ul>
<p>Daily Reps does not sell your child's information. Daily Reps does not use your child's information for ads, targeted advertising, retargeting, marketing pixels, or unrelated marketing.</p>
<h2>Who can see your child's information</h2>
<p>Daily Reps is team-based.</p>
<p>Your child's current teammates may see your child's first and last name, points, and team leaderboard standing.</p>
<p>Your child's coaches may see your child's name, team assignment, assigned drills, completed drills, points, streaks, levels, and leaderboard standing.</p>
<p>Club administrators may see player information for teams in their club.</p>
<p>Daily Reps service providers may process limited information only as needed to host, secure, support, and operate the app. They are not allowed to sell your child's information or use it for their own advertising.</p>
<h2>Parent/guardian rights</h2>
<p>You may contact Daily Reps at any time to:</p>
<ul>
<li>Review the personal information we have about your child</li>
<li>Correct inaccurate information</li>
<li>Ask us to delete your child's information</li>
<li>Revoke your consent</li>
<li>Stop future collection or use of your child's information</li>
</ul>
<p>To make a request, contact us at privacy@mattmcwilliams.com.</p>
<p>If you revoke consent or ask us to delete information needed to operate the account, your child may no longer be able to use Daily Reps.</p>
<h2>Consent</h2>
<p>By checking the box below, I confirm that:</p>
<ol>
<li>I am the parent or legal guardian of the child listed below.</li>
<li>I have read this notice and the Daily Reps Privacy Policy.</li>
<li>I give Daily Reps permission to collect, use, and share my child's limited account information as described above.</li>
<li>I understand that my child's name, points, and leaderboard standing may be visible to current teammates, coaches, and club administrators.</li>
<li>I understand that Daily Reps does not sell my child's information, does not show ads, does not use targeted advertising, and does not use marketing pixels in the player app.</li>
<li>I understand that I can review, delete, or revoke consent for my child's information by contacting Daily Reps.</li>
</ol>
<p>[ ] I agree and give permission for my child to use Daily Reps.</p>`;

  await pool.query(
    `INSERT INTO app_settings (id, privacy_policy_version, privacy_policy_content, consent_language, retention_days)
     VALUES (1, '1.0', $1, $2, 30)
     ON CONFLICT (id) DO NOTHING`,
    [policyContent, consentLanguage]
  );
  console.log('Seeded app_settings.');
}

async function migrateOldData() {
  console.log('Starting data migration from old schema...');

  // 1. Create Fusion FC club
  const clubResult = await pool.query(
    "INSERT INTO clubs (name, status) VALUES ('Fusion FC', 'active') RETURNING id"
  );
  const clubId = clubResult.rows[0].id;

  // 2. Generate join code
  const joinCode = generateJoinCode();

  // 3. Create team
  const teamResult = await pool.query(
    `INSERT INTO teams (club_id, name, join_code, primary_color, status)
     VALUES ($1, 'Fusion FC', $2, '#f77c00', 'active') RETURNING id`,
    [clubId, joinCode]
  );
  const teamId = teamResult.rows[0].id;

  // 4. Migrate coaches
  const oldCoaches = await pool.query("SELECT * FROM old_users WHERE role = 'coach'");
  const coachIdMap = {};
  for (const coach of oldCoaches.rows) {
    const email = coach.username + '@dailyreps.local';
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, club_id, status)
       VALUES ($1, $2, 'coach', $3, $4, $5, 'active') RETURNING id`,
      [email, coach.password_hash, coach.first_name, coach.last_name, clubId]
    );
    coachIdMap[coach.id] = userResult.rows[0].id;
    await pool.query(
      'INSERT INTO coach_teams (user_id, team_id) VALUES ($1, $2)',
      [userResult.rows[0].id, teamId]
    );
  }
  console.log(`Migrated ${oldCoaches.rows.length} coaches.`);

  // 5. Migrate players
  const oldPlayers = await pool.query("SELECT * FROM old_users WHERE role = 'player'");
  const playerIdMap = {};
  for (const player of oldPlayers.rows) {
    const playerResult = await pool.query(
      `INSERT INTO players (team_id, username, password_hash, first_name, last_name, avatar_color, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [teamId, player.username, player.password_hash, player.first_name, player.last_name,
       player.avatar_color, player.active ? 'active' : 'inactive']
    );
    playerIdMap[player.id] = playerResult.rows[0].id;
  }
  console.log(`Migrated ${oldPlayers.rows.length} players.`);

  // 6. Migrate seasons
  const oldSeasons = await pool.query('SELECT * FROM old_seasons ORDER BY id ASC');
  const seasonIdMap = {};
  let activeSeasonId = null;
  for (const season of oldSeasons.rows) {
    const status = season.active ? 'active' : 'archived';
    const seasonResult = await pool.query(
      `INSERT INTO seasons (team_id, name, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [teamId, season.name, season.start_date, season.end_date, status]
    );
    seasonIdMap[season.id] = seasonResult.rows[0].id;
    if (season.active) {
      activeSeasonId = seasonResult.rows[0].id;
    }
  }
  if (activeSeasonId) {
    await pool.query('UPDATE teams SET active_season_id = $1 WHERE id = $2', [activeSeasonId, teamId]);
  }
  console.log(`Migrated ${oldSeasons.rows.length} seasons.`);

  // 7. Migrate drills
  const oldDrills = await pool.query('SELECT * FROM old_drills ORDER BY id ASC');
  const drillIdMap = {};
  for (const drill of oldDrills.rows) {
    // Find the matching season for this drill based on date
    let seasonId = activeSeasonId;
    for (const oldSeason of oldSeasons.rows) {
      const start = new Date(oldSeason.start_date);
      const end = new Date(oldSeason.end_date);
      const drillDate = new Date(drill.date);
      if (drillDate >= start && drillDate <= end) {
        seasonId = seasonIdMap[oldSeason.id];
        break;
      }
    }
    const createdBy = drill.created_by ? coachIdMap[drill.created_by] : null;
    const drillResult = await pool.query(
      `INSERT INTO drills (team_id, season_id, date, title, description, youtube_url, target_time,
                           completion_points, extra_points, is_challenge_day, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [teamId, seasonId, drill.date, drill.title, drill.description, drill.youtube_url,
       drill.target_time,
       drill.points_completion != null ? drill.points_completion : 10,
       drill.points_extra != null ? drill.points_extra : 5,
       drill.is_challenge || false, createdBy]
    );
    drillIdMap[drill.id] = drillResult.rows[0].id;
  }
  console.log(`Migrated ${oldDrills.rows.length} drills.`);

  // 8. Migrate completions
  const oldCompletions = await pool.query('SELECT * FROM old_completions');
  for (const comp of oldCompletions.rows) {
    const newPlayerId = playerIdMap[comp.user_id];
    const newDrillId = drillIdMap[comp.drill_id];
    if (newPlayerId && newDrillId) {
      await pool.query(
        'INSERT INTO completions (player_id, drill_id, completed_at, did_extra, points_earned) VALUES ($1, $2, $3, $4, 0) ON CONFLICT DO NOTHING',
        [newPlayerId, newDrillId, comp.completed_at, comp.did_extra]
      );
    }
  }
  console.log(`Migrated ${oldCompletions.rows.length} completions.`);

  // 9. Migrate questions
  const oldQuestions = await pool.query('SELECT * FROM old_drill_questions ORDER BY id ASC');
  const questionIdMap = {};
  for (const q of oldQuestions.rows) {
    const newDrillId = drillIdMap[q.drill_id];
    if (!newDrillId) continue;
    const qResult = await pool.query(
      'INSERT INTO questions (drill_id, question_text, type, points, position) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [newDrillId, q.question_text, q.input_type, q.point_value || 1, q.sort_order || 0]
    );
    questionIdMap[q.id] = qResult.rows[0].id;
  }

  // Migrate question options
  const oldOptions = await pool.query('SELECT * FROM old_question_options ORDER BY id ASC');
  const optionIdMap = {};
  for (const opt of oldOptions.rows) {
    const newQuestionId = questionIdMap[opt.question_id];
    if (!newQuestionId) continue;
    const optResult = await pool.query(
      'INSERT INTO question_options (question_id, option_text, is_correct, position) VALUES ($1, $2, $3, $4) RETURNING id',
      [newQuestionId, opt.option_text, opt.is_correct, opt.sort_order || 0]
    );
    optionIdMap[opt.id] = optResult.rows[0].id;
  }

  // Migrate question acceptable answers
  const tableCheck = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'old_question_acceptable_answers'");
  if (tableCheck.rows.length > 0) {
    const oldAnswers = await pool.query('SELECT * FROM old_question_acceptable_answers');
    for (const ans of oldAnswers.rows) {
      const newQuestionId = questionIdMap[ans.question_id];
      if (!newQuestionId) continue;
      await pool.query(
        'INSERT INTO question_text_answers (question_id, acceptable_answer) VALUES ($1, $2)',
        [newQuestionId, ans.answer_text]
      );
    }
  }

  // Migrate question responses
  const responseTableCheck = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'old_player_question_responses'");
  if (responseTableCheck.rows.length > 0) {
    const oldResponses = await pool.query('SELECT * FROM old_player_question_responses');
    for (const resp of oldResponses.rows) {
      const newPlayerId = playerIdMap[resp.user_id];
      const newQuestionId = questionIdMap[resp.question_id];
      if (!newPlayerId || !newQuestionId) continue;
      await pool.query(
        'INSERT INTO question_responses (player_id, question_id, response_text, is_correct, points_earned, attempt_number, answered_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
        [newPlayerId, newQuestionId, resp.response_text, resp.points_earned > 0, resp.points_earned, resp.attempt_number, resp.answered_at]
      );
    }
  }
  console.log('Migrated questions, options, answers, and responses.');

  // 10. Migrate badges (badges are seeded fresh; migrate user_badges → player_badges)
  const oldBadgesTableCheck = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'old_user_badges'");
  if (oldBadgesTableCheck.rows.length > 0) {
    const oldUserBadges = await pool.query(
      `SELECT ub.*, ob.slug FROM old_user_badges ub JOIN old_badges ob ON ob.id = ub.badge_id`
    );
    for (const ub of oldUserBadges.rows) {
      const newPlayerId = playerIdMap[ub.user_id];
      if (!newPlayerId) continue;
      await pool.query(
        `INSERT INTO player_badges (player_id, badge_id, earned_at, season_id)
         SELECT $1, b.id, $3, $4 FROM badges b WHERE b.slug = $2
         ON CONFLICT DO NOTHING`,
        [newPlayerId, ub.slug, ub.earned_at, activeSeasonId]
      );
    }
    console.log('Migrated player badges.');
  }

  // 11. Calculate and update player_season_stats and lifetime_points
  for (const oldPlayerId of Object.keys(playerIdMap)) {
    const newPlayerId = playerIdMap[oldPlayerId];
    try {
      await updatePlayerStats(newPlayerId, teamId);
    } catch (err) {
      console.error(`Error updating stats for player ${newPlayerId}:`, err.message);
    }
  }
  console.log('Updated player season stats and lifetime points.');

  // 12. Create super_admin user
  const superAdminPassword = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  const superAdminHash = await bcrypt.hash(superAdminPassword, 10);
  await pool.query(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, status)
     VALUES ('admin@dailyreps.app', $1, 'super_admin', 'Matt', 'Admin', 'active')`,
    [superAdminHash]
  );

  console.log('===========================================');
  console.log('SUPER ADMIN CREDENTIALS (save these!):');
  console.log(`  Email:    admin@dailyreps.app`);
  console.log(`  Password: ${superAdminPassword}`);
  console.log('===========================================');
  console.log(`FUSION FC TEAM JOIN CODE: ${joinCode}`);
  console.log('===========================================');

  return { joinCode, superAdminPassword };
}

async function initDatabase() {
  try {
    // Check if new schema already exists
    const clubsCheck = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'clubs')"
    );
    if (clubsCheck.rows[0].exists) {
      console.log('New multi-tenant schema already exists, skipping migration.');
      // Ensure badges and levels are seeded
      await seedBadges();
      await seedLevels();
      await runBuild2Migrations();
      await runBuild3Migrations();
      await runBuild4Migrations();
      await runBuild5Migrations();
      await runBuild6Migrations();
      await runBuild7Migrations();
      await runBuild8Migrations();
      await seedAppSettings();
      return;
    }

    // Check if old schema exists
    const oldUsersCheck = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users')"
    );
    const hasOldSchema = oldUsersCheck.rows[0].exists;

    if (hasOldSchema) {
      // Check if this is really the old schema (has username column, SERIAL id)
      const colCheck = await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'username'"
      );
      if (colCheck.rows.length > 0) {
        console.log('Detected old schema. Running migration...');

        // Rename old tables
        await pool.query('ALTER TABLE users RENAME TO old_users');
        await pool.query('ALTER TABLE drills RENAME TO old_drills');
        await pool.query('ALTER TABLE completions RENAME TO old_completions');
        await pool.query('ALTER TABLE seasons RENAME TO old_seasons');
        await pool.query('ALTER TABLE badges RENAME TO old_badges');
        await pool.query('ALTER TABLE user_badges RENAME TO old_user_badges');

        // Rename quiz tables if they exist
        const dqCheck = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'drill_questions'");
        if (dqCheck.rows.length > 0) {
          await pool.query('ALTER TABLE drill_questions RENAME TO old_drill_questions');
          await pool.query('ALTER TABLE question_options RENAME TO old_question_options');
          const qaCheck = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'question_acceptable_answers'");
          if (qaCheck.rows.length > 0) {
            await pool.query('ALTER TABLE question_acceptable_answers RENAME TO old_question_acceptable_answers');
          }
          const prCheck = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'player_question_responses'");
          if (prCheck.rows.length > 0) {
            await pool.query('ALTER TABLE player_question_responses RENAME TO old_player_question_responses');
          }
        }

        console.log('Renamed old tables.');

        // Create new schema
        await pool.query(NEW_SCHEMA_SQL);
        console.log('Created new multi-tenant schema.');

        // Seed data
        await seedBadges();
        await seedLevels();
        await runBuild2Migrations();
        await runBuild3Migrations();
        await runBuild4Migrations();
        await runBuild5Migrations();
        await runBuild6Migrations();
        await runBuild7Migrations();
        await runBuild8Migrations();
        await seedAppSettings();

        // Migrate data
        await migrateOldData();

        // Drop old tables
        await pool.query('DROP TABLE IF EXISTS old_player_question_responses CASCADE');
        await pool.query('DROP TABLE IF EXISTS old_question_acceptable_answers CASCADE');
        await pool.query('DROP TABLE IF EXISTS old_question_options CASCADE');
        await pool.query('DROP TABLE IF EXISTS old_drill_questions CASCADE');
        await pool.query('DROP TABLE IF EXISTS old_user_badges CASCADE');
        await pool.query('DROP TABLE IF EXISTS old_badges CASCADE');
        await pool.query('DROP TABLE IF EXISTS old_completions CASCADE');
        await pool.query('DROP TABLE IF EXISTS old_drills CASCADE');
        await pool.query('DROP TABLE IF EXISTS old_seasons CASCADE');
        await pool.query('DROP TABLE IF EXISTS old_users CASCADE');
        console.log('Dropped old tables. Migration complete!');

        return;
      }
    }

    // Fresh database — create new schema
    console.log('Fresh database detected. Creating new schema...');
    await pool.query(NEW_SCHEMA_SQL);
    await seedBadges();
    await seedLevels();
    await runBuild2Migrations();
    await runBuild3Migrations();
    await runBuild4Migrations();
    await runBuild5Migrations();
    await runBuild6Migrations();
    await runBuild7Migrations();
    await runBuild8Migrations();
    await seedAppSettings();
    console.log('Database initialization complete.');
  } catch (err) {
    console.error('Database init error:', err);
  }
}

// ============================================================
// RETENTION CRON JOB
// ============================================================

async function runRetentionJob() {
  console.log('Running retention job...');
  try {
    const settings = await pool.query('SELECT retention_days FROM app_settings WHERE id = 1');
    const retentionDays = settings.rows[0]?.retention_days || 30;

    // Find players eligible for de-identification:
    // 1. Inactive with deactivated_at older than retention_days
    // 2. Any player with deletion_requested_at set
    // Exclude already de-identified players
    const eligible = await pool.query(
      `SELECT id, first_name, last_name FROM players
       WHERE ((status = 'inactive' AND deactivated_at IS NOT NULL AND deactivated_at < NOW() - INTERVAL '1 day' * $1)
          OR deletion_requested_at IS NOT NULL)
       AND first_name != 'Deleted'`,
      [retentionDays]
    );

    for (const player of eligible.rows) {
      const anonId = player.id.substring(0, 8);

      // De-identify player: replace personal fields with anonymized placeholders
      // Keep aggregate stats (completions, points, badges) for de-identified analysis
      await pool.query(
        `UPDATE players SET
           first_name = 'Deleted',
           last_name = $1,
           username = $2,
           player_email = NULL,
           parent_email = NULL,
           password_hash = 'DEIDENTIFIED'
         WHERE id = $3`,
        [anonId, `deleted_${anonId}`, player.id]
      );

      // Anonymize consent records
      await pool.query(
        `UPDATE consent_records SET parent_name = 'REDACTED', parent_email = 'REDACTED' WHERE player_id = $1`,
        [player.id]
      );

      await auditLog('system', null, 'player_deleted', 'player', player.id,
        { original_name: `${player.first_name} ${player.last_name}`, reason: 'retention_policy' });

      console.log(`De-identified player ${player.id}`);
    }

    if (eligible.rows.length > 0) {
      console.log(`Retention job: de-identified ${eligible.rows.length} players.`);
    } else {
      console.log('Retention job: no players to process.');
    }
  } catch (err) {
    console.error('Retention job error:', err);
  }
}

// Schedule: daily at 3:00 AM UTC
cron.schedule('0 3 * * *', runRetentionJob);

// Card expiry reminder: daily at 9:00 AM UTC
cron.schedule('0 9 * * *', async () => {
  console.log('Running card expiry check...');
  try {
    const subs = await pool.query(
      "SELECT * FROM subscriptions WHERE status IN ('active', 'trialing') AND card_exp_month IS NOT NULL AND card_exp_year IS NOT NULL"
    );

    const now = new Date();
    let sent = 0;
    for (const sub of subs.rows) {
      // Card expires at end of exp_month/exp_year
      const expiryDate = new Date(sub.card_exp_year, sub.card_exp_month, 0); // Last day of expiry month
      const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

      if (daysUntilExpiry === 30 || daysUntilExpiry === 10 || daysUntilExpiry === 1) {
        await sendCardExpiryReminderEmail(sub, daysUntilExpiry);
        sent++;
      }
    }
    if (sent > 0) console.log(`Sent ${sent} card expiry reminder(s).`);
  } catch (err) {
    console.error('Card expiry check error:', err);
  }
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3001;

initDatabase().then(async () => {
  // Process any queued emails on startup
  try {
    await processEmailQueue();
  } catch (err) {
    console.error('Email queue processing on startup failed:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`Daily Reps server running on port ${PORT}`);
  });
});
