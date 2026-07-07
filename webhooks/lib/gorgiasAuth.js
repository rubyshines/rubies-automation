/**
 * Gorgias webhook validation middleware
 *
 * Gorgias HTTP integrations don't send HMAC signatures. Authentication relies on:
 * 1. A required shared secret passed as the `?secret=` query param (append
 *    ?secret=xxx to the webhook URL in Gorgias config). GORGIAS_WEBHOOK_SECRET
 *    is provisioned, so it is treated as mandatory — a request that omits or
 *    mismatches it is rejected; it can never be skipped by dropping the param.
 * 2. We also validate the payload has the expected Gorgias shape (ticket.id).
 */

const { verifySharedSecret } = require('./webhookSecret');

function verifyGorgiasSecret(req, res, next) {
  const payload = req.body;

  // Basic shape validation — must have ticket.id
  if (!payload?.ticket?.id) {
    console.warn('[gorgias-auth] Rejected: payload missing ticket.id');
    return res.status(400).json({ error: 'invalid payload — missing ticket.id' });
  }

  const check = verifySharedSecret(req, 'GORGIAS_WEBHOOK_SECRET', { mandatory: true });
  if (!check.ok) {
    console.warn(`[gorgias-auth] Rejected: ${check.error}`);
    return res.status(check.status).json({ error: check.error });
  }

  next();
}

module.exports = { verifyGorgiasSecret };
