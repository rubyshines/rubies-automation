/**
 * Gmail Push Notification (Pub/Sub) validation middleware
 *
 * Google Cloud Pub/Sub sends push messages with a specific shape.
 * We validate:
 * 1. Payload has message.data (base64-encoded)
 * 2. Decoded data has emailAddress matching our account
 * 3. Shared secret via query param, IF GMAIL_WEBHOOK_SECRET is configured.
 *    It's optional here (not yet provisioned) — when set, it is enforced and
 *    cannot be skipped by omitting the param; when unset, we fall back to the
 *    Pub/Sub shape + account-email checks above. Set GMAIL_WEBHOOK_SECRET in
 *    Railway to add the required-secret layer.
 */

const { verifySharedSecret } = require('./webhookSecret');

const OUR_EMAIL = 'jamie@rubyshines.com';

function verifyGmailPush(req, res, next) {
  const payload = req.body;

  // Pub/Sub shape validation
  if (!payload?.message?.data) {
    console.warn('[gmail-push-auth] Rejected: missing message.data');
    return res.status(400).json({ error: 'invalid payload — missing message.data' });
  }

  // Decode and validate
  try {
    const decoded = JSON.parse(Buffer.from(payload.message.data, 'base64').toString());
    if (decoded.emailAddress && decoded.emailAddress !== OUR_EMAIL) {
      console.warn(`[gmail-push-auth] Rejected: wrong email ${decoded.emailAddress}`);
      return res.status(403).json({ error: 'email mismatch' });
    }
    // Attach decoded data for handler use
    req.gmailPush = decoded;
  } catch (err) {
    console.warn(`[gmail-push-auth] Rejected: could not decode message.data — ${err.message}`);
    return res.status(400).json({ error: 'invalid message.data encoding' });
  }

  // Shared secret check (enforced when GMAIL_WEBHOOK_SECRET is configured)
  const check = verifySharedSecret(req, 'GMAIL_WEBHOOK_SECRET', { mandatory: false });
  if (!check.ok) {
    console.warn(`[gmail-push-auth] Rejected: ${check.error}`);
    return res.status(check.status).json({ error: check.error });
  }

  next();
}

module.exports = { verifyGmailPush };
