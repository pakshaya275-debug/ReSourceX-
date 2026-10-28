// ReSourceX integration tests (Node's built-in test runner, no extra dependencies).
// Requires PostgreSQL with backend/schema.sql applied. Use a throwaway database:
//   DATABASE_URL=postgresql://user:pass@localhost:5432/resourcex_test \
//   JWT_SECRET=test ADMIN_REGISTRATION_CODE=admin-code npm test
// Test names start with the checklist id (T01..T18) used in docs/FINAL_REVIEW.md.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { app, pool } = require("../server");

let server, base;
const run = Date.now();
const mail = name => `${name}.${run}@test.example`;

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}
async function signup(name, role, extra = {}) {
  const r = await call("POST", "/api/auth/register", null,
    Object.assign({ firstName: name, lastName: "Tester", email: mail(name), password: "password123", role }, extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user.id, email: mail(name) };
}
const admin = () => signup("admin" + Math.random().toString(36).slice(2, 7), "ADMIN", { adminCode: process.env.ADMIN_REGISTRATION_CODE });
async function addResource(token, name, quantity = 5, extra = {}) {
  const r = await call("POST", "/api/resources", token, Object.assign({ name, category: "Books", quantity, location: "Chennai" }, extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.resource.id;
}

before(() => { server = app.listen(0); base = "http://127.0.0.1:" + server.address().port; });
after(async () => { server.close(); await pool.end(); });

// ---------------------------------------------------------------- authentication
test("T01 register: validation, duplicate email, admin code enforced", async () => {
  assert.equal((await call("POST", "/api/auth/register", null, { firstName: "A", lastName: "B", email: "bad", password: "password123" })).status, 400);
  assert.equal((await call("POST", "/api/auth/register", null, { firstName: "A", lastName: "B", email: mail("short"), password: "short" })).status, 400);
  assert.equal((await call("POST", "/api/auth/register", null, { firstName: "A", lastName: "B", email: mail("evil"), password: "password123", role: "ADMIN", adminCode: "wrong" })).status, 403);
  assert.equal((await call("POST", "/api/auth/register", null, { firstName: "A", lastName: "B", email: mail("x"), password: "password123", role: "HACKER" })).status, 400);
  await signup("dup", "DONOR");
  const again = await call("POST", "/api/auth/register", null, { firstName: "A", lastName: "B", email: mail("dup"), password: "password123", role: "DONOR" });
  assert.equal(again.status, 409);
});

test("T02/T03 login: valid, wrong password, wrong role, unknown user", async () => {
  await signup("login1", "DONOR");
  let r = await call("POST", "/api/auth/login", null, { email: mail("login1"), password: "password123", role: "DONOR" });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal((await call("POST", "/api/auth/login", null, { email: mail("login1"), password: "nope-nope" })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", null, { email: mail("login1"), password: "password123", role: "RECIPIENT" })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", null, { email: "ghost@test.example", password: "password123" })).status, 401);
});

test("T10 protected endpoints reject missing or malformed tokens", async () => {
  for (const path of ["/api/resources", "/api/requests", "/api/exchanges", "/api/notifications", "/api/impact", "/api/profile"]) {
    assert.equal((await call("GET", path)).status, 401, path);
  }
  assert.equal((await call("GET", "/api/resources", "garbage.token.value")).status, 401);
});

test("security: token of a deleted account is rejected", async () => {
  const a = await admin();
  const victim = await signup("victim", "DONOR");
  assert.equal((await call("DELETE", `/api/admin/users/${victim.id}`, a.token)).status, 204);
  assert.equal((await call("GET", "/api/resources", victim.token)).status, 401);
});

// ---------------------------------------------------------------- resources & discovery
test("T04 resources: create, validation, ownership on edit/delete", async () => {
  const d1 = await signup("res1", "DONOR"), d2 = await signup("res2", "DONOR");
  assert.equal((await call("POST", "/api/resources", d1.token, { name: "x", category: "Books", quantity: 0 })).status, 400);
  assert.equal((await call("POST", "/api/resources", d1.token, { name: "", category: "Books", quantity: 2 })).status, 400);
  const id = await addResource(d1.token, "Owned", 3);
  assert.equal((await call("PUT", `/api/resources/${id}`, d2.token, { name: "stolen" })).status, 403);
  assert.equal((await call("DELETE", `/api/resources/${id}`, d2.token)).status, 403);
  const upd = await call("PUT", `/api/resources/${id}`, d1.token, { quantity: 7 });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.resource.quantity, 7);
  assert.equal((await call("GET", "/api/resources/abc", d1.token)).status, 400);
  assert.equal((await call("DELETE", `/api/resources/${id}`, d1.token)).status, 204);
  assert.equal((await call("GET", `/api/resources/${id}`, d1.token)).status, 404);
});

test("T05/T11 recipient sees available resources but not their exact location", async () => {
  const donor = await signup("disc1", "DONOR"), rec = await signup("disc2", "RECIPIENT");
  const id = await addResource(donor.token, "Discover" + run, 4, { location: "Secret Street 12" });
  const list = await call("GET", `/api/resources?search=Discover${run}`, rec.token);
  assert.equal(list.status, 200);
  const found = list.body.resources.find(r => r.id === id);
  assert.ok(found);
  assert.equal(found.location, null, "location must be hidden from other users");
  const own = await call("GET", `/api/resources/${id}`, donor.token);
  assert.equal(own.body.resource.location, "Secret Street 12");
});

test("T06 matching: documented weights, ordering and reasons agree with scores", async () => {
  const donor = await signup("match1", "DONOR"), rec = await signup("match2", "RECIPIENT");
  const tag = "Match" + run;
  await addResource(donor.token, tag + "-near", 10, { location: "Chennai" });
  await addResource(donor.token, tag + "-far", 10, { location: "Delhi" });
  await addResource(donor.token, tag + "-small", 1, { location: "Chennai" });
  const r = await call("GET", `/api/matching?category=Books&location=Chennai&quantity=5&urgency=HIGH&search=${tag}`, rec.token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.scoring, { category: 30, location: 20, quantity: 20, urgency: 15, availability: 15 });
  assert.equal(Object.values(r.body.scoring).reduce((a, b) => a + b, 0), 100);
  const by = n => r.body.matches.find(m => m.name === tag + n);
  // Weights: category 30 + location 20 + quantity 20 + urgency 15 + availability 15
  assert.equal(by("-near").matchScore, 100, "same category and location, enough quantity, available now");
  assert.equal(by("-far").matchScore, 85, "100 - 15 (location mismatch scores 5 of 20)");
  assert.equal(by("-small").matchScore, 84, "100 - 16 (quantity 1 of 5 scores 4 of 20)");
  assert.ok(by("-near").matchReasons.includes("Same location"));
  assert.ok(by("-near").matchReasons.includes("Enough quantity available"));
  assert.ok(by("-small").matchReasons.includes("Partial quantity available"));
  assert.ok(by("-far").matchReasons.includes("Different location; verify pickup distance"));
  const scores = r.body.matches.map(m => m.matchScore);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "sorted by score descending");
  assert.equal((await call("GET", "/api/matching", (await signup("match3", "DONOR")).token)).status, 403, "donors cannot use matching");
});

// ---------------------------------------------------------------- donation lifecycle
test("T07/T08/T09/T16 donation lifecycle with permissions, notifications and history", async () => {
  const donor = await signup("don1", "DONOR"), rec = await signup("rec1", "RECIPIENT"), rec2 = await signup("rec2", "RECIPIENT");
  const other = await signup("don2", "DONOR");
  const rid = await addResource(donor.token, "Lifecycle", 5);

  assert.equal((await call("POST", "/api/requests", donor.token, { resourceId: rid })).status, 403, "donors cannot request");
  assert.equal((await call("POST", "/api/requests", rec.token, { resourceId: rid, urgency: "SUPER" })).status, 400);
  const created = await call("POST", "/api/requests", rec.token, { resourceId: rid, urgency: "HIGH", purpose: "college" });
  assert.equal(created.status, 201);
  assert.equal(created.body.request.status, "PENDING");
  const qid = created.body.request.id;
  assert.equal((await call("POST", "/api/requests", rec2.token, { resourceId: rid })).status, 409, "resource already requested");

  assert.equal((await call("PUT", `/api/requests/${qid}/approve`, rec.token)).status, 403, "recipient cannot approve");
  assert.equal((await call("PUT", `/api/requests/${qid}/approve`, other.token)).status, 403, "another donor cannot approve");
  assert.equal((await call("PUT", `/api/requests/${qid}/handover`, donor.token)).status, 409, "no handover before approval");
  assert.equal((await call("PUT", `/api/requests/${qid}/complete`, rec.token)).status, 409, "no receipt before handover");
  assert.equal((await call("PUT", `/api/requests/${qid}/approve`, donor.token)).body.request.status, "APPROVED");
  assert.equal((await call("PUT", `/api/requests/${qid}/approve`, donor.token)).status, 409, "cannot review twice");
  assert.equal((await call("PUT", `/api/requests/${qid}/complete`, donor.token)).status, 403, "donor cannot confirm receipt");
  assert.equal((await call("PUT", `/api/requests/${qid}/handover`, donor.token)).body.request.status, "HANDED_OVER");
  assert.equal((await call("PUT", `/api/requests/${qid}/complete`, rec2.token)).status, 403, "only the requesting recipient completes");
  const done = await call("PUT", `/api/requests/${qid}/complete`, rec.token);
  assert.equal(done.status, 200);
  assert.equal(done.body.request.status, "COMPLETED");
  assert.ok(done.body.request.completedAt);

  // T16 persistence: state survives a fresh login
  const relog = await call("POST", "/api/auth/login", null, { email: rec.email, password: "password123" });
  const again = await call("GET", "/api/requests", relog.body.token);
  assert.equal(again.body.requests.find(q => q.id === qid).status, "COMPLETED");
  assert.equal((await call("GET", `/api/resources/${rid}`, donor.token)).body.resource.status, "COMPLETED");

  // notifications reached both sides
  const dn = (await call("GET", "/api/notifications", donor.token)).body;
  assert.deepEqual(dn.notifications.map(n => n.type).sort(), ["new_request", "request_completed"]);
  const rn = (await call("GET", "/api/notifications", rec.token)).body;
  assert.deepEqual(rn.notifications.map(n => n.type).sort(), ["request_approved", "request_handed_over"]);

  // resource passport records every step, in order
  const h = await call("GET", `/api/resources/${rid}/history`, donor.token);
  assert.deepEqual(h.body.history.map(x => x.action), ["created", "requested", "approved", "handed_over", "completed"]);
  assert.equal((await call("GET", `/api/resources/${rid}/history`, rec.token)).status, 403, "history is owner/admin only");
});

test("declined request returns the resource to the pool", async () => {
  const donor = await signup("dec1", "DONOR"), rec = await signup("dec2", "RECIPIENT"), rec2 = await signup("dec3", "RECIPIENT");
  const rid = await addResource(donor.token, "Decline", 2);
  const q = (await call("POST", "/api/requests", rec.token, { resourceId: rid })).body.request.id;
  assert.equal((await call("PUT", `/api/requests/${q}/decline`, donor.token)).body.request.status, "DECLINED");
  assert.equal((await call("GET", `/api/resources/${rid}`, donor.token)).body.resource.status, "AVAILABLE");
  assert.equal((await call("POST", "/api/requests", rec2.token, { resourceId: rid })).status, 201, "another recipient can now request");
  assert.equal((await call("POST", "/api/requests", rec.token, { resourceId: 999999999 })).status, 404);
  assert.equal((await call("POST", "/api/requests", rec.token, {})).status, 400);
});

test("concurrency: simultaneous requests cannot double-allocate a resource", async () => {
  const donor = await signup("race0", "DONOR");
  const recs = await Promise.all([1, 2, 3, 4, 5].map(i => signup("race" + i, "RECIPIENT")));
  const rid = await addResource(donor.token, "Race", 1);
  const results = await Promise.all(recs.map(r => call("POST", "/api/requests", r.token, { resourceId: rid })));
  assert.equal(results.filter(r => r.status === 201).length, 1, "exactly one request wins");
  assert.equal(results.filter(r => r.status === 409).length, 4);
});

test("T11 contact and location privacy follow request status", async () => {
  const donor = await signup("priv1", "DONOR"), rec = await signup("priv2", "RECIPIENT");
  const rid = await addResource(donor.token, "Privacy", 2, { location: "Exact Address 5" });
  const qid = (await call("POST", "/api/requests", rec.token, { resourceId: rid })).body.request.id;
  const pending = (await call("GET", "/api/requests", donor.token)).body.requests.find(q => q.id === qid);
  assert.equal(pending.recipient.email, undefined, "recipient email hidden while pending");
  assert.ok(pending.recipient.firstName);
  let mine = (await call("GET", "/api/requests", rec.token)).body.requests.find(q => q.id === qid);
  assert.equal(mine.resource.location, null, "location hidden before approval");
  await call("PUT", `/api/requests/${qid}/approve`, donor.token);
  const approved = (await call("GET", "/api/requests", donor.token)).body.requests.find(q => q.id === qid);
  assert.equal(approved.recipient.email, rec.email, "email revealed after approval");
  mine = (await call("GET", "/api/requests", rec.token)).body.requests.find(q => q.id === qid);
  assert.equal(mine.resource.location, null, "default privacy is approximate: recipient still sees no exact location");
  assert.equal((await call("PUT", "/api/profile/location-privacy", donor.token, { locationPrivacy: "exact" })).status, 200);
  mine = (await call("GET", "/api/requests", rec.token)).body.requests.find(q => q.id === qid);
  assert.equal(mine.resource.location, "Exact Address 5", "exact location shared once donor opts in and request is approved");
  assert.equal((await call("PUT", "/api/profile/location-privacy", donor.token, { locationPrivacy: "everyone" })).status, 400);
});

// ---------------------------------------------------------------- messaging
test("request messaging: only participants, closed when declined, read receipts, notifications", async () => {
  const donor = await signup("msg1", "DONOR"), rec = await signup("msg2", "RECIPIENT"), stranger = await signup("msg3", "DONOR");
  const a = await admin();
  const rid = await addResource(donor.token, "Chat", 2);
  const qid = (await call("POST", "/api/requests", rec.token, { resourceId: rid })).body.request.id;
  assert.equal((await call("POST", `/api/requests/${qid}/messages`, rec.token, { content: "   " })).status, 400);
  assert.equal((await call("POST", `/api/requests/${qid}/messages`, rec.token, { content: "Can we collect Friday 3 PM?" })).status, 201);
  assert.equal((await call("POST", `/api/requests/${qid}/messages`, donor.token, { content: "Yes, 3 PM works." })).status, 201);
  assert.equal((await call("GET", `/api/requests/${qid}/messages`, stranger.token)).status, 403);
  assert.equal((await call("POST", `/api/requests/${qid}/messages`, stranger.token, { content: "hi" })).status, 403);
  assert.equal((await call("POST", `/api/requests/${qid}/messages`, a.token, { content: "admin" })).status, 403, "admins may read but not post");
  assert.equal((await call("GET", `/api/requests/${qid}/messages`, a.token)).status, 200);
  const thread = (await call("GET", `/api/requests/${qid}/messages`, donor.token)).body.messages;
  assert.deepEqual(thread.map(m => m.content), ["Can we collect Friday 3 PM?", "Yes, 3 PM works."], "chronological");
  await call("GET", `/api/requests/${qid}/messages`, rec.token); // recipient opens the thread
  const reread = (await call("GET", `/api/requests/${qid}/messages`, donor.token)).body.messages;
  assert.ok(reread.every(m => m.readAt), "messages are marked read once the other participant opens the thread");
  const recNotes = (await call("GET", "/api/notifications", rec.token)).body.notifications;
  assert.ok(recNotes.some(n => n.type === "new_message"));
  await call("PUT", `/api/requests/${qid}/decline`, donor.token);
  assert.equal((await call("POST", `/api/requests/${qid}/messages`, rec.token, { content: "still there?" })).status, 409);
  assert.equal((await call("GET", "/api/requests/abc/messages", rec.token)).status, 400);
  assert.equal((await call("GET", "/api/requests/999999999/messages", rec.token)).status, 404);
});

// ---------------------------------------------------------------- notifications
test("notifications: list, unread count, mark read, mark all, isolation between users", async () => {
  const donor = await signup("note1", "DONOR"), rec = await signup("note2", "RECIPIENT"), rec2 = await signup("note3", "RECIPIENT");
  for (let i = 0; i < 2; i++) {
    const rid = await addResource(donor.token, "Note" + i, 1);
    await call("POST", "/api/requests", i ? rec.token : rec2.token, { resourceId: rid });
  }
  let n = (await call("GET", "/api/notifications", donor.token)).body;
  assert.equal(n.unreadCount, 2);
  assert.equal(n.notifications.length, 2);
  assert.equal((await call("PUT", `/api/notifications/${n.notifications[0].id}/read`, rec.token)).status, 404, "cannot read another user's notification");
  const one = await call("PUT", `/api/notifications/${n.notifications[0].id}/read`, donor.token);
  assert.equal(one.body.notification.isRead, true);
  n = (await call("GET", "/api/notifications?unread=true", donor.token)).body;
  assert.equal(n.unreadCount, 1);
  assert.equal(n.notifications.length, 1);
  assert.equal((await call("PUT", "/api/notifications/read-all", donor.token)).body.updated, 1);
  assert.equal((await call("GET", "/api/notifications", donor.token)).body.unreadCount, 0);
  assert.equal((await call("PUT", "/api/notifications/abc/read", donor.token)).status, 400);
  assert.equal((await call("GET", "/api/notifications", rec.token)).body.notifications.length, 0, "recipient has none yet");
});

// ---------------------------------------------------------------- exchange
test("T13/T14/T15 exchange: propose, counteroffer, accept, two-sided handover and receipt", async () => {
  const a = await signup("exa", "DONOR"), b = await signup("exb", "DONOR"), c = await signup("exc", "DONOR");
  const aBooks = await addResource(a.token, "A-books", 10), aKit = await addResource(a.token, "A-kit", 3);
  const bKit = await addResource(b.token, "B-kit", 4);
  const propose = (token, over = {}) => call("POST", "/api/exchanges", token, Object.assign({ recipientId: b.id, offeredResourceId: aBooks, requestedResourceId: bKit, offeredQuantity: 4, requestedQuantity: 2, message: "swap?" }, over));

  assert.equal((await propose(a.token, { offeredQuantity: 0 })).status, 400);
  assert.equal((await propose(a.token, { recipientId: a.id })).status, 400, "cannot exchange with yourself");
  assert.equal((await propose(a.token, { offeredQuantity: 99 })).status, 422, "quantity cannot exceed stock");
  assert.equal((await propose(c.token)).status, 403, "can only offer what you own");
  const created = await propose(a.token);
  assert.equal(created.status, 201);
  const xid = created.body.exchange.id;
  assert.equal(created.body.exchange.status, "PROPOSED");
  assert.equal((await propose(a.token)).status, 409, "resources already in an active exchange");

  assert.equal((await call("PUT", `/api/exchanges/${xid}/respond`, a.token, { action: "accept" })).status, 403, "proposer cannot accept own offer");
  assert.equal((await call("PUT", `/api/exchanges/${xid}/respond`, c.token, { action: "accept" })).status, 403, "non-participant");
  assert.equal((await call("GET", `/api/exchanges/${xid}`, c.token)).status, 403);
  assert.equal((await call("PUT", `/api/exchanges/${xid}/respond`, b.token, { action: "dance" })).status, 400);
  assert.equal((await call("PUT", `/api/exchanges/${xid}/complete`, b.token)).status, 409, "cannot complete before handover");

  // B counters: wants A's kit instead of books
  const counter = await call("PUT", `/api/exchanges/${xid}/respond`, b.token, { action: "counteroffer", offeredResourceId: bKit, offeredQuantity: 2, requestedResourceId: aKit, requestedQuantity: 1, message: "kit for kit" });
  assert.equal(counter.status, 200, JSON.stringify(counter.body));
  assert.equal(counter.body.exchange.status, "COUNTERED");
  assert.equal(counter.body.exchange.currentProposerId, b.id);
  assert.equal((await call("PUT", `/api/exchanges/${xid}/respond`, b.token, { action: "accept" })).status, 403, "counter-proposer cannot accept own counter");
  const accepted = await call("PUT", `/api/exchanges/${xid}/respond`, a.token, { action: "accept" });
  assert.equal(accepted.body.exchange.status, "ACCEPTED");
  assert.equal((await call("PUT", `/api/exchanges/${xid}/cancel`, a.token)).status, 403, "only the current proposer may cancel");
  assert.equal((await call("PUT", `/api/exchanges/${xid}/cancel`, b.token)).status, 409, "an accepted exchange cannot be cancelled");
  assert.equal((await call("PUT", `/api/resources/${aKit}`, a.token, { name: "edit" })).status, 409, "allocated resource is locked");

  assert.equal((await call("PUT", `/api/exchanges/${xid}/progress`, a.token)).body.exchange.status, "ACCEPTED", "one handover is not enough");
  assert.equal((await call("PUT", `/api/exchanges/${xid}/progress`, b.token)).body.exchange.status, "IN_PROGRESS");
  assert.equal((await call("PUT", `/api/exchanges/${xid}/complete`, a.token)).body.exchange.status, "IN_PROGRESS", "one receipt is not enough");
  const finished = await call("PUT", `/api/exchanges/${xid}/complete`, b.token);
  assert.equal(finished.body.exchange.status, "COMPLETED");
  assert.equal(finished.body.exchange.requestedResources[0].quantityFulfilled, 1);

  // partial exchange keeps the remaining stock available
  const kit = (await call("GET", `/api/resources/${aKit}`, a.token)).body.resource;
  assert.equal(kit.quantity, 2);
  assert.equal(kit.status, "AVAILABLE");
  const bk = (await call("GET", `/api/resources/${bKit}`, b.token)).body.resource;
  assert.equal(bk.quantity, 2);

  const nb = (await call("GET", "/api/notifications", b.token)).body.notifications.map(n => n.type);
  assert.ok(nb.includes("new_exchange_offer") && nb.includes("exchange_accepted"));
  const hist = (await call("GET", `/api/resources/${aKit}/history`, a.token)).body.history.map(x => x.action);
  assert.deepEqual(hist, ["created", "exchange_accepted", "exchange_completed"]);
});

test("exchange: decline, cancel and messaging", async () => {
  const a = await signup("exd1", "DONOR"), b = await signup("exd2", "DONOR"), c = await signup("exd3", "DONOR");
  const ra = await addResource(a.token, "D-a", 2), rb = await addResource(b.token, "D-b", 2);
  const mk = () => call("POST", "/api/exchanges", a.token, { recipientId: b.id, offeredResourceId: ra, requestedResourceId: rb, offeredQuantity: 1, requestedQuantity: 1 });
  let x = (await mk()).body.exchange.id;
  assert.equal((await call("PUT", `/api/exchanges/${x}/respond`, b.token, { action: "decline" })).body.exchange.status, "DECLINED");
  assert.equal((await call("PUT", `/api/exchanges/${x}/respond`, b.token, { action: "accept" })).status, 409, "already closed");
  x = (await mk()).body.exchange.id;
  assert.equal((await call("PUT", `/api/exchanges/${x}/cancel`, b.token)).status, 403, "only proposer cancels");
  assert.equal((await call("PUT", `/api/exchanges/${x}/cancel`, a.token)).body.exchange.status, "CANCELLED");
  x = (await mk()).body.exchange.id;
  assert.equal((await call("POST", `/api/exchanges/${x}/messages`, b.token, { content: "Is Friday ok?" })).status, 201);
  assert.equal((await call("POST", `/api/exchanges/${x}/messages`, c.token, { content: "hi" })).status, 403);
  assert.equal((await call("GET", `/api/exchanges/${x}/messages`, a.token)).body.messages.length, 1);
});

test("deleting a resource that has exchange history returns 409, not 500", async () => {
  const a = await signup("exh1", "DONOR"), b = await signup("exh2", "DONOR");
  const ra = await addResource(a.token, "H-a", 2), rb = await addResource(b.token, "H-b", 2);
  const x = (await call("POST", "/api/exchanges", a.token, { recipientId: b.id, offeredResourceId: ra, requestedResourceId: rb, offeredQuantity: 1, requestedQuantity: 1 })).body.exchange.id;
  await call("PUT", `/api/exchanges/${x}/respond`, b.token, { action: "decline" });
  const r = await call("DELETE", `/api/resources/${ra}`, a.token);
  assert.equal(r.status, 409);
  assert.ok(r.body.error);
});

// ---------------------------------------------------------------- admin, profile, impact
test("T12 admin: statistics agree with the database; non-admins are refused", async () => {
  const a = await admin(), donor = await signup("adm1", "DONOR");
  assert.equal((await call("GET", "/api/admin/stats", donor.token)).status, 403);
  assert.equal((await call("GET", "/api/admin/users", donor.token)).status, 403);
  const stats = (await call("GET", "/api/admin/stats", a.token)).body;
  const db = (await pool.query("SELECT (SELECT COUNT(*)::int FROM users) u, (SELECT COUNT(*)::int FROM resources) r, (SELECT COUNT(*)::int FROM requests) q")).rows[0];
  assert.equal(stats.users.total, db.u);
  assert.equal(stats.resources.total, db.r);
  assert.equal(stats.requests.total, db.q);
  const users = (await call("GET", "/api/admin/users", a.token)).body;
  assert.equal(users.count, db.u);
  assert.ok("organisationVerified" in users.users[0]);
});

test("admin cannot delete their own account", async () => {
  const a = await admin();
  const r = await call("DELETE", `/api/admin/users/${a.id}`, a.token);
  assert.equal(r.status, 409);
});

test("profile: edit details, validation, organisation claim vs verification", async () => {
  const org = await signup("org1", "DONOR"), a = await admin();
  assert.equal((await call("PUT", "/api/profile", org.token, { organisationType: "spaceship" })).status, 400);
  assert.equal((await call("PUT", "/api/profile", org.token, { phoneNumber: "abc" })).status, 400);
  assert.equal((await call("PUT", "/api/profile", org.token, { firstName: "" })).status, 400);
  assert.equal((await call("PUT", `/api/admin/users/${org.id}/verification`, a.token, { verified: true })).status, 409, "nothing to verify yet");
  const saved = await call("PUT", "/api/profile", org.token, { organisationName: "Green College", organisationType: "college", phoneNumber: "+91 98765 43210" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.profile.organisationVerified, false, "a claim is not verification");
  assert.equal((await call("PUT", `/api/admin/users/${org.id}/verification`, org.token, { verified: true })).status, 403, "users cannot verify themselves");
  assert.equal((await call("PUT", `/api/admin/users/${org.id}/verification`, a.token, { verified: "yes" })).status, 400);
  const v = await call("PUT", `/api/admin/users/${org.id}/verification`, a.token, { verified: true, documentType: "registration", documentReference: "REG-123", notes: "checked" });
  assert.equal(v.status, 200);
  assert.equal((await call("GET", "/api/profile", org.token)).body.profile.organisationVerified, true);
  assert.equal((await pool.query("SELECT COUNT(*)::int c FROM organisation_verifications WHERE user_id = $1", [org.id])).rows[0].c, 1, "decision recorded");
  assert.ok((await call("GET", "/api/notifications", org.token)).body.notifications.some(n => n.type === "org_verified"));
  const renamed = await call("PUT", "/api/profile", org.token, { organisationName: "Different Org" });
  assert.equal(renamed.body.profile.organisationVerified, false, "changing the organisation removes verification");
  assert.equal((await call("PUT", `/api/admin/users/999999999/verification`, a.token, { verified: false })).status, 404);
});

test("impact: completed donations and exchanges are counted", async () => {
  const before = (await call("GET", "/api/impact", (await signup("imp0", "DONOR")).token)).body;
  const donor = await signup("imp1", "DONOR"), rec = await signup("imp2", "RECIPIENT");
  const rid = await addResource(donor.token, "Impact", 6, { category: "Impact" + run });
  const q = (await call("POST", "/api/requests", rec.token, { resourceId: rid })).body.request.id;
  await call("PUT", `/api/requests/${q}/approve`, donor.token);
  await call("PUT", `/api/requests/${q}/handover`, donor.token);
  await call("PUT", `/api/requests/${q}/complete`, rec.token);
  const afterDon = (await call("GET", "/api/impact", donor.token)).body;
  assert.equal(afterDon.donationsCompleted, before.donationsCompleted + 1);
  assert.equal(afterDon.unitsDonated, before.unitsDonated + 6);
  assert.equal(afterDon.unitsRedistributed, afterDon.unitsDonated + afterDon.unitsExchanged);
  assert.deepEqual(afterDon.byCategory.find(c => c.category === "Impact" + run), { category: "Impact" + run, units: 6 });
});

test("T17 health endpoint reports database connectivity; unknown routes return JSON 404", async () => {
  const h = await call("GET", "/api/health");
  assert.equal(h.status, 200);
  assert.equal(h.body.database, "connected");
  const nf = await call("GET", "/api/does-not-exist");
  assert.equal(nf.status, 404);
  assert.ok(nf.body.error);
});

// ---------------------------------------------------------------- phase 6: search, map, profile, match events
test("search: short words and categories match ('eng' finds Engineering textbooks)", async () => {
  const donor = await signup("srch1", "DONOR"), rec = await signup("srch2", "RECIPIENT");
  const tag = "Srch" + run;
  await addResource(donor.token, "Textbooks " + tag, 6, { category: "Engineering" });
  await addResource(donor.token, "Lab kit " + tag, 2, { category: "Science" });
  const found = await call("GET", `/api/matching?search=${encodeURIComponent("eng " + tag)}`, rec.token);
  assert.equal(found.status, 200);
  assert.ok(found.body.matches.some(m => m.name === "Textbooks " + tag), "'eng' matches the Engineering category");
  assert.ok(!found.body.matches.some(m => m.name === "Lab kit " + tag), "every word must match, so the science kit is excluded");
  const partialCategory = await call("GET", `/api/matching?category=engin&search=${tag}`, rec.token);
  assert.ok(partialCategory.body.matches.some(m => m.name === "Textbooks " + tag), "category filter accepts a partial word");
  const listed = await call("GET", `/api/resources?search=${encodeURIComponent("engineering " + tag)}`, rec.token);
  assert.ok(listed.body.resources.some(r => r.name === "Textbooks " + tag), "resource list uses the same search");
  const wildcard = await call("GET", `/api/resources?search=${encodeURIComponent("%")}`, rec.token);
  assert.equal(wildcard.status, 200, "SQL wildcard characters are stripped, not used to match everything");
});

test("coordinates: owner sees exact, others see ~1 km rounded, hidden when privacy is 'none', invalid input rejected", async () => {
  const donor = await signup("geo1", "DONOR"), rec = await signup("geo2", "RECIPIENT");
  assert.equal((await call("POST", "/api/resources", donor.token, { name: "X", category: "Books", quantity: 1, latitude: 120, longitude: 80 })).status, 400);
  assert.equal((await call("POST", "/api/resources", donor.token, { name: "X", category: "Books", quantity: 1, latitude: 12.98765 })).status, 400, "latitude without longitude is rejected");
  const created = await call("POST", "/api/resources", donor.token, { name: "Geo" + run, category: "Books", quantity: 1, latitude: 12.98765, longitude: 79.13412 });
  assert.equal(created.status, 201);
  const id = created.body.resource.id;
  assert.deepEqual(created.body.resource.coordinates, { latitude: 12.98765, longitude: 79.13412, exact: true });
  const seen = (await call("GET", `/api/resources/${id}`, rec.token)).body.resource;
  assert.deepEqual(seen.coordinates, { latitude: 12.99, longitude: 79.13, exact: false }, "recipient gets rounded coordinates by default");
  assert.equal((await call("PUT", "/api/profile/location-privacy", donor.token, { locationPrivacy: "none" })).status, 200);
  const hidden = (await call("GET", `/api/resources/${id}`, rec.token)).body.resource;
  assert.equal(hidden.coordinates, null, "owner chose 'none': no coordinates shown to others");
  assert.equal((await call("PUT", `/api/resources/${id}`, donor.token, { latitude: 13.1, longitude: 80.2 })).status, 200, "owner can update coordinates");
  assert.equal((await call("PUT", `/api/resources/${id}`, donor.token, { latitude: 13.1 })).status, 400, "partial update is rejected");
});

test("matching uses distance when the recipient shares a location", async () => {
  const donor = await signup("dist1", "DONOR"), rec = await signup("dist2", "RECIPIENT");
  const tag = "Dist" + run;
  await call("POST", "/api/resources", donor.token, { name: tag + "-close", category: "Books", quantity: 5, location: "Chennai", latitude: 13.0827, longitude: 80.2707 });
  await call("POST", "/api/resources", donor.token, { name: tag + "-far", category: "Books", quantity: 5, location: "Madurai", latitude: 9.9252, longitude: 78.1198 });
  const r = await call("GET", `/api/matching?category=Books&search=${tag}&latitude=13.0827&longitude=80.2707`, rec.token);
  const close = r.body.matches.find(m => m.name === tag + "-close");
  const far = r.body.matches.find(m => m.name === tag + "-far");
  assert.ok(close.matchReasons.some(x => x.startsWith("Nearby")), "nearby reason");
  assert.ok(far.matchReasons.some(x => /km/.test(x)), "distance reason for the far resource");
  assert.ok(close.matchScore > far.matchScore, "closer resource ranks higher");
  assert.equal(r.body.matches[0].name, tag + "-close");
});

test("profile: address, phone and coordinates are saved, validated and returned", async () => {
  const u = await signup("prof1", "RECIPIENT");
  const saved = await call("PUT", "/api/profile", u.token, { addressLine: "12 Temple Road", city: "Vellore", state: "Tamil Nadu", country: "India", postalCode: "632014", phoneNumber: "+91 98765 43210", latitude: 12.9165, longitude: 79.1325 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.profile.city, "Vellore");
  assert.equal(saved.body.profile.postalCode, "632014");
  const back = (await call("GET", "/api/profile", u.token)).body.profile;
  assert.equal(back.addressLine, "12 Temple Road", "address persists");
  assert.equal(back.latitude, 12.9165);
  assert.equal((await call("PUT", "/api/profile", u.token, { latitude: 95, longitude: 10 })).status, 400, "latitude out of range rejected");
  assert.equal((await call("PUT", "/api/profile", u.token, { phoneNumber: "call me" })).status, 400);
  const cleared = await call("PUT", "/api/profile", u.token, { city: "" });
  assert.equal(cleared.body.profile.city, null, "empty value clears the field");
  assert.equal(cleared.body.profile.latitude, 12.9165, "other fields are untouched by a partial update");
});

test("match events: recipients record views/requests; donors and bad input are refused", async () => {
  const donor = await signup("ev1", "DONOR"), rec = await signup("ev2", "RECIPIENT");
  const rid = await addResource(donor.token, "Event item", 2);
  const ok = await call("POST", "/api/matching/events", rec.token, { resourceId: rid, action: "view", rank: 1, score: 88 });
  assert.equal(ok.status, 201);
  assert.equal((await call("POST", "/api/matching/events", rec.token, { resourceId: rid, action: "request", rank: 1, score: 88 })).status, 201);
  assert.equal((await call("POST", "/api/matching/events", donor.token, { resourceId: rid, action: "view" })).status, 403, "donors cannot log recipient matches");
  assert.equal((await call("POST", "/api/matching/events", rec.token, { resourceId: rid, action: "click" })).status, 400);
  assert.equal((await call("POST", "/api/matching/events", rec.token, { resourceId: 999999999, action: "view" })).status, 404);
  const n = await pool.query("SELECT COUNT(*)::int c FROM match_events WHERE resource_id = $1", [rid]);
  assert.equal(n.rows[0].c, 2, "both events stored");
});

// ---------------------------------------------------------------- production hardening
const { spawnSync, spawn } = require("node:child_process");
const path = require("node:path");
const serverFile = path.join(__dirname, "..", "server.js");

test("hardening: rate limiter returns 429 after 20 login attempts (enabled explicitly for this check)", () => {
  const script = `
    const { app, pool } = require(${JSON.stringify(serverFile)});
    const s = app.listen(0); const b = "http://127.0.0.1:" + s.address().port;
    (async () => { const codes = [];
      for (let i = 0; i < 22; i++) codes.push((await fetch(b + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "x@y.io", password: "wrong-password" }) })).status);
      console.log("RESULT " + codes.filter(c => c === 429).length);
      s.close(); await pool.end(); })();`;
  const out = spawnSync(process.execPath, ["-e", script], { env: Object.assign({}, process.env, { RATE_LIMIT_TEST: "1" }), encoding: "utf8" });
  const count = Number((out.stdout.match(/RESULT (\d+)/) || [])[1]);
  assert.ok(count >= 1, "expected at least one 429, got: " + out.stdout + out.stderr);
});

test("hardening: production refuses a weak JWT secret", () => {
  const out = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(serverFile)})`], {
    env: Object.assign({}, process.env, { NODE_ENV: "production", JWT_SECRET: "short", CORS_ORIGIN: "https://example.org", PGPASSWORD: "x" }), encoding: "utf8"
  });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /JWT_SECRET must be set and at least 32 characters/);
});

test("hardening: health reports uptime and security headers are present", async () => {
  const h = await call("GET", "/api/health");
  assert.equal(h.status, 200);
  assert.equal(typeof h.body.uptimeSeconds, "number");
  const res = await fetch(base + "/api/health");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("hardening: the server shuts down cleanly on SIGTERM", async () => {
  const child = spawn(process.execPath, [serverFile], { env: Object.assign({}, process.env, { PORT: "5977" }), stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 8000);
    child.stdout.on("data", d => { if (String(d).includes("listening")) { clearTimeout(timer); resolve(); } });
    child.on("exit", code => reject(new Error("exited early with " + code)));
  });
  const code = await new Promise(resolve => { child.on("exit", resolve); child.kill("SIGTERM"); });
  assert.equal(code, 0, "exit code after SIGTERM");
});

test("matching breakdown: five factors with documented maxima that add up to the score", async () => {
  const donor = await signup("bd1", "DONOR"), rec = await signup("bd2", "RECIPIENT");
  const tag = "Brk" + run;
  await addResource(donor.token, tag + "-item", 2, { category: "Books", location: "Chennai", availability: "Available now" });
  const r = await call("GET", `/api/matching?category=Books&location=Chennai&quantity=4&urgency=HIGH&search=${tag}`, rec.token);
  const m = r.body.matches.find(x => x.name === tag + "-item");
  assert.deepEqual(m.breakdown.map(f => [f.factor, f.max]), [["category", 30], ["location", 20], ["quantity", 20], ["urgency", 15], ["availability", 15]]);
  const sum = m.breakdown.reduce((total, f) => total + f.points, 0);
  assert.ok(Math.abs(sum - m.matchScore) <= 1, `breakdown ${sum} vs score ${m.matchScore}`);
  assert.equal(m.breakdown.find(f => f.factor === "quantity").points, 10, "2 of 4 units gives half of 20 points");
  assert.equal(m.breakdown.find(f => f.factor === "category").points, 30);
});

// ---------------------------------------------------------------- correction round: scoring, ownership, password
test("smart match: no stated need gives no score; a stated need is scored only on the factors asked about", async () => {
  const donor = await signup("sc1", "DONOR"), rec = await signup("sc2", "RECIPIENT");
  const tag = "Score" + run;
  await addResource(donor.token, tag + "-books", 5, { category: "Books", location: "Chennai" });
  const none = await call("GET", `/api/matching?search=${tag}`, rec.token);
  const item = none.body.matches.find(m => m.name === tag + "-books");
  assert.equal(item.matchScore, null, "no need stated: no score is shown");
  assert.ok(item.matchReasons[0].includes("Add a category"), "the reason tells the user what to add");
  assert.equal(item.breakdown.find(f => f.factor === "category").applicable, false);
  // category asked: availability (15) and category (30) apply; a different category earns 0 of 30
  const same = await call("GET", `/api/matching?search=${tag}&category=Books`, rec.token);
  assert.equal(same.body.matches.find(m => m.name === tag + "-books").matchScore, 100, "same category, available now");
  // quantity asked (40 units, 5 available): quantity earns 2.5 of 20; availability 15 of 15; score = 17.5 of 35
  const qty = await call("GET", `/api/matching?search=${tag}&quantity=40`, rec.token);
  assert.equal(qty.body.matches.find(m => m.name === tag + "-books").matchScore, 50, "only the asked factors count");
});

test("ownership: only donors list resources and propose exchanges", async () => {
  const rec = await signup("own1", "RECIPIENT"), adm = await admin(), donor = await signup("own2", "DONOR");
  const body = { name: "Attempt", category: "Books", quantity: 1 };
  assert.equal((await call("POST", "/api/resources", rec.token, body)).status, 403, "recipient cannot list a resource");
  assert.equal((await call("POST", "/api/resources", adm.token, body)).status, 403, "administrator does not own listings");
  const mine = await addResource(donor.token, "Owned by donor", 2);
  assert.equal((await call("POST", "/api/exchanges", rec.token, { recipientId: donor.id, offeredResourceId: mine, requestedResourceId: mine, offeredQuantity: 1, requestedQuantity: 1 })).status, 403, "recipient cannot propose an exchange");
});

test("settings: password change checks the current password and works for the next sign-in", async () => {
  const u = await signup("pw1", "DONOR");
  assert.equal((await call("PUT", "/api/auth/password", u.token, { currentPassword: "wrong-one", newPassword: "brandnew123" })).status, 400);
  assert.equal((await call("PUT", "/api/auth/password", u.token, { currentPassword: "password123", newPassword: "short" })).status, 400);
  assert.equal((await call("PUT", "/api/auth/password", u.token, { currentPassword: "password123", newPassword: "brandnew123" })).status, 200);
  assert.equal((await call("POST", "/api/auth/login", null, { email: mail("pw1"), password: "password123" })).status, 401, "old password no longer works");
  assert.equal((await call("POST", "/api/auth/login", null, { email: mail("pw1"), password: "brandnew123" })).status, 200, "new password works");
});
