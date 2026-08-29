# ReSourceX Backend

Node.js + Express REST API backed by PostgreSQL.

## Run locally

1. Install dependencies:

   ```bash
   cd backend
   npm install
   ```

2. Copy the environment template and set your database credentials:

   ```bash
   cp .env.example .env
   ```

3. Create the tables:

   ```bash
   psql "$DATABASE_URL" -f schema.sql
   ```

4. Start the API:

   ```bash
   npm start
   ```

The health check is available at `GET /api/health`.

## Authentication

Register and log in to receive a JWT. Send it on protected requests as:

```
Authorization: Bearer <token>
```

Roles are `DONOR`, `RECIPIENT`, and `ADMIN`. Admin registration requires `ADMIN_REGISTRATION_CODE`.

## API routes

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/resources`
- `GET /api/resources/:id`
- `POST /api/resources` — donor/admin
- `PUT /api/resources/:id` — owner/admin
- `DELETE /api/resources/:id` — owner/admin
- `GET /api/requests`
- `POST /api/requests` — recipient
- `PUT /api/requests/:id/approve` — donor/admin
- `PUT /api/requests/:id/decline` — donor/admin
- `GET /api/matching` — explainable category, quantity, condition, location, and availability scoring

The existing static frontend still uses localStorage. The next integration step is to replace those storage helpers with calls to these endpoints and persist the returned JWT in the browser.
