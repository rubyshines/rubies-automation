/**
 * Gmail Push Notification (Pub/Sub) validation middleware
 *
 * Google Cloud Pub/Sub sends push messages with a specific shape.
 * We validate:
 * 1. Payload has message.data (base64-encoded)
 * 2. Decoded data has emailAddress matching our account
 * 3. Optional: shared secret via query param (same as Gorgias pattern)
 */

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

  // Optional secret check
  const secret = process.env.GMAIL_WEBHOOK_SECRET;
  if (secret && req.query.secret) {
    if (req.query.secret !== secret) {
      console.warn('[gmail-push-auth] Rejected: secret mismatch');
      return res.status(401).json({ error: 'invalid secret' });
    }
  }

  next();
}

module.exports = { verifyGmailPush };
