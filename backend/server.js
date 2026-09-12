require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 5000);
const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !process.env.JWT_SECRET) throw new Error("JWT_SECRET must be configured in production");
const jwtSecret = process.env.JWT_SECRET || "development-only-change-me";
if (!process.env.JWT_SECRET) console.warn("JWT_SECRET is not set. Use a strong secret outside local development.");

const pool = new Pool(process.env.DATABASE_URL ? {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
} : {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "resourcex",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres"
});

const origins = (process.env.CORS_ORIGIN || "http://localhost:5500,http://127.0.0.1:5500").split(",").map(value => value.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => !origin || origins.includes("*") || origins.includes(origin)
    ? callback(null, true) : callback(new Error("CORS origin is not allowed")),
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const role = value => String(value || "").trim().toUpperCase();
const status = value => String(value || "").trim().toUpperCase();
const text = (value, fallback = "") => String(value === undefined || value === null ? fallback : value).trim();
const idOf = value => { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; };
const positiveInt = value => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; };

const userView = row => ({
  id: row.id, firstName: row.first_name, lastName: row.last_name,
  email: row.email, role: row.role, createdAt: row.created_at
});
const resourceView = row => ({
  id: row.id, donorId: row.donor_id, name: row.name, category: row.category,
  quantity: row.quantity, condition: row.condition, location: row.location,
  availability: row.availability, description: row.description,
  specifications: row.specifications, status: row.status,
  createdAt: row.created_at, updatedAt: row.updated_at
});
const requestView = row => ({
  id: row.id, resourceId: row.resource_id, recipientId: row.recipient_id,
  status: row.status, urgency: row.urgency, purpose: row.purpose,
  requestedAt: row.requested_at, reviewedAt: row.reviewed_at,
  handedOverAt: row.handed_over_at, completedAt: row.completed_at,
  resource: row.resource_name ? {
    id: row.resource_id, name: row.resource_name, category: row.resource_category,
    quantity: row.resource_quantity, location: row.resource_location,
    status: row.resource_status, donorId: row.donor_id
  } : undefined,
  recipient: row.recipient_email ? {
    id: row.recipient_id, firstName: row.recipient_first_name,
    lastName: row.recipient_last_name, email: row.recipient_email
  } : undefined
});

const tokenFor = user => jwt.sign(
  { id: user.id, email: user.email, role: user.role }, jwtSecret, { expiresIn: "7d" }
);
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try { req.user = jwt.verify(token, jwtSecret); return next(); }
  catch (error) { return res.status(401).json({ error: "Invalid or expired token" }); }
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

async function getRequest(client, requestId) {
  const result = await client.query(
    "SELECT q.id, q.resource_id, q.recipient_id, q.status, q.urgency, q.purpose, " +
    "q.requested_at, q.reviewed_at, q.handed_over_at, q.completed_at, r.name AS resource_name, " +
    "r.category AS resource_category, r.quantity AS resource_quantity, " +
    "r.location AS resource_location, r.status AS resource_status, r.donor_id, " +
    "u.first_name AS recipient_first_name, u.last_name AS recipient_last_name, " +
    "u.email AS recipient_email FROM requests q JOIN resources r ON r.id = q.resource_id " +
    "JOIN users u ON u.id = q.recipient_id WHERE q.id = $1", [requestId]
  );
  return result.rows[0] || null;
}

app.get("/api/health", asyncRoute(async (req, res) => {
  try { await pool.query("SELECT 1"); return res.json({ status: "ok", database: "connected", service: "resourcex-api" }); }
  catch (error) { return res.status(503).json({ status: "degraded", database: "unavailable", service: "resourcex-api" }); }
}));

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const firstName = text(req.body.firstName || req.body.first_name);
  const lastName = text(req.body.lastName || req.body.last_name);
  const email = text(req.body.email).toLowerCase();
  const password = String(req.body.password || "");
  const userRole = role(req.body.role || "RECIPIENT");
  if (!firstName || !lastName || !email || !password) return res.status(400).json({ error: "firstName, lastName, email, and password are required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (!["DONOR", "RECIPIENT", "ADMIN"].includes(userRole)) return res.status(400).json({ error: "Role must be DONOR or RECIPIENT" });
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

app.get("/api/admin/users", requireAuth, requireRole("ADMIN"), asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT id, first_name, last_name, email, role, created_at FROM users ORDER BY created_at DESC"
  );
  return res.json({ users: result.rows.map(userView), count: result.rowCount });
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
  if (userId === req.user.id) return res.status(409).json({ error: "You cannot delete your own administrator account" });
  const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING id", [userId]);
  if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
  return res.status(204).send();
}));

app.get("/api/resources", requireAuth, asyncRoute(async (req, res) => {
  const params = [];
  const conditions = ["1 = 1"];
  const param = value => { params.push(value); return "$" + params.length; };
  if (req.user.role === "DONOR") conditions.push("r.donor_id = " + param(req.user.id));
  if (req.user.role === "RECIPIENT") conditions.push("r.status = 'AVAILABLE'");
  if (req.query.status && req.user.role !== "RECIPIENT") {
    const requestedStatus = status(req.query.status);
    if (["AVAILABLE", "REQUESTED", "ALLOCATED"].includes(requestedStatus)) conditions.push("r.status = " + param(requestedStatus));
  }
  if (req.query.category) conditions.push("LOWER(r.category) = LOWER(" + param(text(req.query.category)) + ")");
  if (req.query.search) {
    const search = param("%" + text(req.query.search) + "%");
    conditions.push("(r.name ILIKE " + search + " OR r.location ILIKE " + search + " OR r.description ILIKE " + search + ")");
  }
  const limit = Math.min(positiveInt(req.query.limit) || 100, 100);
  const offset = Number.isInteger(Number(req.query.offset)) && Number(req.query.offset) >= 0 ? Number(req.query.offset) : 0;
  params.push(limit, offset);
  const result = await pool.query(
    "SELECT r.* FROM resources r WHERE " + conditions.join(" AND ") +
    " ORDER BY r.created_at DESC LIMIT $" + (params.length - 1) + " OFFSET $" + params.length, params
  );
  return res.json({ resources: result.rows.map(resourceView), count: result.rowCount });
}));

app.get("/api/resources/:id", requireAuth, asyncRoute(async (req, res) => {
  const resourceId = idOf(req.params.id);
  if (!resourceId) return res.status(400).json({ error: "Invalid resource id" });
  const result = await pool.query("SELECT * FROM resources WHERE id = $1", [resourceId]);
  if (!result.rows[0]) return res.status(404).json({ error: "Resource not found" });
  return res.json({ resource: resourceView(result.rows[0]) });
}));

app.post("/api/resources", requireAuth, requireRole("DONOR", "ADMIN"), asyncRoute(async (req, res) => {
  const name = text(req.body.name);
  const category = text(req.body.category);
  const quantity = positiveInt(req.body.quantity);
  if (!name || !category || !quantity) return res.status(400).json({ error: "name, category, and a positive quantity are required" });
  const result = await pool.query(
    "INSERT INTO resources (donor_id, name, category, quantity, condition, location, availability, description, specifications) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
    [req.user.id, name, category, quantity, text(req.body.condition, "Good"), text(req.body.location, "Not specified"), text(req.body.availability, "Available now"), text(req.body.description), text(req.body.specifications)]
  );
  return res.status(201).json({ resource: resourceView(result.rows[0]) });
}));

app.put("/api/resources/:id", requireAuth, requireRole("DONOR", "ADMIN"), asyncRoute(async (req, res) => {
  const resourceId = idOf(req.params.id);
  if (!resourceId) return res.status(400).json({ error: "Invalid resource id" });
  const existing = await pool.query("SELECT * FROM resources WHERE id = $1", [resourceId]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Resource not found" });
  if (req.user.role === "DONOR" && existing.rows[0].donor_id !== req.user.id) return res.status(403).json({ error: "You can only edit your own resources" });
  if (existing.rows[0].status === "ALLOCATED") return res.status(409).json({ error: "Allocated resources cannot be edited" });
  const fields = ["name", "category", "quantity", "condition", "location", "availability", "description", "specifications"];
  const updates = [];
  const values = [];
  for (const field of fields) if (req.body[field] !== undefined) {
    const value = field === "quantity" ? positiveInt(req.body[field]) : text(req.body[field]);
    if (field === "quantity" && !value) return res.status(400).json({ error: "quantity must be a positive integer" });
    values.push(value); updates.push(field + " = $" + values.length);
  }
  if (!updates.length) return res.status(400).json({ error: "No editable fields were provided" });
  values.push(resourceId);
  const result = await pool.query("UPDATE resources SET " + updates.join(", ") + ", updated_at = NOW() WHERE id = $" + values.length + " RETURNING *", values);
  return res.json({ resource: resourceView(result.rows[0]) });
}));

app.delete("/api/resources/:id", requireAuth, requireRole("DONOR", "ADMIN"), asyncRoute(async (req, res) => {
  const resourceId = idOf(req.params.id);
  if (!resourceId) return res.status(400).json({ error: "Invalid resource id" });
  const existing = await pool.query("SELECT donor_id, status FROM resources WHERE id = $1", [resourceId]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Resource not found" });
  if (req.user.role === "DONOR" && existing.rows[0].donor_id !== req.user.id) return res.status(403).json({ error: "You can only delete your own resources" });
  if (existing.rows[0].status === "ALLOCATED") return res.status(409).json({ error: "Allocated resources cannot be deleted" });
  await pool.query("DELETE FROM resources WHERE id = $1", [resourceId]);
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
    "r.location AS resource_location, r.status AS resource_status, r.donor_id, " +
    "u.first_name AS recipient_first_name, u.last_name AS recipient_last_name, u.email AS recipient_email " +
    "FROM requests q JOIN resources r ON r.id = q.resource_id JOIN users u ON u.id = q.recipient_id " +
    "WHERE " + conditions.join(" AND ") + " ORDER BY q.requested_at DESC", params
  );
  return res.json({ requests: result.rows.map(requestView), count: result.rowCount });
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
    return res.status(201).json({ request: requestView(await getRequest(pool, requestResult.rows[0].id)) });
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
    return res.json({ request: requestView(await getRequest(pool, requestId)) });
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
    return res.json({ request: requestView(await getRequest(pool, requestId)) });
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
      "SELECT q.*, r.status AS resource_status FROM requests q JOIN resources r ON r.id = q.resource_id WHERE q.id = $1 FOR UPDATE",
      [requestId]
    );
    const request = result.rows[0];
    if (!request) { await client.query("ROLLBACK"); finished = true; return res.status(404).json({ error: "Request not found" }); }
    if (req.user.role === "RECIPIENT" && request.recipient_id !== req.user.id) { await client.query("ROLLBACK"); finished = true; return res.status(403).json({ error: "You can only confirm your own requests" }); }
    if (request.status !== "HANDED_OVER" || request.resource_status !== "HANDED_OVER") { await client.query("ROLLBACK"); finished = true; return res.status(409).json({ error: "Only a handed-over request can be completed" }); }
    await client.query("UPDATE requests SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1", [requestId]);
    await client.query("UPDATE resources SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1", [request.resource_id]);
    await client.query("COMMIT"); finished = true;
    return res.json({ request: requestView(await getRequest(pool, requestId)) });
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
function matchingScore(resource, criteria) {
  const requiredQuantity = positiveInt(criteria.quantity);
  const requestedUrgency = criteria.urgency ? urgencyOf(criteria.urgency) : null;
  const resourceDays = availabilityDays(resource.availability);
  let score = 0;
  const reasons = [];

  if (criteria.category) {
    if (text(resource.category).toLowerCase() === text(criteria.category).toLowerCase()) {
      score += 30;
      reasons.push("Same category");
    } else {
      reasons.push("Different category");
    }
  } else {
    score += 30;
    reasons.push("Category not specified");
  }

  if (criteria.location) {
    const resourceLocation = text(resource.location).toLowerCase();
    const requestedLocation = text(criteria.location).toLowerCase();
    if (resourceLocation === requestedLocation) {
      score += 20;
      reasons.push("Same location");
    } else if (resourceLocation.includes(requestedLocation) || requestedLocation.includes(resourceLocation)) {
      score += 12;
      reasons.push("Nearby location");
    } else {
      score += 5;
      reasons.push("Different location; verify pickup distance");
    }
  } else {
    score += 20;
    reasons.push("Location not specified");
  }

  if (requiredQuantity) {
    const quantityScore = Math.min(1, Number(resource.quantity) / requiredQuantity) * 20;
    score += quantityScore;
    reasons.push(resource.quantity >= requiredQuantity ? "Enough quantity available" : "Partial quantity available");
  } else {
    score += 20;
    reasons.push("Quantity requirement not specified");
  }

  if (requestedUrgency) {
    const urgencyScore = requestedUrgency >= 4
      ? (resourceDays === 0 ? 15 : resourceDays !== null && resourceDays <= 2 ? 10 : 5)
      : requestedUrgency === 3
        ? (resourceDays === 0 ? 15 : resourceDays !== null && resourceDays <= 7 ? 12 : 8)
        : (resourceDays === 0 ? 15 : resourceDays !== null && resourceDays <= 14 ? 14 : 12);
    score += urgencyScore;
    reasons.push(requestedUrgency >= 4 && resourceDays === 0 ? "Suitable for urgent needs" : "Urgency considered");
  } else {
    score += 15;
    reasons.push("Urgency not specified");
  }

  const availabilityScore = resourceDays === 0 ? 15 : resourceDays !== null && resourceDays <= 2 ? 12 : resourceDays !== null && resourceDays <= 7 ? 9 : resourceDays !== null ? 5 : 3;
  score += availabilityScore;
  reasons.push(availabilityLabel(resourceDays));

  return { matchScore: Math.round(score), matchReasons: reasons };
}
app.get("/api/matching", requireAuth, requireRole("RECIPIENT", "ADMIN"), asyncRoute(async (req, res) => {
  const params = []; const conditions = ["status = 'AVAILABLE'"];
  if (req.query.category) { params.push(text(req.query.category)); conditions.push("LOWER(category) = LOWER($" + params.length + ")"); }
  if (req.query.search) { params.push("%" + text(req.query.search) + "%"); conditions.push("(name ILIKE $" + params.length + " OR location ILIKE $" + params.length + " OR description ILIKE $" + params.length + ")"); }
  const result = await pool.query("SELECT * FROM resources WHERE " + conditions.join(" AND ") + " ORDER BY created_at DESC", params);
  const matches = result.rows.map(item => Object.assign(resourceView(item), matchingScore(item, req.query))).sort((a, b) => b.matchScore - a.matchScore);
  return res.json({ matches, scoring: { category: 30, location: 20, quantity: 20, urgency: 15, availability: 15 } });
}));

app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  if (error.type === "entity.parse.failed" || error.status === 400) return res.status(400).json({ error: "Request body contains invalid JSON" });
  return res.status(500).json({ error: "Internal server error" });
});

if (require.main === module) app.listen(port, () => console.log("ReSourceX API listening on port " + port));
module.exports = { app, pool };
