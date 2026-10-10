-- ReSourceX resource-for-resource exchange workflow.
-- Apply once to an existing database after the core schema.sql.

CREATE TABLE IF NOT EXISTS exchanges (
  id BIGSERIAL PRIMARY KEY,
  proposer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offered_resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  requested_resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  message TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'OFFERED'
    CHECK (status IN ('OFFERED', 'ACCEPTED', 'DECLINED', 'HANDED_OVER', 'COMPLETED', 'CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  handed_over_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT exchanges_distinct_resources
    CHECK (offered_resource_id <> requested_resource_id),
  CONSTRAINT exchanges_distinct_users
    CHECK (proposer_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS exchanges_proposer_created_idx
  ON exchanges (proposer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS exchanges_receiver_created_idx
  ON exchanges (receiver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS exchanges_status_created_idx
  ON exchanges (status, created_at DESC);

-- Prevent duplicate active offers for the same resource pair.
CREATE UNIQUE INDEX IF NOT EXISTS exchanges_one_open_pair_idx
  ON exchanges (offered_resource_id, requested_resource_id)
  WHERE status IN ('OFFERED', 'ACCEPTED');
