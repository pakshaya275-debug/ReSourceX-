# ReSourceX Enhancement Plan
## Final Review Deadline: October 29, 2026 (19 days)

### Executive Summary
This plan outlines the enhancement of ReSourceX from a donation-only MVP to a comprehensive resource redistribution platform supporting donations, exchanges, and requests, based on the audit of the current implementation and the vision provided.

### Current State Audit
**Working Components:**
- ✅ User authentication (donor/recipient/admin roles)
- ✅ Resource management (create, view, update, delete)
- ✅ Donation/request workflow (request → approve → handover → complete)
- ✅ Explainable matching algorithm (30% category, 20% location, 20% quantity, 15% urgency, 15% availability)
- ✅ Admin dashboard with statistics and moderation
- ✅ Production deployment (Render + Neon PostgreSQL)

**Limitations to Address:**
- ❌ Exchange functionality (only donations exist)
- ❌ Basic user profiles (needs organization support, contact info, location details)
- ❌ No communication system between users
- ❌ No persistent notification system
- ❌ No impact tracking or history
- ❌ No location/maps integration
- ❌ No ML recommendations (only rule-based matching)

### Functional Requirements

#### 1. User and Organisation Profiles
**Essential Features:**
- Support for individual and organisation accounts
- Organisation type: college, NGO, company, community organisation
- Contact information: email, phone (with privacy controls)
- Location: country, state, city, area/locality, pickup address
- Privacy: approximate location display until transaction accepted
- Profile picture/organisation logo
- Account settings: edit profile, change password, notification preferences

#### 2. Resource Management Enhancement
**Essential Features:**
- Support for both donation and exchange resource listings
- Enhanced condition tracking (Poor, Fair, Good, Excellent, New)
- Availability dates (specific dates or "available now")
- Quantity tracking with partial allocation support
- Resource specifications/description fields

#### 3. Donation and Exchange Workflows
**Donation Workflow (Enhanced):**
```
List Resource → Find Match → Submit Request → Donor Approves → Arrange Handover → Confirm Receipt
```

**Exchange Workflow (New Core Feature):**
```
List Available Resource → Propose Exchange → Review Offer → Accept/Counteroffer/Decline → 
Confirm Agreement → Transfer Resources → Confirm Completion
```

**Exchange Offer Structure:**
- Requested resource (what user wants to receive)
- Offered resource (what user is willing to give)  
- Offered quantity
- Desired quantity
- Condition of both resources
- Location for exchange
- Message/notes
- Status (proposed, countered, accepted, completed, declined)

**Critical Rules:**
- Both parties must agree for exchange to complete
- System prevents double allocation of resources
- Supports partial exchanges
- Transaction types: DONATION and EXCHANGE

#### 4. Smart Matching
**Essential Features:**
- Maintain current explainable scoring algorithm
- Support exchange matching (matching offered resources to requested resources)
- Location-based filtering and sorting
- Category compatibility checking
- Quantity sufficiency validation
- Urgency consideration

#### 5. Location and Maps
**High Priority Features:**
- Nearby resource discovery (within specified radius)
- Map view toggle (list ↔ map)
- Approximate location display for privacy
- Pickup coordination assistance
- Integration with OpenStreetMap/Leaflet (free tier)

#### 6. Communication and Notifications
**High Priority Features:**
- Transaction-based messaging (context of specific request/exchange)
- Persistent notification center (in-app)
- Notification events:
  - New request/exchange offer
  - Approval/declination
  - Counteroffer submission
  - Exchange agreement
  - Handover recorded
  - Receipt confirmed
- Read/unread status for notifications

#### 7. Resource History and Impact
**High Priority Features:**
- Completed transfer history for users
- Impact metrics (resources diverted from waste, etc.)
- Organization impact dashboards
- Transaction completion tracking

#### 8. Machine Learning Recommendations
**Advanced/Evaluative Features:**
- Research prototype only if feasible within timeline
- Comparison with rule-based baseline
- Clear documentation of limitations and evaluation
- No unexplained "black box" claims

### Prioritised Agile Backlog (19-Day Sprint Plan)

**Sprint 1: Foundation & Exchange Core (Days 1-4)**
- Database schema enhancements for exchanges and profiles
- Exchange transaction model and API endpoints
- Basic exchange workflow implementation
- User profile enhancements (organisation type, location fields)

**Sprint 2: Communication & Notifications (Days 5-8)**
- Transaction-based messaging system
- Persistent notification center and API
- Notification event implementation
- UI for messages and notifications

**Sprint 3: Location & Impact (Days 9-12)**
- Maps integration (OpenStreetMap/Leaflet)
- Nearby resource discovery
- Location-based filtering
- Impact tracking and history
- Completed transfer recording

**Sprint 4: Polish & Preparation (Days 13-19)**
- Exchange workflow refinement and testing
- Privacy controls and location approximation
- UI/UX improvements across all new features
- Testing, bug fixes, and deployment preparation
- Documentation and final review preparation

### Database Schema Changes Required

1. **Enhanced Users Table:**
   - organisation_name, organisation_type
   - phone_number, latitude, longitude
   - location_privacy_setting (exact/approximate/none)
   - organisation_verified (boolean)
   - profile_picture_url

2. **New Tables:**
   - `exchanges`: id, offered_resource_id, requested_resource details, status, etc.
   - `exchange_messages`: id, exchange_id, sender_id, content, timestamp, read_status
   - `notifications`: id, user_id, type, related_id, message, timestamp, read_status
   - `resource_history`: id, resource_id, action, performed_by, timestamp, details

3. **Enhanced Resources Table:**
   - availability_date (date)
   - condition_enum (Poor/Fair/Good/Excellent/New)
   - specifications enhancements

### API Endpoints to Implement

**Exchange Management:**
- POST /api/exchanges (propose exchange)
- GET /api/exchanges (get user's exchanges)
- GET /api/exchanges/:id (get exchange details)
- PUT /api/exchanges/:id/respond (accept/counteroffer/decline)
- PUT /api/exchanges/:id/complete (mark exchange complete)
- GET /api/exchanges/:id/messages (get exchange messages)
- POST /api/exchanges/:id/messages (send message in exchange)

**Notifications:**
- GET /api/notifications (get user's notifications)
- PUT /api/notifications/:id/read (mark notification as read)
- DELETE /api/notifications/:id (delete notification)

**Enhanced Profiles:**
- PUT /api/users/profile (update profile)
- GET /api/users/:id (get user profile - with privacy controls)

### ML Feasibility Assessment

Given the 19-day timeline and need for proper evaluation:
- **Not Recommended:** Full ML implementation with training/evaluation
- **Alternative:** Research prototype using small sample dataset with clear documentation
- **Focus:** Improve rule-based matching with additional factors (response time, historical success rates)
- **Documentation:** Clearly explain limitations and evaluation methodology

### Success Criteria for October 29 Review

**Must Have (Core Exchange Platform):**
1. Working exchange workflow (propose → respond → complete)
2. Enhanced user profiles with organisation support
3. Transaction-based messaging
4. Persistent notification system
5. Basic location/distance filtering
6. Impact tracking for completed transfers

**Should Have (Enhanced Experience):**
1. Map view for resource discovery
2. Organisation verification indicators
3. Privacy controls for location/contact info
4. Enhanced resource details (condition, availability dates)

**Could Have (Time Permitting):**
1. ML research prototype with evaluation
2. Advanced filtering options
3. Email notifications
4. Resource passport/history view

### Risk Mitigation

1. **Scope Creep:** Strict adherence to prioritised backlog
2. **Technical Complexity:** Exchange workflow is most complex - tackle early
3. **Integration Risks:** Use well-documented libraries (Leaflet, OpenStreetMap)
4. **Timeline Pressure:** Daily progress checkpoints, ready to desccope lower priority items

### Next Immediate Steps (Upon Approval)

1. Database migration scripts for enhanced schema
2. Exchange model and service layer implementation
3. Profile enhancement API endpoints
4. Basic exchange proposal UI

This plan ensures we deliver a meaningful enhancement focused on the core exchange functionality while maintaining the existing donation workflow, all within the 19-day timeline.

---
*Plan created: October 10, 2026*
*For review and approval before implementation begins*