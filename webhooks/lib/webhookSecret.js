/**
 * Shared webhook shared-secret verification.
 *
 * Used by the Gorgias and Gmail push middlewares. Both accept a shared secret
 * as the `?secret=` query param. The critical rule: if a secret IS configured,
 * a request that omits or mismatches it is REJECTED — it can never be skipped
 * by simply not sending the param (the bug this replaces).
 *
 * `mandatory: true`  — the secret must be configured; an unset env var is a
 *                      500 (misconfiguration). Use when we know the secret is
 *                      provisioned (e.g. Gorgias).
 * `mandatory: false` — an unset env var falls through to the caller's other
 *                      payload validation, with a loud warning. Use when the
 *                      secret is an optional extra layer (e.g. Gmail, which
 *                      also validates Pub/Sub shape + account email).
 *
 * Comparison is constant-time to avoid leaking the secret via timing.
 *
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
const crypto = require('crypto');

function verifySharedSecret(req, envVarName, { mandatory }) {
  const secret = process.env[envVarName];

  if (!secret) {
    if (mandatory) {
      console.error(`[webhook-auth] ${envVarName} not set`);
      return { ok: false, status: 500, error: 'webhook secret not configured' };
    }
    console.warn(`[webhook-auth] ${envVarName} not set — falling back to payload validation only`);
    return { ok: true };
  }

  const provided = req.query.secret;
  if (typeof provided !== 'string' || provided.length === 0) {
    return { ok: false, status: 401, error: 'missing secret' };
  }

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'invalid secret' };
  }

  return { ok: true };
}

module.exports = { verifySharedSecret };
