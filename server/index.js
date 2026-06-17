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

  // Perfect week bonus: for each Mon-Sun calendar week that has at least
  // one scheduled drill, if ALL drills in that week are completed, +10 pts
  const weekMap = {};
  for (const drill of drills) {
    const d = drill.date instanceof Date ? drill.date : new Date(drill.date);
    const day = d.getUTCDay(); // 0=Sun, 1=Mon ...
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + mondayOffset);
    const weekKey = monday.toISOString().split('T')[0];

    if (!weekMap[weekKey]) weekMap[weekKey] = { total: 0, completed: 0 };
    weekMap[weekKey].total++;
    if (drill.completion_id) weekMap[weekKey].completed++;
  }

  for (const week of Object.values(weekMap)) {
    if (week.total > 0 && week.completed === week.total) {
      totalPoints += 10;
    }
  }

  return { totalPoints, totalCompletions, extraCount };
}

// ============================================================
// BADGE CHECKING HELPER
// ============================================================

async function checkAndAwardBadges(userId) {
  const seasonResult = await pool.query('SELECT * FROM seasons WHERE active = true LIMIT 1');
  const season = seasonResult.rows[0];
  if (!season) return;

  const { totalPoints, totalCompletions, extraCount } = await calculatePlayerPoints(userId, season.start_date, season.end_date);
  const currentStreak = await calculateCurrentStreak(userId, season.start_date, season.end_date);

  const badgeCriteria = [
    { slug: 'first-touch', condition: totalCompletions >= 1 },
    { slug: 'hat-trick', condition: totalCompletions >= 3 },
    { slug: 'double-digits', condition: totalCompletions >= 10 },
    { slug: 'week-warrior', condition: currentStreak >= 7 },
    { slug: 'above-and-beyond', condition: extraCount >= 5 },
    { slug: 'century', condition: totalPoints >= 100 },
  ];

  for (const badge of badgeCriteria) {
    if (badge.condition) {
      await pool.query(
        `INSERT INTO user_badges (user_id, badge_id)
         SELECT $1, b.id FROM badges b WHERE b.slug = $2
         ON CONFLICT DO NOTHING`,
        [userId, badge.slug]
      );
    }
  }
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

    // Check and award badges after completion
    await checkAndAwardBadges(req.user.id);

    res.json({ completion: result.rows[0] });
  } catch (err) {
    console.error('Complete drill error:', err);
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

    // Calculate points, completions, and streak for each player
    const players = [];
    for (const player of playersResult.rows) {
      const { totalPoints, totalCompletions } = await calculatePlayerPoints(player.id, season.start_date, season.end_date);
      const current_streak = await calculateCurrentStreak(player.id, season.start_date, season.end_date);
      players.push({
        id: player.id,
        first_name: player.first_name,
        last_name: player.last_name,
        avatar_color: player.avatar_color,
        completions: totalCompletions,
        points: totalPoints,
        current_streak,
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
      });
    }

    const season = seasonResult.rows[0];

    const { totalPoints, totalCompletions, extraCount } = await calculatePlayerPoints(req.user.id, season.start_date, season.end_date);
    const currentStreak = await calculateCurrentStreak(req.user.id, season.start_date, season.end_date);
    const longestStreak = await calculateLongestStreak(req.user.id, season.start_date, season.end_date);

    res.json({
      current_streak: currentStreak,
      longest_streak: longestStreak,
      total_completions: totalCompletions,
      total_points: totalPoints,
      extra_count: extraCount,
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
    res.json({ players: result.rows });
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
    console.log(`Fusion FC Training server running on port ${PORT}`);
  });
});
