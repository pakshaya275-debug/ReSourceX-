-- Phase 6: postal address for profiles, match-event logging (training data for future ranking work).
-- Additive and idempotent: safe to run more than once, and on any database created from the v1 or v2 schema.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS address_line VARCHAR(200),
  ADD COLUMN IF NOT EXISTS city VARCHAR(100),
  ADD COLUMN IF NOT EXISTS state VARCHAR(100),
  ADD COLUMN IF NOT EXISTS country VARCHAR(100),
  ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20);

-- Records what recipients were shown and what they chose, so a future model can be trained and evaluated.
CREATE TABLE IF NOT EXISTS match_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL CHECK (action IN ('view', 'request')),
  rank_position INTEGER,
  match_score INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS match_events_user_idx ON match_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS match_events_resource_idx ON match_events (resource_id);
