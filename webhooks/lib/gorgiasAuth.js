/**
 * Gorgias webhook validation middleware
 *
 * Gorgias HTTP integrations don't send HMAC signatures.
 * Authentication relies on:
 * 1. Only Gorgias knows the webhook URL (obscurity)
 * 2. We validate the payload has the expected Gorgias shape
 * 3. Optional: check a shared secret passed as a query param or header
 */

function verifyGorgiasSecret(req, res, next) {
  const payload = req.body;

  // Basic shape validation — must have ticket.id
  if (!payload?.ticket?.id) {
    console.warn('[gorgias-auth] Rejected: payload missing ticket.id');
    return res.status(400).json({ error: 'invalid payload — missing ticket.id' });
  }

  // Optional: if GORGIAS_WEBHOOK_SECRET is set, check it as a query param
  // (you can append ?secret=xxx to the webhook URL in Gorgias config)
  const secret = process.env.GORGIAS_WEBHOOK_SECRET;
  if (secret && req.query.secret) {
    if (req.query.secret !== secret) {
      console.warn('[gorgias-auth] Rejected: secret mismatch');
      return res.status(401).json({ error: 'invalid secret' });
    }
  }

  next();
}

module.exports = { verifyGorgiasSecret };
