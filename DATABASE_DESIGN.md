# ReSourceX — Database Design
**Prepared: October 10, 2026 · For Implementation Starting October 11, 2026**

This document specifies the complete PostgreSQL schema for the enhanced ReSourceX platform supporting donations, exchanges, and requests.

## 1. Design Principles

1. **Backward Compatibility:** All existing tables and columns remain unchanged; only additive changes.
2. **Extensibility:** New features added as new tables or nullable columns where appropriate.
3. **Privacy by Design:** Sensitive contact info (phone, exact address) is stored but access-controlled.
4. **Referential Integrity:** Foreign keys and constraints prevent orphaned records.
5. **Audit Trail:** Critical state changes recorded where needed.

## 2. Schema Overview

All table and column names use snake_case.

### Core Tables (Modified)
- `users`: Enhanced with profile/organisation/contact/location fields
- `resources`: Enhanced with condition enum, availability date, coordinates  
- `requests`: Unchanged (donation/request flow still valid)
- New: `exchanges`: Core exchange transaction table
- New: `exchange_resources`: Junction table for resources involved in exchanges
- New: `notifications`: Persistent notification center
- New: `messages`: Transaction-based messaging
- New: `resource_history`: Audit trail of resource state changes
- New: `organisation_verifications`: Manual org verification tracking

### Supporting Tables
- None currently needed beyond core.

## 3. Detailed Schema

### 3.1 Users Table (Enhanced)

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS organisation_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS organisation_type VARCHAR(40)
    CHECK (organisation_type IN ('individual', 'college', 'ngo', 'company', 'community_organisation', NULL)),
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_privacy VARCHAR(20) DEFAULT 'approximate'
    CHECK (location_privacy IN ('exact', 'approximate', 'none')),
  ADD COLUMN IF NOT EXISTS organisation_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS profile_picture_url TEXT;
```

**Notes:**
- `organisation_name` and `organisation_type` together identify organisation accounts
- When both are NULL, user is an individual
- `organisation_type` enum covers major categories; NULL allowed for individuals
- `latitude`/`longitude` NULL when location not provided or privacy set to 'none'
- `location_privacy` controls what is shown publicly:
  - 'exact': Show precise location (rare, requires consent)
  - 'approximate': Show city/area only (default)
  - 'none': Show no location info
- `organisation_verified` set manually by admins after verification process
- `profile_picture_url` stores URL to avatar/logo image

### 3.2 Resources Table (Enhanced)

```sql
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS condition_enum VARCHAR(10)
    DEFAULT 'Good'
    CHECK (condition_enum IN ('Poor', 'Fair', 'Good', 'Excellent', 'New')),
  ADD COLUMN IF NOT EXISTS availability_date DATE,
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
```

**Notes:**
- `condition_enum` provides structured condition alongside free-text `condition` field
- `availability_date` NULL means "available now"; future date means scheduled availability
- `latitude`/`longitude` mirror user location; can be overridden per resource if needed
- Existing `condition` (TEXT) and `availability` (VARCHAR) fields retained for backward compatibility and free-form details

### 3.3 Exchange Core Tables

```sql
-- Main exchange transaction record
CREATE TABLE IF NOT EXISTS exchanges (
  id BIGSERIAL PRIMARY KEY,
  initiator_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED', 'COUNTERED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'CANCELLED')),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  message TEXT,  -- Free-form notes from initiator
  CONSTRAINT exch_initiator_recipient_check CHECK (initiator_id <> recipient_id)
);

-- Resources involved in each side of the exchange
CREATE TABLE IF NOT EXISTS exchange_resources (
  id BIGSERIAL PRIMARY KEY,
  exchange_id BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  -- Which side: 'offered' (what initiator provides) or 'requested' (what initiator wants)
  side VARCHAR(10) NOT NULL CHECK (side IN ('offered', 'requested')),
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  -- For tracking partial fulfilment
  quantity_fulfilled INTEGER DEFAULT 0 CHECK (quantity_fulfilled >= 0 AND quantity_fulfilled <= quantity),
  UNIQUE (exchange_id, side)  -- One resource per side per exchange
);

-- Prevents double allocation of resources in active exchanges
CREATE UNIQUE INDEX IF NOT EXISTS exch_resource_active_unique
  ON exchange_resources (resource_id)
  WHERE exchange_id IN (
    SELECT id FROM exchanges 
    WHERE status IN ('PROPOSED', 'COUNTERED', 'ACCEPTED', 'IN_PROGRESS')
  );
```

**Notes:**
- Exchange is directional: initiator proposes, recipient responds
- `side` indicates which resource belongs to which party:
  - 'offered': Resource the initiator is providing
  - 'requested': Resource the initiator wants to receive
- Status flow:
  - PROPOSED → (recipient responds) → COUNTERED/ACCEPTED/DECLINED
  - ACCEPTED → (both confirm handover) → IN_PROGRESS
  - IN_PROGRESS → (both confirm receipt) → COMPLETED
- Alternative paths: PROPOSED → CANCELLED (by initiator), any → DECLINED (by recipient)
- `exchange_resources` allows tracking quantities and partial fulfilment
- Active exchange prevention index stops same resource being used in multiple concurrent exchanges
- Quantity tracking: `quantity` total offered/requested, `quantity_fulfilled` amount actually transferred

### 3.4 Notifications Table

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,
  related_id BIGINT,  -- FK to exchanges.id, requests.id, or NULL
  related_type VARCHAR(20),  -- 'exchange', 'request', or NULL
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, is_read)
  WHERE is_read = FALSE;

CREATE INDEX IF NOT EXISTS notifications_created_idx
  ON notifications (created_at DESC);
```

**Notes:**
- `type` categorizes notification: 'new_request', 'request_approved', 'request_declined', 
  'exchange_offer', 'exchange_counter', 'exchange_accepted', 'handover_notified', 'completed', etc.
- `related_id` + `related_type` links notification to specific transaction
- Index on (user_id, is_read) optimizes fetching unread notifications
- Notifications are immutable after creation; state changes via separate read/delete actions

### 3.5 Messages Table

```sql
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  exchange_id BIGINT REFERENCES exchanges(id) ON DELETE CASCADE,
  request_id BIGINT REFERENCES requests(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  -- Exactly one of exchange_id or request_id must be set (or neither for system messages)
  CONSTRAINT msg_exchange_or_request_check 
    CHECK (
      (exchange_id IS NOT NULL AND request_id IS NULL) OR
      (exchange_id IS NULL AND request_id IS NOT NULL) OR
      (exchange_id IS NULL AND request_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS messages_exchange_idx 
  ON messages (exchange_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_request_idx 
  ON messages (request_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_sender_idx 
  ON messages (sender_id, sent_at);
```

**Notes:**
- Messages belong to either an exchange or a request (or neither for system broadcasts)
- `content` is the message text
- `read_at` when recipient last read the message (nullable = unread)
- System messages (admin broadcasts) have both FKs NULL

### 3.6 Resource History Table

```sql
CREATE TABLE IF NOT EXISTS resource_history (
  id BIGSERIAL PRIMARY KEY,
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  action VARCHAR(30) NOT NULL,  -- 'listed', 'requested', 'allocated', 'handover_initiated', 
                                -- 'handover_confirmed', 'completed', 'declined', 'cancelled'
  performed_by BIGINT NOT NULL REFERENCES users(id),
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB,  -- Flexible context: quantities, counterpart IDs, etc.
  resource_snapshot JSONB  -- Denormalized copy of resource state at time of action
);

CREATE INDEX IF NOT EXISTS resource_history_resource_idx 
  ON resource_history (resource_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS resource_history_action_idx 
  ON resource_history (action);
```

**Notes:**
- Provides complete audit trail of resource lifecycle
- `details` and `resource_snapshot` denormalize context for historical queries
- Enables features like resource passport, impact reporting, dispute resolution
- Actions mirror request/exchange statuses plus resource-specific events

### 3.7 Organisation Verifications (Optional)

```sql
CREATE TABLE IF NOT EXISTS organisation_verifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_by BIGINT REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  document_type VARCHAR(40),  -- 'college_id', 'ngo_registration', 'business_license', etc.
  document_reference TEXT,    -- ID or reference number
  notes TEXT,
  expires_at DATE
);

CREATE UNIQUE INDEX IF NOT EXISTS org_ver_user_unique 
  ON organisation_verifications (user_id)
  WHERE expires_at IS NULL OR expires_at > CURRENT_DATE;

CREATE INDEX IF NOT EXISTS org_ver_verified_idx 
  ON organisation_verifications (verified_at DESC);
```

**Notes:**
- Manual verification process initiated by admins
- Tracks what was verified and when
- Allows expiry for time-bound verification (e.g., annual business licenses)
- `verified_by` NULL means self-attested (not trusted); non-NULL means admin-verified
- Unique constraint prevents multiple active verifications per user

## 4. Migration Strategy

All changes are **ADDITIVE** - no existing columns or tables are modified in a breaking way.

### Migration 1: Users Enhancements
```sql
-- Run during low-traffic period
ALTER TABLE users
  ADD COLUMN organisation_name VARCHAR(160),
  ADD COLUMN organisation_type VARCHAR(40) CHECK (organisation_type IN ('individual', 'college', 'ngo', 'company', 'community_organisation')),
  ADD COLUMN phone_number VARCHAR(20),
  ADD COLUMN latitude DOUBLE PRECISION,
  ADD COLUMN longitude DOUBLE PRECISION,
  ADD COLUMN location_privacy VARCHAR(20) DEFAULT 'approximate' CHECK (location_privacy IN ('exact', 'approximate', 'none')),
  ADD COLUMN organisation_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN profile_picture_url TEXT;
```

### Migration 2: Resources Enhancements
```sql
ALTER TABLE resources
  ADD COLUMN condition_enum VARCHAR(10) DEFAULT 'Good' CHECK (condition_enum IN ('Poor', 'Fair', 'Good', 'Excellent', 'New')),
  ADD COLUMN availability_date DATE,
  ADD COLUMN latitude DOUBLE PRECISION,
  ADD COLUMN longitude DOUBLE PRECISION;
```

### Migration 3: New Tables
Create the exchange_resources, notifications, messages, resource_history, and organisation_verifications tables as defined above, including all indexes and constraints.

### Migration 4: Backfill Defaults (Optional)
```sql
-- Set sensible defaults for existing records
UPDATE users SET location_privacy = 'approximate' WHERE location_privacy IS NULL;
UPDATE resources SET condition_enum = 'Good' WHERE condition_enum IS NULL;
```

## 5. Indexing Strategy

Performance-critical indexes are included in the table definitions above. Key access patterns supported:

1. **User lookups:** by id, email (existing), organisation verification status
2. **Resource discovery:** by category, location (text), coordinates (distance), status, donor_id
3. **Exchange/Request listings:** by user_id, status, timestamps
4. **Notifications:** unread count per user, recent notifications
5. **Messages:** by conversation (exchange_id/request_id), chronologically
6. **History:** resource-centric queries, action-based reporting

## 6. Constraints and Triggers

### 6.1 Application-Level Constraints (Enforced in Service Layer)
- Exchange resource quantity cannot exceed available resource quantity
- Users cannot initiate exchange with themselves
- Location coordinates must be valid (-90 to 90 lat, -180 to 180 lon) when provided
- Availability date cannot be in past (unless special handling for historical data)

### 6.2 Database-Level Constraints
All foreign keys, check constraints, and unique indexes defined above enforce data integrity at the storage layer.

### 6.3 Triggers (Not Initially Required)
No triggers needed for MVP; application logic handles state transitions.
Consider later for:
- Automatic updated_at timestamps
- Complex validation spanning multiple tables
- Audit logging separate from resource_history

## 7. Size and Growth Estimates

| Table | Estimated Rows (6 months) | Notes |
|-------|---------------------------|-------|
| users | 1,000–5,000 | Depends on adoption |
| resources | 500–2,000 | Active listings |
| exchanges | 100–500 | Successful + attempted exchanges |
| requests | 200–1,000 | Donation requests |
| notifications | 5,000–20,000 | Scales with user activity |
| messages | 2,000–10,000 | Scales with notification/messaging |
| resource_history | 2,000–8,000 | One per state change per resource |
| organisation_verifications | 50–500 | Subset of org users |

Total estimated size: < 5 GB for first year, easily manageable on Neon PostgreSQL.

## 8. Relationship to API Design

Each new table corresponds to API endpoints:
- `exchanges` ↔ `/api/exchanges` (CRUD + actions)
- `notifications` ↔ `/api/notifications` (list, mark read, delete)
- `messages` ↔ `/api/exchanges/:id/messages` and `/api/requests/:id/messages`
- `resource_history` ↔ Internal/admin use or `/api/resources/:id/history`

No direct API for `organisation_verifications` (admin-only manual process).

## 9. Extension Points

1. **Future Exchange Types:** Add `exchange_type` column to `exchanges` table (e.g., 'cyclic', 'third_party')
2. **Rich Notifications:** Add `payload_jsonb` column to `notifications` for structured data
3. **Geospatial:** Add PostGIS extension and geography types for advanced distance queries
4. **Soft Deletes:** Add `deleted_at` column if needed for compliance
5. **Multilingual:** Add language columns or translation tables for i18n

---

**Schema is ready for implementation.** All changes are additive and backward compatible with existing donation workflow.

*Next step: Implement migration scripts and update service layer to use new schema.*