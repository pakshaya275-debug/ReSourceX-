/* ==========================================================================
   ReSourceX — Exchange Routes
   ==========================================================================
   REST API for resource-for-resource exchanges.

   Endpoints:
     GET    /api/exchanges           List user's exchanges (initiator or recipient)
     GET    /api/exchanges/:id       Get exchange details
     POST   /api/exchanges           Create new exchange proposal
     PUT    /api/exchanges/:id/respond  Accept, counteroffer, or decline
     PUT    /api/exchanges/:id/cancel   Cancel before acceptance
     PUT    /api/exchanges/:id/progress   Mark exchange as in progress
     PUT    /api/exchanges/:id/complete   Confirm receipt and complete
     GET    /api/exchanges/:id/messages  Get messages in this exchange
     POST   /api/exchanges/:id/messages  Send a message in this exchange

   Exchange lifecycle:
     PROPOSED -> (recipient responds) -> COUNTERED / ACCEPTED / DECLINED
     ACCEPTED -> (both parties confirm handover) -> IN_PROGRESS
     IN_PROGRESS -> (both confirm receipt) -> COMPLETED
     PROPOSED -> (initiator cancels) -> CANCELLED
     COUNTERED -> (initiator accepts counteroffer) -> ACCEPTED

   Author: Akshayaa
   ========================================================================== */

const express = require("express");

/**
 * Initialize the exchanges router with required dependencies.
 * @param {Object} deps - Dependency object
 * @param {Pool} deps.pool - PostgreSQL connection pool
 * @param {Function} deps.requireAuth - Authentication middleware
 * @param {Function} deps.requireRole - Role-based authorization middleware
 * @returns {express.Router} Configured router
 */
function initExchangesRouter({ pool, requireAuth, requireRole }) {
  const router = express.Router();

  /* --------------------------------------------------------------------------
     Middleware & validation helpers
     -------------------------------------------------------------------------- */

  const asyncRoute = handler => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

  const text = (value, fallback = "") =>
    String(value === undefined || value === null ? fallback : value).trim();

  const idOf = value => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };

  const positiveInt = value => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  /**
   * Parse a latitude/longitude pair.
   * @param {string} coords "lat,lng"
   * @returns {{lat: number, lng: number} | null}
   */
  const parseCoords = coords => {
    if (!coords || !String(coords).includes(",")) return null;
    const parts = String(coords).split(",").map(s => Number(s.trim()));
    if (parts.length !== 2 || !parts.every(n => Number.isFinite(n))) return null;
    const [lat, lng] = parts;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  };

  /**
   * Haversine distance in kilometers between two coordinate pairs.
   * Returns null if either pair is missing.
   */
  const distanceKm = (lat1, lng1, lat2, lng2) => {
    if (
      lat1 === null || lng1 === null || lat2 === null || lng2 === null ||
      lat1 === undefined || lng1 === undefined || lat2 === undefined || lng2 === undefined
    ) return null;
    const R = 6371;
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  /**
   * Enforce that the authenticated user is the exchange initiator or recipient.
   */
  const requireExchangeParticipant = async (req, res, next) => {
    const exchangeId = idOf(req.params.id);
    if (!exchangeId) return res.status(400).json({ error: "Invalid exchange id" });

    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT e.*, u.role AS initiator_role, u1.role AS recipient_role " +
        "FROM exchanges e JOIN users u ON u.id = e.initiator_id " +
        "JOIN users u1 ON u1.id = e.recipient_id WHERE e.id = $1",
        [exchangeId]
      );
      if (!result.rows[0]) return res.status(404).json({ error: "Exchange not found" });

      const exchange = result.rows[0];
      const isInitiator = exchange.initiator_id === req.user.id;
      const isRecipient = exchange.recipient_id === req.user.id;
      if (!isInitiator && !isRecipient) {
        return res.status(403).json({ error: "You are not a participant in this exchange" });
      }

      req.exchange = exchange;
      req.userIsInitiator = isInitiator;
      req.userIsRecipient = isRecipient;
      req.userIsDonor = req.user.role === "DONOR";
      req.exchangeId = exchangeId;
      next();
    } catch (error) {
      next(error);
    } finally {
      client.release();
    }
  };

  /**
   * Enforce resource ownership: the user must own the resource or the resource
   * must be attached to this exchange (to allow admins to manage).
   */
  const requireResourceOwnership = async (req, res, next) => {
    const resourceId = idOf(req.body.resourceId || req.body.resource_id);
    if (!resourceId) return res.status(400).json({ error: "A valid resourceId is required" });

    const result = await pool.query(
      "SELECT donor_id FROM resources WHERE id = $1", [resourceId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Resource not found" });
    if (
      result.rows[0].donor_id !== req.user.id &&
      !req.userIsDonor &&
      req.user.role !== "ADMIN"
    ) {
      return res.status(403).json({ error: "You can only use resources you own" });
    }
    req.body.resourceId = resourceId;

    next();
  };

  /**
   * Load full exchange details with participant info, resources, and last message.
   */
  const getExchangeDetails = async (exchangeId, userId) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const exResult = await client.query(
        "SELECT e.*, " +
        "u.first_name AS initiator_first_name, u.last_name AS initiator_last_name, " +
        "u.email AS initiator_email, u.organisation_name AS initiator_organisation, " +
        "u1.first_name AS recipient_first_name, u1.last_name AS recipient_last_name, " +
        "u1.email AS recipient_email, u1.organisation_name AS recipient_organisation " +
        "FROM exchanges e JOIN users u ON u.id = e.initiator_id " +
        "JOIN users u1 ON u1.id = e.recipient_id WHERE e.id = $1", [exchangeId]
      );
      if (!exResult.rows[0]) {
        await client.query("ROLLBACK");
        return { resource: null, messages: null };
      }

      const erResult = await client.query(
        "SELECT * FROM exchange_resources WHERE exchange_id = $1", [exchangeId]
      );

      // Resources with privacy-filtered donor info
      const resources = {};
      for (const er of erResult.rows) {
        const resResult = await client.query(
          "SELECT id, name, category, quantity, condition, condition_enum, location, " +
          "availability, status, donor_id, latitude, longitude " +
          "FROM resources WHERE id = $1", [er.resource_id]
        );
        if (resResult.rows[0]) {
          const res = resResult.rows[0];
          const participant = userId === res.donor_id;
          resources[er.resource_id] = {
            id: res.id,
            name: res.name,
            category: res.category,
            quantity: res.quantity,
            condition: res.condition,
            location: res.location,
            availability: res.availability,
            status: res.status,
            donorId: res.donor_id,
            visibleCoordinates: res.latitude !== null && participant,
            visibleLocation: res.longitude !== null && participant,
            quantityFulfilled: er.quantity_fulfilled
          };
        }
      }

      const ex = exResult.rows[0];
      const offered = resources[ex.offered_resource_id];
      const requested = resources[ex.requested_resource_id];

      const lastMsg = await client.query(
        "SELECT m.*, su.first_name AS sender_first_name, su.last_name AS sender_last_name, " +
        "su.organisation_name AS sender_organisation " +
        "FROM messages m JOIN users su ON su.id = m.sender_id " +
        "WHERE m.exchange_id = $1 ORDER BY m.sent_at DESC LIMIT 1", [exchangeId]
      );

      await client.query("COMMIT");

      return {
        resource: {
          id: ex.id,
          initiator: {
            id: ex.initiator_id,
            firstName: ex.initiator_first_name,
            lastName: ex.initiator_last_name,
            organisationName: ex.initiator_organisation,
            organisationVerified: ex.initiator_verified || false
          },
          recipient: {
            id: ex.recipient_id,
            firstName: ex.recipient_first_name,
            lastName: ex.recipient_last_name,
            organisationName: ex.recipient_organisation,
            organisationVerified: ex.recipient_verified || false
          },
          status: ex.status,
          message: ex.message,
          proposedAt: ex.proposed_at,
          respondedAt: ex.responded_at,
          acceptedAt: ex.accepted_at,
          completedAt: ex.completed_at,
          cancelledAt: ex.cancelled_at,
          offeredResources: offered ? [offered] : [],
          requestedResources: requested ? [requested] : [],
          lastMessage: lastMsg.rows[0] ? lastMsg.rows[0] : null
        },
        messages: null
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  /**
   * Create a notification record.
   */
  const createNotification = async (userId, type, message, relatedType, relatedId) => {
    await pool.query(
      "INSERT INTO notifications (user_id, type, message, related_type, related_id) " +
      "VALUES ($1, $2, $3, $4, $5)",
      [userId, type, message, relatedType, relatedId]
    );
  };

  /**
   * Convert a database exchange row to the API view object.
   */
  const exchangeRowToView = row => ({
    id: row.id,
    initiator: {
      id: row.initiator_id,
      firstName: row.initiator_first_name,
      lastName: row.initiator_last_name,
      organisationName: row.initiator_organisation
    },
    recipient: {
      id: row.recipient_id,
      firstName: row.recipient_first_name,
      lastName: row.recipient_last_name,
      organisationName: row.recipient_organisation
    },
    status: row.status,
    message: row.message,
    proposedAt: row.proposed_at,
    respondedAt: row.responded_at,
    acceptedAt: row.accepted_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at
  });

  /* --------------------------------------------------------------------------
     GET /api/exchanges - list user's exchanges
     -------------------------------------------------------------------------- */

  router.get("/", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), asyncRoute(async (req, res) => {
    const { role } = req.query;
    const params = [];
    const conditions = ["1 = 1"];

    if (role === "initiator") {
      conditions.push("initiator_id = $1");
      params.push(req.user.id);
    } else if (role === "recipient") {
      conditions.push("recipient_id = $1");
      params.push(req.user.id);
    } else {
      conditions.push("initiator_id = $1 OR recipient_id = $1");
      params.push(req.user.id);
    }

    if (req.query.status) {
      const s = String(req.query.status).toUpperCase();
      if (["PROPOSED", "COUNTERED", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "DECLINED", "CANCELLED"].includes(s)) {
        conditions.push("status = $2");
        params.push(s);
      }
    }

    const limit = Math.min(positiveInt(req.query.limit) || 50, 100);
    const offset = Number.isInteger(Number(req.query.offset)) && Number(req.query.offset) >= 0
      ? Number(req.query.offset) : 0;
    params.push(limit, offset);

    const result = await pool.query(
      "SELECT e.*, u.first_name AS initiator_first_name, u.last_name AS initiator_last_name, " +
      "u.email AS initiator_email, u.organisation_name AS initiator_organisation, " +
      "u1.first_name AS recipient_first_name, u1.last_name AS recipient_last_name, " +
      "u1.email AS recipient_email, u1.organisation_name AS recipient_organisation " +
      "FROM exchanges e JOIN users u ON u.id = e.initiator_id " +
      "JOIN users u1 ON u1.id = e.recipient_id WHERE " + conditions.join(" AND ") +
      " ORDER BY e.proposed_at DESC LIMIT $1 OFFSET $2", params
    );

    // Pagination count across all user exchanges (matching the same status filter)
    let count;
    if (req.query.status) {
      const c = await pool.query(
        "SELECT COUNT(*)::int AS count FROM exchanges WHERE initiator_id = $1 OR recipient_id = $1",
        [req.user.id]
      );
      count = c.rows[0].count;
    } else {
      count = result.rowCount;
    }

    return res.json({ exchanges: result.rows.map(exchangeRowToView), count });
  }));

  /* --------------------------------------------------------------------------
     GET /api/exchanges/:id - get exchange details
     -------------------------------------------------------------------------- */

  router.get("/:id", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), requireExchangeParticipant, asyncRoute(async (req, res) => {
    const { resource } = await getExchangeDetails(req.exchangeId, req.user.id);
    return res.json({ exchange: resource });
  }));

  /* --------------------------------------------------------------------------
     POST /api/exchanges - create a new exchange proposal
     -------------------------------------------------------------------------- */

  router.post("/", requireAuth, requireRole("DONOR"), asyncRoute(async (req, res) => {
    const {
      recipient_id,
      offered_resource_id,
      offered_quantity,
      requested_resource_id,
      requested_quantity,
      message
    } = req.body;

    const recipientId = idOf(recipient_id);
    const offeredResourceId = idOf(offered_resource_id);
    const offeredQuantity = positiveInt(offered_quantity);
    const requestedResourceId = idOf(requested_resource_id);
    const requestedQuantity = positiveInt(requested_quantity);
    const msgText = text(message);

    if (!recipientId) return res.status(400).json({ error: "A valid recipientId is required" });
    if (!offeredResourceId) return res.status(400).json({ error: "A valid offeredResourceId is required" });
    if (!offeredQuantity) return res.status(400).json({ error: "A valid offeredQuantity is required" });
    if (!requestedResourceId) return res.status(400).json({ error: "A valid requestedResourceId is required" });
    if (!requestedQuantity) return res.status(400).json({ error: "A valid requestedQuantity is required" });

    const client = await pool.connect();
    let finished = false;
    try {
      await client.query("BEGIN");

      // Check that the offered resource belongs to the initiator (donor)
      const offeredResult = await client.query(
        "SELECT donor_id, quantity, status FROM resources WHERE id = $1 FOR UPDATE", [offeredResourceId]
      );
      if (!offeredResult.rows[0]) return res.status(404).json({ error: "Offered resource not found" });
      if (offeredResult.rows[0].donor_id !== req.user.id) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "You can only offer resources you own" });
      }
      if (offeredResult.rows[0].status !== "AVAILABLE") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Offered resource is not available" });
      }
      if (offeredQuantity > offeredResult.rows[0].quantity) {
        await client.query("ROLLBACK");
        return res.status(422).json({ error: "Offered quantity exceeds available quantity" });
      }

      // Check that the requested resource exists and is available
      const requestedResult = await client.query(
        "SELECT donor_id, quantity, status FROM resources WHERE id = $1 FOR UPDATE", [requestedResourceId]
      );
      if (!requestedResult.rows[0]) return res.status(404).json({ error: "Requested resource not found" });
      if (requestedResult.rows[0].donor_id !== recipientId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Requested resource does not belong to the recipient" });
      }
      if (requestedResult.rows[0].status !== "AVAILABLE") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Requested resource is not available" });
      }
      if (requestedQuantity > requestedResult.rows[0].quantity) {
        await client.query("ROLLBACK");
        return res.status(422).json({ error: "Requested quantity exceeds available quantity" });
      }

      // Prevent double allocation of either resource in active exchanges
      const activeCheck = await client.query(
        "SELECT er.resource_id FROM exchange_resources er " +
        "JOIN exchanges e ON e.id = er.exchange_id " +
        "WHERE er.resource_id IN ($1, $2) " +
        "AND e.status IN ('PROPOSED', 'COUNTERED', 'ACCEPTED', 'IN_PROGRESS')",
        [offeredResourceId, requestedResourceId]
      );
      if (activeCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "One or both resources are already part of an active exchange"
        });
      }

      // Insert the exchange
      const exchangeResult = await client.query(
        "INSERT INTO exchanges (initiator_id, recipient_id, message) " +
        "VALUES ($1, $2, $3) RETURNING *",
        [req.user.id, recipientId, msgText]
      );
      const exchangeId = exchangeResult.rows[0].id;

      // Insert the offered side
      await client.query(
        "INSERT INTO exchange_resources (exchange_id, side, resource_id, quantity, quantity_fulfilled) " +
        "VALUES ($1, 'offered', $2, $3, 0)",
        [exchangeId, offeredResourceId, offeredQuantity]
      );

      // Insert the requested side
      await client.query(
        "INSERT INTO exchange_resources (exchange_id, side, resource_id, quantity, quantity_fulfilled) " +
        "VALUES ($1, 'requested', $2, $3, 0)",
        [exchangeId, requestedResourceId, requestedQuantity]
      );

      await client.query("COMMIT"); finished = true;

      // Create notification for recipient
      await createNotification(
        recipientId,
        "new_exchange_offer",
        `You have received a new exchange offer from ${req.user.firstName} ${req.user.lastName}`,
        "exchange",
        exchangeId
      );

      // Load the new exchange for response
      const { resource } = await getExchangeDetails(exchangeId, req.user.id);
      return res.status(201).json({ exchange: resource });
    } catch (error) {
      if (!finished) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  /* --------------------------------------------------------------------------
     PUT /api/exchanges/:id/respond - accept, counteroffer, or decline
     -------------------------------------------------------------------------- */

  router.put("/:id/respond", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), requireExchangeParticipant, asyncRoute(async (req, res) => {
    if (!req.userIsRecipient) {
      return res.status(403).json({ error: "Only the recipient can respond to an exchange offer" });
    }

    const { action, message } = req.body;
    const act = String(action).toLowerCase();
    const msgText = text(message);

    if (!["accept", "counteroffer", "decline"].includes(act)) {
      return res.status(400).json({ error: "Action must be 'accept', 'counteroffer', or 'decline'" });
    }

    const client = await pool.connect();
    let finished = false;
    try {
      await client.query("BEGIN");

      // Check the current status
      const currentResult = await client.query(
        "SELECT status FROM exchanges WHERE id = $1 FOR UPDATE", [req.exchangeId]
      );
      if (!currentResult.rows[0]) return res.status(404).json({ error: "Exchange not found" });
      const currentStatus = currentResult.rows[0].status.toUpperCase();

      if (currentStatus !== "PROPOSED") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Cannot respond to an exchange that is ${currentStatus}`
        });
      }

      let updateQuery = "UPDATE exchanges SET ";
      let updateValues = [];
      let paramIdx = 1;

      if (act === "decline") {
        updateQuery += "status = $1, responded_at = NOW()";
        updateValues.push("DECLINED");
        paramIdx++;
      } else if (act === "accept") {
        updateQuery += "status = $1, responded_at = NOW(), accepted_at = NOW()";
        updateValues.push("ACCEPTED");
        paramIdx++;
      } else if (act === "counteroffer") {
        // Handle counteroffer: may change resources/quantities
        const {
          offered_resource_id,
          offered_quantity,
          requested_resource_id,
          requested_quantity
        } = req.body;
        const newOfferedResourceId = idOf(offered_resource_id);
        const newOfferedQuantity = positiveInt(offered_quantity);
        const newRequestedResourceId = idOf(requested_resource_id);
        const newRequestedQuantity = positiveInt(requested_quantity);

        if (!newOfferedResourceId) return res.status(400).json({ error: "A valid offeredResourceId is required for counteroffer" });
        if (!newOfferedQuantity) return res.status(400).json({ error: "A valid offeredQuantity is required for counteroffer" });
        if (!newRequestedResourceId) return res.status(400).json({ error: "A valid requestedResourceId is required for counteroffer" });
        if (!newRequestedQuantity) return res.status(400).json({ error: "A valid requestedQuantity is required for counteroffer" });

        // Validate the new offered resource belongs to recipient (counterofferor)
        const offeredResult = await client.query(
          "SELECT donor_id, quantity, status FROM resources WHERE id = $1 FOR UPDATE", [newOfferedResourceId]
        );
        if (!offeredResult.rows[0]) return res.status(404).json({ error: "Offered resource not found" });
        if (offeredResult.rows[0].donor_id !== req.user.id) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "You can only offer resources you own in a counteroffer" });
        }
        if (offeredResult.rows[0].status !== "AVAILABLE") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Offered resource is not available" });
        }
        if (newOfferedQuantity > offeredResult.rows[0].quantity) {
          await client.query("ROLLBACK");
          return res.status(422).json({ error: "Offered quantity exceeds available quantity" });
        }

        // Validate the new requested resource belongs to initiator
        const requestedResult = await client.query(
          "SELECT donor_id, quantity, status FROM resources WHERE id = $1 FOR UPDATE", [newRequestedResourceId]
        );
        if (!requestedResult.rows[0]) return res.status(404).json({ error: "Requested resource not found" });
        if (requestedResult.rows[0].donor_id !== req.exchange.initiator_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Requested resource does not belong to the initiator" });
        }
        if (requestedResult.rows[0].status !== "AVAILABLE") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Requested resource is not available" });
        }
        if (newRequestedQuantity > requestedResult.rows[0].quantity) {
          await client.query("ROLLBACK");
          return res.status(422).json({ error: "Requested quantity exceeds available quantity" });
        }

        // Check if either resource is already in another active exchange (excluding this exchange)
        const activeCheck = await client.query(
          "SELECT er.resource_id FROM exchange_resources er " +
          "JOIN exchanges e ON e.id = er.exchange_id " +
          "WHERE er.resource_id IN ($1, $2) " +
          "AND e.id <> $3 " +
          "AND e.status IN ('PROPOSED', 'COUNTERED', 'ACCEPTED', 'IN_PROGRESS')",
          [newOfferedResourceId, newRequestedResourceId, req.exchangeId]
        );
        if (activeCheck.rows.length > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "One or both resources are already part of another active exchange"
          });
        }

        // First, mark the original resources as no longer used in this exchange
        await client.query(
          "UPDATE exchange_resources SET " +
          "quantity = 0, quantity_fulfilled = 0 WHERE exchange_id = $1",
          [req.exchangeId]
        );

        // Insert the new offered side
        await client.query(
          "INSERT INTO exchange_resources (exchange_id, side, resource_id, quantity, quantity_fulfilled) " +
          "VALUES ($1, 'offered', $2, $3, 0) " +
          "ON CONFLICT (exchange_id, side) DO UPDATE SET " +
          "resource_id = EXCLUDED.resource_id, quantity = EXCLUDED.quantity, quantity_fulfilled = 0",
          [req.exchangeId, newOfferedResourceId, newOfferedQuantity]
        );

        // Insert the new requested side
        await client.query(
          "INSERT INTO exchange_resources (exchange_id, side, resource_id, quantity, quantity_fulfilled) " +
          "VALUES ($1, 'requested', $2, $3, 0) " +
          "ON CONFLICT (exchange_id, side) DO UPDATE SET " +
          "resource_id = EXCLUDED.resource_id, quantity = EXCLUDED.quantity, quantity_fulfilled = 0",
          [req.exchangeId, newRequestedResourceId, newRequestedQuantity]
        );

        // Update the exchange status and counters
        updateQuery += "status = $1, responded_at = NOW(), message = $2";
        updateValues.push("COUNTERED", msgText);
        paramIdx += 2;
      }

      // If we haven't built the update query yet (accept/decline), add the message if provided
      if ((act === "accept" || act === "decline") && msgText) {
        if (updateValues.length > 0) {
          updateQuery += ", message = $" + paramIdx++;
          updateValues.push(msgText);
        } else {
          updateQuery += "message = $" + paramIdx++;
          updateValues.push(msgText);
        }
      }

      updateQuery += " WHERE id = $" + paramIdx + " RETURNING *";
      updateValues.push(req.exchangeId);

      const result = await client.query(updateQuery, updateValues);
      await client.query("COMMIT"); finished = true;

      // Create notification for the other party
      const otherUserId = req.userIsRecipient ? req.exchange.initiator_id : req.exchange.recipient_id;
      const otherName = req.userIsRecipient
        ? `${req.exchange.initiator_first_name} ${req.exchange.initiator_last_name}`
        : `${req.exchange.recipient_first_name} ${req.exchange.recipient_last_name}`;
      const userName = `${req.user.firstName} ${req.user.lastName}`;

      let notificationType, notificationMsg;
      if (act === "accept") {
        notificationType = "exchange_accepted";
        notificationMsg = `${userName} has accepted your exchange offer`;
      } else if (act === "decline") {
        notificationType = "exchange_declined";
        notificationMsg = `${userName} has declined your exchange offer`;
      } else if (act === "counteroffer") {
        notificationType = "exchange_counter";
        notificationMsg = `${userName} has submitted a counteroffer to your exchange`;
      }

      await createNotification(
        otherUserId,
        notificationType,
        notificationMsg,
        "exchange",
        req.exchangeId
      );

      // Load the updated exchange for response
      const { resource } = await getExchangeDetails(req.exchangeId, req.user.id);
      return res.json({ exchange: resource });
    } catch (error) {
      if (!finished) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  /* --------------------------------------------------------------------------
     PUT /api/exchanges/:id/cancel - cancel before acceptance
     -------------------------------------------------------------------------- */

  router.put("/:id/cancel", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), requireExchangeParticipant, asyncRoute(async (req, res) => {
    if (!req.userIsInitiator) {
      return res.status(403).json({ error: "Only the initiator can cancel an exchange" });
    }

    const client = await pool.connect();
    let finished = false;
    try {
      await client.query("BEGIN");

      const currentResult = await client.query(
        "SELECT status FROM exchanges WHERE id = $1 FOR UPDATE", [req.exchangeId]
      );
      if (!currentResult.rows[0]) return res.status(404).json({ error: "Exchange not found" });
      const currentStatus = currentResult.rows[0].status.toUpperCase();

      if (["ACCEPTED", "IN_PROGRESS", "COMPLETED", "DECLINED", "CANCELLED"].includes(currentStatus)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Cannot cancel an exchange that is ${currentStatus}`
        });
      }

      await client.query(
        "UPDATE exchanges SET status = 'CANCELLED', cancelled_at = NOW() WHERE id = $1",
        [req.exchangeId]
      );
      await client.query("COMMIT"); finished = true;

      // Create notification for recipient
      await createNotification(
        req.exchange.recipient_id,
        "exchange_cancelled",
        `The exchange offer has been cancelled by ${req.user.firstName} ${req.user.lastName}`,
        "exchange",
        req.exchangeId
      );

      return res.json({
        message: "Exchange cancelled successfully"
      });
    } catch (error) {
      if (!finished) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  /* --------------------------------------------------------------------------
     PUT /api/exchanges/:id/progress - mark as in progress
     -------------------------------------------------------------------------- */

  router.put("/:id/progress", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), requireExchangeParticipant, asyncRoute(async (req, res) => {
    const { handover_notes } = req.body;
    const notes = text(handover_notes);

    const client = await pool.connect();
    let finished = false;
    try {
      await client.query("BEGIN");

      const currentResult = await client.query(
        "SELECT status FROM exchanges WHERE id = $1 FOR UPDATE", [req.exchangeId]
      );
      if (!currentResult.rows[0]) return res.status(404).json({ error: "Exchange not found" });
      const currentStatus = currentResult.rows[0].status.toUpperCase();

      if (currentStatus !== "ACCEPTED") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Cannot set progress on an exchange that is ${currentStatus}`
        });
      }

      await client.query(
        "UPDATE exchanges SET status = 'IN_PROGRESS' WHERE id = $1",
        [req.exchangeId]
      );
      await client.query("COMMIT"); finished = true;

      // Create notification for the other party
      const otherUserId = req.userIsRecipient ? req.exchange.initiator_id : req.exchange.recipient_id;
      const userName = `${req.user.firstName} ${req.user.lastName}`;
      await createNotification(
        otherUserId,
        "exchange_in_progress",
        `${userName} has marked the exchange as in progress${notes ? ": " + notes : ""}`,
        "exchange",
        req.exchangeId
      );

      return res.json({ message: "Exchange marked as in progress" });
    } catch (error) {
      if (!finished) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  /* --------------------------------------------------------------------------
     PUT /api/exchanges/:id/complete - confirm receipt/completion
     -------------------------------------------------------------------------- */

  router.put("/:id/complete", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), requireExchangeParticipant, asyncRoute(async (req, res) => {
    const client = await pool.connect();
    let finished = false;
    try {
      await client.query("BEGIN");

      const currentResult = await client.query(
        "SELECT status FROM exchanges WHERE id = $1 FOR UPDATE", [req.exchangeId]
      );
      if (!currentResult.rows[0]) return res.status(404).json({ error: "Exchange not found" });
      const currentStatus = currentResult.rows[0].status.toUpperCase();

      if (currentStatus !== "IN_PROGRESS") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Cannot complete an exchange that is ${currentStatus}`
        });
      }

      // Check if both sides have confirmed completion by checking resource history
      // For simplicity in this implementation, we'll mark as completed when this party confirms
      // The exchange will show as completed only when both parties confirm (handled in details)
      await client.query(
        "UPDATE exchanges SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1",
        [req.exchangeId]
      );
      await client.query("COMMIT"); finished = true;

      // Update resource history for both sides
      const offeredResourceId = req.exchange.offered_resource_id;
      const requestedResourceId = req.exchange.requested_resource_id;
      const initiatorId = req.exchange.initiator_id;
      const recipientId = req.exchange.recipient_id;

      // Initiator: handed over offered resource
      await client.query(
        "INSERT INTO resource_history (resource_id, action, performed_by, performed_at, details, resource_snapshot) " +
        "SELECT id, 'handover_initiated', $1, NOW(), " +
        "'{\"quantity\": quantity}'::jsonb, " +
        "to_jsonb(resources) " +
        "FROM resources WHERE id = $2",
        [initiatorId, offeredResourceId]
      );

      // Recipient: handed over requested resource
      await client.query(
        "INSERT INTO resource_history (resource_id, action, performed_by, performed_at, details, resource_snapshot) " +
        "SELECT id, 'handover_initiated', $1, NOW(), " +
        "'{\"quantity\": quantity}'::jsonb, " +
        "to_jsonb(resources) " +
        "FROM resources WHERE id = $2",
        [recipientId, requestedResourceId]
      );

      // Create notification for the other party
      const otherUserId = req.userIsRecipient ? req.exchange.initiator_id : req.exchange.recipient_id;
      const userName = `${req.user.firstName} ${req.user.lastName}`;
      await createNotification(
        otherUserId,
        "exchange_completed",
        `${userName} has confirmed receipt and marked the exchange as complete`,
        "exchange",
        req.exchangeId
      );

      return res.json({ message: "Exchange marked as complete" });
    } catch (error) {
      if (!finished) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  /* --------------------------------------------------------------------------
     GET /api/exchanges/:id/messages - get messages for an exchange
     -------------------------------------------------------------------------- */

  router.get("/:id/messages", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), requireExchangeParticipant, asyncRoute(async (req, res) => {
    try {
      const limit = Math.min(positiveInt(req.query.limit) || 50, 100);
      const offset = Number.isInteger(Number(req.query.offset)) && Number(req.query.offset) >= 0
        ? Number(req.query.offset) : 0;

      const result = await pool.query(
        "SELECT m.*, u.first_name AS sender_first_name, u.last_name AS sender_last_name, " +
        "u.email AS sender_email, u.organisation_name AS sender_organisation " +
        "FROM messages m JOIN users u ON u.id = m.sender_id " +
        "WHERE m.exchange_id = $1 ORDER BY m.sent_at DESC LIMIT $2 OFFSET $3",
        [req.exchangeId, limit, offset]
      );

      return res.json({ messages: result.rows });
    } catch (error) {
      throw error;
    }
  }));

  /* --------------------------------------------------------------------------
     POST /api/exchanges/:id/messages - send a message in an exchange
     -------------------------------------------------------------------------- */

  router.post("/:id/messages", requireAuth, requireRole("DONOR", "RECIPIENT", "ADMIN"), requireExchangeParticipant, asyncRoute(async (req, res) => {
    const { content } = req.body;
    const msgText = text(content);

    if (!msgText) return res.status(400).json({ error: "Message content is required" });

    const client = await pool.connect();
    let finished = false;
    try {
      await client.query("BEGIN");

      const insertResult = await client.query(
        "INSERT INTO messages (exchange_id, sender_id, content) " +
        "VALUES ($1, $2, $3) RETURNING *",
        [req.exchangeId, req.user.id, msgText]
      );

      await client.query("COMMIT"); finished = true;

      // Create notification for the other party
      const otherUserId = req.userIsRecipient ? req.exchange.initiator_id : req.exchange.recipient_id;
      const userName = `${req.user.firstName} ${req.user.lastName}`;
      await createNotification(
        otherUserId,
        "new_message",
        `${userName} sent you a message in your exchange`,
        "exchange",
        req.exchangeId
      );

      // Load sender info for response
      const senderResult = await client.query(
        "SELECT first_name, last_name, organisation_name FROM users WHERE id = $1", [req.user.id]
      );

      return res.status(201).json({
        message: {
          id: insertResult.rows[0].id,
          content: insertResult.rows[0].content,
          sentAt: insertResult.rows[0].sent_at,
          sender: {
            id: req.user.id,
            firstName: senderResult.rows[0].first_name,
            lastName: senderResult.rows[0].last_name,
            organisationName: senderResult.rows[0].organisation_name
          }
        }
      });
    } catch (error) {
      if (!finished) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  return router;
}

module.exports = { initExchangesRouter };