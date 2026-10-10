-- Phase 5: Enhanced profiles, exchange workflow, notifications, messaging, history, org verification
-- Run this against an existing v1 database to add all new features.
-- This migration is ADDITIVE only — no breaking changes to existing tables.

-- =====================================================================
-- 1. USERS — add profile, organisation, contact, location, privacy fields
-- =====================================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS organisation_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS organisation_type VARCHAR(40)
    CHECK (organisation_type IN ('individual', 'college', 'ngo', 'company', 'community_organisation')),
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_privacy VARCHAR(20) NOT NULL DEFAULT 'APPROXIMATE'
    CHECK (location_privacy IN ('exact', 'approximate', 'none')),
  ADD COLUMN IF NOT EXISTS organisation_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS profile_picture_url TEXT;

-- Backfill existing users with defaults
UPDATE users SET location_privacy = 'APPROXIMATE' WHERE location_privacy IS NULL;
UPDATE users SET organisation_verified = FALSE WHERE organisation_verified IS NULL;

CREATE INDEX IF NOT EXISTS users_organisation_verified_idx ON users (organisation_verified);

-- =====================================================================
-- 2. RESOURCES — add condition_enum, availability_date, coordinates
-- =====================================================================
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS condition_enum VARCHAR(10) NOT NULL DEFAULT 'GOOD'
    CHECK (condition_enum IN ('POOR', 'FAIR', 'GOOD', 'EXCELLENT', 'NEW')),
  ADD COLUMN IF NOT EXISTS availability_date DATE,
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

-- Backfill existing resources
UPDATE resources SET condition_enum = 'GOOD' WHERE condition_enum IS NULL;

-- Map old text 'condition' to enum where possible (case-insensitive)
UPDATE resources SET condition_enum = 'POOR' WHERE condition_enum IS NULL AND LOWER(condition) LIKE '%poor%';
UPDATE resources SET condition_enum = 'FAIR' WHERE condition_enum IS NULL AND LOWER(condition) LIKE '%fair%';
UPDATE resources SET condition_enum = 'GOOD' WHERE condition_enum IS NULL AND LOWER(condition) LIKE '%good%';
UPDATE resources SET condition_enum = 'EXCELLENT' WHERE condition_enum IS NULL AND LOWER(condition) LIKE '%excellent%';
UPDATE resources SET condition_enum = 'NEW' WHERE condition_enum IS NULL AND LOWER(condition) LIKE '%new%';

CREATE INDEX IF NOT EXISTS resources_latitude_idx ON resources (latitude);
CREATE INDEX IF NOT EXISTS resources_longitude_idx ON resources (longitude);

-- =====================================================================
-- 3. EXCHANGES — new core tables for resource-for-resource transactions
-- =====================================================================
CREATE TABLE IF NOT EXISTS exchanges (
  id BIGSERIAL PRIMARY KEY,
  initiator_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED', 'COUNTERED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'CANCELLED')),
  message TEXT,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT exchanges_initiator_recipient_check CHECK (initiator_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS exchanges_initiator_id_idx ON exchanges (initiator_id);
CREATE INDEX IF NOT EXISTS exchanges_recipient_id_idx ON exchanges (recipient_id);
CREATE INDEX IF NOT EXISTS exchanges_status_idx ON exchanges (status);

CREATE TABLE IF NOT EXISTS exchange_resources (
  id BIGSERIAL PRIMARY KEY,
  exchange_id BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  side VARCHAR(10) NOT NULL
    CHECK (side IN ('offered', 'requested')),
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  quantity_fulfilled INTEGER NOT NULL DEFAULT 0
    CHECK (quantity_fulfilled >= 0 AND quantity_fulfilled <= quantity),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT exchange_resources_unique_side UNIQUE (exchange_id, side)
);

CREATE INDEX IF NOT EXISTS exchange_resources_exchange_id_idx ON exchange_resources (exchange_id);
CREATE INDEX IF NOT EXISTS exchange_resources_resource_id_idx ON exchange_resources (resource_id);

-- Prevent double allocation in active exchanges
CREATE UNIQUE INDEX IF NOT EXISTS exchange_resources_active_unique
  ON exchange_resources (resource_id)
  WHERE resource_id IN (
    SELECT er.resource_id
    FROM exchange_resources er
    JOIN exchanges e ON e.id = er.exchange_id
    WHERE e.status IN ('PROPOSED', 'COUNTERED', 'ACCEPTED', 'IN_PROGRESS')
  );

-- =====================================================================
-- 4. NOTIFICATIONS — persistent in-app notification centre
-- =====================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,
  related_id BIGINT,
  related_type VARCHAR(20),
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, is_read)
  WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS notifications_user_all_idx
  ON notifications (user_id, created_at DESC);

-- =====================================================================
-- 5. MESSAGES — transaction-based messaging
-- =====================================================================
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  exchange_id BIGINT REFERENCES exchanges(id) ON DELETE CASCADE,
  request_id BIGINT REFERENCES requests(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  CONSTRAINT messages_exchange_or_request_check
    CHECK (
      (exchange_id IS NOT NULL AND request_id IS NULL)
      OR (exchange_id IS NULL AND request_id IS NOT NULL)
      OR (exchange_id IS NULL AND request_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS messages_exchange_id_idx ON messages (exchange_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_request_id_idx ON messages (request_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_sender_id_idx ON messages (sender_id, sent_at);

-- =====================================================================
-- 6. RESOURCE HISTORY — audit trail for traceability
-- =====================================================================
CREATE TABLE IF NOT EXISTS resource_history (
  id BIGSERIAL PRIMARY KEY,
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  action VARCHAR(30) NOT NULL,
  performed_by BIGINT NOT NULL REFERENCES users(id),
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB,
  resource_snapshot JSONB
);

CREATE INDEX IF NOT EXISTS resource_history_resource_id_idx ON resource_history (resource_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS resource_history_action_idx ON resource_history (action);

-- =====================================================================
-- 7. ORGANISATION VERIFICATIONS — manual admin approval
-- =====================================================================
CREATE TABLE IF NOT EXISTS organisation_verifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_by BIGINT REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  document_type VARCHAR(40),
  document_reference TEXT,
  notes TEXT,
  expires_at DATE
);

CREATE UNIQUE INDEX IF NOT EXISTS organisation_verifications_user_unique
  ON organisation_verifications (user_id)
  WHERE expires_at IS NULL OR expires_at > CURRENT_DATE;

CREATE INDEX IF NOT EXISTS organisation_verifications_verified_idx ON organisation_verifications (verified_at DESC);

-- =====================================================================
-- 8. EXISTING TABLES — ensure constraints are up to date
-- =====================================================================
-- Requests: ensure handover/completed timestamps exist (from phase4)
ALTER TABLE requests ADD COLUMN IF NOT EXISTS handed_over_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Resources: ensure status constraint includes all states
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_status_check;
ALTER TABLE resources ADD CONSTRAINT resources_status_check
  CHECK (status IN ('AVAILABLE', 'REQUESTED', 'ALLOCATED', 'HANDED_OVER', 'COMPLETED'));

-- Requests: ensure status constraint includes all states
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'HANDED_OVER', 'COMPLETED'));

-- =====================================================================
-- COMPLETE
-- =====================================================================
-- After running this migration:
-- - All v1 tables remain intact and functional
-- - New tables support exchanges, notifications, messaging, history, org verification
-- - Run: psql "$DATABASE_URL" -f migrations/phase5_enhancements.sql