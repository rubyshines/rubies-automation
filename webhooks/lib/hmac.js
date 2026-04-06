/**
 * Shopify HMAC-SHA256 webhook verification middleware
 *
 * Validates the X-Shopify-Hmac-Sha256 header against the raw request body
 * using the SHOPIFY_WEBHOOK_SECRET environment variable.
 */

const crypto = require('crypto');

function verifyShopifyHmac(req, res, next) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[hmac] SHOPIFY_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'webhook secret not configured' });
  }

  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader) {
    return res.status(401).json({ error: 'missing HMAC header' });
  }

  const rawBody = req.body; // Buffer, because we use express.raw()
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: 'raw body not available' });
  }

  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  const valid = crypto.timingSafeEqual(
    Buffer.from(hmacHeader, 'utf8'),
    Buffer.from(computed, 'utf8')
  );

  if (!valid) {
    console.warn('[hmac] Shopify HMAC verification failed');
    return res.status(401).json({ error: 'HMAC verification failed' });
  }

  next();
}

module.exports = { verifyShopifyHmac };
