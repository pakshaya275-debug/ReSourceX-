# ReSourceX

ReSourceX is a surplus-resource exchange platform connecting donors with recipients who need resources. It supports explainable matching, request approval, physical handover tracking, and administrator monitoring.

## Live Deployment

- Frontend: https://resourcex-frontend.onrender.com
- Backend health check: https://resourcex-hjz9.onrender.com/api/health
- Production database: Neon PostgreSQL
- Hosting: Render

## Features

### Donors

- Register and sign in
- Add and manage resources
- View live resource inventory and statistics
- Review, approve, or decline recipient requests
- Mark approved resources as handed over
- View resource details and activity

### Recipients

- Browse available resources
- Search and filter by category, location, and quantity
- Set urgency requirements
- See ranked match percentages and explanations
- Submit requests with a purpose and urgency
- Confirm receipt after handover

### Administrators

- View users, resources, and requests
- View platform statistics
- Monitor request lifecycle statuses
- Remove users or resources where permitted
- Access is protected by administrator role authorization

## Resource Lifecycle

```text
AVAILABLE -> REQUESTED -> ALLOCATED -> HANDED_OVER -> COMPLETED
                         |
                         +-> DECLINED -> AVAILABLE
```

## Smart Matching

The backend calculates an explainable score out of 100 using:

- Category: 30 points
- Location: 20 points
- Quantity: 20 points
- Urgency: 15 points
- Availability: 15 points

The API returns both `matchScore` and `matchReasons`, and sorts recommendations from highest to lowest score.

## Technology

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js, Express
- Database: PostgreSQL
- Authentication: JWT and bcrypt
- Production hosting: Render
- Production database hosting: Neon

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

For an existing database, also apply:

```powershell
psql "$env:DATABASE_URL" -f migrations/phase4_handover.sql
```

Start the API:

```powershell
npm run dev
```

The local API runs at `http://localhost:5000`.

### Frontend

Serve `frontend/` with VS Code Live Server. The frontend uses the production API by default and supports the `window.RESOURCEX_API_URL` override for local development.

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

## Testing

The project has been tested for authentication, role authorization, resource and request validation, smart matching, duplicate requests, ownership boundaries, approval/handover/completion, malformed JSON, invalid IDs, and Render/Neon connectivity.

## Production Readiness Roadmap

The current deployment is a working MVP. Before unrestricted public use, add:

- Email or in-app notifications
- Verified donor and recipient organizations
- Safe messaging or contact exchange
- Moderation, reporting, and dispute handling
- Privacy policy, terms, and account deletion
- Rate limiting, backups, monitoring, and audit logs
- A small community or NGO pilot
