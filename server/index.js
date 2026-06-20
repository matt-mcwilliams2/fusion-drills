require('dotenv').config({ path: '../.env' });
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();
const dbUrl = process.env.DATABASE_URL || '';
const isInternalRailway = dbUrl.includes('.railway.internal');
const pool = new Pool({
  connectionString: dbUrl,
  ssl: (!isInternalRailway && process.env.NODE_ENV === 'production') ? { rejectUnauthorized: false } : false,
});
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

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

    res.json({ token, user: tokenPayload, teams });
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
      "SELECT * FROM players WHERE team_id = $1 AND username = $2 AND status = 'active'",
      [team.id, username.trim()]
    );

    if (playerResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const player = playerResult.rows[0];
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
      "SELECT id, username, first_name, last_name, avatar_color, status, created_at FROM players WHERE team_id = $1 ORDER BY last_name ASC",
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

app.post('/api/admin/players', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { first_name, last_name, username, password } = req.body;
    if (!first_name || !last_name || !username || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO players (team_id, first_name, last_name, username, password_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id, username, first_name, last_name, avatar_color, status, created_at`,
      [req.teamId, first_name, last_name, username.trim(), passwordHash]
    );

    res.status(201).json({ ...result.rows[0], active: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists on this team' });
    }
    console.error('Create player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/players/:id/deactivate', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE players SET status = 'inactive' WHERE id = $1 AND team_id = $2 RETURNING id, username, first_name, last_name, status",
      [req.params.id, req.teamId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
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
    const { name, start_date, end_date } = req.body;
    if (!name || !start_date || !end_date) {
      return res.status(400).json({ error: 'Name, start_date, and end_date are required' });
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
    // Deactivate all seasons for this team
    await pool.query(
      "UPDATE seasons SET status = 'archived' WHERE team_id = $1",
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

app.post('/api/admin/coaches', authenticate, requireRole('coach', 'super_admin'), requireTeamAccess, async (req, res) => {
  try {
    const { first_name, last_name, email, password } = req.body;
    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Check if user with this email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);

    let userId;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
    } else {
      const result = await pool.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, status)
         VALUES ($1, $2, 'coach', $3, $4, 'active')
         RETURNING id, email, first_name, last_name, role, status, created_at`,
        [email.toLowerCase().trim(), passwordHash, first_name, last_name]
      );
      userId = result.rows[0].id;
    }

    // Link coach to team
    await pool.query(
      'INSERT INTO coach_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, req.teamId]
    );

    const coach = await pool.query('SELECT id, email, first_name, last_name, role, status, created_at FROM users WHERE id = $1', [userId]);

    res.status(201).json({ coach: coach.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Create coach error:', err);
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
    console.log('Database initialization complete.');
  } catch (err) {
    console.error('Database init error:', err);
  }
}

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3001;

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Daily Reps server running on port ${PORT}`);
  });
});
