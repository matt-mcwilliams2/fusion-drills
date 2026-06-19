require('dotenv').config({ path: '../.env' });
const express = require('express');
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
// Serve React build in production
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

/**
 * If the active season's end_date is in the past, extend it to today
 * for calculation purposes. An "active" season should always include
 * current activity.
 */
function effectiveEndDate(season) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const end = season.end_date instanceof Date ? season.end_date : new Date(season.end_date);
  return end >= today ? season.end_date : today;
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
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireCoach(req, res, next) {
  if (req.user.role !== 'coach') {
    return res.status(403).json({ error: 'Coach access required' });
  }
  next();
}

// ============================================================
// STREAK CALCULATION HELPERS
// ============================================================

/**
 * Get all drills for a user within a season with completion info.
 * Shared query used by streak and points calculations.
 */
async function getSeasonDrills(userId, seasonStartDate, seasonEndDate) {
  const result = await pool.query(
    `SELECT d.id, d.date, d.points_completion, d.points_extra,
            c.id as completion_id, c.did_extra
     FROM drills d
     LEFT JOIN completions c ON c.drill_id = d.id AND c.user_id = $1
     WHERE d.date BETWEEN $2 AND $3
       AND d.date <= CURRENT_DATE
     ORDER BY d.date ASC`,
    [userId, seasonStartDate, seasonEndDate]
  );
  return result.rows;
}

/**
 * Calculate the current streak for a user within a season.
 * A streak counts consecutive completed drills going backwards from today.
 * If today has a drill that isn't completed yet, start from yesterday.
 * Days without a scheduled drill don't break streaks.
 */
async function calculateCurrentStreak(userId, seasonStartDate, seasonEndDate) {
  const today = new Date().toISOString().split('T')[0];

  const drillsResult = await pool.query(
    `SELECT d.id, d.date,
            EXISTS(SELECT 1 FROM completions c WHERE c.user_id = $1 AND c.drill_id = d.id) as completed
     FROM drills d
     WHERE d.date BETWEEN $2 AND $3
       AND d.date <= CURRENT_DATE
     ORDER BY d.date DESC`,
    [userId, seasonStartDate, seasonEndDate]
  );

  const drills = drillsResult.rows;
  if (drills.length === 0) return 0;

  let streak = 0;
  let startIndex = 0;

  // If the most recent drill is today and it's NOT completed, skip it
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

/**
 * Calculate the longest streak for a user within a season.
 * Iterates all drills in chronological order and finds the max consecutive completions.
 */
async function calculateLongestStreak(userId, seasonStartDate, seasonEndDate) {
  const drillsResult = await pool.query(
    `SELECT d.id, d.date,
            EXISTS(SELECT 1 FROM completions c WHERE c.user_id = $1 AND c.drill_id = d.id) as completed
     FROM drills d
     WHERE d.date BETWEEN $2 AND $3
       AND d.date <= CURRENT_DATE
     ORDER BY d.date ASC`,
    [userId, seasonStartDate, seasonEndDate]
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

/**
 * Calculate total points for a player within a season.
 * Includes:
 *   - Per-drill points (coach-set points_completion + points_extra)
 *   - Streak multiplier: 1.2x after 3+ consecutive completed drills
 *   - Perfect week bonus: +10 for each Mon-Sun week where all scheduled drills are completed
 * Days without a scheduled drill do NOT break streaks.
 */
async function calculatePlayerPoints(userId, seasonStartDate, seasonEndDate) {
  const drills = await getSeasonDrills(userId, seasonStartDate, seasonEndDate);

  let totalPoints = 0;
  let totalCompletions = 0;
  let extraCount = 0;
  let streak = 0;

  for (const drill of drills) {
    if (drill.completion_id) {
      let base = (drill.points_completion != null ? drill.points_completion : 10)
               + (drill.did_extra ? (drill.points_extra != null ? drill.points_extra : 5) : 0);

      // Streak multiplier: 1.2x when completing after 3+ consecutive drills
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

  // Perfect week bonus: for each COMPLETED Mon-Sun calendar week (Sunday has
  // passed) that has at least one scheduled drill, if ALL drills in that week
  // are completed, +10 pts
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const weekMap = {};
  for (const drill of drills) {
    const d = drill.date instanceof Date ? drill.date : new Date(drill.date);
    const day = d.getUTCDay(); // 0=Sun, 1=Mon ...
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

  // Add question bonus points
  const questionPointsResult = await pool.query(
    `SELECT COALESCE(SUM(pqr.points_earned), 0) as question_points
     FROM player_question_responses pqr
     JOIN drill_questions dq ON dq.id = pqr.question_id
     JOIN drills d ON d.id = dq.drill_id
     WHERE pqr.user_id = $1 AND d.date BETWEEN $2 AND $3 AND d.date <= CURRENT_DATE`,
    [userId, seasonStartDate, seasonEndDate]
  );
  totalPoints += parseInt(questionPointsResult.rows[0].question_points, 10);

  return { totalPoints, totalCompletions, extraCount };
}

// ============================================================
// BADGE CHECKING HELPER
// ============================================================

async function checkAndAwardBadges(userId) {
  const seasonResult = await pool.query('SELECT * FROM seasons WHERE active = true LIMIT 1');
  const season = seasonResult.rows[0];
  if (!season) return [];

  const endDate = effectiveEndDate(season);
  const { totalPoints, totalCompletions, extraCount } = await calculatePlayerPoints(userId, season.start_date, endDate);
  const currentStreak = await calculateCurrentStreak(userId, season.start_date, endDate);
  const drills = await getSeasonDrills(userId, season.start_date, endDate);

  // Check perfect week: only count COMPLETED weeks (Sunday has passed)
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

  // Check perfect month: only count months that have fully ended
  const monthMap = {};
  for (const drill of drills) {
    const d = drill.date instanceof Date ? drill.date : new Date(drill.date);
    const monthKey = d.toISOString().slice(0, 7); // YYYY-MM
    if (!monthMap[monthKey]) monthMap[monthKey] = { total: 0, completed: 0 };
    monthMap[monthKey].total++;
    if (drill.completion_id) monthMap[monthKey].completed++;
  }
  const hasPerfectMonth = Object.entries(monthMap).some(([key, m]) => {
    const [year, mon] = key.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, mon, 0)); // last day of that month
    return lastDay <= today && m.total > 0 && m.completed === m.total;
  });

  // Check challenge drill completions
  const challengeResult = await pool.query(
    `SELECT COUNT(*) as cnt FROM completions c
     JOIN drills d ON d.id = c.drill_id
     WHERE c.user_id = $1 AND d.is_challenge = true
       AND d.date BETWEEN $2 AND $3`,
    [userId, season.start_date, endDate]
  );
  const challengeCount = parseInt(challengeResult.rows[0].cnt, 10);

  // Check weekly winner: did this player earn the most base points in any
  // completed Mon-Sun week? Query all drill dates to find completed weeks,
  // then check per-week leaderboard.
  let isWeeklyWinner = false;
  const allDrillDates = await pool.query(
    `SELECT DISTINCT date FROM drills
     WHERE date BETWEEN $1 AND $2 AND date <= CURRENT_DATE`,
    [season.start_date, endDate]
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
      `SELECT c.user_id,
         SUM(COALESCE(d.points_completion, 10) +
             CASE WHEN c.did_extra THEN COALESCE(d.points_extra, 5) ELSE 0 END) as week_points
       FROM completions c
       JOIN drills d ON d.id = c.drill_id
       JOIN users u ON u.id = c.user_id
       WHERE d.date >= $1::date AND d.date <= $2::date
         AND u.role = 'player' AND u.active = true
       GROUP BY c.user_id
       ORDER BY week_points DESC
       LIMIT 1`,
      [mondayStr, sundayDate.toISOString().split('T')[0]]
    );
    if (topResult.rows.length > 0 && topResult.rows[0].user_id == userId) {
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
        `INSERT INTO user_badges (user_id, badge_id)
         SELECT $1, b.id FROM badges b WHERE b.slug = $2
         ON CONFLICT DO NOTHING
         RETURNING badge_id`,
        [userId, badge.slug]
      );
      if (result.rows.length > 0) {
        newBadges.push(badge.slug);
      }
    }
  }
  return newBadges;
}

// ============================================================
// AUTH ENDPOINTS
// ============================================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND active = true',
      [username]
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
      username: user.username,
      role: user.role,
      first_name: user.first_name,
      last_name: user.last_name,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: tokenPayload });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        first_name: req.user.first_name,
        last_name: req.user.last_name,
      },
    });
  } catch (err) {
    console.error('Auth me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// DRILL ENDPOINTS
// ============================================================

// GET /api/drills/today
app.get('/api/drills/today', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*,
              c.id as completion_id,
              c.completed_at,
              c.did_extra
       FROM drills d
       LEFT JOIN completions c ON c.drill_id = d.id AND c.user_id = $1
       WHERE d.date = CURRENT_DATE`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({ drill: null, completion: null });
    }

    const row = result.rows[0];

    // Check if drill has questions
    const qCount = await pool.query(
      'SELECT COUNT(*) as cnt FROM drill_questions WHERE drill_id = $1',
      [row.id]
    );

    const drill = {
      id: row.id,
      date: row.date,
      title: row.title,
      description: row.description,
      youtube_url: row.youtube_url,
      target_time: row.target_time,
      is_challenge: row.is_challenge,
      created_by: row.created_by,
      created_at: row.created_at,
      has_questions: parseInt(qCount.rows[0].cnt, 10) > 0,
    };

    const completion = row.completion_id
      ? {
          id: row.completion_id,
          completed_at: row.completed_at,
          did_extra: row.did_extra,
        }
      : null;

    res.json({ drill, completion });
  } catch (err) {
    console.error('Get today drill error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/drills/date/:date
app.get('/api/drills/date/:date', authenticate, async (req, res) => {
  try {
    const { date } = req.params;
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    const result = await pool.query(
      `SELECT d.*,
              c.id as completion_id,
              c.completed_at,
              c.did_extra
       FROM drills d
       LEFT JOIN completions c ON c.drill_id = d.id AND c.user_id = $1
       WHERE d.date = $2::date`,
      [req.user.id, date]
    );

    if (result.rows.length === 0) {
      return res.json({ drill: null, completion: null });
    }

    const row = result.rows[0];

    // Check if drill has questions
    const qCount = await pool.query(
      'SELECT COUNT(*) as cnt FROM drill_questions WHERE drill_id = $1',
      [row.id]
    );

    const drill = {
      id: row.id,
      date: row.date,
      title: row.title,
      description: row.description,
      youtube_url: row.youtube_url,
      target_time: row.target_time,
      is_challenge: row.is_challenge,
      created_by: row.created_by,
      created_at: row.created_at,
      has_questions: parseInt(qCount.rows[0].cnt, 10) > 0,
    };

    const completion = row.completion_id
      ? {
          id: row.completion_id,
          completed_at: row.completed_at,
          did_extra: row.did_extra,
        }
      : null;

    res.json({ drill, completion });
  } catch (err) {
    console.error('Get drill by date error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/drills/:id/complete
app.post('/api/drills/:id/complete', authenticate, async (req, res) => {
  try {
    const drillId = parseInt(req.params.id, 10);
    const { did_extra } = req.body;

    // Verify drill exists and is for today or yesterday
    const drillCheck = await pool.query(
      `SELECT date FROM drills WHERE id = $1`,
      [drillId]
    );
    if (drillCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Drill not found' });
    }
    const drillDate = drillCheck.rows[0].date.toISOString().split('T')[0];
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (drillDate !== todayStr && drillDate !== yesterdayStr) {
      return res.status(403).json({ error: 'You can only complete drills from today or yesterday' });
    }

    // Capture level BEFORE completion for level-up detection
    let levelBefore = null;
    try {
      const seasonCheck = await pool.query('SELECT * FROM seasons WHERE active = true LIMIT 1');
      if (seasonCheck.rows.length > 0) {
        const s = seasonCheck.rows[0];
        const { totalPoints: ptsBefore } = await calculatePlayerPoints(req.user.id, s.start_date, effectiveEndDate(s));
        levelBefore = getLevelInfo(ptsBefore);
      }
    } catch (levelErr) {
      console.error('Level-before calculation error (non-fatal):', levelErr);
    }

    // INSERT completion FIRST — this is the critical operation
    const result = await pool.query(
      `INSERT INTO completions (user_id, drill_id, did_extra)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, drill_id) DO NOTHING
       RETURNING *`,
      [req.user.id, drillId, did_extra || false]
    );

    if (result.rows.length === 0) {
      // Already completed - fetch the existing completion
      const existing = await pool.query(
        'SELECT * FROM completions WHERE user_id = $1 AND drill_id = $2',
        [req.user.id, drillId]
      );
      return res.json({ completion: existing.rows[0] });
    }

    // Check and award badges + detect level-up (non-critical)
    let newBadges = [];
    let levelUp = null;
    let level = null;
    try {
      newBadges = await checkAndAwardBadges(req.user.id);

      const seasonResult = await pool.query('SELECT * FROM seasons WHERE active = true LIMIT 1');
      if (seasonResult.rows.length > 0) {
        const s = seasonResult.rows[0];
        const { totalPoints: ptsAfter } = await calculatePlayerPoints(req.user.id, s.start_date, effectiveEndDate(s));
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

// GET /api/drills/:id/questions - Get questions for a drill (player-facing, no correct answers)
app.get('/api/drills/:id/questions', authenticate, async (req, res) => {
  try {
    const drillId = parseInt(req.params.id, 10);
    const userId = req.user.id;

    const questions = await pool.query(
      'SELECT id, question_text, input_type, point_value, sort_order FROM drill_questions WHERE drill_id = $1 ORDER BY sort_order ASC',
      [drillId]
    );

    const result = [];
    for (const q of questions.rows) {
      // Check if player already answered this question (has any response)
      const responded = await pool.query(
        'SELECT id FROM player_question_responses WHERE user_id = $1 AND question_id = $2 ORDER BY attempt_number DESC LIMIT 1',
        [userId, q.id]
      );

      // For text/radio: check if they used both attempts or got it right
      // For checkbox: check if they have any response (one attempt only)
      let answered = false;
      if (responded.rows.length > 0) {
        if (q.input_type === 'checkbox') {
          answered = true;
        } else {
          // Check if they got it right on attempt 1, or already used attempt 2
          const attempts = await pool.query(
            'SELECT attempt_number, points_earned FROM player_question_responses WHERE user_id = $1 AND question_id = $2 ORDER BY attempt_number ASC',
            [userId, q.id]
          );
          if (attempts.rows.length >= 2) {
            answered = true; // Used both attempts
          } else if (attempts.rows.length === 1 && attempts.rows[0].points_earned > 0) {
            answered = true; // Got it right on first try
          }
          // If they have 1 attempt with 0 points, they still need a second try
        }
      }

      if (!answered) {
        const questionData = { ...q, options: [] };
        if (q.input_type === 'radio' || q.input_type === 'checkbox') {
          const opts = await pool.query(
            'SELECT id, option_text, sort_order FROM question_options WHERE question_id = $1 ORDER BY sort_order ASC',
            [q.id]
          );
          questionData.options = opts.rows;
        }
        // Check if this is a retry (text/radio with 1 failed attempt)
        if (responded.rows.length > 0) {
          questionData.is_retry = true;
        }
        result.push(questionData);
      }
    }

    res.json({
      questions: result,
      total_count: questions.rows.length,
      remaining_count: result.length,
    });
  } catch (err) {
    console.error('Get player questions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/drills/questions/:questionId/answer - Submit an answer
app.post('/api/drills/questions/:questionId/answer', authenticate, async (req, res) => {
  try {
    const questionId = parseInt(req.params.questionId, 10);
    const userId = req.user.id;
    const { answer, selected_option_ids } = req.body;

    // Get the question
    const qResult = await pool.query('SELECT * FROM drill_questions WHERE id = $1', [questionId]);
    if (qResult.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }
    const question = qResult.rows[0];

    // Check existing attempts
    const existingAttempts = await pool.query(
      'SELECT * FROM player_question_responses WHERE user_id = $1 AND question_id = $2 ORDER BY attempt_number ASC',
      [userId, questionId]
    );

    if (question.input_type === 'checkbox') {
      // Checkbox: one attempt only
      if (existingAttempts.rows.length > 0) {
        return res.status(400).json({ error: 'Already answered this question' });
      }

      // Get correct options
      const optionsResult = await pool.query(
        'SELECT * FROM question_options WHERE question_id = $1 ORDER BY sort_order ASC',
        [questionId]
      );

      const selectedIds = new Set((selected_option_ids || []).map(id => parseInt(id, 10)));
      let correctSelected = 0;
      let wrongSelected = 0;
      const optionResults = [];

      for (const opt of optionsResult.rows) {
        const wasSelected = selectedIds.has(parseInt(opt.id, 10));
        const isCorrect = opt.is_correct;
        if (wasSelected && isCorrect) {
          correctSelected++;
        } else if (wasSelected && !isCorrect) {
          wrongSelected++;
        }
        optionResults.push({
          id: opt.id,
          option_text: opt.option_text,
          is_correct: isCorrect,
          was_selected: wasSelected,
        });
      }

      // Each wrong selection cancels out one correct selection
      const netCorrect = Math.max(0, correctSelected - wrongSelected);
      const pointsEarned = netCorrect * question.point_value;

      // Assign per-option points_earned for display
      for (const opt of optionResults) {
        opt.points_earned = (opt.was_selected && opt.is_correct && netCorrect > 0) ? question.point_value : 0;
      }

      // Store response
      await pool.query(
        `INSERT INTO player_question_responses (user_id, question_id, response_text, points_earned, attempt_number)
         VALUES ($1, $2, $3, $4, 1)`,
        [userId, questionId, JSON.stringify(selected_option_ids), pointsEarned]
      );

      return res.json({
        correct: null, // checkbox doesn't have simple correct/wrong
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
    // Also block if they already got it right
    if (existingAttempts.rows.length === 1 && existingAttempts.rows[0].points_earned > 0) {
      return res.status(400).json({ error: 'Already answered correctly' });
    }

    let isCorrect = false;

    if (question.input_type === 'text') {
      if (question.min_char_count != null) {
        // Min char count mode: any answer with enough characters is correct
        isCorrect = (answer || '').trim().length >= question.min_char_count;
      } else {
        // Text: compare against acceptable answers (case-insensitive, trim)
        const acceptableResult = await pool.query(
          'SELECT answer_text FROM question_acceptable_answers WHERE question_id = $1',
          [questionId]
        );
        const normalizedAnswer = (answer || '').trim().toLowerCase().replace(/\s+/g, ' ');
        isCorrect = acceptableResult.rows.some(
          a => a.answer_text.trim().toLowerCase().replace(/\s+/g, ' ') === normalizedAnswer
        );
      }
    } else if (question.input_type === 'radio') {
      // Radio: check if selected option is correct
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
        ? question.point_value
        : Math.floor(question.point_value / 2);
    }

    // Store response
    await pool.query(
      `INSERT INTO player_question_responses (user_id, question_id, response_text, points_earned, attempt_number)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, questionId, answer || JSON.stringify(selected_option_ids), pointsEarned, attemptNumber]
    );

    const responseData = {
      correct: isCorrect,
      points_earned: pointsEarned,
      attempts_used: attemptNumber,
    };

    if (!isCorrect && attemptNumber === 1) {
      responseData.message = 'Not quite, give it another shot!';
      responseData.can_retry = true;
    } else if (!isCorrect && attemptNumber === 2) {
      // Show correct answer
      if (question.input_type === 'text') {
        if (question.min_char_count != null) {
          responseData.correct_answers = [`Answer must be at least ${question.min_char_count} characters`];
        } else {
          const acceptableResult = await pool.query(
            'SELECT answer_text FROM question_acceptable_answers WHERE question_id = $1',
            [questionId]
          );
          responseData.correct_answers = acceptableResult.rows.map(a => a.answer_text);
        }
      } else if (question.input_type === 'radio') {
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

// GET /api/leaderboard
app.get('/api/leaderboard', authenticate, async (req, res) => {
  try {
    // Get the active season
    const seasonResult = await pool.query('SELECT * FROM seasons WHERE active = true LIMIT 1');
    if (seasonResult.rows.length === 0) {
      return res.json({ season: null, players: [] });
    }

    const season = seasonResult.rows[0];

    // Get all active players
    const playersResult = await pool.query(
      `SELECT id, first_name, last_name, avatar_color
       FROM users
       WHERE role = 'player' AND active = true`
    );

    // Get latest badge emoji for each player in one query
    const latestBadgesResult = await pool.query(
      `SELECT DISTINCT ON (ub.user_id) ub.user_id, b.icon_emoji
       FROM user_badges ub
       JOIN badges b ON b.id = ub.badge_id
       ORDER BY ub.user_id, ub.earned_at DESC`
    );
    const latestBadgeMap = {};
    for (const row of latestBadgesResult.rows) {
      latestBadgeMap[row.user_id] = row.icon_emoji;
    }

    // Calculate points, completions, streak, and level for each player
    const endDate = effectiveEndDate(season);
    const players = [];
    for (const player of playersResult.rows) {
      const { totalPoints, totalCompletions } = await calculatePlayerPoints(player.id, season.start_date, endDate);
      const current_streak = await calculateCurrentStreak(player.id, season.start_date, endDate);
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

    // Sort by points DESC, then completions DESC
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

// GET /api/me/stats
app.get('/api/me/stats', authenticate, async (req, res) => {
  try {
    // Get the active season
    const seasonResult = await pool.query('SELECT * FROM seasons WHERE active = true LIMIT 1');
    if (seasonResult.rows.length === 0) {
      return res.json({
        current_streak: 0,
        longest_streak: 0,
        total_completions: 0,
        total_points: 0,
        extra_count: 0,
        level: getLevelInfo(0),
      });
    }

    const season = seasonResult.rows[0];
    const endDate = effectiveEndDate(season);

    const { totalPoints, totalCompletions, extraCount } = await calculatePlayerPoints(req.user.id, season.start_date, endDate);
    const currentStreak = await calculateCurrentStreak(req.user.id, season.start_date, endDate);
    const longestStreak = await calculateLongestStreak(req.user.id, season.start_date, endDate);

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

// GET /api/me/badges
app.get('/api/me/badges', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, ub.earned_at
       FROM badges b
       LEFT JOIN user_badges ub ON ub.badge_id = b.id AND ub.user_id = $1
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

// GET /api/admin/players
app.get('/api/admin/players', authenticate, requireCoach, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, first_name, last_name, avatar_color, active, created_at
       FROM users
       WHERE role = 'player'
       ORDER BY last_name ASC`
    );

    // Get latest badge emoji for each player
    const latestBadgesResult = await pool.query(
      `SELECT DISTINCT ON (ub.user_id) ub.user_id, b.icon_emoji
       FROM user_badges ub
       JOIN badges b ON b.id = ub.badge_id
       ORDER BY ub.user_id, ub.earned_at DESC`
    );
    const latestBadgeMap = {};
    for (const row of latestBadgesResult.rows) {
      latestBadgeMap[row.user_id] = row.icon_emoji;
    }

    // Get active season for level calculation
    const seasonResult = await pool.query('SELECT * FROM seasons WHERE active = true LIMIT 1');
    const season = seasonResult.rows[0] || null;

    const players = [];
    for (const player of result.rows) {
      let level = getLevelInfo(0);
      if (season) {
        const endDate = effectiveEndDate(season);
        const { totalPoints } = await calculatePlayerPoints(player.id, season.start_date, endDate);
        level = getLevelInfo(totalPoints);
      }
      players.push({
        ...player,
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

// POST /api/admin/players
app.post('/api/admin/players', authenticate, requireCoach, async (req, res) => {
  try {
    const { first_name, last_name, username, password } = req.body;
    if (!first_name || !last_name || !username || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (first_name, last_name, username, password_hash, role)
       VALUES ($1, $2, $3, $4, 'player')
       RETURNING id, username, first_name, last_name, avatar_color, active, created_at`,
      [first_name, last_name, username, passwordHash]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('Create player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/players/:id/deactivate
app.put('/api/admin/players/:id/deactivate', authenticate, requireCoach, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users SET active = false WHERE id = $1 AND role = 'player'
       RETURNING id, username, first_name, last_name, active`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Deactivate player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/players/:id/activate
app.put('/api/admin/players/:id/activate', authenticate, requireCoach, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users SET active = true WHERE id = $1 AND role = 'player'
       RETURNING id, username, first_name, last_name, active`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Activate player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/players/:id/reset-password
app.put('/api/admin/players/:id/reset-password', authenticate, requireCoach, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2
       RETURNING id, username, first_name, last_name`,
      [passwordHash, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/players/:id
app.delete('/api/admin/players/:id', authenticate, requireCoach, async (req, res) => {
  try {
    // Delete related data first
    await pool.query('DELETE FROM player_question_responses WHERE user_id = $1', [req.params.id]);
    await pool.query('DELETE FROM user_badges WHERE user_id = $1', [req.params.id]);
    await pool.query('DELETE FROM completions WHERE user_id = $1', [req.params.id]);

    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 AND role = 'player' RETURNING id",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json({ message: 'Player deleted' });
  } catch (err) {
    console.error('Delete player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Drills ---

// GET /api/admin/drills
app.get('/api/admin/drills', authenticate, requireCoach, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM drills ORDER BY date DESC'
    );
    res.json({ drills: result.rows });
  } catch (err) {
    console.error('List drills error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/drills
app.post('/api/admin/drills', authenticate, requireCoach, async (req, res) => {
  try {
    const { date, title, description, youtube_url, target_time, points_completion, points_extra, is_challenge } = req.body;
    if (!date || !title) {
      return res.status(400).json({ error: 'Date and title are required' });
    }

    const result = await pool.query(
      `INSERT INTO drills (date, title, description, youtube_url, target_time, points_completion, points_extra, is_challenge, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [date, title, description || null, youtube_url || null, target_time ? parseInt(target_time, 10) : null, points_completion ? parseInt(points_completion, 10) : 10, points_extra ? parseInt(points_extra, 10) : 5, is_challenge || false, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A drill already exists for this date' });
    }
    console.error('Create drill error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/drills/:id
app.put('/api/admin/drills/:id', authenticate, requireCoach, async (req, res) => {
  try {
    const { date, title, description, youtube_url, target_time, points_completion, points_extra, is_challenge } = req.body;

    const result = await pool.query(
      `UPDATE drills
       SET date = COALESCE($1, date),
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           youtube_url = COALESCE($4, youtube_url),
           target_time = $5,
           points_completion = COALESCE($6, 10),
           points_extra = COALESCE($7, 5),
           is_challenge = $8
       WHERE id = $9
       RETURNING *`,
      [date || null, title || null, description || null, youtube_url || null, target_time ? parseInt(target_time, 10) : null, points_completion ? parseInt(points_completion, 10) : null, points_extra ? parseInt(points_extra, 10) : null, is_challenge || false, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drill not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A drill already exists for this date' });
    }
    console.error('Update drill error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/drills/:id
app.delete('/api/admin/drills/:id', authenticate, requireCoach, async (req, res) => {
  try {
    // Delete associated completions first (in case ON DELETE CASCADE is not set)
    await pool.query('DELETE FROM completions WHERE drill_id = $1', [req.params.id]);

    const result = await pool.query(
      'DELETE FROM drills WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drill not found' });
    }

    res.json({ message: 'Drill deleted successfully' });
  } catch (err) {
    console.error('Delete drill error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Drill Questions ---

// GET /api/admin/drills/:id/questions
app.get('/api/admin/drills/:id/questions', authenticate, requireCoach, async (req, res) => {
  try {
    const drillId = parseInt(req.params.id, 10);
    const questions = await pool.query(
      'SELECT * FROM drill_questions WHERE drill_id = $1 ORDER BY sort_order ASC',
      [drillId]
    );

    const result = [];
    for (const q of questions.rows) {
      const questionData = { ...q, options: [], acceptable_answers: [] };
      if (q.input_type === 'radio' || q.input_type === 'checkbox') {
        const opts = await pool.query(
          'SELECT * FROM question_options WHERE question_id = $1 ORDER BY sort_order ASC',
          [q.id]
        );
        questionData.options = opts.rows;
      } else if (q.input_type === 'text') {
        const answers = await pool.query(
          'SELECT * FROM question_acceptable_answers WHERE question_id = $1',
          [q.id]
        );
        questionData.acceptable_answers = answers.rows;
      }
      result.push(questionData);
    }

    res.json({ questions: result });
  } catch (err) {
    console.error('Get drill questions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/drills/:id/questions
app.put('/api/admin/drills/:id/questions', authenticate, requireCoach, async (req, res) => {
  const client = await pool.connect();
  try {
    const drillId = parseInt(req.params.id, 10);
    const { questions } = req.body;

    if (!Array.isArray(questions)) {
      return res.status(400).json({ error: 'Questions must be an array' });
    }
    if (questions.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 questions per drill' });
    }

    await client.query('BEGIN');

    // Get existing question IDs for this drill
    const existing = await client.query(
      'SELECT id FROM drill_questions WHERE drill_id = $1',
      [drillId]
    );
    const existingIds = new Set(existing.rows.map(r => r.id));
    const incomingIds = new Set(questions.filter(q => q.id).map(q => q.id));

    // Delete questions that were removed by the coach
    for (const existId of existingIds) {
      if (!incomingIds.has(existId)) {
        await client.query('DELETE FROM drill_questions WHERE id = $1', [existId]);
      }
    }

    // Upsert questions
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      let questionId;

      if (q.id && existingIds.has(q.id)) {
        // Update existing question
        await client.query(
          `UPDATE drill_questions SET question_text = $1, input_type = $2, point_value = $3, sort_order = $4, min_char_count = $5
           WHERE id = $6`,
          [q.question_text, q.input_type, parseInt(q.point_value, 10) || 1, i, q.min_char_count != null ? parseInt(q.min_char_count, 10) : null, q.id]
        );
        questionId = q.id;
      } else {
        // Insert new question
        const insertResult = await client.query(
          `INSERT INTO drill_questions (drill_id, question_text, input_type, point_value, sort_order, min_char_count)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [drillId, q.question_text, q.input_type, parseInt(q.point_value, 10) || 1, i, q.min_char_count != null ? parseInt(q.min_char_count, 10) : null]
        );
        questionId = insertResult.rows[0].id;
      }

      // Replace options for radio/checkbox
      if (q.input_type === 'radio' || q.input_type === 'checkbox') {
        await client.query('DELETE FROM question_options WHERE question_id = $1', [questionId]);
        if (q.options && q.options.length > 0) {
          for (let j = 0; j < q.options.length; j++) {
            const opt = q.options[j];
            await client.query(
              `INSERT INTO question_options (question_id, option_text, is_correct, sort_order)
               VALUES ($1, $2, $3, $4)`,
              [questionId, opt.option_text, opt.is_correct || false, j]
            );
          }
        }
      }

      // Replace acceptable answers for text
      if (q.input_type === 'text') {
        await client.query('DELETE FROM question_acceptable_answers WHERE question_id = $1', [questionId]);
        if (q.acceptable_answers && q.acceptable_answers.length > 0) {
          for (const ans of q.acceptable_answers) {
            const ansText = typeof ans === 'string' ? ans : ans.answer_text;
            await client.query(
              `INSERT INTO question_acceptable_answers (question_id, answer_text)
               VALUES ($1, $2)`,
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

// GET /api/admin/seasons
app.get('/api/admin/seasons', authenticate, requireCoach, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM seasons ORDER BY start_date DESC'
    );
    res.json({ seasons: result.rows });
  } catch (err) {
    console.error('List seasons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/seasons
app.post('/api/admin/seasons', authenticate, requireCoach, async (req, res) => {
  try {
    const { name, start_date, end_date } = req.body;
    if (!name || !start_date || !end_date) {
      return res.status(400).json({ error: 'Name, start_date, and end_date are required' });
    }

    const result = await pool.query(
      `INSERT INTO seasons (name, start_date, end_date, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, start_date, end_date, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create season error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/seasons/:id
app.put('/api/admin/seasons/:id', authenticate, requireCoach, async (req, res) => {
  try {
    const { name, start_date, end_date } = req.body;

    const result = await pool.query(
      `UPDATE seasons
       SET name = COALESCE($1, name),
           start_date = COALESCE($2, start_date),
           end_date = COALESCE($3, end_date)
       WHERE id = $4
       RETURNING *`,
      [name || null, start_date || null, end_date || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Season not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update season error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/seasons/:id/activate
app.put('/api/admin/seasons/:id/activate', authenticate, requireCoach, async (req, res) => {
  try {
    // Deactivate all seasons first
    await pool.query('UPDATE seasons SET active = false');

    // Activate the specified season
    const result = await pool.query(
      'UPDATE seasons SET active = true WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Season not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Activate season error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/seasons/:id
app.delete('/api/admin/seasons/:id', authenticate, requireCoach, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM seasons WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Season not found' });
    }

    res.json({ message: 'Season deleted' });
  } catch (err) {
    console.error('Delete season error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Coaches ---

// POST /api/admin/coaches
app.post('/api/admin/coaches', authenticate, requireCoach, async (req, res) => {
  try {
    const { first_name, last_name, username, password } = req.body;
    if (!first_name || !last_name || !username || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (first_name, last_name, username, password_hash, role)
       VALUES ($1, $2, $3, $4, 'coach')
       RETURNING id, username, first_name, last_name, role, active, created_at`,
      [first_name, last_name, username, passwordHash]
    );

    res.status(201).json({ coach: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('Create coach error:', err);
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
// DATABASE AUTO-INIT
// ============================================================

async function runMigrations() {
  try {
    // Add target_time column to drills if it doesn't exist
    const col = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'drills' AND column_name = 'target_time'"
    );
    if (col.rows.length === 0) {
      await pool.query('ALTER TABLE drills ADD COLUMN target_time INTEGER');
      console.log('Migration: added target_time column to drills.');
    }
    // Add points_completion and points_extra columns to drills if they don't exist
    const pcol = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'drills' AND column_name = 'points_completion'"
    );
    if (pcol.rows.length === 0) {
      await pool.query('ALTER TABLE drills ADD COLUMN points_completion INTEGER DEFAULT 10');
      await pool.query('ALTER TABLE drills ADD COLUMN points_extra INTEGER DEFAULT 5');
      console.log('Migration: added points_completion and points_extra columns to drills.');
    }
    // Add is_challenge column to drills if it doesn't exist
    const ccol = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'drills' AND column_name = 'is_challenge'"
    );
    if (ccol.rows.length === 0) {
      await pool.query('ALTER TABLE drills ADD COLUMN is_challenge BOOLEAN DEFAULT false');
      console.log('Migration: added is_challenge column to drills.');
    }
    // Insert new badges if they don't exist
    const newBadges = [
      ['perfect-week',      'Perfect Week',      'Complete every drill in a week',  '📅'],
      ['perfect-month',     'Perfect Month',     'Complete every drill in a month', '🗓️'],
      ['challenge-accepted','Challenge Accepted', 'Complete 5 challenge drills',    '💪'],
      ['challenge-master',  'Challenge Master',  'Complete 20 challenge drills',    '🏆'],
      ['weekly-winner',     'Weekly Winner',     'Most points in a completed week', '👑'],
      ['extra-effort-20',   'Extra Effort x20',  'Log extra time 20 times',        '🌟'],
      ['200-club',          '200 Club',          'Earn 200 points',                '🥉'],
      ['500-club',          '500 Club',          'Earn 500 points',                '🥈'],
      ['1000-club',         '1000 Club',         'Earn 1000 points',               '🥇'],
      ['2000-club',         '2000 Club',         'Earn 2000 points',               '💎'],
      ['3000-club',         '3000 Club',         'Earn 3000 points',               '💍'],
      ['5000-club',         '5000 Club',         'Earn 5000 points',               '🏅'],
      ['10000-club',        '10000 Club',        'Earn 10000 points',              '🌠'],
    ];
    for (const [slug, name, description, emoji] of newBadges) {
      await pool.query(
        `INSERT INTO badges (slug, name, description, icon_emoji)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO NOTHING`,
        [slug, name, description, emoji]
      );
    }
    console.log('Migration: ensured all badges exist.');
    // Remove deprecated extra-effort-5 badge (duplicate of above-and-beyond)
    await pool.query(`DELETE FROM user_badges WHERE badge_id IN (SELECT id FROM badges WHERE slug = 'extra-effort-5')`);
    await pool.query(`DELETE FROM badges WHERE slug = 'extra-effort-5'`);
    // Update weekly-winner description if stale
    await pool.query(`UPDATE badges SET description = 'Most points in a completed week' WHERE slug = 'weekly-winner'`);

    // Create quiz/questions tables if they don't exist
    const dqTable = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'drill_questions'"
    );
    if (dqTable.rows.length === 0) {
      await pool.query(`
        CREATE TABLE drill_questions (
          id SERIAL PRIMARY KEY,
          drill_id INTEGER REFERENCES drills(id) ON DELETE CASCADE NOT NULL,
          question_text TEXT NOT NULL,
          input_type VARCHAR(20) NOT NULL CHECK (input_type IN ('text', 'radio', 'checkbox')),
          point_value INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0
        )
      `);
      await pool.query(`
        CREATE TABLE question_options (
          id SERIAL PRIMARY KEY,
          question_id INTEGER REFERENCES drill_questions(id) ON DELETE CASCADE NOT NULL,
          option_text VARCHAR(500) NOT NULL,
          is_correct BOOLEAN DEFAULT false,
          sort_order INTEGER NOT NULL DEFAULT 0
        )
      `);
      await pool.query(`
        CREATE TABLE question_acceptable_answers (
          id SERIAL PRIMARY KEY,
          question_id INTEGER REFERENCES drill_questions(id) ON DELETE CASCADE NOT NULL,
          answer_text VARCHAR(500) NOT NULL
        )
      `);
      await pool.query(`
        CREATE TABLE player_question_responses (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
          question_id INTEGER REFERENCES drill_questions(id) ON DELETE CASCADE NOT NULL,
          response_text TEXT,
          points_earned INTEGER NOT NULL DEFAULT 0,
          attempt_number INTEGER NOT NULL DEFAULT 1,
          answered_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, question_id, attempt_number)
        )
      `);
      console.log('Migration: created quiz/questions tables.');
    }

    // Add min_char_count column to drill_questions if it doesn't exist
    const mccCol = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'drill_questions' AND column_name = 'min_char_count'"
    );
    if (mccCol.rows.length === 0) {
      await pool.query('ALTER TABLE drill_questions ADD COLUMN min_char_count INTEGER');
      console.log('Migration: added min_char_count column to drill_questions.');
    }
  } catch (err) {
    console.error('Migration error:', err);
  }
}

async function initDatabase() {
  try {
    // Check if tables already exist (skip unless RESET_DB is set)
    if (!process.env.RESET_DB) {
      const check = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users')"
      );
      if (check.rows[0].exists) {
        console.log('Database tables already exist, skipping init.');
        // Run migrations for existing databases
        await runMigrations();
        return;
      }
    } else {
      console.log('RESET_DB is set — forcing re-init...');
    }

    console.log('Running schema and seed...');

    const schemaPath = path.join(__dirname, '../db/schema.sql');
    const seedPath = path.join(__dirname, '../db/seed.sql');

    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const seedSql = fs.readFileSync(seedPath, 'utf8');

    await pool.query(schemaSql);
    console.log('Schema created.');

    await pool.query(seedSql);
    console.log('Seed data inserted.');

    console.log('Database initialization complete.');
  } catch (err) {
    console.error('Database init error:', err);
    // Don't crash — the app may still work if tables were partially created
  }
}

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3001;

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Daily Reps Training server running on port ${PORT}`);
  });
});
