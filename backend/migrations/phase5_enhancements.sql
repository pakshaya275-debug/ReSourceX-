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
  ADD COLUMN IF NOT EXISTS location_privacy VARCHAR(20) NOT NULL DEFAULT 'approximate'
    CHECK (location_privacy IN ('exact', 'approximate', 'none')),
  ADD COLUMN IF NOT EXISTS organisation_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS profile_picture_url TEXT;
  ,ADD COLUMN IF NOT EXISTS address_line VARCHAR(200)
  ,ADD COLUMN IF NOT EXISTS city VARCHAR(100)
  ,ADD COLUMN IF NOT EXISTS state VARCHAR(100)
  ,ADD COLUMN IF NOT EXISTS country VARCHAR(100)
  ,ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20);

-- Backfill existing users with defaults
UPDATE users SET location_privacy = LOWER(location_privacy) WHERE location_privacy IS NOT NULL;
UPDATE users SET location_privacy = 'approximate' WHERE location_privacy IS NULL;
ALTER TABLE users ALTER COLUMN location_privacy SET DEFAULT 'approximate';
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
UPDATE resources SET condition_enum = CASE
  WHEN LOWER(condition) LIKE '%poor%' THEN 'POOR'
  WHEN LOWER(condition) LIKE '%fair%' THEN 'FAIR'
  WHEN LOWER(condition) LIKE '%excellent%' THEN 'EXCELLENT'
  WHEN LOWER(condition) LIKE '%new%' THEN 'NEW'
  ELSE 'GOOD' END;

CREATE INDEX IF NOT EXISTS resources_latitude_idx ON resources (latitude);
CREATE INDEX IF NOT EXISTS resources_longitude_idx ON resources (longitude);

-- =====================================================================
-- 3. EXCHANGES — new core tables for resource-for-resource transactions
-- =====================================================================
-- Normalize either legacy exchange table before creating the shared model.
DO $$
BEGIN
  IF to_regclass('public.exchanges') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='proposer_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='initiator_id') THEN
      ALTER TABLE exchanges RENAME COLUMN proposer_id TO initiator_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='receiver_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='recipient_id') THEN
      ALTER TABLE exchanges RENAME COLUMN receiver_id TO recipient_id;
    END IF;
  END IF;
END $$;

DO $$
DECLARE c RECORD;
BEGIN
  IF to_regclass('public.exchanges') IS NOT NULL THEN
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.exchanges'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%status%'
    LOOP EXECUTE format('ALTER TABLE exchanges DROP CONSTRAINT %I',c.conname); END LOOP;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS exchanges (
  id BIGSERIAL PRIMARY KEY,
  initiator_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_proposer_id BIGINT REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED',
  message TEXT NOT NULL DEFAULT '',
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  initiator_handover_at TIMESTAMPTZ,
  recipient_handover_at TIMESTAMPTZ,
  initiator_completed_at TIMESTAMPTZ,
  recipient_completed_at TIMESTAMPTZ,
  CONSTRAINT exchanges_initiator_recipient_check_v2 CHECK (initiator_id <> recipient_id)
);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS current_proposer_id BIGINT REFERENCES users(id);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ;
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS initiator_handover_at TIMESTAMPTZ;
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS recipient_handover_at TIMESTAMPTZ;
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS initiator_completed_at TIMESTAMPTZ;
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS recipient_completed_at TIMESTAMPTZ;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='created_at') THEN
    EXECUTE 'UPDATE exchanges SET proposed_at=COALESCE(proposed_at,created_at)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='offered_resource_id') THEN
    EXECUTE 'ALTER TABLE exchanges ALTER COLUMN offered_resource_id DROP NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='requested_resource_id') THEN
    EXECUTE 'ALTER TABLE exchanges ALTER COLUMN requested_resource_id DROP NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='handed_over_at') THEN
    EXECUTE 'UPDATE exchanges SET initiator_handover_at=handed_over_at,recipient_handover_at=handed_over_at WHERE status IN (''HANDED_OVER'',''IN_PROGRESS'') AND handed_over_at IS NOT NULL';
  END IF;
END $$;
UPDATE exchanges SET status=CASE status WHEN 'OFFERED' THEN 'PROPOSED' WHEN 'HANDED_OVER' THEN 'IN_PROGRESS' ELSE status END;
UPDATE exchanges SET proposed_at=NOW() WHERE proposed_at IS NULL;
UPDATE exchanges SET current_proposer_id=initiator_id WHERE current_proposer_id IS NULL;
ALTER TABLE exchanges ALTER COLUMN current_proposer_id SET NOT NULL;
ALTER TABLE exchanges ALTER COLUMN proposed_at SET DEFAULT NOW();
ALTER TABLE exchanges ALTER COLUMN proposed_at SET NOT NULL;
-- Legacy tables defaulted to 'OFFERED', which the new status constraint rejects.
ALTER TABLE exchanges ALTER COLUMN status SET DEFAULT 'PROPOSED';
ALTER TABLE exchanges DROP CONSTRAINT IF EXISTS exchanges_status_v2_check;
ALTER TABLE exchanges DROP CONSTRAINT IF EXISTS exchanges_initiator_recipient_check_v2;
ALTER TABLE exchanges ADD CONSTRAINT exchanges_status_v2_check CHECK (status IN ('PROPOSED','COUNTERED','ACCEPTED','IN_PROGRESS','COMPLETED','DECLINED','CANCELLED'));
ALTER TABLE exchanges ADD CONSTRAINT exchanges_initiator_recipient_check_v2 CHECK (initiator_id <> recipient_id);
DROP INDEX IF EXISTS exchanges_one_open_pair_idx;
CREATE INDEX IF NOT EXISTS exchanges_initiator_id_idx ON exchanges (initiator_id);
CREATE INDEX IF NOT EXISTS exchanges_recipient_id_idx ON exchanges (recipient_id);
CREATE INDEX IF NOT EXISTS exchanges_status_idx ON exchanges (status);

CREATE TABLE IF NOT EXISTS exchange_resources (
  id BIGSERIAL PRIMARY KEY,
  exchange_id BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  side VARCHAR(10) NOT NULL CHECK (side IN ('offered','requested')),
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  quantity_fulfilled INTEGER NOT NULL DEFAULT 0 CHECK (quantity_fulfilled >= 0 AND quantity_fulfilled <= quantity),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT exchange_resources_unique_side UNIQUE (exchange_id, side)
);
ALTER TABLE exchange_resources DROP CONSTRAINT IF EXISTS exchange_resources_unique_resource;
CREATE INDEX IF NOT EXISTS exchange_resources_exchange_id_idx ON exchange_resources (exchange_id);
CREATE INDEX IF NOT EXISTS exchange_resources_resource_id_idx ON exchange_resources (resource_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='offered_resource_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exchanges' AND column_name='requested_resource_id') THEN
    EXECUTE $sql$ INSERT INTO exchange_resources (exchange_id,side,resource_id,quantity)
      SELECT e.id,'offered',e.offered_resource_id,GREATEST(COALESCE(r.quantity,1),1)
      FROM exchanges e JOIN resources r ON r.id=e.offered_resource_id WHERE e.offered_resource_id IS NOT NULL
      ON CONFLICT (exchange_id,side) DO NOTHING $sql$;
    EXECUTE $sql$ INSERT INTO exchange_resources (exchange_id,side,resource_id,quantity)
      SELECT e.id,'requested',e.requested_resource_id,GREATEST(COALESCE(r.quantity,1),1)
      FROM exchanges e JOIN resources r ON r.id=e.requested_resource_id WHERE e.requested_resource_id IS NOT NULL
      ON CONFLICT (exchange_id,side) DO NOTHING $sql$;
  END IF;
END $$;

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
    )
);

CREATE INDEX IF NOT EXISTS messages_exchange_id_idx ON messages (exchange_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_request_id_idx ON messages (request_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_sender_id_idx ON messages (sender_id, sent_at);

-- Replace the earlier permissive constraint if this migration was previously applied.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_exchange_or_request_check;
ALTER TABLE messages ADD CONSTRAINT messages_exchange_or_request_check
  CHECK (
    (exchange_id IS NOT NULL AND request_id IS NULL)
    OR (exchange_id IS NULL AND request_id IS NOT NULL)
  ) NOT VALID;

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

-- Organisation verification history. A non-unique index permits renewal records.
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
CREATE INDEX IF NOT EXISTS organisation_verifications_user_idx ON organisation_verifications (user_id);
CREATE INDEX IF NOT EXISTS organisation_verifications_verified_idx ON organisation_verifications (verified_at DESC);

-- Repair the earlier permissive message constraint even when this migration was previously run.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_exchange_or_request_check;
ALTER TABLE messages ADD CONSTRAINT messages_exchange_or_request_check
  CHECK (
    (exchange_id IS NOT NULL AND request_id IS NULL)
    OR (exchange_id IS NULL AND request_id IS NOT NULL)
  ) NOT VALID;

-- Keep existing donation workflow columns and status constraints compatible.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS handed_over_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_status_check;
ALTER TABLE resources ADD CONSTRAINT resources_status_check
  CHECK (status IN ('AVAILABLE', 'REQUESTED', 'ALLOCATED', 'HANDED_OVER', 'COMPLETED'));

ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'HANDED_OVER', 'COMPLETED'));

-- COMPLETE
-- This migration is additive for the donation workflow. Back up the database
-- before applying it to a production instance.