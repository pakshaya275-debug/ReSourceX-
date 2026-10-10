# ReSourceX — API Design
**Prepared: October 10, 2026 · Implementation target: October 13, 2026**

This document defines all API endpoints for the enhanced ReSourceX platform, organized by module. Endpoints that currently exist are marked (EXISTING); new endpoints are marked (NEW).

---

## 1. Design Conventions

| Convention | Value |
|------------|-------|
| Base path | `/api` |
| Auth | JWT in `Authorization: Bearer <token>` header for protected routes |
| Response format | `{"data": ..., "error": "..."}` or `{"data": {...}}` for success |
| Error format | `{"error": "Human readable error message"}` with appropriate HTTP status |
| Pagination | `?limit=N&offset=M` (defaults: limit 50, offset 0) |
| Filtering | Query parameters, e.g. `?category=books&location=chennai` |
| Sorting | `?sort=score&order=desc` |
| Date format | ISO 8601 (`2026-10-10T14:30:00.000Z`) |
| Content type | `application/json` |

---

## 2. Authentication Endpoints

### POST `/api/auth/register` (EXISTING)
**Add:** organisation-related request fields.

**Request:**
```json
{
  "firstName": "Akshayaa",
  "lastName": "Kumar",
  "email": "akshaya@example.com",
  "password": "StrongPass123",
  "role": "recipient",
  "organisation_name": "VIT University",
  "organisation_type": "college",
  "phone_number": "+919876543210"
}
```

**Response:** `201 { "user": {...}, "token": "..." }`

### POST `/api/auth/login` (EXISTING)
No changes. Optional `organisation_name` login support in future.

### GET `/api/auth/me` (EXISTING)
**Response now includes:** organisation info, phone, location (as set by privacy settings).

### PUT `/api/auth/change-password` (NEW)
```
PUT /api/auth/change-password
Request: { "oldPassword": "...", "newPassword": "..." }
Response: { "success": true }
```

---

## 3. User / Profile Endpoints

### GET `/api/users/:id` (NEW)
Fetch another user's public profile (privacy-filtered).

**Path:** `:id`
**Auth:** required
**Response:**
```json
{
  "user": {
    "id": 42,
    "displayName": "VIT University",
    "firstName": "Akshayaa",
    "lastName": "Kumar",
    "email": null,           // Only if trusted/accepted relationship
    "phone": null,           // Only if trusted/accepted relationship
    "role": "DONOR",
    "organisation_name": "VIT University",
    "organisation_type": "college",
    "organisation_verified": true,
    "location": {
      "city": "Vellore",     // Approximate only (privacy default)
      "country": "India",
      "latitude": null,      // Only if privacy = 'exact'
      "longitude": null
    },
    "profile_picture_url": "https://..."
  }
}
```

**Privacy rules:**
- `location` shows approximate (city/area) unless `location_privacy = 'exact'`
- `email` and `phone` shown only to participants who have accepted requests/exchanges with the profile owner
- Unauthenticated GET returns same but with email/phone always null

### PUT `/api/users/profile` (NEW)
Update current user's profile.

**Request:**
```json
{
  "organisation_name": "VIT University",
  "organisation_type": "college",
  "phone_number": "+919876543210",
  "latitude": 12.924980,
  "longitude": 79.131784,
  "location_privacy": "approximate",
  "profile_picture_url": "https://..."
}
```

**Response:** `200 { "user": {...} }`

---

## 4. Resource Endpoints

### GET `/api/resources` (EXISTING)
No changes required. Query params may be extended in future: `?coords=12.92,79.13&radius=10000`.

### GET `/api/resources/:id` (EXISTING)
No changes.

### POST `/api/resources` (EXISTING)
**Add request fields:** `availability_date`, `condition_enum`, `latitude`, `longitude`.

### PUT `/api/resources/:id` (EXISTING)
**Add accepted fields:** `availability_date`, `condition_enum`, `latitude`, `longitude`.

### DELETE `/api/resources/:id` (EXISTING)
No changes.

### GET `/api/resources/:id/history` (NEW)
Fetch resource history (resource passport view).

**Path:** `:id`
**Auth:** required (any role)
**Response:**
```json
{
  "history": [
    {
      "id": 123,
      "action": "allocated",
      "performed_by": {"id": 42, "displayName": "VIT University"},
      "performed_at": "2026-10-10T14:30:00.000Z",
      "details": {"quantity": 10, "request_id": 55},
      "resource_snapshot": {"name": "Engineering Textbooks", "quantity": 10}
    }
  ]
}
```

---

## 5. Matching Endpoint

### GET `/api/matching` (EXISTING)
**Extend:** add exchange-aware matching and distance calculation.

**Query params (new/extended):**
| Param | Type | Description |
|-------|------|-------------|
| `category` | string | Filter by category |
| `search` | string | Text search in name/description/location |
| `location` | string | City/area filter (text-based, existing) |
| `coords` | string | `lat,lng` for distance-based filtering |
| `radius` | number | Radius in meters (default 10000) |
| `quantity` | int | Minimum quantity required |
| `urgency` | string/number | Urgency level |
| `type` | string | `donation` (default) or `exchange` |
| `sort` | string | `score` (default), `distance`, `newest` |
| `exchange_offered_id` | int | For exchange matching: match against this offered resource |

**Response (extended):**
```json
{
  "matches": [
    {
      "id": 789,
      "name": "Physics Lab Equipment",
      "category": "Science",
      "quantity": 5,
      "condition": "Good",
      "location": "Chennai",
      "status": "AVAILABLE",
      "matchScore": 87,
      "matchReasons": ["Same category", "Same location", "Enough quantity", "Suitable for urgent needs"],
      "distance_km": 2.3,        // NEW when coords provided
      "type": "exchange",        // NEW matching mode
      "exchangeContext": {       // NEW for exchange matching
        "offeredResource": {...},
        "requestedResource": {...}
      }
    }
  ],
  "scoring": { "category": 30, "location": 20, "quantity": 20, "urgency": 15, "availability": 15 },
  "filters_applied": { "category": "Science", "coords": "12.92,79.13", "radius": 5000 }
}
```

---

## 6. Request (Donation) Endpoints

### GET `/api/requests` (EXISTING)
No changes.

### POST `/api/requests` (EXISTING)
No changes.

### PUT `/api/requests/:id/approve` (EXISTING)
No changes.

### PUT `/api/requests/:id/decline` (EXISTING)
No changes.

### PUT `/api/requests/:id/handover` (EXISTING)
No changes.

### PUT `/api/requests/:id/complete` (EXISTING)
No changes.

### GET `/api/requests/:id/messages` (NEW)
Fetch messages for a donation request.

**Path:** `:id`
**Auth:** required (donor or recipient of this request)
**Response:** `200 { "messages": [ {id, sender: {...}, content, sent_at, read_at} ] }`

### POST `/api/requests/:id/messages` (NEW)
Send a message in the context of a request.

**Request:** `{ "content": "Hi, can we meet at 3pm?" }`
**Response:** `201 { "message": {...}, "notification": { "sent_to": 42, "type": "new_message" } }`

---

## 7. Exchange Endpoints (NEW — Core Feature)

### GET `/api/exchanges` (NEW)
List the current user's exchanges (as initiator or recipient).

**Query params:** `?status=PENDING&role=initiator&limit=50&offset=0`
**Auth:** required
**Response:**
```json
{
  "exchanges": [
    {
      "id": 55,
      "initiator": {"id": 12, "displayName": "XYZ College", "organisation_verified": true},
      "recipient": {"id": 42, "displayName": "ABC NGO"},
      "status": "PENDING",
      "offeredResource": {
        "id": 789,
        "name": "Unused Laboratory Kits",
        "quantity": 10,
        "condition": "Good"
      },
      "requestedResource": {
        "id": 890,
        "name": "Computer Textbooks",
        "quantity": 5,
        "condition": "Excellent"
      },
      "proposed_at": "2026-10-10T10:00:00.000Z",
      "responded_at": null,
      "message": "Would you be interested in swapping?"
    }
  ],
  "count": 3
}
```

### GET `/api/exchanges/:id` (NEW)
Get full details of an exchange.

**Auth:** required (must be initiator or recipient)
**Response:**
```json
{
  "exchange": {
    "id": 55,
    "initiator": {...},
    "recipient": {...},
    "status": "PENDING",
    "proposed_at": "...",
    "responded_at": null,
    "accepted_at": null,
    "completed_at": null,
    "message": "...",
    "offeredResources": [ {"id": 789, "name": "...", "quantity": 10, "quantity_fulfilled": 0} ],
    "requestedResources": [ {"id": 890, "name": "...", "quantity": 5, "quantity_fulfilled": 0} ],
    "lastMessage": "Hi, thanks for the offer! We'd like to counter..."
  }
}
```

### POST `/api/exchanges` (NEW)
Propose a new exchange.

**Request:**
```json
{
  "recipient_id": 42,
  "offered_resource_id": 789,
  "offered_quantity": 10,
  "requested_resource_id": 890,
  "requested_quantity": 5,
  "message": "We have 10 lab kits. Would you exchange them for 5 computer textbooks?"
}
```
**Response:** `201 { "exchange": {...}, "notification": { "sent_to": 42, "type": "new_exchange_offer" } }`

### PUT `/api/exchanges/:id/respond` (NEW)
Respond to an exchange offer (accept / counteroffer / decline).

**Path:** `:id`
**Auth:** required (must be the recipient)
**Request:**
```json
{
  "action": "counteroffer",          // accept | counteroffer | decline
  "message": "We'd accept if you can give 12 kits instead."
}
```
For a counteroffer that changes resource/quantity, additional params:
```json
{
  "action": "counteroffer",
  "offered_resource_id": 789,
  "offered_quantity": 10,
  "requested_resource_id": 890,
  "requested_quantity": 6,
  "message": "..."
}
```
**Response:** `200 { "exchange": {...}, "notification": { ... } }`

### PUT `/api/exchanges/:id/cancel` (NEW)
Initiator cancels exchange before acceptance.

**Path:** `:id`
**Auth:** required (must be initiator)
**Response:** `200 { "exchange": {...} }`

### PUT `/api/exchanges/:id/accept` (NEW) — (Alternative for simple accept, deprecate if respond covers it)

### PUT `/api/exchanges/:id/progress` (NEW)
Mark exchange progress: from ACCEPTED → IN_PROGRESS when both parties confirm handover arranged.

**Request:** `{ "status": "IN_PROGRESS", "handover_notes": "Pickup at main gate, 2pm" }`
**Auth:** required (both parties must call; last call transitions)
**Response:** `200 { "exchange": {...} }`

### PUT `/api/exchanges/:id/complete` (NEW)
Confirm receipt/fulfilment of exchange.

**Path:** `:id`
**Auth:** required
**Request:** `{ "confirmed": true }`
**Response:** `200 { "exchange": {...} }`
(Only finalizes when both parties have confirmed; each party can only confirm their own side's delivery.)

---

## 8. Notification Endpoints (NEW)

### GET `/api/notifications` (NEW)
List current user's notifications.

**Query params:** `?unread_only=true&limit=50&offset=0`
**Auth:** required (own notifications only)
**Response:**
```json
{
  "notifications": [
    {
      "id": 101,
      "type": "exchange_offer",
      "related_type": "exchange",
      "related_id": 55,
      "message": "XYZ College offered to exchange 10 lab kits for 5 computer textbooks",
      "is_read": false,
      "created_at": "2026-10-10T10:00:00.000Z"
    }
  ],
  "unread_count": 3,
  "count": 12
}
```

### PUT `/api/notifications/:id/read` (NEW)
Mark a notification as read.

**Path:** `:id`
**Auth:** required (own notifications)
**Response:** `200 { "notification": {...} }`

### DELETE `/api/notifications/:id` (NEW)
Delete a notification.

**Auth:** required (own notifications)
**Response:** `204`

---

## 9. Message Endpoints

### GET `/api/exchanges/:id/messages` (NEW)
Get messages for an exchange.

**Path:** `:id`
**Auth:** required (must be participant)
**Response:**
```json
{
  "messages": [
    {
      "id": 22,
      "sender": {"id": 12, "displayName": "XYZ College", "organisation_verified": true},
      "content": "Hi, thanks for the offer!",
      "sent_at": "2026-10-10T11:00:00.000Z",
      "read_at": "2026-10-10T11:30:00.000Z"
    }
  ]
}
```

### POST `/api/exchanges/:id/messages` (NEW)
Send a message in an exchange.

**Path:** `:id`
**Auth:** required (must be participant)
**Request:** `{ "content": "We'd like to accept your offer." }`
**Response:** `201 { "message": {...}, "notification": { "sent_to": <other_party>, "type": "new_message" } }`

---

## 10. Admin Endpoints

### GET `/api/admin/stats` (EXISTING)
No changes required; can be extended to include exchange counts in future.

### GET `/api/admin/users` (EXISTING)
No changes.

### DELETE `/api/admin/users/:id` (EXISTING)
No changes.

### POST `/api/admin/verifications/:userId/approve` (NEW)
Approve organisation verification.

**Path:** `:userId`
**Auth:** required (admin)
**Request:** `{ "notes": "Verified via college portal" }`
**Response:** `200 { "success": true, "user": {..., "organisation_verified": true} }`

### POST `/api/admin/verifications/:userId/reject` (NEW)
Reject organisation verification.
**Response:** `200 { "success": true, "user": {..., "organisation_verified": false} }`

### GET `/api/admin/reports/impact` (NEW)
Platform impact report (aggregates completed transfers).

**Auth:** required (admin)
**Response:**
```json
{
  "summary": {
    "total_users": 150,
    "total_resources": 420,
    "completed_donations": 89,
    "completed_exchanges": 34,
    "total_items_redistributed": 12500
  },
  "recent": [
    {"user": "XYZ College", "action": "completed exchange", "items": 10, "date": "2026-10-10"},
    ...
  ]
}
```

---

## 11. Error Response Standards

All errors follow this format:
```json
{
  "error": "Invalid request",
  "code": "VALIDATION_ERROR",     // Optional machine-readable code
  "field": "email",               // Optional, for field-level errors
  "details": []                   // Optional, for validation details
}
```

| HTTP Status | Use case |
|-------------|----------|
| 400 | Bad request, validation error |
| 401 | Missing or invalid token |
| 403 | Insufficient permissions |
| 404 | Resource not found |
| 409 | Conflict (duplicate, already reviewed, double allocation) |
| 422 | Unprocessable (e.g., quantity exceeds available) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

---

## 12. Authentication & Authorization Matrix

| Endpoint | Anon | User | Donor | Recipient | Admin |
|----------|------|------|-------|-----------|-------|
| POST /api/auth/register | ✅ | | | | (code req.) |
| POST /api/auth/login | ✅ | | | | |
| GET /api/auth/me | | ✅ | ✅ | ✅ | ✅ |
| PUT /api/auth/change-password | | ✅ | ✅ | ✅ | ✅ |
| GET /api/users/:id | ✅ | ✅ | ✅ | ✅ | ✅ |
| PUT /api/users/profile | | ✅ | ✅ | ✅ | ✅ |
| GET /api/resources | | ✅ | ✅ | ✅ | ✅ |
| POST /api/resources | | | ✅ | | ✅ |
| PUT/DELETE /api/resources/:id | | | ✅* | | ✅ |
| GET /api/matching | | ✅ | | ✅ | ✅ |
| GET /api/requests | | ✅ | ✅ | ✅ | ✅ |
| POST /api/requests | | | | ✅ | ✅ |
| /api/requests/:id/approve/decline | | | ✅ | | ✅ |
| /api/requests/:id/handover | | | ✅ | | ✅ |
| /api/requests/:id/complete | | | | ✅ | ✅ |
| GET/POST /api/requests/:id/messages | | ✅ | ✅* | ✅* | ✅ |
| GET/POST /api/exchanges | | ✅ | ✅ | ✅ | ✅ |
| /api/exchanges/:id | | ✅ | ✅* | ✅* | ✅* |
| POST /api/exchanges | | ✅ | ✅ | ✅ | |
| PUT /api/exchanges/:id/respond | | ✅ | ✅* | ✅* | ✅* |
| PUT /api/exchanges/:id/cancel | | ✅ | ✅* | | ✅* |
| PUT /api/exchanges/:id/progress | | ✅ | ✅* | ✅* | ✅ |
| PUT /api/exchanges/:id/complete | | ✅ | ✅* | ✅* | ✅ |
| GET/POST /api/exchanges/:id/messages | | ✅ | ✅* | ✅* | ✅ |
| GET /api/notifications | | ✅ | ✅ | ✅ | ✅ |
| PUT/DELETE /api/notifications/:id | | ✅ | ✅ | ✅ | ✅ |
| GET /api/resources/:id/history | | ✅ | ✅ | ✅ | ✅ |
| GET /api/admin/* | | | | | ✅ |

`*` means access restricted to participants in the specific transaction.

---

## 13. Security Considerations

1. **IDOR protection:** Every endpoint verifies the authenticated user owns or participates in the resource requested (never trust `:id`).
2. **Rate limiting:** Add `express-rate-limit` to POST endpoints and auth routes.
3. **Input validation:** Validate all incoming data (type, length, enum values) before DB operations.
4. **SQL injection:** Already mitigated by parameterized queries (existing pattern continues).
5. **XSS:** Frontend `escapeHtml` maintained; backend stores user content with sanitization.
6. **Sensitive data:** Phone/email only served to verified participants.
7. **Audit logging:** All state-changing admin actions logged (new endpoints included).

---

## 14. Rate Limiting (New Middleware)

```
POST /api/*         → 10 requests/minute
PUT /api/*          → 20 requests/minute
GET /api/*          → 60 requests/minute
POST /api/auth/*    → 5 requests/minute
```

---

**API design complete.** Next step: implement new endpoints in server.js and update frontend to consume them.

*Ready for review before implementation.*