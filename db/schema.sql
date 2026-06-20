-- Daily Reps - Multi-Tenant Database Schema (Build 1)
-- PostgreSQL with UUID primary keys
-- This file is for reference only. Migrations run automatically via server/index.js on startup.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Clubs
CREATE TABLE clubs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'trial')),
    subscription_status VARCHAR(50),
    plan VARCHAR(50),
    stripe_customer_id VARCHAR(200),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Teams
CREATE TABLE teams (
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

-- Users (staff: super_admin, club_admin, coach)
CREATE TABLE users (
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

-- Coach-Team many-to-many
CREATE TABLE coach_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    team_id UUID REFERENCES teams(id) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, team_id)
);

-- Players (durable identity)
CREATE TABLE players (
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

-- Seasons
CREATE TABLE seasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) NOT NULL,
    name VARCHAR(200) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'archived' CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Player Season Stats
CREATE TABLE player_season_stats (
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

-- Drills
CREATE TABLE drills (
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

-- Completions
CREATE TABLE completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id UUID REFERENCES players(id) NOT NULL,
    drill_id UUID REFERENCES drills(id) NOT NULL,
    completed_at TIMESTAMPTZ DEFAULT NOW(),
    did_extra BOOLEAN DEFAULT false,
    points_earned INTEGER DEFAULT 0,
    UNIQUE(player_id, drill_id)
);

-- Questions
CREATE TABLE questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    drill_id UUID REFERENCES drills(id) ON DELETE CASCADE NOT NULL,
    question_text TEXT NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('text', 'radio', 'checkbox')),
    points INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Question Options
CREATE TABLE question_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID REFERENCES questions(id) ON DELETE CASCADE NOT NULL,
    option_text VARCHAR(500) NOT NULL,
    is_correct BOOLEAN DEFAULT false,
    position INTEGER NOT NULL DEFAULT 0
);

-- Question Text Answers
CREATE TABLE question_text_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID REFERENCES questions(id) ON DELETE CASCADE NOT NULL,
    acceptable_answer TEXT NOT NULL
);

-- Question Responses
CREATE TABLE question_responses (
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

-- Levels (global config)
CREATE TABLE levels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    threshold INTEGER NOT NULL,
    shield_color VARCHAR(20) NOT NULL,
    text_color VARCHAR(20) NOT NULL,
    sort_order INTEGER NOT NULL,
    is_prestige BOOLEAN DEFAULT false
);

-- Badges (global config)
CREATE TABLE badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon_emoji VARCHAR(10)
);

-- Player Badges
CREATE TABLE player_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id UUID REFERENCES players(id) NOT NULL,
    badge_id UUID REFERENCES badges(id) NOT NULL,
    earned_at TIMESTAMPTZ DEFAULT NOW(),
    season_id UUID REFERENCES seasons(id),
    UNIQUE(player_id, badge_id)
);
