require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { initExchangesRouter } = require("./routes/exchanges");

const app = express();
const port = Number(process.env.PORT || 5000);
const isProduction = process.env.NODE_ENV === "production";
const startedAt = Date.now();

// Configuration checks. Production refuses to start with weak or missing settings.
const configProblems = [];
if (isProduction) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) configProblems.push("JWT_SECRET must be set and at least 32 characters long");
  if (!process.env.DATABASE_URL && !process.env.PGPASSWORD) configProblems.push("DATABASE_URL (or PGPASSWORD) must be set");
  if (!process.env.CORS_ORIGIN) configProblems.push("CORS_ORIGIN must list the frontend origin(s)");
  if (process.env.ADMIN_REGISTRATION_CODE && process.env.ADMIN_REGISTRATION_CODE.length < 12) configProblems.push("ADMIN_REGISTRATION_CODE must be at least 12 characters");
}
if (configProblems.length) throw new Error("Invalid configuration: " + configProblems.join("; "));
const jwtSecret = process.env.JWT_SECRET || "development-only-change-me";
if (!process.env.JWT_SECRET) console.warn("JWT_SECRET is not set. Use a strong secret outside local development.");

const pool = new Pool(Object.assign(process.env.DATABASE_URL ? {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : (isProduction ? { rejectUnauthorized: false } : false)
} : {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "resourcex",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres"
}, { max: Number(process.env.PG_POOL_MAX || 10), idleTimeoutMillis: 30000, statement_timeout: 15000 }));
// An idle connection dropped by the database must not crash the process.
pool.on("error", error => console.error("ReSourceX database pool error:", error.message));

// Behind Render or another proxy, use the real client address for rate limiting.
if (isProduction || process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.disable("x-powered-by");

const origins = (process.env.CORS_ORIGIN || "http://localhost:5500,http://127.0.0.1:5500").split(",").map(value => value.trim()).filter(Boolean);
app.use(helmet({
  // The frontend loads Leaflet and map tiles from CDNs; a strict CSP needs a dedicated pass before enabling.
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: (origin, callback) => !origin || origins.includes("*") || origins.includes(origin)
    ? callback(null, true) : callback(new Error("CORS origin is not allowed")),
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));

// Rate limits. Disabled under NODE_ENV=test so the test suite is not throttled (set RATE_LIMIT_TEST=1 to exercise them).
const limitsEnabled = process.env.NODE_ENV !== "test" || process.env.RATE_LIMIT_TEST === "1";
const rateLimitMessage = { error: "Too many requests. Please wait a few minutes and try again." };
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false, message: rateLimitMessage, skip: () => !limitsEnabled });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false, message: rateLimitMessage, skip: () => !limitsEnabled });
app.use("/api/", apiLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);

// Initialize exchanges router
const exchangesRouter = initExchangesRouter({ pool, requireAuth, requireRole });
app.use("/api/exchanges", exchangesRouter);

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const role = value => String(value || "").trim().toUpperCase();
const status = value => String(value || "").trim().toUpperCase();
const text = (value, fallback = "") => String(value === undefined || value === null ? fallback : value).trim();
const idOf = value => { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; };
const positiveInt = value => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; };

// Search: every word must match somewhere in the listing, as a substring.
// "eng" finds "Engineering" textbooks even when the name is just "Textbooks".
function likeSafe(value) { return String(value == null ? "" : value).replace(/[%_\\]/g, "").trim().slice(0, 80); }
function searchConditions(rawSearch, params, conditions, alias) {
  const words = String(rawSearch || "").toLowerCase().split(/\s+/).map(likeSafe).filter(Boolean).slice(0, 5);
  for (const word of words) {
    params.push("%" + word + "%");
    const p = "$" + params.length;
    conditions.push("(" + ["name", "category", "location", "description", "specifications"].map(c => alias + "." + c + " ILIKE " + p).join(" OR ") + ")");
  }
}
// Coordinates: a valid number within the limit, or null when absent/invalid (used for read paths).
function parseCoordinate(value, limit) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}
// Write paths: validate strictly. Returns { ok, value } where value is null when the field is cleared.
function coordinateInput(value, limit) {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? { ok: true, value: n } : { ok: false, value: null };
}
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const round2 = n => Math.round(Number(n) * 100) / 100;
// Owners see exact coordinates. Everyone else sees coordinates rounded to ~1 km, and none if the owner chose 'none'.
function resourceCoordinates(row, viewerId) {
  if (row.latitude == null || row.longitude == null) return null;
  if (String(row.donor_id) === String(viewerId)) return { latitude: row.latitude, longitude: row.longitude, exact: true };
  if (row.location_privacy === "none") return null;
  return { latitude: round2(row.latitude), longitude: round2(row.longitude), exact: false };
}

const userView = row => ({
  id: row.id, firstName: row.first_name, lastName: row.last_name,
  email: row.email, role: row.role, createdAt: row.created_at
});
const resourceView = (row, viewerId) => ({
  id: row.id, donorId: row.donor_id, name: row.name, category: row.category,
  quantity: row.quantity, condition: row.condition,
  location: String(row.donor_id) === String(viewerId) ? row.location : null,
  coordinates: resourceCoordinates(row, viewerId),
  availability: row.availability, description: row.description,
  specifications: row.specifications, status: row.status,
  createdAt: row.created_at, updatedAt: row.updated_at
});
const requestView = (row, viewerId) => ({
  id: row.id, resourceId: row.resource_id, recipientId: row.recipient_id,
  status: row.status, urgency: row.urgency, purpose: row.purpose,
  requestedAt: row.requested_at, reviewedAt: row.reviewed_at,
  handedOverAt: row.handed_over_at, completedAt: row.completed_at,
  resource: row.resource_name ? {
    id: row.resource_id, name: row.resource_name, category: row.resource_category,
    quantity: row.resource_quantity, location: String(row.donor_id) === String(viewerId) || (["APPROVED", "HANDED_OVER", "COMPLETED"].includes(row.status) && row.resource_location_privacy === "exact") ? row.resource_location : null,
    status: row.resource_status, donorId: row.donor_id
  } : undefined,
  recipient: row.recipient_email ? {
    id: row.recipient_id, firstName: row.recipient_first_name,
    lastName: row.recipient_last_name,
    ...(["APPROVED", "HANDED_OVER", "COMPLETED"].includes(row.status) ? { email: row.recipient_email } : {})
  } : undefined
});

const tokenFor = user => jwt.sign(
  { id: user.id, email: user.email, role: user.role }, jwtSecret, { expiresIn: "7d" }
);
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  let payload;
  try { payload = jwt.verify(token, jwtSecret); }
  catch (error) { return res.status(401).json({ error: "Invalid or expired token" }); }
  try {
    // A valid token is not enough: the account must still exist, and its current role applies.
    const found = await pool.query("SELECT id, email, role FROM users WHERE id = $1", [payload.id]);
    if (!found.rows[0]) return res.status(401).json({ error: "Account no longer exists" });
    req.user = found.rows[0];
    return next();
  } catch (error) { return next(error); }
}
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user && req.user.role)
    ? next() : res.status(403).json({ error: "You do not have permission for this action" });
}
function urgencyOf(value) {
  if (value === undefined || value === null || value === "") return 3;
  const labels = { LOW: 1, MEDIUM: 3, HIGH: 4, CRITICAL: 5 };
  const label = String(value).trim().toUpperCase();
  if (labels[label]) return labels[label];
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

// Persistent in-app notifications. Failures never break the main operation.
async function notify(userId, type, message, relatedType, relatedId) {
  try {
    await pool.query("INSERT INTO notifications (user_id, type, message, related_type, related_id) VALUES ($1, $2, $3, $4, $5)",
      [userId, type, message, relatedType || null, relatedId || null]);
  } catch (error) { console.error("ReSourceX notification failed:", error.message); }
}
// Audit trail for traceability ("resource passport"). Recorded after the main transaction commits.
async function recordHistory(resourceId, action, userId, details) {
  try {
    await pool.query("INSERT INTO resource_history (resource_id, action, performed_by, details) VALUES ($1, $2, $3, $4)",
      [resourceId, action, userId, details ? JSON.stringify(details) : null]);
  } catch (error) { console.error("ReSourceX history failed:", error.message); }
}

async function getRequest(client, requestId) {
  const result = await client.query(
    "SELECT q.id, q.resource_id, q.recipient_id, q.status, q.urgency, q.purpose, " +
    "q.requested_at, q.reviewed_at, q.handed_over_at, q.completed_at, r.name AS resource_name, " +
    "r.category AS resource_category, r.quantity AS resource_quantity, " +
    "r.location AS resource_location, r.status AS resource_status, r.donor_id, owner.location_privacy AS resource_location_privacy, " +
    "u.first_name AS recipient_first_name, u.last_name AS recipient_last_name, " +
    "u.email AS recipient_email FROM requests q JOIN resources r ON r.id = q.resource_id " +
    "JOIN users u ON u.id = q.recipient_id JOIN users owner ON owner.id = r.donor_id WHERE q.id = $1", [requestId]
  );
  return result.rows[0] || null;
}

app.get("/api/health", asyncRoute(async (req, res) => {
  const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000);
  try { await pool.query("SELECT 1"); return res.json({ status: "ok", database: "connected", service: "resourcex-api", uptimeSeconds }); }
  catch (error) { return res.status(503).json({ status: "degraded", database: "unavailable", service: "resourcex-api", uptimeSeconds }); }
}));

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const firstName = text(req.body.firstName || req.body.first_name);
  const lastName = text(req.body.lastName || req.body.last_name);
  const email = text(req.body.email).toLowerCase();
  const password = String(req.body.password || "");
  const userRole = role(req.body.role || "RECIPIENT");
  if (!firstName || !lastName || !email || !password) return res.status(400).json({ error: "firstName, lastName, email, and password are required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (!["DONOR", "RECIPIENT", "ADMIN"].includes(userRole)) return res.status(400).json({ error: "Role must be DONOR, RECIPIENT, or ADMIN" });
  if (userRole === "ADMIN" && (!process.env.ADMIN_REGISTRATION_CODE || req.body.adminCode !== process.env.ADMIN_REGISTRATION_CODE)) return res.status(403).json({ error: "An administrator registration code is required" });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (first_name, last_name, email, password_hash, role) " +
      "VALUES ($1, $2, $3, $4, $5) RETURNING id, first_name, last_name, email, role, created_at",
      [firstName, lastName, email, passwordHash, userRole]
    );
    return res.status(201).json({ user: userView(result.rows[0]), token: tokenFor(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account with this email already exists" });
    throw error;
  }
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const email = text(req.body.email).toLowerCase();
  const password = String(req.body.password || "");
  const requestedRole = req.body.role ? role(req.body.role) : null;
  const result = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)) || (requestedRole && user.role !== requestedRole)) return res.status(401).json({ error: "Invalid email, password, or role" });
  return res.json({ user: userView(user), token: tokenFor(user) });
}));

app.get("/api/auth/me", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT id, first_name, last_name, email, role, created_at FROM users WHERE id = $1", [req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
  return res.json({ user: userView(result.rows[0]) });
}));

app.get("/api/profile", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT id, first_name, last_name, email, role, organisation_name, organisation_type, phone_number, location_privacy, organisation_verified, " +
    "address_line, city, state, country, postal_code, latitude, longitude FROM users WHERE id = $1", [req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
  const row = result.rows[0];
  return res.json({ profile: profileView(row) });
}));

app.put("/api/profile/location-privacy", requireAuth, asyncRoute(async (req, res) => {
  const privacy = text(req.body.locationPrivacy || req.body.location_privacy).toLowerCase();
  if (!["exact", "approximate", "none"].includes(privacy)) {
    return res.status(400).json({ error: "locationPrivacy must be exact, approximate, or none" });
  }
  const result = await pool.query(
    "UPDATE users SET location_privacy = $1 WHERE id = $2 RETURNING location_privacy",
    [privacy, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
  return res.json({ locationPrivacy: result.rows[0].location_privacy });
}));

app.get("/api/admin/users", requireAuth, requireRole("ADMIN"), asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT id, first_name, last_name, email, role, created_at, organisation_name, organisation_type, organisation_verified FROM users ORDER BY created_at DESC"
  );
  return res.json({ users: result.rows.map(row => Object.assign(userView(row), {
    organisationName: row.organisation_name, organisationType: row.organisation_type,
    organisationVerified: Boolean(row.organisation_verified)
  })), count: result.rowCount });
}));

app.get("/api/admin/stats", requireAuth, requireRole("ADMIN"), asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT " +
    "(SELECT COUNT(*)::int FROM users) AS users_total, " +
    "(SELECT COUNT(*)::int FROM users WHERE role = 'DONOR') AS donors_total, " +
    "(SELECT COUNT(*)::int FROM users WHERE role = 'RECIPIENT') AS recipients_total, " +
    "(SELECT COUNT(*)::int FROM resources) AS resources_total, " +
    "(SELECT COUNT(*)::int FROM resources WHERE status = 'AVAILABLE') AS resources_available, " +
    "(SELECT COUNT(*)::int FROM resources WHERE status = 'REQUESTED') AS resources_requested, " +
    "(SELECT COUNT(*)::int FROM resources WHERE status = 'ALLOCATED') AS resources_allocated, " +
    "(SELECT COUNT(*)::int FROM resources WHERE status = 'COMPLETED') AS resources_completed, " +
    "(SELECT COUNT(*)::int FROM requests) AS requests_total, " +
    "(SELECT COUNT(*)::int FROM requests WHERE status = 'PENDING') AS requests_pending, " +
    "(SELECT COUNT(*)::int FROM requests WHERE status = 'APPROVED') AS requests_approved, " +
    "(SELECT COUNT(*)::int FROM requests WHERE status = 'HANDED_OVER') AS requests_handed_over, " +
    "(SELECT COUNT(*)::int FROM requests WHERE status = 'COMPLETED') AS requests_completed, " +
    "(SELECT COUNT(*)::int FROM requests WHERE status = 'DECLINED') AS requests_declined"
  );
  const row = result.rows[0];
  return res.json({
    users: { total: row.users_total, donors: row.donors_total, recipients: row.recipients_total },
    resources: { total: row.resources_total, available: row.resources_available, requested: row.resources_requested, allocated: row.resources_allocated, completed: row.resources_completed },
    requests: { total: row.requests_total, pending: row.requests_pending, approved: row.requests_approved, handedOver: row.requests_handed_over, completed: row.requests_completed, declined: row.requests_declined }
  });
}));

app.delete("/api/admin/users/:id", requireAuth, requireRole("ADMIN"), asyncRoute(async (req, res) => {
  const userId = idOf(req.params.id);
  if (!userId) return res.status(400).json({ error: "Invalid user id" });
  if (String(userId) === String(req.user.id)) return res.status(409).json({ error: "You cannot delete your own administrator account" });
  const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING id", [userId]);
  if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
  return res.status(204).send();
}));

app.get("/api/resources", requireAuth, asyncRoute(async (req, res) => {
  const params = [];
  const conditions = ["1 = 1"];
  const param = value => { params.push(value); return "$" + params.length; };
  if (req.user.role === "DONOR") {
    if (req.query.marketplace === "true") conditions.push("(r.status = 'AVAILABLE' OR r.donor_id = " + param(req.user.id) + ")");
    else conditions.push("r.donor_id = " + param(req.user.id));
  }
  if (req.user.role === "RECIPIENT") conditions.push("(r.status = 'AVAILABLE' OR r.donor_id = " + param(req.user.id) + ")");
  if (req.query.status && req.user.role !== "RECIPIENT") {
    const requestedStatus = status(req.query.status);
    if (["AVAILABLE", "REQUESTED", "ALLOCATED"].includes(requestedStatus)) conditions.push("r.status = " + param(requestedStatus));
  }
  if (req.query.category) { const c = likeSafe(req.query.category); if (c) conditions.push("r.category ILIKE " + param("%" + c + "%")); }
  if (req.query.search) searchConditions(req.query.search, params, conditions, "r");
  const limit = Math.min(positiveInt(req.query.limit) || 100, 100);
  const offset = Number.isInteger(Number(req.query.offset)) && Number(req.query.offset) >= 0 ? Number(req.query.offset) : 0;
  params.push(limit, offset);
  const result = await pool.query(
    "SELECT r.*, owner.location_privacy FROM resources r JOIN users owner ON owner.id = r.donor_id WHERE " + conditions.join(" AND ") +
    " ORDER BY r.created_at DESC LIMIT $" + (params.length - 1) + " OFFSET $" + params.length, params
  );
  return res.json({ resources: result.rows.map(item => resourceView(item, req.user.id)), count: result.rowCount });
}));

app.get("/api/resources/:id", requireAuth, asyncRoute(async (req, res) => {
  const resourceId = idOf(req.params.id);
  if (!resourceId) return res.status(400).json({ error: "Invalid resource id" });

  // Match the visibility rules used by the resource list: users can see their own
  // resources, while other users see only available resources.
  const result = req.user.role === "ADMIN"
    ? await pool.query("SELECT r.*, owner.location_privacy FROM resources r JOIN users owner ON owner.id = r.donor_id WHERE r.id = $1", [resourceId])
    : req.user.role === "DONOR"
      ? await pool.query("SELECT r.*, owner.location_privacy FROM resources r JOIN users owner ON owner.id = r.donor_id WHERE r.id = $1 AND r.donor_id = $2", [resourceId, req.user.id])
      : await pool.query("SELECT r.*, owner.location_privacy FROM resources r JOIN users owner ON owner.id = r.donor_id WHERE r.id = $1 AND (r.status = 'AVAILABLE' OR r.donor_id = $2)", [resourceId, req.user.id]);

  if (!result.rows[0]) return res.status(404).json({ error: "Resource not found" });
  return res.json({ resource: resourceView(result.rows[0], req.user.id) });
}));

app.post("/api/resources", requireAuth, requireRole("DONOR"), asyncRoute(async (req, res) => {
  const name = text(req.body.name);
  const category = text(req.body.category);
  const quantity = positiveInt(req.body.quantity);
  if (!name || !category || !quantity) return res.status(400).json({ error: "name, category, and a positive quantity are required" });
  const lat = coordinateInput(req.body.latitude, 90), lon = coordinateInput(req.body.longitude, 180);
  if (!lat.ok || !lon.ok || (lat.value === null) !== (lon.value === null)) return res.status(400).json({ error: "Latitude and longitude must both be valid numbers, or both left empty" });
  const result = await pool.query(
    "INSERT INTO resources (donor_id, name, category, quantity, condition, location, availability, description, specifications, latitude, longitude) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *",
    [req.user.id, name, category, quantity, text(req.body.condition, "Good"), text(req.body.location, "Not specified"), text(req.body.availability, "Available now"), text(req.body.description), text(req.body.specifications), lat.value, lon.value]
  );
  await recordHistory(result.rows[0].id, "created", req.user.id, { quantity: result.rows[0].quantity });
  return res.status(201).json({ resource: resourceView(result.rows[0], req.user.id) });
}));

app.put("/api/resources/:id", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), asyncRoute(async (req, res) => {
  const resourceId = idOf(req.params.id);
  if (!resourceId) return res.status(400).json({ error: "Invalid resource id" });
  const existing = await pool.query("SELECT * FROM resources WHERE id = $1", [resourceId]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Resource not found" });
  if (req.user.role !== "ADMIN" && String(existing.rows[0].donor_id) !== String(req.user.id)) return res.status(403).json({ error: "You can only edit your own resources" });
  if (existing.rows[0].status === "ALLOCATED") return res.status(409).json({ error: "Allocated resources cannot be edited" });
  const activeExchange = await pool.query(
    "SELECT 1 FROM exchange_resources er JOIN exchanges e ON e.id = er.exchange_id " +
    "WHERE er.resource_id = $1 AND e.status IN ('PROPOSED', 'COUNTERED', 'ACCEPTED', 'IN_PROGRESS') LIMIT 1",
    [resourceId]
  );
  if (activeExchange.rowCount) return res.status(409).json({ error: "Resources in an active exchange cannot be edited" });
  const fields = ["name", "category", "quantity", "condition", "location", "availability", "description", "specifications"];
  const updates = [];
  const values = [];
  for (const field of fields) if (req.body[field] !== undefined) {
    const value = field === "quantity" ? positiveInt(req.body[field]) : text(req.body[field]);
    if (field === "quantity" && !value) return res.status(400).json({ error: "quantity must be a positive integer" });
    values.push(value); updates.push(field + " = $" + values.length);
  }
  if (req.body.latitude !== undefined || req.body.longitude !== undefined) {
    const lat = coordinateInput(req.body.latitude, 90), lon = coordinateInput(req.body.longitude, 180);
    if (!lat.ok || !lon.ok || (lat.value === null) !== (lon.value === null)) return res.status(400).json({ error: "Latitude and longitude must both be valid numbers, or both left empty" });
    values.push(lat.value); updates.push("latitude = $" + values.length);
    values.push(lon.value); updates.push("longitude = $" + values.length);
  }
  if (!updates.length) return res.status(400).json({ error: "No editable fields were provided" });
  values.push(resourceId);
  const result = await pool.query("UPDATE resources SET " + updates.join(", ") + ", updated_at = NOW() WHERE id = $" + values.length + " RETURNING *", values);
  return res.json({ resource: resourceView(result.rows[0], req.user.id) });
}));

app.delete("/api/resources/:id", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), asyncRoute(async (req, res) => {
  const resourceId = idOf(req.params.id);
  if (!resourceId) return res.status(400).json({ error: "Invalid resource id" });
  const existing = await pool.query("SELECT donor_id, status FROM resources WHERE id = $1", [resourceId]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Resource not found" });
  if (req.user.role !== "ADMIN" && String(existing.rows[0].donor_id) !== String(req.user.id)) return res.status(403).json({ error: "You can only delete your own resources" });
  if (["ALLOCATED", "HANDED_OVER", "COMPLETED"].includes(existing.rows[0].status)) return res.status(409).json({ error: "Allocated or completed resources cannot be deleted" });
  const activeExchange = await pool.query(
    "SELECT 1 FROM exchange_resources er JOIN exchanges e ON e.id = er.exchange_id " +
    "WHERE er.resource_id = $1 AND e.status IN ('PROPOSED', 'COUNTERED', 'ACCEPTED', 'IN_PROGRESS') LIMIT 1",
    [resourceId]
  );
  if (activeExchange.rowCount) return res.status(409).json({ error: "Resources in an active exchange cannot be deleted" });
  try { await pool.query("DELETE FROM resources WHERE id = $1", [resourceId]); }
  catch (error) {
    if (error.code === "23503") return res.status(409).json({ error: "This resource is referenced by exchange history and cannot be deleted" });
    throw error;
  }
  return res.status(204).send();
}));

app.get("/api/requests", requireAuth, asyncRoute(async (req, res) => {
  const params = [];
  const conditions = ["1 = 1"];
  if (req.user.role === "DONOR") { params.push(req.user.id); conditions.push("r.donor_id = $" + params.length); }
  if (req.user.role === "RECIPIENT") { params.push(req.user.id); conditions.push("q.recipient_id = $" + params.length); }
  if (req.query.status) {
    const requestedStatus = status(req.query.status);
    if (["PENDING", "APPROVED", "DECLINED", "HANDED_OVER", "COMPLETED"].includes(requestedStatus)) { params.push(requestedStatus); conditions.push("q.status = $" + params.length); }
  }
  const result = await pool.query(
    "SELECT q.id, q.resource_id, q.recipient_id, q.status, q.urgency, q.purpose, q.requested_at, q.reviewed_at, q.handed_over_at, q.completed_at, " +
    "r.name AS resource_name, r.category AS resource_category, r.quantity AS resource_quantity, " +
    "r.location AS resource_location, r.status AS resource_status, r.donor_id, owner.location_privacy AS resource_location_privacy, " +
    "u.first_name AS recipient_first_name, u.last_name AS recipient_last_name, u.email AS recipient_email " +
    "FROM requests q JOIN resources r ON r.id = q.resource_id JOIN users u ON u.id = q.recipient_id " +
    "JOIN users owner ON owner.id = r.donor_id " +
    "WHERE " + conditions.join(" AND ") + " ORDER BY q.requested_at DESC", params
  );
  return res.json({ requests: result.rows.map(item => requestView(item, req.user.id)), count: result.rowCount });
}));

app.post("/api/requests", requireAuth, requireRole("RECIPIENT"), asyncRoute(async (req, res) => {
  const resourceId = idOf(req.body.resourceId || req.body.resource_id);
  const urgency = urgencyOf(req.body.urgency);
  if (!resourceId) return res.status(400).json({ error: "A valid resourceId is required" });
  if (!urgency) return res.status(400).json({ error: "urgency must be LOW, MEDIUM, HIGH, CRITICAL, or 1-5" });
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    const resourceResult = await client.query("SELECT * FROM resources WHERE id = $1 FOR UPDATE", [resourceId]);
    const resource = resourceResult.rows[0];
    if (!resource) { await client.query("ROLLBACK"); finished = true; return res.status(404).json({ error: "Resource not found" }); }
    if (resource.status !== "AVAILABLE") { await client.query("ROLLBACK"); finished = true; return res.status(409).json({ error: "This resource is no longer available" }); }
    const requestResult = await client.query(
      "INSERT INTO requests (resource_id, recipient_id, urgency, purpose) VALUES ($1, $2, $3, $4) RETURNING id",
      [resourceId, req.user.id, urgency, text(req.body.purpose)]
    );
    await client.query("UPDATE resources SET status = 'REQUESTED', updated_at = NOW() WHERE id = $1", [resourceId]);
    await client.query("COMMIT"); finished = true;
    const newRequestId = requestResult.rows[0].id;
    await notify(resource.donor_id, "new_request", "Someone requested your resource \"" + resource.name + "\".", "request", newRequestId);
    await recordHistory(resourceId, "requested", req.user.id, { requestId: newRequestId });
    return res.status(201).json({ request: requestView(await getRequest(pool, newRequestId), req.user.id) });
  } catch (error) {
    if (!finished) await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ error: "You already have an active request for this resource" });
    throw error;
  } finally { client.release(); }
}));

async function reviewRequest(req, res, action) {
  const requestId = idOf(req.params.id);
  if (!requestId) return res.status(400).json({ error: "Invalid request id" });
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT q.*, r.donor_id FROM requests q JOIN resources r ON r.id = q.resource_id WHERE q.id = $1 FOR UPDATE", [requestId]);
    const request = result.rows[0];
    if (!request) { await client.query("ROLLBACK"); finished = true; return res.status(404).json({ error: "Request not found" }); }
    if (req.user.role === "DONOR" && request.donor_id !== req.user.id) { await client.query("ROLLBACK"); finished = true; return res.status(403).json({ error: "You can only review requests for your resources" }); }
    if (request.status !== "PENDING") { await client.query("ROLLBACK"); finished = true; return res.status(409).json({ error: "This request has already been reviewed" }); }
    if (action === "approve") {
      await client.query("UPDATE requests SET status = 'APPROVED', reviewed_at = NOW() WHERE id = $1", [requestId]);
      await client.query("UPDATE requests SET status = 'DECLINED', reviewed_at = NOW() WHERE resource_id = $1 AND id <> $2 AND status = 'PENDING'", [request.resource_id, requestId]);
      await client.query("UPDATE resources SET status = 'ALLOCATED', updated_at = NOW() WHERE id = $1", [request.resource_id]);
    } else {
      await client.query("UPDATE requests SET status = 'DECLINED', reviewed_at = NOW() WHERE id = $1", [requestId]);
      const pending = await client.query("SELECT COUNT(*)::int AS count FROM requests WHERE resource_id = $1 AND status = 'PENDING'", [request.resource_id]);
      if (pending.rows[0].count === 0) await client.query("UPDATE resources SET status = 'AVAILABLE', updated_at = NOW() WHERE id = $1", [request.resource_id]);
    }
    await client.query("COMMIT"); finished = true;
    const approved = action === "approve";
    await notify(request.recipient_id, approved ? "request_approved" : "request_declined",
      approved ? "Your request was approved. You can now coordinate the handover." : "Your request was declined.", "request", requestId);
    await recordHistory(request.resource_id, approved ? "approved" : "declined", req.user.id, { requestId });
    return res.json({ request: requestView(await getRequest(pool, requestId), req.user.id) });
  } catch (error) { if (!finished) await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
app.put("/api/requests/:id/approve", requireAuth, requireRole("DONOR", "ADMIN"), asyncRoute((req, res) => reviewRequest(req, res, "approve")));
app.put("/api/requests/:id/decline", requireAuth, requireRole("DONOR", "ADMIN"), asyncRoute((req, res) => reviewRequest(req, res, "decline")));

async function markHandedOver(req, res) {
  const requestId = idOf(req.params.id);
  if (!requestId) return res.status(400).json({ error: "Invalid request id" });
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT q.*, r.donor_id, r.status AS resource_status FROM requests q JOIN resources r ON r.id = q.resource_id WHERE q.id = $1 FOR UPDATE",
      [requestId]
    );
    const request = result.rows[0];
    if (!request) { await client.query("ROLLBACK"); finished = true; return res.status(404).json({ error: "Request not found" }); }
    if (req.user.role === "DONOR" && request.donor_id !== req.user.id) { await client.query("ROLLBACK"); finished = true; return res.status(403).json({ error: "You can only hand over your resources" }); }
    if (request.status !== "APPROVED" || request.resource_status !== "ALLOCATED") { await client.query("ROLLBACK"); finished = true; return res.status(409).json({ error: "Only an approved allocated request can be handed over" }); }
    await client.query("UPDATE requests SET status = 'HANDED_OVER', handed_over_at = NOW() WHERE id = $1", [requestId]);
    await client.query("UPDATE resources SET status = 'HANDED_OVER', updated_at = NOW() WHERE id = $1", [request.resource_id]);
    await client.query("COMMIT"); finished = true;
    await notify(request.recipient_id, "request_handed_over", "The donor marked your resource as handed over. Please confirm receipt.", "request", requestId);
    await recordHistory(request.resource_id, "handed_over", req.user.id, { requestId });
    return res.json({ request: requestView(await getRequest(pool, requestId), req.user.id) });
  } catch (error) { if (!finished) await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function confirmReceived(req, res) {
  const requestId = idOf(req.params.id);
  if (!requestId) return res.status(400).json({ error: "Invalid request id" });
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT q.*, r.status AS resource_status, r.donor_id FROM requests q JOIN resources r ON r.id = q.resource_id WHERE q.id = $1 FOR UPDATE",
      [requestId]
    );
    const request = result.rows[0];
    if (!request) { await client.query("ROLLBACK"); finished = true; return res.status(404).json({ error: "Request not found" }); }
    if (req.user.role === "RECIPIENT" && request.recipient_id !== req.user.id) { await client.query("ROLLBACK"); finished = true; return res.status(403).json({ error: "You can only confirm your own requests" }); }
    if (request.status !== "HANDED_OVER" || request.resource_status !== "HANDED_OVER") { await client.query("ROLLBACK"); finished = true; return res.status(409).json({ error: "Only a handed-over request can be completed" }); }
    await client.query("UPDATE requests SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1", [requestId]);
    await client.query("UPDATE resources SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1", [request.resource_id]);
    await client.query("COMMIT"); finished = true;
    await notify(request.donor_id, "request_completed", "The recipient confirmed receipt. The donation is complete.", "request", requestId);
    await recordHistory(request.resource_id, "completed", req.user.id, { requestId });
    return res.json({ request: requestView(await getRequest(pool, requestId), req.user.id) });
  } catch (error) { if (!finished) await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
app.put("/api/requests/:id/handover", requireAuth, requireRole("DONOR", "ADMIN"), asyncRoute(markHandedOver));
app.put("/api/requests/:id/complete", requireAuth, requireRole("RECIPIENT", "ADMIN"), asyncRoute(confirmReceived));

function conditionValue(value) { return ({ POOR: 1, FAIR: 2, GOOD: 3, EXCELLENT: 4, NEW: 5 })[String(value || "").trim().toUpperCase()] || 3; }
function availabilityDays(value) {
  const normalized = text(value).toLowerCase();
  if (!normalized || normalized.includes("now") || normalized.includes("today")) return 0;
  const dateMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;
  const availableDate = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
  const today = new Date();
  const todayDate = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.ceil((availableDate - todayDate) / 86400000));
}
function availabilityLabel(days) {
  if (days === 0) return "Available immediately";
  if (days === 1) return "Available tomorrow";
  if (days !== null && days <= 7) return "Available within a week";
  if (days !== null) return "Available later";
  return "Availability needs review";
}
const MATCH_FACTORS = [
  { key: "category", label: "Category", max: 30 },
  { key: "location", label: "Location", max: 20 },
  { key: "quantity", label: "Quantity", max: 20 },
  { key: "urgency", label: "Urgency", max: 15 },
  { key: "availability", label: "Availability", max: 15 }
];
function matchingScore(resource, criteria) {
  const requiredQuantity = positiveInt(criteria.quantity);
  const requestedUrgency = criteria.urgency ? urgencyOf(criteria.urgency) : null;
  const resourceDays = availabilityDays(resource.availability);
  const seekerLat = parseCoordinate(criteria.latitude, 90), seekerLon = parseCoordinate(criteria.longitude, 180);
  let score = 0;
  const reasons = [];
  const factors = {};

  if (criteria.category) {
    if (text(resource.category).toLowerCase() === text(criteria.category).toLowerCase()) {
      score += 30; factors.category = 30;
      reasons.push("Same category");
    } else {
      factors.category = 0;
      reasons.push("Different category");
    }
  } else {
    score += 30; factors.category = 30;
    reasons.push("Category not specified");
  }

  const hasDistance = seekerLat !== null && seekerLon !== null && resource.latitude != null && resource.longitude != null;
  if (hasDistance) {
    // Distance uses the owner's rounded coordinates, the same precision recipients are shown on the map.
    const km = distanceKm(seekerLat, seekerLon, round2(resource.latitude), round2(resource.longitude));
    if (km <= 5) { score += 20; factors.location = 20; reasons.push("Nearby: about " + km.toFixed(1) + " km away"); }
    else if (km <= 25) { score += 14; factors.location = 14; reasons.push("Within 25 km: about " + km.toFixed(1) + " km away"); }
    else if (km <= 100) { score += 8; factors.location = 8; reasons.push("About " + Math.round(km) + " km away; check transport"); }
    else { score += 3; factors.location = 3; reasons.push("Far away: about " + Math.round(km) + " km"); }
  } else if (criteria.location) {
    const resourceLocation = text(resource.location).toLowerCase();
    const requestedLocation = text(criteria.location).toLowerCase();
    if (resourceLocation === requestedLocation) {
      score += 20; factors.location = 20;
      reasons.push("Same location");
    } else if (resourceLocation.includes(requestedLocation) || requestedLocation.includes(resourceLocation)) {
      score += 12; factors.location = 12;
      reasons.push("Nearby location");
    } else {
      score += 5; factors.location = 5;
      reasons.push("Different location; verify pickup distance");
    }
  } else {
    score += 20; factors.location = 20;
    reasons.push("Location not specified");
  }

  if (requiredQuantity) {
    const quantityScore = Math.min(1, Number(resource.quantity) / requiredQuantity) * 20;
    score += quantityScore; factors.quantity = quantityScore;
    reasons.push(resource.quantity >= requiredQuantity ? "Enough quantity available" : "Partial quantity available");
  } else {
    score += 20; factors.quantity = 20;
    reasons.push("Quantity requirement not specified");
  }

  if (requestedUrgency) {
    const urgencyScore = requestedUrgency >= 4
      ? (resourceDays === 0 ? 15 : resourceDays !== null && resourceDays <= 2 ? 10 : 5)
      : requestedUrgency === 3
        ? (resourceDays === 0 ? 15 : resourceDays !== null && resourceDays <= 7 ? 12 : 8)
        : (resourceDays === 0 ? 15 : resourceDays !== null && resourceDays <= 14 ? 14 : 12);
    score += urgencyScore; factors.urgency = urgencyScore;
    reasons.push(requestedUrgency >= 4 && resourceDays === 0 ? "Suitable for urgent needs" : "Urgency considered");
  } else {
    score += 15; factors.urgency = 15;
    reasons.push("Urgency not specified");
  }

  const availabilityScore = resourceDays === 0 ? 15 : resourceDays !== null && resourceDays <= 2 ? 12 : resourceDays !== null && resourceDays <= 7 ? 9 : resourceDays !== null ? 5 : 3;
  score += availabilityScore; factors.availability = availabilityScore;
  reasons.push(availabilityLabel(resourceDays));

  // A factor counts only when the recipient asked about it. The score is the share of the
  // points available for the factors that were asked about, out of 100. Availability always applies.
  const applicable = {
    category: Boolean(criteria.category),
    quantity: Boolean(requiredQuantity),
    urgency: Boolean(requestedUrgency),
    location: Boolean(hasDistance || criteria.location),
    availability: true
  };
  const needsSomething = ["category", "quantity", "urgency", "location"].some(k => applicable[k]);
  let earned = 0, possible = 0;
  MATCH_FACTORS.forEach(f => { if (applicable[f.key]) { earned += factors[f.key] || 0; possible += f.max; } });
  const matchScore = needsSomething && possible > 0 ? Math.round((earned / possible) * 100) : null;
  if (!needsSomething) reasons.unshift("Add a category, quantity, urgency or area to get a match score");
  // Per-factor breakdown: points only for the factors that were asked about.
  const breakdown = MATCH_FACTORS.map(f => ({
    factor: f.key, label: f.label, max: f.max, applicable: applicable[f.key],
    points: applicable[f.key] ? Math.round((factors[f.key] || 0) * 10) / 10 : 0
  }));
  return { matchScore, matchReasons: reasons, breakdown };
}
app.get("/api/matching", requireAuth, requireRole("RECIPIENT", "ADMIN"), asyncRoute(async (req, res) => {
  const params = [req.user.id]; const conditions = ["r.status = 'AVAILABLE' AND r.donor_id <> $1"];
  const category = likeSafe(req.query.category);
  if (category) { params.push("%" + category + "%"); conditions.push("r.category ILIKE $" + params.length); }
  if (req.query.search) searchConditions(req.query.search, params, conditions, "r");
  const result = await pool.query("SELECT r.*, owner.location_privacy FROM resources r JOIN users owner ON owner.id = r.donor_id WHERE " + conditions.join(" AND ") + " ORDER BY r.created_at DESC", params);
  const availabilityOf = m => (m.breakdown.find(f => f.factor === "availability") || { points: 0 }).points;
  const matches = result.rows.map(item => Object.assign(resourceView(item, req.user.id), matchingScore(item, req.query)))
    .sort((a, b) => ((b.matchScore ?? -1) - (a.matchScore ?? -1)) || (availabilityOf(b) - availabilityOf(a)));
  return res.json({ matches, scoring: Object.fromEntries(MATCH_FACTORS.map(f => [f.key, f.max])) });
}));


// Change the signed-in user's password. The current password must be given.
app.put("/api/auth/password", requireAuth, asyncRoute(async (req, res) => {
  const current = String(req.body.currentPassword || "");
  const next = String(req.body.newPassword || "");
  if (next.length < 8) return res.status(400).json({ error: "The new password must be at least 8 characters" });
  if (next.length > 200) return res.status(400).json({ error: "The new password is too long" });
  const row = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!row.rows[0] || !(await bcrypt.compare(current, row.rows[0].password_hash))) {
    return res.status(400).json({ error: "The current password is incorrect" });
  }
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(next, 12), req.user.id]);
  return res.json({ updated: true });
}));

// Recipients' views and requests of ranked recommendations. Stored for evaluation of future ranking changes.
app.post("/api/matching/events", requireAuth, requireRole("RECIPIENT"), asyncRoute(async (req, res) => {
  const resourceId = idOf(req.body.resourceId);
  const action = text(req.body.action).toLowerCase();
  if (!resourceId) return res.status(400).json({ error: "A valid resourceId is required" });
  if (!["view", "request"].includes(action)) return res.status(400).json({ error: "action must be view or request" });
  const rank = positiveInt(req.body.rank);
  const scoreValue = Number(req.body.score);
  const score = Number.isInteger(scoreValue) && scoreValue >= 0 && scoreValue <= 100 ? scoreValue : null;
  const result = await pool.query(
    "INSERT INTO match_events (user_id, resource_id, action, rank_position, match_score) " +
    "SELECT $1, id, $2, $3, $4 FROM resources WHERE id = $5 RETURNING id",
    [req.user.id, action, rank, score, resourceId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Resource not found" });
  return res.status(201).json({ recorded: true });
}));

// Exchange endpoints are implemented in ./routes/exchanges.js.

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
const ORGANISATION_TYPES = ["individual", "college", "ngo", "company", "community_organisation"];
const profileView = row => ({
  id: row.id, firstName: row.first_name, lastName: row.last_name, email: row.email, role: row.role,
  organisationName: row.organisation_name, organisationType: row.organisation_type, phoneNumber: row.phone_number,
  addressLine: row.address_line, city: row.city, state: row.state, country: row.country, postalCode: row.postal_code,
  latitude: row.latitude, longitude: row.longitude,
  locationPrivacy: row.location_privacy, organisationVerified: Boolean(row.organisation_verified)
});
app.put("/api/profile", requireAuth, asyncRoute(async (req, res) => {
  const current = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  if (!current.rows[0]) return res.status(404).json({ error: "User not found" });
  const row = current.rows[0];
  const body = req.body || {};
  const pick = (key, column, max) => body[key] !== undefined ? (text(body[key]).slice(0, max) || null) : row[column];
  const lat = body.latitude !== undefined ? coordinateInput(body.latitude, 90) : { ok: true, value: row.latitude };
  const lon = body.longitude !== undefined ? coordinateInput(body.longitude, 180) : { ok: true, value: row.longitude };
  const next = {
    first_name: body.firstName !== undefined ? text(body.firstName) : row.first_name,
    last_name: body.lastName !== undefined ? text(body.lastName) : row.last_name,
    organisation_name: body.organisationName !== undefined ? (text(body.organisationName) || null) : row.organisation_name,
    organisation_type: body.organisationType !== undefined ? (text(body.organisationType).toLowerCase() || null) : row.organisation_type,
    phone_number: body.phoneNumber !== undefined ? (text(body.phoneNumber) || null) : row.phone_number,
    address_line: pick("addressLine", "address_line", 200),
    city: pick("city", "city", 100),
    state: pick("state", "state", 100),
    country: pick("country", "country", 100),
    postal_code: pick("postalCode", "postal_code", 20),
    latitude: lat.value, longitude: lon.value
  };
  if (!next.first_name || !next.last_name) return res.status(400).json({ error: "First and last name cannot be empty" });
  if (next.organisation_type && !ORGANISATION_TYPES.includes(next.organisation_type)) return res.status(400).json({ error: "organisationType must be one of: " + ORGANISATION_TYPES.join(", ") });
  if (next.phone_number && !/^[0-9+()\-\s]{7,20}$/.test(next.phone_number)) return res.status(400).json({ error: "Enter a valid phone number" });
  if (!lat.ok || !lon.ok || (lat.value === null) !== (lon.value === null)) return res.status(400).json({ error: "Latitude and longitude must both be valid numbers, or both left empty" });
  // An organisation name is only a claim. Changing it removes any earlier verification.
  const identityChanged = next.organisation_name !== row.organisation_name || next.organisation_type !== row.organisation_type;
  const result = await pool.query(
    "UPDATE users SET first_name = $1, last_name = $2, organisation_name = $3, organisation_type = $4, phone_number = $5, " +
    "address_line = $6, city = $7, state = $8, country = $9, postal_code = $10, latitude = $11, longitude = $12, " +
    "organisation_verified = CASE WHEN $13 THEN FALSE ELSE organisation_verified END WHERE id = $14 " +
    "RETURNING id, first_name, last_name, email, role, organisation_name, organisation_type, phone_number, location_privacy, organisation_verified, " +
    "address_line, city, state, country, postal_code, latitude, longitude",
    [next.first_name, next.last_name, next.organisation_name, next.organisation_type, next.phone_number,
     next.address_line, next.city, next.state, next.country, next.postal_code, next.latitude, next.longitude,
     identityChanged, req.user.id]
  );
  return res.json({ profile: profileView(result.rows[0]) });
}));

// Administrators verify (or revoke verification of) an organisation, keeping a record of the decision.
app.put("/api/admin/users/:id/verification", requireAuth, requireRole("ADMIN"), asyncRoute(async (req, res) => {
  const userId = idOf(req.params.id);
  if (!userId) return res.status(400).json({ error: "Invalid user id" });
  if (typeof req.body.verified !== "boolean") return res.status(400).json({ error: "verified must be true or false" });
  const found = await pool.query("SELECT id, organisation_name FROM users WHERE id = $1", [userId]);
  if (!found.rows[0]) return res.status(404).json({ error: "User not found" });
  if (req.body.verified && !found.rows[0].organisation_name) return res.status(409).json({ error: "This user has not provided an organisation name to verify" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE users SET organisation_verified = $1 WHERE id = $2", [req.body.verified, userId]);
    await client.query(
      "INSERT INTO organisation_verifications (user_id, verified_by, verified_at, document_type, document_reference, notes) VALUES ($1, $2, $3, $4, $5, $6)",
      [userId, req.user.id, req.body.verified ? new Date() : null, text(req.body.documentType).slice(0, 40) || null, text(req.body.documentReference) || null, text(req.body.notes) || null]
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await notify(userId, req.body.verified ? "org_verified" : "org_unverified",
    req.body.verified ? "Your organisation has been verified by an administrator." : "Your organisation verification was removed.", null, null);
  return res.json({ userId, organisationVerified: req.body.verified });
}));

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
const notificationView = row => ({
  id: row.id, type: row.type, message: row.message, relatedType: row.related_type,
  relatedId: row.related_id, isRead: row.is_read, createdAt: row.created_at, readAt: row.read_at
});
app.get("/api/notifications", requireAuth, asyncRoute(async (req, res) => {
  const limit = Math.min(positiveInt(req.query.limit) || 30, 100);
  const unreadOnly = String(req.query.unread) === "true";
  const list = await pool.query(
    "SELECT * FROM notifications WHERE user_id = $1" + (unreadOnly ? " AND is_read = FALSE" : "") + " ORDER BY created_at DESC, id DESC LIMIT $2",
    [req.user.id, limit]
  );
  const unread = await pool.query("SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE", [req.user.id]);
  return res.json({ notifications: list.rows.map(notificationView), unreadCount: unread.rows[0].count });
}));
// Declared before /:id/read so that "read-all" is not parsed as an id.
app.put("/api/notifications/read-all", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query("UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE user_id = $1 AND is_read = FALSE", [req.user.id]);
  return res.json({ updated: result.rowCount });
}));
app.put("/api/notifications/:id/read", requireAuth, asyncRoute(async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid notification id" });
  const result = await pool.query("UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING *", [id, req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "Notification not found" });
  return res.json({ notification: notificationView(result.rows[0]) });
}));

// ---------------------------------------------------------------------------
// Messaging linked to a donation request (only the two participants; admins may read)
// ---------------------------------------------------------------------------
async function requestParticipant(req, res, next) {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid request id" });
  try {
    const found = await pool.query("SELECT q.id, q.status, q.recipient_id, r.donor_id, r.name FROM requests q JOIN resources r ON r.id = q.resource_id WHERE q.id = $1", [id]);
    const row = found.rows[0];
    if (!row) return res.status(404).json({ error: "Request not found" });
    const isRecipient = String(row.recipient_id) === String(req.user.id);
    const isDonor = String(row.donor_id) === String(req.user.id);
    if (!isRecipient && !isDonor && req.user.role !== "ADMIN") return res.status(403).json({ error: "Only the donor and recipient can access this conversation" });
    req.requestRow = row; req.requestId = id; req.isRecipient = isRecipient; req.isDonor = isDonor;
    return next();
  } catch (error) { return next(error); }
}
app.get("/api/requests/:id/messages", requireAuth, requestParticipant, asyncRoute(async (req, res) => {
  const limit = Math.min(positiveInt(req.query.limit) || 100, 200);
  const result = await pool.query(
    "SELECT m.id, m.sender_id, m.content, m.sent_at, m.read_at, u.first_name, u.last_name FROM messages m JOIN users u ON u.id = m.sender_id " +
    "WHERE m.request_id = $1 ORDER BY m.sent_at ASC, m.id ASC LIMIT $2", [req.requestId, limit]
  );
  if (req.isRecipient || req.isDonor) {
    await pool.query("UPDATE messages SET read_at = NOW() WHERE request_id = $1 AND sender_id <> $2 AND read_at IS NULL", [req.requestId, req.user.id]);
  }
  return res.json({ messages: result.rows.map(m => ({
    id: m.id, senderId: m.sender_id, senderName: (m.first_name + " " + m.last_name).trim(), content: m.content, sentAt: m.sent_at, readAt: m.read_at
  })) });
}));
app.post("/api/requests/:id/messages", requireAuth, requestParticipant, asyncRoute(async (req, res) => {
  if (!req.isRecipient && !req.isDonor) return res.status(403).json({ error: "Only the donor and recipient can send messages" });
  if (req.requestRow.status === "DECLINED") return res.status(409).json({ error: "Messaging is closed for declined requests" });
  const content = text(req.body.content).slice(0, 2000);
  if (!content) return res.status(400).json({ error: "Message content is required" });
  const result = await pool.query("INSERT INTO messages (request_id, sender_id, content) VALUES ($1, $2, $3) RETURNING id, sender_id, content, sent_at", [req.requestId, req.user.id, content]);
  const other = req.isRecipient ? req.requestRow.donor_id : req.requestRow.recipient_id;
  await notify(other, "new_message", "New message about \"" + req.requestRow.name + "\".", "request", req.requestId);
  const m = result.rows[0];
  return res.status(201).json({ message: { id: m.id, senderId: m.sender_id, content: m.content, sentAt: m.sent_at } });
}));

// ---------------------------------------------------------------------------
// Resource history ("resource passport")
// ---------------------------------------------------------------------------
app.get("/api/resources/:id/history", requireAuth, asyncRoute(async (req, res) => {
  const resourceId = idOf(req.params.id);
  if (!resourceId) return res.status(400).json({ error: "Invalid resource id" });
  const resource = await pool.query("SELECT id, donor_id, name FROM resources WHERE id = $1", [resourceId]);
  if (!resource.rows[0]) return res.status(404).json({ error: "Resource not found" });
  if (req.user.role !== "ADMIN" && String(resource.rows[0].donor_id) !== String(req.user.id)) return res.status(403).json({ error: "Only the resource owner can view its history" });
  const result = await pool.query(
    "SELECT h.id, h.action, h.performed_at, h.details, u.first_name, u.last_name, u.role FROM resource_history h JOIN users u ON u.id = h.performed_by " +
    "WHERE h.resource_id = $1 ORDER BY h.performed_at ASC, h.id ASC", [resourceId]
  );
  return res.json({ resource: { id: resource.rows[0].id, name: resource.rows[0].name }, history: result.rows.map(h => ({
    id: h.id, action: h.action, performedAt: h.performed_at, details: h.details,
    performedBy: { name: (h.first_name + " " + h.last_name).trim(), role: h.role }
  })) });
}));

// ---------------------------------------------------------------------------
// Impact: measurable outcomes of completed redistribution
// ---------------------------------------------------------------------------
app.get("/api/impact", requireAuth, asyncRoute(async (req, res) => {
  const donations = await pool.query(
    "SELECT r.category, COUNT(*)::int AS transfers, COALESCE(SUM(r.quantity), 0)::int AS units " +
    "FROM requests q JOIN resources r ON r.id = q.resource_id WHERE q.status = 'COMPLETED' GROUP BY r.category"
  );
  const exchanges = await pool.query(
    "SELECT r.category, COUNT(DISTINCT e.id)::int AS transfers, COALESCE(SUM(er.quantity_fulfilled), 0)::int AS units " +
    "FROM exchanges e JOIN exchange_resources er ON er.exchange_id = e.id JOIN resources r ON r.id = er.resource_id " +
    "WHERE e.status = 'COMPLETED' GROUP BY r.category"
  );
  const donationsCompleted = (await pool.query("SELECT COUNT(*)::int AS count FROM requests WHERE status = 'COMPLETED'")).rows[0].count;
  const exchangesCompleted = (await pool.query("SELECT COUNT(*)::int AS count FROM exchanges WHERE status = 'COMPLETED'")).rows[0].count;
  const byCategory = new Map();
  for (const row of [...donations.rows, ...exchanges.rows]) byCategory.set(row.category, (byCategory.get(row.category) || 0) + row.units);
  const donationUnits = donations.rows.reduce((sum, row) => sum + row.units, 0);
  const exchangeUnits = exchanges.rows.reduce((sum, row) => sum + row.units, 0);
  return res.json({
    donationsCompleted, exchangesCompleted,
    unitsDonated: donationUnits, unitsExchanged: exchangeUnits, unitsRedistributed: donationUnits + exchangeUnits,
    byCategory: [...byCategory.entries()].map(([category, units]) => ({ category, units })).sort((a, b) => b.units - a.units)
  });
}));


app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  if (error.type === "entity.parse.failed" || error.status === 400) return res.status(400).json({ error: "Request body contains invalid JSON" });
  return res.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  const server = app.listen(port, () => console.log("ReSourceX API listening on port " + port));
  let stopping = false;
  const shutdown = signal => {
    if (stopping) return;
    stopping = true;
    console.log("Received " + signal + ", closing server");
    server.close(() => pool.end().then(() => process.exit(0)).catch(() => process.exit(1)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
module.exports = { app, pool };
