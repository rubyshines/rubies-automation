'use strict';
/** Programme page, two-step sign-up, verification, sign in/out, reset, invitations. */
const express = require('express');
const auth = require('../lib/auth');
const centres = require('../lib/centres');
const emails = require('../lib/emails');
const boxes = require('../lib/boxes');
const { db, must, logEvent } = require('../lib/db');
const view = require('../views/programme');
const { SIZES } = require('../lib/catalog');

const r = express.Router();
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---- programme page + step 1 ----------------------------------------------
r.get('/', (req, res) => res.type('html').send(view.programme()));
r.get('/signup', (req, res) => res.redirect(302, '/#signup'));

r.post('/signup', async (req, res, next) => {
  try {
    const b = req.body;
    const values = { name: b.name, website: b.website, closet: !!b.closet, pass_it_on: !!b.pass_it_on, sizes: arr(b.sizes).filter(s => SIZES.includes(s)), kids_sizes: !!b.kids_sizes };
    const errors = [];
    if (!values.name || values.name.trim().length < 2) errors.push('Centre name is needed.');
    if (!values.closet && !values.pass_it_on) errors.push('Tick at least one programme.');
    if (!values.sizes.length && !values.kids_sizes) errors.push('Pick at least one size.');
    if (errors.length) return res.status(400).type('html').send(view.programme({ values, errors }));
    const centre = await centres.createFromSignup({ name: values.name, website: values.website, programmes: { closet: values.closet, pass_it_on: values.pass_it_on }, sizes: values.sizes, kids_sizes: values.kids_sizes });
    auth.setSignupCookie(res, centre.id);
    res.redirect(302, '/signup/account');
  } catch (err) { next(err); }
});

// ---- step 2: the first admin ----------------------------------------------
async function pendingCentre(req) {
  const id = auth.readSignupCookie(req);
  if (!id) return null;
  const centre = await centres.getById(id);
  return centre && centre.status === 'pending' ? centre : null;
}

r.get('/signup/account', async (req, res, next) => {
  try {
    const centre = await pendingCentre(req);
    if (!centre) return res.redirect(302, '/#signup');
    res.type('html').send(view.accountStep({ centre, centreDomain: auth.domainOf(centre.website) || '' }));
  } catch (err) { next(err); }
});

r.post('/signup/account', async (req, res, next) => {
  try {
    const centre = await pendingCentre(req);
    if (!centre) return res.redirect(302, '/#signup');
    const b = req.body;
    const values = { name: b.name, role_title: b.role_title, email: b.email };
    const errors = [];
    if (!values.name) errors.push('Your name is needed.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email || '')) errors.push('That email does not look right.');
    const pp = auth.passwordProblem(b.password); if (pp) errors.push(pp);
    let user = null;
    if (!errors.length) {
      user = await auth.getUserByEmail(values.email);
      if (user && user.password_hash) errors.push('That email already has an account. Sign in, or use a different address.');
    }
    if (errors.length) return res.status(400).type('html').send(view.accountStep({ centre, values, errors, centreDomain: auth.domainOf(centre.website) || '' }));
    if (!user) user = await auth.createUser({ email: values.email, name: values.name, role_title: values.role_title, password: b.password });
    else user = await auth.updateUser(user.id, { name: values.name, role_title: values.role_title, password_hash: auth.hashPassword(b.password) });
    await auth.addMembership(centre.id, user.id, 'admin');
    await logEvent(centre.id, `user:${user.id}`, 'account.created', { role: 'admin', personal_email: auth.isPersonalEmail(user.email) });
    const token = await auth.issueToken('verify_email', { userId: user.id, email: user.email, payload: { centre_id: centre.id } });
    await emails.verifyEmail({ user, token, centre });
    const sid = await auth.createSession(user.id);
    auth.setSessionCookie(res, sid, req);
    res.redirect(302, '/verify');
  } catch (err) { next(err); }
});

// ---- verification gate ------------------------------------------------------
r.get('/verify', async (req, res) => {
  if (!req.user) return res.redirect(302, '/signin');
  if (req.user.email_verified_at) return res.redirect(302, req.centre?.status === 'pending' ? '/welcome' : '/home');
  res.type('html').send(view.verifySent({ email: req.user.email, centre: req.centre, resent: req.query.resent === '1' }));
});
r.post('/verify/resend', async (req, res, next) => {
  try {
    if (!req.user) return res.redirect(302, '/signin');
    if (req.user.email_verified_at) return res.redirect(302, '/home');
    const token = await auth.issueToken('verify_email', { userId: req.user.id, email: req.user.email, payload: { centre_id: req.centre?.id } });
    await emails.verifyEmail({ user: req.user, token, centre: req.centre || { name: 'your centre' } });
    res.redirect(302, '/verify?resent=1');
  } catch (err) { next(err); }
});
r.get('/verify/:token', async (req, res, next) => {
  try {
    const t = await auth.consumeToken('verify_email', req.params.token);
    if (!t) return res.status(410).type('html').send(view.reset({ expired: true }).replace('Link expired', 'This link has expired').replace('/forgot', '/verify'));
    const user = await auth.updateUser(t.user_id, { email_verified_at: new Date().toISOString() });
    const m = await auth.membershipFor(user.id);
    const centre = m?.centre;
    const sid = await auth.createSession(user.id);
    auth.setSessionCookie(res, sid, req);
    if (centre) {
      await logEvent(centre.id, `user:${user.id}`, 'account.verified', {});
      // RUBIES is only told about a new centre once its admin is verified.
      if (centre.status === 'pending' && m.role === 'admin') {
        const already = must(await db().from('vc_events').select('id').eq('centre_id', centre.id).eq('kind', 'operator.notified').limit(1), 'notified?');
        if (!already.length) { await emails.operatorSignup({ centre, user }); await logEvent(centre.id, 'system', 'operator.notified', {}); }
        return res.redirect(302, '/welcome');
      }
    }
    res.redirect(302, '/home');
  } catch (err) { next(err); }
});
r.get('/welcome', (req, res) => {
  if (!req.user || !req.centre) return res.redirect(302, '/signin');
  if (req.centre.status !== 'pending') return res.redirect(302, '/home');
  res.type('html').send(view.confirmation({ centre: req.centre }));
});

// ---- sign in / out ----------------------------------------------------------
r.get('/signin', (req, res) => {
  if (req.user) return res.redirect(302, '/home');
  res.type('html').send(view.signin({ next: req.query.next || '', notice: req.query.reset ? 'Password saved. Sign in with it.' : '' }));
});
r.post('/signin', async (req, res, next) => {
  try {
    const email = auth.normEmail(req.body.email);
    const user = await auth.getUserByEmail(email);
    if (!user || !auth.verifyPassword(req.body.password, user.password_hash)) {
      return res.status(401).type('html').send(view.signin({ errors: ['That email and password do not match.'], values: { email }, next: req.body.next || '' }));
    }
    const sid = await auth.createSession(user.id);
    auth.setSessionCookie(res, sid, req);
    const nxt = String(req.body.next || '');
    res.redirect(302, nxt.startsWith('/') && !nxt.startsWith('//') ? nxt : '/home');
  } catch (err) { next(err); }
});
r.get('/signout', async (req, res) => {
  if (req.session) await auth.revokeSession(req.session.id);
  auth.clearSessionCookie(res);
  res.redirect(302, '/');
});

// ---- forgot / reset ----------------------------------------------------------
r.get('/forgot', (req, res) => res.type('html').send(view.forgot()));
r.post('/forgot', async (req, res, next) => {
  try {
    const user = await auth.getUserByEmail(req.body.email);
    if (user) {
      const token = await auth.issueToken('reset_password', { userId: user.id, email: user.email, ttlHours: 24 });
      await emails.resetPassword({ user, token });
    }
    res.type('html').send(view.forgot({ sent: true, values: { email: req.body.email } }));
  } catch (err) { next(err); }
});
r.get('/reset/:token', async (req, res, next) => {
  try {
    const t = await auth.peekToken('reset_password', req.params.token);
    res.type('html').send(view.reset({ token: req.params.token, expired: !t }));
  } catch (err) { next(err); }
});
r.post('/reset/:token', async (req, res, next) => {
  try {
    const errors = [];
    const pp = auth.passwordProblem(req.body.password); if (pp) errors.push(pp);
    if (req.body.password !== req.body.password2) errors.push('The two passwords differ.');
    if (errors.length) return res.status(400).type('html').send(view.reset({ token: req.params.token, errors }));
    const t = await auth.consumeToken('reset_password', req.params.token);
    if (!t) return res.status(410).type('html').send(view.reset({ expired: true }));
    await auth.updateUser(t.user_id, { password_hash: auth.hashPassword(req.body.password) });
    await auth.revokeAllSessions(t.user_id);
    res.redirect(302, '/signin?reset=1');
  } catch (err) { next(err); }
});

// ---- invitations --------------------------------------------------------------
async function loadInvite(raw) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(String(raw)).digest('hex');
  const inv = must(await db().from('vc_invitations').select('*, vc_centres(*), inviter:vc_users!vc_invitations_invited_by_fkey(name, email)').eq('token_hash', hash).maybeSingle(), 'invitation');
  if (!inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) return null;
  return inv;
}
r.get('/invite/:token', async (req, res, next) => {
  try {
    const inv = await loadInvite(req.params.token);
    if (!inv) return res.status(410).type('html').send(view.invite({ expired: true, centre: null }));
    res.type('html').send(view.invite({ invitation: { ...inv, token: req.params.token }, centre: inv.vc_centres, invitedBy: inv.inviter?.name || 'A colleague', signedIn: req.user && auth.normEmail(req.user.email) === inv.email ? req.user : null }));
  } catch (err) { next(err); }
});
r.post('/invite/:token', async (req, res, next) => {
  try {
    const inv = await loadInvite(req.params.token);
    if (!inv) return res.status(410).type('html').send(view.invite({ expired: true, centre: null }));
    const errors = [];
    if (!req.body.name) errors.push('Your name is needed.');
    const pp = auth.passwordProblem(req.body.password); if (pp) errors.push(pp);
    if (errors.length) return res.status(400).type('html').send(view.invite({ invitation: { ...inv, token: req.params.token }, centre: inv.vc_centres, invitedBy: inv.inviter?.name || 'A colleague', errors, values: req.body }));
    let user = await auth.getUserByEmail(inv.email);
    if (user && user.password_hash) {
      return res.status(400).type('html').send(view.invite({ invitation: { ...inv, token: req.params.token }, centre: inv.vc_centres, invitedBy: inv.inviter?.name || 'A colleague', errors: ['That email already has an account. Sign in and the invitation attaches.'], values: req.body }));
    }
    if (!user) user = await auth.createUser({ email: inv.email, name: req.body.name, password: req.body.password });
    else user = await auth.updateUser(user.id, { name: req.body.name, password_hash: auth.hashPassword(req.body.password) });
    await auth.addMembership(inv.centre_id, user.id, inv.role);
    must(await db().from('vc_invitations').update({ accepted_at: new Date().toISOString() }).eq('id', inv.id), 'accept');
    await logEvent(inv.centre_id, `user:${user.id}`, 'team.joined', { role: inv.role });
    const token = await auth.issueToken('verify_email', { userId: user.id, email: user.email, payload: { centre_id: inv.centre_id } });
    await emails.verifyEmail({ user, token, centre: inv.vc_centres });
    const sid = await auth.createSession(user.id);
    auth.setSessionCookie(res, sid, req);
    res.redirect(302, '/verify');
  } catch (err) { next(err); }
});
r.post('/invite/:token/attach', async (req, res, next) => {
  try {
    const inv = await loadInvite(req.params.token);
    if (!inv || !req.user || auth.normEmail(req.user.email) !== inv.email) return res.redirect(302, `/invite/${req.params.token}`);
    await auth.addMembership(inv.centre_id, req.user.id, inv.role);
    must(await db().from('vc_invitations').update({ accepted_at: new Date().toISOString() }).eq('id', inv.id), 'accept');
    await logEvent(inv.centre_id, `user:${req.user.id}`, 'team.joined', { role: inv.role, attached: true });
    await emails.addedToCentre({ user: req.user, centre: inv.vc_centres });
    res.redirect(302, '/home');
  } catch (err) { next(err); }
});

module.exports = r;
module.exports.boxes = boxes;
