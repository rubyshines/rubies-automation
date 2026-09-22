'use strict';
/**
 * Centre accounts: passwords (scrypt, no dependency), single-use tokens for
 * every emailed link, and sessions stored as rows so a removed member is
 * signed out everywhere. The cookie carries only the session id and an HMAC.
 */
const crypto = require('crypto');
const { db, must, logEvent } = require('./db');

const SECRET = process.env.VC_SESSION_SECRET || process.env.SESSION_SECRET || 'dev-only-secret';
const COOKIE = 'vc_session';
const SESSION_DAYS = 30;

// ---- passwords -------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes('$')) return false;
  const [salt, hash] = stored.split('$');
  const check = crypto.scryptSync(String(password), salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === check.length && crypto.timingSafeEqual(known, check);
}
function passwordProblem(password) {
  if (!password || String(password).length < 8) return 'Use at least 8 characters.';
  return null;
}

// ---- users -----------------------------------------------------------------
const normEmail = e => String(e || '').trim().toLowerCase();

async function getUserByEmail(email) {
  return must(await db().from('vc_users').select('*').eq('email', normEmail(email)).maybeSingle(), 'user by email');
}
async function getUserById(id) {
  return must(await db().from('vc_users').select('*').eq('id', id).maybeSingle(), 'user by id');
}
async function createUser({ email, name, role_title, password }) {
  return must(await db().from('vc_users').insert({
    email: normEmail(email), name: name ? String(name).trim() : null, role_title: role_title ? String(role_title).trim() : null,
    password_hash: password ? hashPassword(password) : null,
  }).select('*').single(), 'create user');
}
async function updateUser(id, patch) {
  return must(await db().from('vc_users').update(patch).eq('id', id).select('*').single(), 'update user');
}
async function touch(userId) {
  await db().from('vc_users').update({ last_active_at: new Date().toISOString() }).eq('id', userId);
}

// ---- memberships -----------------------------------------------------------
async function addMembership(centreId, userId, role) {
  must(await db().from('vc_memberships').upsert({ centre_id: centreId, user_id: userId, role }, { onConflict: 'centre_id,user_id' }), 'membership');
}
/** The centre a user works in (one per user for now; the first if several). */
async function membershipFor(userId) {
  const rows = must(await db().from('vc_memberships').select('role, centre_id, vc_centres(*)').eq('user_id', userId).order('created_at'), 'memberships');
  if (!rows.length) return null;
  return { role: rows[0].role, centre: rows[0].vc_centres };
}
async function teamFor(centreId) {
  const members = must(await db().from('vc_memberships').select('role, created_at, vc_users(id, email, name, role_title, last_active_at, email_verified_at)').eq('centre_id', centreId).order('created_at'), 'team');
  const invites = must(await db().from('vc_invitations').select('*').eq('centre_id', centreId).is('accepted_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString()).order('created_at'), 'invites');
  return { members: members.map(m => ({ role: m.role, since: m.created_at, ...m.vc_users })), invites };
}
async function adminCount(centreId) {
  const rows = must(await db().from('vc_memberships').select('user_id').eq('centre_id', centreId).eq('role', 'admin'), 'admins');
  return rows.length;
}
async function setRole(centreId, userId, role) {
  must(await db().from('vc_memberships').update({ role }).eq('centre_id', centreId).eq('user_id', userId), 'set role');
}
async function removeMember(centreId, userId) {
  must(await db().from('vc_memberships').delete().eq('centre_id', centreId).eq('user_id', userId), 'remove member');
  await revokeAllSessions(userId);
}

// ---- tokens ----------------------------------------------------------------
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

async function issueToken(purpose, { userId = null, email = null, payload = {}, ttlHours = 48 } = {}) {
  const raw = crypto.randomBytes(24).toString('base64url');
  must(await db().from('vc_tokens').insert({
    purpose, token_hash: sha(raw), user_id: userId, email: email ? normEmail(email) : null, payload,
    expires_at: new Date(Date.now() + ttlHours * 3600000).toISOString(),
  }), 'issue token');
  return raw;
}
/** Returns the token row and marks it used, or null when unknown, used or expired. */
async function consumeToken(purpose, raw) {
  if (!raw) return null;
  const row = must(await db().from('vc_tokens').select('*').eq('purpose', purpose).eq('token_hash', sha(raw)).maybeSingle(), 'token');
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) return null;
  const { data } = await db().from('vc_tokens').update({ used_at: new Date().toISOString() }).eq('id', row.id).is('used_at', null).select('id');
  if (!data || !data.length) return null; // lost a race
  return row;
}
async function peekToken(purpose, raw) {
  if (!raw) return null;
  const row = must(await db().from('vc_tokens').select('*').eq('purpose', purpose).eq('token_hash', sha(raw)).maybeSingle(), 'token');
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) return null;
  return row;
}

// ---- sessions --------------------------------------------------------------
function sign(id) { return crypto.createHmac('sha256', SECRET).update(id).digest('base64url'); }

async function createSession(userId, { actingAs = null } = {}) {
  const id = crypto.randomBytes(24).toString('base64url');
  must(await db().from('vc_sessions').insert({ id, user_id: userId, acting_as: actingAs, expires_at: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() }), 'create session');
  return id;
}
function setSessionCookie(res, id, req) {
  const secure = req && (req.secure || req.headers['x-forwarded-proto'] === 'https');
  res.setHeader('Set-Cookie', `${COOKIE}=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
async function sessionFromRequest(req) {
  const value = readCookie(req, COOKIE);
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const id = value.slice(0, dot), sig = value.slice(dot + 1);
  const expected = sign(id);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const row = must(await db().from('vc_sessions').select('*').eq('id', id).maybeSingle(), 'session');
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return null;
  return row;
}
async function revokeSession(id) {
  await db().from('vc_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', id);
}
async function revokeAllSessions(userId) {
  await db().from('vc_sessions').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId).is('revoked_at', null);
}

/** Express middleware: attaches req.user, req.centre, req.role, req.session when signed in. */
function attach() {
  return async (req, res, next) => {
    try {
      const session = await sessionFromRequest(req);
      if (!session) return next();
      const user = await getUserById(session.user_id);
      if (!user) return next();
      const m = await membershipFor(user.id);
      req.session = session; req.user = user;
      if (m) { req.centre = m.centre; req.role = m.role; }
      if (session.acting_as) { req.actingAs = session.acting_as; req.role = 'admin'; }
      touch(user.id).catch(() => {});
      next();
    } catch (err) { next(err); }
  };
}
function requireUser(req, res, next) {
  if (!req.user) return res.redirect(302, `/signin?next=${encodeURIComponent(req.originalUrl)}`);
  if (!req.user.email_verified_at && !req.actingAs) return res.redirect(302, '/verify');
  next();
}
function requireAdmin(req, res, next) {
  if (req.role !== 'admin') return res.status(403).send('Admins only');
  next();
}

// Signed short-lived cookie for the two-step sign-up (centre id between step 1 and 2).
function setSignupCookie(res, centreId) {
  const v = `${centreId}.${sign(`signup:${centreId}`)}`;
  res.setHeader('Set-Cookie', `vc_signup=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
}
function readSignupCookie(req) {
  const v = readCookie(req, 'vc_signup');
  if (!v) return null;
  const [id, sig] = v.split('.');
  return sig === sign(`signup:${id}`) ? parseInt(id, 10) : null;
}

const PERSONAL_DOMAINS = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm)\./i;
function isPersonalEmail(email) {
  const domain = normEmail(email).split('@')[1] || '';
  return PERSONAL_DOMAINS.test(domain);
}
function domainOf(website) {
  try { return new URL(/^https?:/i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, ''); } catch { return null; }
}

module.exports = {
  hashPassword, verifyPassword, passwordProblem, normEmail,
  getUserByEmail, getUserById, createUser, updateUser,
  addMembership, membershipFor, teamFor, adminCount, setRole, removeMember,
  issueToken, consumeToken, peekToken,
  createSession, setSessionCookie, clearSessionCookie, sessionFromRequest, revokeSession, revokeAllSessions,
  attach, requireUser, requireAdmin, setSignupCookie, readSignupCookie,
  isPersonalEmail, domainOf, logEvent, readCookie,
};
