# ReSourceX

ReSourceX is a surplus-resource exchange platform connecting donors with recipients who need resources. It supports JWT authentication, role-based access, explainable smart matching, request approval, physical handover tracking, receipt confirmation, and administrator monitoring.

## Live Deployment

- **Frontend:** https://resourcex-frontend.onrender.com
- **Backend health check:** https://resourcex-hjz9.onrender.com/api/health
- **Production database:** Neon PostgreSQL
- **Hosting:** Render

The current deployment is a **working MVP suitable for demonstration and small pilot testing**. It is not yet intended for unrestricted public use.

## Core Features

### Donors

- Register and sign in
- Add, edit, and manage surplus resources
- View live resource inventory and statistics
- Review incoming recipient requests
- View request urgency and purpose
- Approve or decline requests
- Mark approved allocations as handed over
- Track resource status through the fulfillment lifecycle
- View resource details and activity

### Recipients

- Register and sign in
- Browse available resources
- Search and filter by category, location, and quantity
- Specify pickup location, quantity needed, and urgency
- See ranked match percentages and explainable match reasons
- Submit requests with a purpose and urgency
- Track request approval and allocation status
- Confirm receipt after physical handover

### Administrators

- View users, resources, and requests
- View platform statistics
- Monitor request lifecycle statuses
- Remove users or resources where permitted
- Access is protected by administrator role authorization

## Request & Fulfillment Flow

The platform supports the complete request lifecycle:

```text
AVAILABLE
    ↓
REQUESTED
    ↓
ALLOCATED
    ↓
HANDED_OVER
    ↓
COMPLETED

REQUESTED ──→ DECLINED ──→ AVAILABLE
```

The backend protects the lifecycle with role authorization and transactional updates. A donor can approve or decline a request, an approved donor can mark the resource as handed over, and the recipient can confirm receipt to complete the allocation.

## Smart Matching

ReSourceX uses an explainable, rule-based matching algorithm rather than an opaque recommendation model.

The backend calculates a score out of 100 using:

| Matching factor | Weight |
|---|---:|
| Category | 30 points |
| Location | 20 points |
| Quantity | 20 points |
| Urgency | 15 points |
| Availability | 15 points |
| **Total** | **100 points** |

The matching API returns:

- `matchScore`
- `matchReasons`

Recommendations are sorted from highest to lowest score. Availability is evaluated using the resource's availability date/value, and unavailable resources are excluded from recommendations.

## Handover & Receipt Tracking

The current MVP supports physical fulfillment after approval:

1. Recipient submits a request with a purpose and urgency.
2. Donor reviews the request.
3. Donor approves or declines it.
4. An approved resource becomes allocated.
5. Donor marks the resource as handed over.
6. Recipient confirms receipt.
7. The request and resource become completed.

The current UI provides status and action controls for this flow. A more detailed dedicated handover screen is planned as the next fulfillment-UX improvement, including clearer presentation of:

- Recipient name
- Request purpose
- Urgency
- Pickup location
- Handover instructions
- Approval status
- Donor/resource information
- Recipient confirmation

Personal information should be minimized and exposed only when necessary for fulfillment.

## Technology

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js, Express
- **Database:** PostgreSQL
- **Authentication:** JWT and bcrypt
- **Production hosting:** Render
- **Production database hosting:** Neon PostgreSQL

## Project Structure

```text
ReSourceX/
├── frontend/
│   ├── index.html
│   ├── donor_dashboard.html
│   ├── recipient_dashboard.html
│   ├── admin_dashboard.html
│   ├── add_resource.html
│   ├── resource_details.html
│   ├── request_confirmation.html
│   ├── script.js
│   └── style.css
├── backend/
│   ├── server.js
│   ├── schema.sql
│   ├── migrations/
│   ├── package.json
│   └── .env.example
└── README.md
```

## Run Locally

### Backend

```powershell
cd backend
npm install
```

Create `backend/.env` from `.env.example` and configure PostgreSQL, JWT, CORS, and the administrator registration code.

Initialize a new database:

```powershell
psql "$env:DATABASE_URL" -f schema.sql
```

For an existing database, also apply the handover migration:

```powershell
psql "$env:DATABASE_URL" -f migrations/phase4_handover.sql
```

Start the API:

```powershell
npm run dev
```

The local API runs at `http://localhost:5000`.

### Frontend

Serve `frontend/` with VS Code Live Server.

The frontend uses the production API by default and supports the `window.RESOURCEX_API_URL` override for local development.

For local frontend + backend testing, configure the frontend API override to use:

```text
http://localhost:5000/api
```

The backend CORS configuration supports both:

```text
http://localhost:5500
http://127.0.0.1:5500
```

## API Overview

```text
GET    /api/health

POST   /api/auth/register
POST   /api/auth/login
GET    /api/auth/me

GET    /api/resources
GET    /api/resources/:id
POST   /api/resources
PUT    /api/resources/:id
DELETE /api/resources/:id

GET    /api/matching

GET    /api/requests
POST   /api/requests
PUT    /api/requests/:id/approve
PUT    /api/requests/:id/decline
PUT    /api/requests/:id/handover
PUT    /api/requests/:id/complete

GET    /api/admin/users
GET    /api/admin/stats
DELETE /api/admin/users/:id
```

Protected endpoints require:

```text
Authorization: Bearer <jwt>
```

## Environment Variables

```env
DATABASE_URL=postgresql://user:password@host:5432/resourcex
PORT=5000
NODE_ENV=development
JWT_SECRET=replace-with-a-long-random-secret
CORS_ORIGIN=http://localhost:5500,http://127.0.0.1:5500
ADMIN_REGISTRATION_CODE=choose-a-private-code
```

Never commit `.env` files or production credentials.

## Testing & Validation

The project has been tested across the main backend and frontend flows, including:

- Authentication and JWT sessions
- Role-based authorization
- Resource creation and validation
- Request creation and validation
- Explainable smart matching
- Duplicate active-request protection
- Resource ownership boundaries
- Request approval and decline
- Handover and receipt completion
- Invalid IDs and malformed input handling
- Render and Neon connectivity
- JavaScript syntax validation
- Workspace diagnostics
- Git diff validation

## Current Project Status

### Completed

- Frontend prototype and dashboards
- Backend REST API
- PostgreSQL persistence
- JWT authentication and bcrypt password hashing
- Donor, recipient, and administrator roles
- Resource management
- Request lifecycle
- Transactional resource allocation
- Explainable smart matching
- Handover and receipt confirmation
- Render + Neon deployment
- Production API health check

### Next Improvement: Fulfillment UX

The next coding task is to make the handover process clearer and more realistic by creating a dedicated handover/receipt experience.

The donor-side experience should clearly show:

- Recipient name
- Request purpose
- Urgency
- Pickup location
- Handover instructions
- Mark as handed over

The recipient-side experience should clearly show:

- Approval status
- Donor/resource information
- Pickup location
- Request purpose
- Confirm received

The interface should avoid exposing unnecessary personal information.

## Real-World Readiness Roadmap

The MVP works technically, but unrestricted public deployment requires additional operational, privacy, and trust features.

### 1. Complete fulfillment UX

- Add the dedicated handover screen
- Show request purpose clearly to donors
- Show pickup and handover information to both parties
- Improve approval, handover, and receipt states

### 2. User and organization verification

- Verify donor identities where appropriate
- Verify recipient organizations/community groups
- Introduce trust indicators without exposing unnecessary personal information

### 3. Notifications

- Add email notifications
- Add optional in-app notifications
- Notify users about request submission, approval, decline, handover, and completion

### 4. Safe messaging or contact exchange

- Provide a controlled way for donors and recipients to coordinate handover
- Avoid exposing private contact information by default

### 5. Moderation and reporting

- Report inappropriate resources or users
- Add moderation workflows
- Handle abuse and suspicious activity

### 6. Audit logs and dispute handling

- Record important lifecycle events
- Provide an audit trail for administrative review
- Add a process for disputed handovers or incorrect completion confirmations

### 7. Privacy and account controls

- Add a privacy policy
- Add terms of service
- Add consent notices where required
- Add account deletion and data-deletion workflows
- Minimize collection and exposure of personal information

### 8. Production operations and security

Before unrestricted public use, add:

- Rate limiting
- Production logging
- Monitoring and alerting
- Database backups
- Recovery procedures
- Strong production secrets
- Additional security testing

### 9. Small pilot

Run a controlled pilot with one:

- College
- NGO
- Local community

Measure:

- Successful resource handovers
- Request completion rate
- Matching usefulness
- User drop-off points
- Operational issues
- Trust and safety concerns

### 10. Iterate before scaling

Use pilot feedback to improve:

- Matching weights
- User experience
- Verification
- Notifications
- Fulfillment workflows
- Moderation

Only after these improvements should ReSourceX be considered for broader public use.

## Project Positioning

ReSourceX is currently best described as a **working full-stack MVP for demonstration and pilot testing**.

It already demonstrates the core technical workflow:

```text
Authentication
    ↓
Resource Listing
    ↓
Smart Matching
    ↓
Request
    ↓
Approval / Decline
    ↓
Allocation
    ↓
Physical Handover
    ↓
Receipt Confirmation
    ↓
Completion
```

The remaining work is primarily focused on **trust, safety, communication, privacy, operational reliability, and a stronger real-world fulfillment experience** rather than replacing the core architecture.
