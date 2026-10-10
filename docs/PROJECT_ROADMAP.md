# ReSourceX — Project Plan and Current-State Audit

**Status:** Phase 1 — planning and analysis  
**Scope:** Donations + resource-for-resource exchange (no money in the core workflow)  
**Intended users:** Individuals and community organisations, including colleges and NGOs  
**Implementation rule:** Audit and agree on the data model/API before adding features. Preserve the existing HTML/CSS/JavaScript frontend, Express API, PostgreSQL database, and current donation flow.

## 1. Project goal

ReSourceX helps people and organisations redistribute useful surplus resources. A user can donate a resource or propose a direct resource-for-resource exchange. Recipients should be able to discover relevant resources, understand why a match is recommended, communicate safely with the other party, and track an agreed transfer through completion.

The differentiator should be demonstrable system behaviour—not just another donor/recipient interface:
- explainable, need-driven matching;
- explicit consent and approval before a transfer;
- safe state transitions and a traceable transaction history;
- exchange offers with accept, decline, and (if feasible) counter-offer;
- privacy-aware contact/location sharing; and
- impact counts based on completed transactions.

## 2. Current-state audit (based on repository files inspected)

### Already present in the codebase
- HTML/CSS/JavaScript frontend under frontend/.
- Node.js/Express backend under backend/server.js.
- PostgreSQL schema in backend/schema.sql.
- JWT authentication and bcrypt password hashing are configured in the backend.
- User roles currently include DONOR, RECIPIENT, and ADMIN.
- Resource records currently contain name, category, quantity, condition, location, availability, description, specifications, and status.
- Donation/request lifecycle fields and statuses exist in the schema.
- The README documents weighted, explainable rule-based matching and handover/receipt confirmation.
- Render deployment and Neon PostgreSQL are documented in the README.

### Gaps to verify or address before adding features
- The current schema has no dedicated profile/contact fields, latitude/longitude, exchange offers, messages, or persistent notifications.
- The frontend JavaScript API-client comment says resource data remains local for now. This conflicts with the README's description of an API-backed end-to-end flow, so Phase 2 must trace each screen and endpoint and remove any misleading documentation only after verifying the implementation.
- Dashboard notification buttons and settings links are present in the HTML, but their presence alone does not mean notifications/settings are implemented.
- Location is currently a text field in the resource schema; map-based nearby search needs a reviewed location/privacy design.
- The matching approach documented today is rule-based. Machine learning is a future experiment, not an existing feature, unless a trained model and evaluation are added and verified.
- The current schema is donation/request-oriented; exchange needs a separate offer/agreement model rather than overloading donation request statuses.

## 3. Functional requirements

### Profiles and privacy
- Support individual and organisation/community users without making organisation verification claims unless verification is implemented.
- Add editable contact and pickup-area details.
- Do not show a user's full private address or phone number to everyone. Reveal contact/pickup details only to authorised transaction participants when needed.
- Validate inputs and restrict profile access to the authenticated owner/admin.

### Donations
- Preserve the existing resource listing, request, donor approval/decline, handover, and recipient receipt-confirmation flow.
- Ensure resource/request state changes are authorised, consistent, and resistant to duplicate or competing requests.
- Make transaction status and next action clear to both parties.

### Resource exchange
- Let a user offer one of their listed resources in return for another resource; no money/payment flow in this scope.
- Record the offered resource, requested resource, quantities, message, participants, status, and timestamps.
- Support offer, accept, decline, and counter-offer if the transaction design can safely support it.
- Require agreement before either transfer is treated as committed.
- Track both sides of the exchange and completion confirmations. Prevent the same resource quantity from being committed to multiple active transactions.

### Discovery and matching
- Keep explainable rule-based matching as the baseline.
- Explain score contributions in plain language and test ranking quality with representative cases.
- Add map/radius discovery only after deciding how coordinates are collected, geocoded, stored, and hidden from unauthorised users.
- Attribute map/tile/geocoding providers correctly and follow their usage policies.

### Communication and notifications
- Start with persistent in-app notifications generated by backend events, with read/unread state.
- Add transaction-scoped messaging so only the participants (and authorised administrators where justified) can access a conversation.
- Validate and safely render messages; add basic report/block or moderation handling before broad public use.
- Treat email, push, and real-time delivery as later extensions, not prerequisites for the first working version.

### Machine learning and impact
- Do not label the current weighted rules as machine learning.
- First establish test cases and baseline ranking metrics. Only build an ML experiment if appropriate labelled/historical data is available, and compare it against the baseline.
- Track impact using completed donations/exchanges, quantities redistributed, and other metrics that the database can substantiate—not clicks or merely accepted requests.

## 4. Delivery phases

### Phase 1 — Planning and analysis (current)
- Record scope, existing implementation, gaps, requirements, and dependencies.
- Keep feature code unchanged until the API/data model is reviewed.

### Phase 2 — Implementation audit and baseline stabilisation
- Trace frontend calls against backend routes and database operations.
- Verify registration/login, resource CRUD, matching, request approval, handover, and receipt confirmation.
- Fix mismatches and add a repeatable manual/API test checklist before expanding the schema.

### Phase 3 — Profiles and contact preferences
- Design and migrate profile fields, validation, privacy rules, and profile APIs.
- Add editable contact/pickup-area details without exposing private information publicly.

### Phase 4 — Exchange workflow
- Design exchange-offer tables and safe transaction/state transitions.
- Implement offer, response, agreement, transfer, and completion flows; add concurrency/duplicate tests.

### Phase 5 — Discovery, maps, and matching
- Add coordinates and nearby/radius search with privacy safeguards.
- Keep rule-based explainable matching as the measured baseline; assess ML feasibility using real test data.

### Phase 6 — Messaging and notifications
- Add participant-authorised conversations and persistent in-app notifications.
- Connect notifications to request/exchange state changes and test access controls.

### Phase 7 — Impact, security, and final verification
- Add evidence-based impact metrics, validation, error handling, audit history, and regression tests.
- Verify deployment configuration and document known limitations and demo steps.

**Sequencing note:** The phases can be adjusted after the Phase 2 audit. Do not build maps, ML, or real-time messaging before the underlying profile, transaction, and API contracts are stable.

## 5. Acceptance criteria for the expanded project

- A donation can move from request to donor approval, handover, and recipient confirmation without bypassing backend permissions.
- A resource exchange is distinguishable from a donation and records both agreed sides of the exchange.
- Competing transactions cannot allocate the same resource quantity beyond what is available.
- Private contact/location data is not exposed in public resource listings or to unrelated users.
- Matching explanations correspond to the actual score calculation.
- Notifications are stored persistently and only visible to their intended user.
- Messages are visible only to conversation participants.
- ML is described as experimental unless trained and evaluated; baseline comparisons are documented.
- Tests cover success, rejection, unauthorised actions, duplicate actions, and invalid input for the main flows.

## 6. Immediate next task

**Phase 2 begins with an implementation audit, not new feature code.** Map every frontend action to its API endpoint and database effect, identify any local-only/mock paths, then stabilise and test the existing donation lifecycle. This avoids layering exchange, maps, and messaging on top of inconsistent state.
