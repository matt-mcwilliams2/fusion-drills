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
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/build')));

// ============================================================
// LEVELS SYSTEM
// ============================================================

const LEVELS = [
  { name: 'Neymar',    threshold: 0,    color: '#FFD700', textColor: '#000000' },
  { name: 'Mbappe',    threshold: 89,   color: '#1348e5', textColor: '#000000' },
  { name: 'Salah',     threshold: 230,  color: '#C8102E', textColor: '#000000' },
  { name: 'Yamal',     threshold: 435,  color: '#CD7F32', textColor: '#000000' },
  { name: 'Guardiola', threshold: 682,  color: '#000000', textColor: '#ffffff' },
  { name: 'Haaland',   threshold: 901,  color: '#6CABDD', textColor: '#000000' },
  { name: 'Maradona',  threshold: 1233, color: '#CD7F32', textColor: '#000000' },
  { name: 'Cruyff',    threshold: 1677, color: '#f77c00', textColor: '#000000' },
  { name: 'Xavi',      threshold: 2098, color: '#ffffff', textColor: '#C8102E' },
  { name: 'Zico',      threshold: 2455, color: '#C0C0C0', textColor: '#000000' },
  { name: 'Pele',      threshold: 2833, color: '#009739', textColor: '#FFD700' },
  { name: 'Messi',     threshold: 3209, color: '#FF69B4', textColor: '#000000' },
  { name: 'Ronaldo',   threshold: 3651, color: '#FFD700', textColor: '#000000' },
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
        nextLevelName: next ? next.name : null,
      };
    }
  }
  return {
    name: current.name,
    color: current.color,
    textColor: current.textColor,
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

    res.json({ user: userData, teams });
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

    res.json({
      current_streak: currentStreak,
      longest_streak: longestStreak,
      total_completions: totalCompletions,
      total_points: totalPoints,
      extra_count: extraCount,
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
      "SELECT id, username, first_name, last_name, avatar_color, status, consent_status, parent_email, created_at FROM players WHERE team_id = $1 ORDER BY last_name ASC",
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

app.post('/api/admin/players', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { first_name, last_name, username, password, parent_email } = req.body;
    if (!first_name || !last_name || !username || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if team requires consent
    const teamResult = await pool.query('SELECT has_under_13, name FROM teams WHERE id = $1', [req.teamId]);
    const requiresConsent = teamResult.rows[0]?.has_under_13 === true;

    if (requiresConsent && !parent_email) {
      return res.status(400).json({ error: 'Parent email is required for teams with under-13 players' });
    }

    const playerStatus = requiresConsent ? 'pending' : 'active';
    const consentStatus = requiresConsent ? 'awaiting' : 'not_required';

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO players (team_id, first_name, last_name, username, password_hash, status, consent_status, parent_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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

app.post('/api/admin/drills', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { date, title, description, youtube_url, target_time, points_completion, points_extra, is_challenge } = req.body;
    if (!date || !title) {
      return res.status(400).json({ error: 'Date and title are required' });
    }

    // Get active season for team
    const season = await getActiveSeasonForTeam(req.teamId);
    const seasonId = season ? season.id : null;

    const result = await pool.query(
      `INSERT INTO drills (team_id, season_id, date, title, description, youtube_url, target_time, completion_points, extra_points, is_challenge_day, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.teamId, seasonId, date, title, description || null, youtube_url || null,
       target_time ? parseInt(target_time, 10) : null,
       points_completion ? parseInt(points_completion, 10) : 10,
       points_extra ? parseInt(points_extra, 10) : 5,
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
    const { date, title, description, youtube_url, target_time, points_completion, points_extra, is_challenge } = req.body;

    const result = await pool.query(
      `UPDATE drills
       SET date = COALESCE($1, date),
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           youtube_url = COALESCE($4, youtube_url),
           target_time = $5,
           completion_points = COALESCE($6, 10),
           extra_points = COALESCE($7, 5),
           is_challenge_day = $8
       WHERE id = $9 AND team_id = $10
       RETURNING *`,
      [date || null, title || null, description || null, youtube_url || null,
       target_time ? parseInt(target_time, 10) : null,
       points_completion ? parseInt(points_completion, 10) : null,
       points_extra ? parseInt(points_extra, 10) : null,
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

app.post('/api/admin/seasons', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
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
app.get('/api/super/clubs', authenticate, requireRole('super_admin'), async (req, res) => {
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
app.post('/api/super/clubs', authenticate, requireRole('super_admin'), async (req, res) => {
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

    res.json({
      club: { id: club.id, name: club.name, status: club.status, player_limit: club.player_limit },
      teams: teamsResult.rows,
      total_players: parseInt(countResult.rows[0].total),
      invitations: invitations.rows,
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

// Create team
app.post('/api/club/teams', authenticate, requireRole('club_admin'), requireClubAccess, async (req, res) => {
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
app.post('/api/club/import', authenticate, requireRole('club_admin'), requireClubAccess, async (req, res) => {
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
app.post('/api/admin/players/import', authenticate, requireRole('coach', 'super_admin', 'club_admin'), requireTeamAccess, async (req, res) => {
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

    await client.query('BEGIN');

    const credentials = [];
    for (const p of validPlayers) {
      const tempPassword = generatePlayerPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const playerStatus = requiresConsent ? 'pending' : 'active';
      const consentStatus = requiresConsent ? 'awaiting' : 'not_required';
      const parentEmail = p.email ? p.email.trim() : null;

      const result = await client.query(
        `INSERT INTO players (team_id, first_name, last_name, username, password_hash, status, consent_status, parent_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
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
// SPA CATCH-ALL
// ============================================================

app.get('*', (req, res) => {
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
       VALUES ($1, $2, $3, $4, $5, false)
       ON CONFLICT DO NOTHING`,
      [l.name, l.threshold, l.color, l.textColor, i]
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
      await runBuild2Migrations();
      await runBuild3Migrations();
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
