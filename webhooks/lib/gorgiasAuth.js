/**
 * Gorgias webhook secret verification middleware
 *
 * Validates the X-Gorgias-Signature header (or shared secret)
 * against the GORGIAS_WEBHOOK_SECRET environment variable.
 */

const crypto = require('crypto');

function verifyGorgiasSecret(req, res, next) {
  const secret = process.env.GORGIAS_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[gorgias-auth] GORGIAS_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'webhook secret not configured' });
  }

  // Gorgias sends an HMAC signature in X-Gorgias-Signature
  // computed as HMAC-SHA256 of the raw body with the webhook secret
  const signature = req.get('X-Gorgias-Signature');
  if (!signature) {
    return res.status(401).json({ error: 'missing Gorgias signature' });
  }

  const rawBody = JSON.stringify(req.body);
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  const valid = crypto.timingSafeEqual(
    Buffer.from(signature, 'utf8'),
    Buffer.from(computed, 'utf8')
  );

  if (!valid) {
    console.warn('[gorgias-auth] Gorgias signature verification failed');
    return res.status(401).json({ error: 'signature verification failed' });
  }

  next();
}

module.exports = { verifyGorgiasSecret };
