-- Fusion FC Training - Seed Data
-- Run after schema.sql

-- ============================================================
-- Badges
-- ============================================================
INSERT INTO badges (slug, name, description, icon_emoji) VALUES
    ('first-touch',      'First Touch',      'Complete your first drill',   '⚽'),
    ('hat-trick',        'Hat Trick',         'Complete 3 drills',           '🎩'),
    ('week-warrior',     'Week Warrior',      '7-day streak',               '🔥'),
    ('double-digits',    'Double Digits',     '10 completions total',       '🔟'),
    ('above-and-beyond', 'Above and Beyond',  'Do extra time 5 times',      '⭐'),
    ('century',          'Century',           'Earn 100 points',            '💯');

-- ============================================================
-- Users
-- ============================================================

-- Coach
INSERT INTO users (username, password_hash, role, first_name, last_name) VALUES
    ('coach_matt', '$2b$10$LQ0wMxJgL8VPmMnSYmLOr.NBmGmYX7RCYFtmgOFnmLSPqXBHMbAMu', 'coach', 'Matt', 'Williams');

-- Players
INSERT INTO users (username, password_hash, role, first_name, last_name) VALUES
    ('alex_j',    '$2b$10$LQ0wMxJgL8VPmMnSYmLOr.NFmGmYX7RCYFtmgOFnmLSPqXBHMbAMu', 'player', 'Alex',   'Johnson'),
    ('sam_r',     '$2b$10$LQ0wMxJgL8VPmMnSYmLOr.NFmGmYX7RCYFtmgOFnmLSPqXBHMbAMu', 'player', 'Sam',    'Rodriguez'),
    ('jordan_k',  '$2b$10$LQ0wMxJgL8VPmMnSYmLOr.NFmGmYX7RCYFtmgOFnmLSPqXBHMbAMu', 'player', 'Jordan', 'Kim'),
    ('taylor_m',  '$2b$10$LQ0wMxJgL8VPmMnSYmLOr.NFmGmYX7RCYFtmgOFnmLSPqXBHMbAMu', 'player', 'Taylor', 'Martinez');

-- ============================================================
-- Drills (scheduled for today, tomorrow, and day after tomorrow)
-- ============================================================
INSERT INTO drills (date, title, description, youtube_url, created_by) VALUES
    (
        CURRENT_DATE,
        'Ball Mastery: Close Control Drills',
        'Work on your first touch and close ball control with these cone weaving exercises. Focus on using both feet and keeping the ball within playing distance at all times. Aim for 3 sets of 10 reps.',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
        1
    ),
    (
        CURRENT_DATE + INTERVAL '1 day',
        'Passing Accuracy: Wall Pass Combos',
        'Sharpen your short and medium-range passing with wall pass combinations. Practice one-touch and two-touch passing patterns. Work on both inside-of-foot and outside-of-foot technique.',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
        1
    ),
    (
        CURRENT_DATE + INTERVAL '2 days',
        'Shooting Technique: Finishing Under Pressure',
        'Practice striking the ball cleanly with power and placement. Set up cones as defenders and work on quick turns before shooting. Focus on planting your non-kicking foot beside the ball and following through.',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
        1
    );

-- ============================================================
-- Seasons
-- ============================================================
INSERT INTO seasons (name, start_date, end_date, active, created_by) VALUES
    ('Summer 2025', '2025-06-01', '2025-08-31', true,  1),
    ('Fall 2025',   '2025-09-01', '2025-12-15', false, 1);
