-- Fusion FC Training - Database Schema
-- PostgreSQL

-- Drop tables in reverse dependency order if they exist
DROP TABLE IF EXISTS user_badges CASCADE;
DROP TABLE IF EXISTS badges CASCADE;
DROP TABLE IF EXISTS completions CASCADE;
DROP TABLE IF EXISTS drills CASCADE;
DROP TABLE IF EXISTS seasons CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Users table: players and coaches
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(10) NOT NULL CHECK (role IN ('player', 'coach')),
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    avatar_color VARCHAR(7) DEFAULT '#f77c00',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    active BOOLEAN DEFAULT true
);

-- Drills table: one drill per day
CREATE TABLE drills (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    youtube_url VARCHAR(500),
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Completions table: tracks which players completed which drills
CREATE TABLE completions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) NOT NULL,
    drill_id INTEGER REFERENCES drills(id) NOT NULL,
    completed_at TIMESTAMPTZ DEFAULT NOW(),
    did_extra BOOLEAN DEFAULT false,
    UNIQUE(user_id, drill_id)
);

-- Badges table: definitions of earnable badges
CREATE TABLE badges (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon_emoji VARCHAR(10)
);

-- User badges table: tracks which players earned which badges
CREATE TABLE user_badges (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) NOT NULL,
    badge_id INTEGER REFERENCES badges(id) NOT NULL,
    earned_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, badge_id)
);

-- Seasons table: training seasons
CREATE TABLE seasons (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    active BOOLEAN DEFAULT false,
    created_by INTEGER REFERENCES users(id)
);
