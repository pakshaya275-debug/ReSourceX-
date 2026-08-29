require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 5000);
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

const origins = (process.env.CORS_ORIGIN || "*").split(",").map(value => value.trim()).filter(Boolean);
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
    "q.requested_at, q.reviewed_at, r.name AS resource_name, " +
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
    if (["PENDING", "APPROVED", "DECLINED"].includes(requestedStatus)) { params.push(requestedStatus); conditions.push("q.status = $" + params.length); }
  }
  const result = await pool.query(
    "SELECT q.id, q.resource_id, q.recipient_id, q.status, q.urgency, q.purpose, q.requested_at, q.reviewed_at, " +
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

function conditionValue(value) { return ({ POOR: 1, FAIR: 2, GOOD: 3, EXCELLENT: 4, NEW: 5 })[String(value || "").trim().toUpperCase()] || 3; }
function matchingScore(resource, criteria) {
  let score = 0; const reasons = []; const requiredQuantity = positiveInt(criteria.quantity);
  if (criteria.category) { if (resource.category.toLowerCase() === text(criteria.category).toLowerCase()) { score += 35; reasons.push("Category matches"); } else reasons.push("Category differs"); } else score += 35;
  if (requiredQuantity) { score += Math.min(1, resource.quantity / requiredQuantity) * 20; reasons.push(resource.quantity >= requiredQuantity ? "Quantity is sufficient" : "Partial quantity available"); } else score += 20;
  if (criteria.condition) { score += Math.min(1, conditionValue(resource.condition) / conditionValue(criteria.condition)) * 15; reasons.push(conditionValue(resource.condition) >= conditionValue(criteria.condition) ? "Condition meets requirement" : "Condition is below requirement"); } else score += 15;
  if (criteria.location) { if (resource.location.toLowerCase() === text(criteria.location).toLowerCase()) { score += 15; reasons.push("Location matches"); } else { score += 5; reasons.push("Location differs; verify distance"); } } else score += 15;
  if (criteria.availabilityDays) { const requestedDays = Number(criteria.availabilityDays); const availableDays = Number((resource.availability.match(/\d+/) || [0])[0]); if (availableDays >= requestedDays) { score += 15; reasons.push("Availability window matches"); } else { score += 7; reasons.push("Availability window needs review"); } } else score += 15;
  return { matchScore: Math.round(score), matchReasons: reasons };
}
app.get("/api/matching", requireAuth, requireRole("RECIPIENT", "ADMIN"), asyncRoute(async (req, res) => {
  const params = []; const conditions = ["status = 'AVAILABLE'"];
  if (req.query.category) { params.push(text(req.query.category)); conditions.push("LOWER(category) = LOWER($" + params.length + ")"); }
  if (req.query.search) { params.push("%" + text(req.query.search) + "%"); conditions.push("(name ILIKE $" + params.length + " OR location ILIKE $" + params.length + " OR description ILIKE $" + params.length + ")"); }
  const result = await pool.query("SELECT * FROM resources WHERE " + conditions.join(" AND ") + " ORDER BY created_at DESC", params);
  const matches = result.rows.map(item => Object.assign(resourceView(item), matchingScore(item, req.query))).sort((a, b) => b.matchScore - a.matchScore);
  return res.json({ matches, scoring: { category: 35, quantity: 20, condition: 15, location: 15, availability: 15 } });
}));

app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((error, req, res, next) => { console.error(error); if (res.headersSent) return next(error); return res.status(500).json({ error: "Internal server error" }); });

if (require.main === module) app.listen(port, () => console.log("ReSourceX API listening on port " + port));
module.exports = { app, pool };
