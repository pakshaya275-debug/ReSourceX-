# ReSourceX Backend

Node.js and Express REST API backed by PostgreSQL.

## Local Setup

```powershell
cd backend
npm install
```

Create `.env` from `.env.example` and configure `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`, and `ADMIN_REGISTRATION_CODE`.

Initialize a new database:

```powershell
psql "$env:DATABASE_URL" -f schema.sql
```

For an existing database created before handover support, apply:

```powershell
psql "$env:DATABASE_URL" -f migrations/phase4_handover.sql
```

Start the development server:

```powershell
npm run dev
```

The API runs on `http://localhost:5000` by default. Health check:

```text
GET /api/health
```

## Authentication

Register or log in to receive a JWT. Send it with protected requests:

```text
Authorization: Bearer <jwt>
```

Roles are `DONOR`, `RECIPIENT`, and `ADMIN`. Administrator registration requires `ADMIN_REGISTRATION_CODE`.

## API Routes

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/resources`
- `GET /api/resources/:id`
- `POST /api/resources` - donor/admin
- `PUT /api/resources/:id` - owner/admin
- `DELETE /api/resources/:id` - owner/admin
- `GET /api/matching` - recipient/admin
- `GET /api/requests`
- `POST /api/requests` - recipient
- `PUT /api/requests/:id/approve` - donor/admin
- `PUT /api/requests/:id/decline` - donor/admin
- `PUT /api/requests/:id/handover` - donor/admin
- `PUT /api/requests/:id/complete` - recipient/admin
- `GET /api/admin/users` - admin
- `GET /api/admin/stats` - admin
- `DELETE /api/admin/users/:id` - admin

## Deployment

The production backend is hosted on Render and uses Neon PostgreSQL. Production requires a strong `JWT_SECRET`, a production `DATABASE_URL`, an explicit frontend `CORS_ORIGIN`, and an administrator registration code.

Never commit `.env` files or credentials.
