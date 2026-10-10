# ReSourceX — Requirements and Gap Analysis
**Version 1.0 · Prepared: October 10, 2026 · Review Deadline: October 29, 2026 (19 days)**

---

## 1. Executive Summary

ReSourceX currently delivers a functional donation-only MVP: donors list surplus resources, recipients browse and request them, donors approve, and handover/completion is tracked. The platform is deployed on Render (Node.js/Express API + Neon PostgreSQL).

This document analyzes the gap between the current implementation and the expanded vision of ReSourceX as a full resource redistribution platform supporting **Donations**, **Exchanges**, and **Requests**, serving **both individuals and organisations**.

The primary recommendation: **implement the Exchange workflow and supporting infrastructure as the core enhancement**, because:
- Exchanges represent a fundamentally different transaction type (two-sided, negotiated, requires agreement from both parties)
- The current donation-only model cannot support the "resource-for-resource" redistribution use case
- Supporting exchanges unlocks the full value proposition of the platform
- The existing codebase has strong patterns (CRUD APIs, role authorization, request state machine) that transfer well

---

## 2. Current System Audit

### 2.1 What Currently Works

| Component | Status | Notes |
|-----------|--------|-------|
| User Authentication | ✅ Working | JWT + bcrypt, email/password, 3 roles (DONOR, RECIPIENT, ADMIN) |
| User Registration | ✅ Working | With admin registration code for admin accounts |
| Resource CRUD | ✅ Working | Create, read, update, delete with ownership checks |
| Donation Request Flow | ✅ Working | RECIPIENT submits → DONOR approves/declines → HANDED_OVER → COMPLETED |
| Duplicate Request Prevention | ✅ Working | Unique constraint on (resource_id, recipient_id) for active requests |
| Smart Matching | ✅ Working | Explainable scoring: 30% category, 20% location, 20% quantity, 15% urgency, 15% availability |
| Admin Dashboard | ✅ Working | User/resource/request moderation + platform statistics |
| Production Deployment | ✅ Working | Render backend + Neon PostgreSQL + Render frontend |
| Frontend Fallback Mode | ✅ Working | localStorage-based offline/demo mode |

### 2.2 Current Schema

```
users
  id, first_name, last_name, email (unique), password_hash, role, created_at

resources
  id, donor_id, name, category, quantity, condition, location, availability,
  description, specifications, status, created_at, updated_at

requests
  id, resource_id, recipient_id, status, urgency, purpose,
  requested_at, reviewed_at, handed_over_at, completed_at
```

### 2.3 Current Resource Lifecycle

```
AVAILABLE → REQUESTED → ALLOCATED → HANDED_OVER → COMPLETED
                         │
                         └→ DECLINED → AVAILABLE
```

### 2.4 Key Limitations vs. Vision

| Area | Current State | Required for Vision |
|------|---------------|---------------------|
| Transaction types | Donation only | Donation + Exchange + Request |
| User profiles | Basic name/email/role | Organisation support, contact, location, privacy controls |
| Two-sided transactions | Not supported | Propose → counteroffer → dual-accept → complete |
| Communication | None | Transaction-based messaging |
| Notifications | In-app alerts only | Persistent notification center + events |
| Location/Maps | Text-based location only | Coordinates, proximity search, map view |
| History/Impact | No completion history | Transfer history, impact metrics |
| Matching | Rule-based, donation-oriented | Rule-based + ML evaluation, exchange-aware |

### 2.5 Known Technical Debt

1. **Frontend duality:** `script.js` contains both live API mode and localStorage fallback mode. This is acceptable for testing but creates maintenance burden; should be made explicit/configurable.
2. **Password reset** is localStorage-based (offline mode only) — not connected to backend.
3. **No rate limiting** on API endpoints.
4. **No audit logging** of actions.
5. **Frontend validation** is inconsistent — backend validation exists but duplicate form submissions can race.
6. **No input sanitization beyond escapeHtml** for backend (description/specifications stored raw).

---

## 3. Functional Requirements (by Module)

### Module 1: User and Organisation Profiles

| ID | Requirement | Priority |
|----|-------------|----------|
| P-01 | Users can be individuals or organisations (organisation type selectable: individual, college, NGO, company, community organisation) | Essential |
| P-02 | Organisation accounts require organisation name and organisation type fields | Essential |
| P-03 | Users can store contact info: email (verified), phone number (optional) | Essential |
| P-04 | Users can store location: country, state, city, area/locality, pickup address | Essential |
| P-05 | Users can optionally store geographic coordinates (lat/long) for proximity matching | Essential |
| P-06 | Privacy controls: users choose whether to show exact or approximate location publicly | Essential |
| P-07 | Contact information (phone, exact address) only revealed to participants after a request/exchange is accepted | Essential |
| P-08 | Users can edit profile and change password | Essential |
| P-09 | Profile visibility: recipients see approximate location + category of profile owner before acceptance | Essential |
| P-10 | Organisation verification status (unverified / verified) — verification can be manual (admin) | High |
| P-11 | Profile has a display name separate from private identity | High |

### Module 2: Resource Management

| ID | Requirement | Priority |
|----|-------------|----------|
| R-01 | Resources can be listed as available for donation, available for exchange (offered), or as a request (needed) | Essential |
| R-02 | Resource has required fields: name, category, quantity | Essential |
| R-03 | Condition tracking with defined enum: New, Excellent, Good, Fair, Poor | Essential |
| R-04 | Availability can be "Available now" or a specific date | Essential |
| R-05 | Resources have location text field (for display) and optional coordinates | Essential |
| R-06 | Description and specifications fields | Essential |
| R-07 | Resources belong to a user (owner/donor) | Essential |
| R-08 | Resource quantity supports partial fulfilment (remaining quantity tracked) | Essential |
| R-09 | Resources have status reflecting their lifecycle | Essential |
| R-10 | Users can update only their own resources | Essential |
| R-11 | Resources with active transactions cannot be modified or deleted | Essential |
| R-12 | Duplicate listing detection (optional: warn if same category + name listed recently) | High |

### Module 3: Donation Workflow

| ID | Requirement | Priority |
|----|-------------|----------|
| D-01 | Recipient can submit a request for an available resource | Essential |
| D-02 | Request includes urgency and purpose | Essential |
| D-03 | Donor can approve or decline pending requests | Essential |
| D-04 | Approving a request allocates the resource (declines other pending requests on the same resource) | Essential |
| D-05 | Declining returns resource to available if no other pending requests | Essential |
| D-06 | Donor can mark approved request as handed over | Essential |
| D-07 | Recipient can confirm receipt to complete the request | Essential |
| D-08 | One active request per (resource, recipient) pair | Essential |
| D-09 | Recipients can see status of all their requests | Essential |
| D-10 | Donors see pending requests with resource context | Essential |
| D-11 | Partial donation quantities supported when resource quantity > requested quantity | High |
| D-12 | Request history viewable by both parties | High |

### Module 4: Exchange Workflow (NEW — Core Feature)

| ID | Requirement | Priority |
|----|-------------|----------|
| X-01 | Users can list a resource as available for exchange (offering it for something) | Essential |
| X-02 | Users can propose an exchange: offer Resource A → request Resource B | Essential |
| X-03 | Exchange offer includes offered quantity and requested quantity | Essential |
| X-04 | Offer can reference another user's listing or describe desired resources freely | Essential |
| X-05 | Counteroffer mechanism: recipient can propose different terms (different resource, different quantity) | Essential |
| X-06 | Both parties must explicitly accept before exchange can proceed | Essential |
| X-07 | Exchange lifecycle: PROPOSED → COUNTERED → ACCEPTED → IN_PROGRESS → COMPLETED / DECLINED / CANCELLED | Essential |
| X-08 | Exchange offers must not allocate offered resources until both parties accept | Essential |
| X-09 | Once both accept, both resources are reserved (no double allocation) | Essential |
| X-10 | Each party can mark their own handover as complete | Essential |
| X-11 | Exchange completes only when both parties confirm receipt | Essential |
| X-12 | Exchange history visible to both participants | High |
| X-13 | Users can cancel a proposed exchange before it's accepted | High |
| X-14 | Declining an exchange returns offered resources to available | High |

### Module 5: Smart Matching

| ID | Requirement | Priority |
|----|-------------|----------|
| M-01 | Rule-based matching score out of 100 with explainable reasons | Essential |
| M-02 | Scoring factors: category, location, quantity, urgency, availability | Essential |
| M-03 | Matching filters by category, search text, location, minimum quantity, urgency | Essential |
| M-04 | Matching supports both donation-oriented and exchange-oriented queries | Essential |
| M-05 | Distance-based sorting (nearest first) where coordinates available | Essential |
| M-06 | Results ranked highest to lowest score | Essential |
| M-07 | Matching respects privacy (no exact location shown to non-participants) | Essential |
| M-08 | ML recommendation layer evaluated vs. rule-based baseline (research prototype) | Advanced |

### Module 6: Location and Maps

| ID | Requirement | Priority |
|----|-------------|----------|
| L-01 | Recipients can filter resources by city/locality | Essential |
| L-02 | Recipients can search resources within a distance radius | Essential |
| L-03 | Resources show distance from recipient location | Essential |
| L-04 | Map view toggle: list ↔ map displaying approximate resource locations | High |
| L-05 | Map uses free/open data (OpenStreetMap) with free library (Leaflet) | High |
| L-06 | Exact coordinates only shown to transaction participants | Essential |
| L-07 | Pickup point can be specified/edited during coordination | High |
| L-08 | Directions integration (link to map app) | Medium |

### Module 7: Communication and Notifications

| ID | Requirement | Priority |
|----|-------------|----------|
| N-01 | Persistent in-app notifications (stored in database, not just browser memory) | Essential |
| N-02 | Notification includes: type, related transaction id, message, timestamp, read status | Essential |
| N-03 | Users see all notifications with unread indicator | Essential |
| N-04 | Mark notifications as read | Essential |
| N-05 | Notification events for donations: new request, approved, declined, handed over, completed | Essential |
| N-06 | Notification events for exchanges: offer received, counteroffer, accepted, both handed over, completed | Essential |
| N-07 | Transaction-based messaging between participants | Essential |
| N-08 | Messages link to specific request or exchange id | Essential |
| N-09 | Message access restricted to transaction participants only | Essential |
| N-10 | Message timestamped and sender identified | Essential |
| N-11 | Email notifications as time-permitting | High |

### Module 8: Resource History and Impact

| ID | Requirement | Priority |
|----|-------------|----------|
| I-01 | Users can view their completed transfers (history) | Essential |
| I-02 | Completed transfers record: resource, counterparty, date, type (donation/exchange) | Essential |
| I-03 | Impact metrics: total resources donated/exchanged, items diverted from waste | High |
| I-04 | Organisation-level impact summaries | High |
| I-05 | Resource passport: full history of a resource across transfers | High |

### Module 9: Machine Learning (Advanced / Evaluative)

| ID | Requirement | Priority |
|----|-------------|----------|
| ML-01 | ML component evaluated against rule-based baseline using defined metrics | Research |
| ML-02 | Prediction target selected explicitly (e.g., "will request be accepted") | Research |
| ML-03 | Limitations documented: sparse data, cold start, fairness | Research |
| ML-04 | No black-box claims; any ML ranking clearly labeled as experimental | Research |
| ML-05 | Privacy-preserving data handling | Research |

---

## 4. Gap Analysis Matrix

| Feature Area | Current | Required | Gap Severity | Recommended Approach |
|--------------|---------|----------|--------------|---------------------|
| Exchange transactions | None | Full exchange workflow with counteroffers, dual acceptance | **Critical** | New module: exchanges, exchange offers, responses, completion |
| User profiles | name/email/role only | Organisation type, contact, location, privacy | **High** | Add columns to users; update registration/profile endpoints |
| Notification system | In-app alerts | Persistent notification table + events | **High** | New notifications table; hook into request/exchange events |
| Messaging | None | Transaction-based messaging | **High** | New messages table with access control |
| Location/Maps | Text only | Coordinates, proximity, map view | **Medium** | Add lat/long to users/resources; Leaflet integration |
| History/Impact | None | Transfer history, impact metrics | **Medium** | Leverage existing request lifecycle + new history aggregation |
| Matching | Rule-based, donation-only | Exchange-aware, distance-based | **Medium** | Extend /api/matching with exchange logic and distance calculation |
| ML recommendations | None | Research prototype only | **Low (conditional)** | Evaluate feasibility; if time permits, build small evaluated prototype |

---

## 5. Decision Points Requiring User Confirmation

| # | Decision | Recommendation | Options |
|---|----------|----------------|---------|
| 1 | Primary audience | Both individuals and organisations | Individual-only vs. Organisation-only vs. Both (both recommended for maximum demonstration scope) |
| 2 | Exchange payment | No money in core workflow | Resource-only exchange vs. Money-enabled marketplace |
| 3 | Exchange model | Donations + exchanges, no paid transactions | Option A/B/C from vision |
| 4 | ML investment | Research prototype, not production claim | Full implementation vs. Prototype vs. Skip |
| 5 | Notification delivery | In-app first, email time-permitting | In-app only vs. In-app + email vs. Real-time WebSocket |

---

## 6. Timeline Reality Check (19 Days)

**Aggressive but achievable if scope is managed:**

| Sprint | Duration | Focus |
|--------|----------|-------|
| Sprint 1 | Days 1–4 | Exchange core: schema, API, basic flow |
| Sprint 2 | Days 5–8 | Notifications + messaging |
| Sprint 3 | Days 9–12 | Location, matching, impact |
| Sprint 4 | Days 13–19 | Profiles enhancement, maps, polish, testing, review prep |

**Must-decide early:** ML feature scope (recommend: minimal/no ML implementation; improve rule-based matching instead).

**Descope if behind:** Email notifications, organisation verification, map view, advanced filtering, ML prototype.

---

## 7. Immediate Next Steps (Upon Approval)

1. Review and approve this document.
2. Approve the 4-sprint plan.
3. Begin database schema design (Phase 1 deliverable).

---

*Prepared October 10, 2026. Pending user approval before any code changes.*
