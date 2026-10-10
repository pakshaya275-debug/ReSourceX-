-- ReSourceX database schema (v2: enhanced profiles, exchange support, notifications, messaging)
-- Run once against your PostgreSQL database before starting the API.
-- Backward compatible with v1; the donation workflow is preserved.

-- =====================================================================
-- USERS (enhanced for individual/organisation profiles, contact, location)
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'RECIPIENT'
    CHECK (role IN ('DONOR', 'RECIPIENT', 'ADMIN')),
  organisation_name VARCHAR(160),
  organisation_type VARCHAR(40)
    CHECK (organisation_type IN ('individual', 'college', 'ngo', 'company', 'community_organisation')),
  phone_number VARCHAR(20),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  location_privacy VARCHAR(20) NOT NULL DEFAULT 'APPROXIMATE'
    CHECK (location_privacy IN ('exact', 'approximate', 'none')),
  organisation_verified BOOLEAN NOT NULL DEFAULT FALSE,
  profile_picture_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
  ON users (LOWER(email));

CREATE INDEX IF NOT EXISTS users_organisation_verified_idx ON users (organisation_verified);

-- =====================================================================
-- RESOURCES (enhanced for exchanges, condition enum, availability dates, coords)
-- =====================================================================
CREATE TABLE IF NOT EXISTS resources (
  id BIGSERIAL PRIMARY KEY,
  donor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  category VARCHAR(80) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  condition VARCHAR(40) NOT NULL DEFAULT 'Good',
  condition_enum VARCHAR(10) NOT NULL DEFAULT 'GOOD'
    CHECK (condition_enum IN ('POOR', 'FAIR', 'GOOD', 'EXCELLENT', 'NEW')),
  location VARCHAR(160) NOT NULL DEFAULT 'Not specified',
  availability VARCHAR(120) NOT NULL DEFAULT 'Available now',
  availability_date DATE,
  description TEXT NOT NULL DEFAULT '',
  specifications TEXT NOT NULL DEFAULT '',
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'REQUESTED', 'ALLOCATED', 'HANDED_OVER', 'COMPLETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS resources_donor_id_idx ON resources (donor_id);
CREATE INDEX IF NOT EXISTS resources_status_idx ON resources (status);
CREATE INDEX IF NOT EXISTS resources_category_idx ON resources (LOWER(category));
CREATE INDEX IF NOT EXISTS resources_latitude_idx ON resources (latitude);
CREATE INDEX IF NOT EXISTS resources_longitude_idx ON resources (longitude);

-- =====================================================================
-- REQUESTS (donation workflow — unchanged from v1)
-- =====================================================================
CREATE TABLE IF NOT EXISTS requests (
  id BIGSERIAL PRIMARY KEY,
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'HANDED_OVER', 'COMPLETED')),
  urgency SMALLINT NOT NULL DEFAULT 3 CHECK (urgency BETWEEN 1 AND 5),
  purpose TEXT NOT NULL DEFAULT '',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  handed_over_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS requests_resource_id_idx ON requests (resource_id);
CREATE INDEX IF NOT EXISTS requests_recipient_id_idx ON requests (recipient_id);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status);

CREATE UNIQUE INDEX IF NOT EXISTS requests_active_recipient_resource_unique
  ON requests (resource_id, recipient_id)
  WHERE status IN ('PENDING', 'APPROVED');

-- =====================================================================
-- EXCHANGES (new: bidirectional resource-for-resource transactions)
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

-- Resources involved in an exchange (offered → requested)
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
  -- Prevent the same resource from appearing twice in a single exchange
  CONSTRAINT exchange_resources_unique_side UNIQUE (exchange_id, side)
);

CREATE INDEX IF NOT EXISTS exchange_resources_exchange_id_idx ON exchange_resources (exchange_id);
CREATE INDEX IF NOT EXISTS exchange_resources_resource_id_idx ON exchange_resources (resource_id);

-- Prevent double allocation of a resource across active exchanges
CREATE UNIQUE INDEX IF NOT EXISTS exchange_resources_active_unique
  ON exchange_resources (resource_id)
  WHERE resource_id IN (
    SELECT er.resource_id
    FROM exchange_resources er
    JOIN exchanges e ON e.id = er.exchange_id
    WHERE e.status IN ('PROPOSED', 'COUNTERED', 'ACCEPTED', 'IN_PROGRESS')
  );

-- =====================================================================
-- NOTIFICATIONS (persistent in-app notification centre)
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
-- MESSAGES (transaction-based communication tied to exchanges/requests)
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
-- RESOURCE HISTORY (audit trail for traceability/impact)
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
-- ORGANISATION VERIFICATIONS (manual admin approval for org trust)
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
