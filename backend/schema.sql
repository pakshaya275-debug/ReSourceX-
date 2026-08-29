-- ReSourceX database schema
-- Run once against your PostgreSQL database before starting the API.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'RECIPIENT'
    CHECK (role IN ('DONOR', 'RECIPIENT', 'ADMIN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
  ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS resources (
  id BIGSERIAL PRIMARY KEY,
  donor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  category VARCHAR(80) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  condition VARCHAR(40) NOT NULL DEFAULT 'Good',
  location VARCHAR(160) NOT NULL DEFAULT 'Not specified',
  availability VARCHAR(120) NOT NULL DEFAULT 'Available now',
  description TEXT NOT NULL DEFAULT '',
  specifications TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'REQUESTED', 'ALLOCATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS resources_donor_id_idx ON resources (donor_id);
CREATE INDEX IF NOT EXISTS resources_status_idx ON resources (status);
CREATE INDEX IF NOT EXISTS resources_category_idx ON resources (LOWER(category));

CREATE TABLE IF NOT EXISTS requests (
  id BIGSERIAL PRIMARY KEY,
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED')),
  urgency SMALLINT NOT NULL DEFAULT 3 CHECK (urgency BETWEEN 1 AND 5),
  purpose TEXT NOT NULL DEFAULT '',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS requests_resource_id_idx ON requests (resource_id);
CREATE INDEX IF NOT EXISTS requests_recipient_id_idx ON requests (recipient_id);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status);

CREATE UNIQUE INDEX IF NOT EXISTS requests_active_recipient_resource_unique
  ON requests (resource_id, recipient_id)
  WHERE status IN ('PENDING', 'APPROVED');
