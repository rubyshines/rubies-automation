'use strict';
/** Programme page with sign-up (1a), confirmation (1b), account pages (1r, 1s, 1u). */
const { page, esc, LINKS, illustration } = require('./layout');
const { SIZES } = require('../lib/catalog');

function errorBox(errors) {
  if (!errors || !errors.length) return '';
  return `<div class="error"><ul class="list">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
}

function sizeChips(selected, { kids = false, name = 'sizes' } = {}) {
  const sel = new Set(selected || SIZES);
  return `<div class="chips">${SIZES.map(s => `<label class="chip"><input type="checkbox" name="${name}" value="${s}" ${sel.has(s) ? 'checked' : ''}> ${s}</label>`).join('')}<label class="chip"><input type="checkbox" name="kids_sizes" value="1" ${kids ? 'checked' : ''}> Kids sizes</label></div>`;
}

function programme({ values = {}, errors = [] } = {}) { // eslint-disable-line no-unused-vars
  // The minimal cut (2026-09-21): the programme is a link, a balance and an
  // email. Jamie enrols centres; there is no sign-up form on this page.
  const talk = `<a class="btn btn-fill" href="mailto:jamie@rubyshines.com?subject=Virtual%20Closet">Talk to Jamie</a>`;
  const body = `
<section class="hero">
  <div class="hero-copy">
    <h1>A closet for your community, stocked by your community.</h1>
    <p class="lede">RUBIES makes gender-affirming underwear and swimwear for trans girls and women. Your community shops through your link and sponsors your closet; RUBIES matches every dollar. It costs your centre nothing.</p>
    <div class="doors">${talk}</div>
  </div>
  ${illustration('mirror')}
</section>
<section>
  <h2>Two ways your community can help</h2>
  <div class="two">
    <div class="card"><h3>Shop</h3><p>Anyone who opens your link gets 20% off one RUBIES order. A quarter of what they pay goes to your closet, and RUBIES matches it.</p></div>
    <div class="card"><h3>Sponsor</h3><p>Pick an amount, $10 to $100, and pay at the RUBIES store. It goes straight to your closet, and RUBIES matches it.</p></div>
  </div>
</section>
<section id="how">
  <h2>How it works</h2>
  <ol class="steps steps-4">
    <li><b>Talk to Jamie.</b> A short call or an email. Jamie sets your closet up; there is nothing to fill in.</li>
    <li><b>Share your link.</b> On your site, your socials, your noticeboard. A QR code comes with it. That is all the upkeep there is.</li>
    <li><b>Hear how it's going.</b> On any day something comes in, you get one email with what was added and your balance.</li>
    <li><b>Order when you're ready.</b> Email Jamie your order and your balance comes off it. RUBIES ships gender-affirming underwear and swimwear to your closet.</li>
  </ol>
</section>
<section class="about">
  <div><h2>About RUBIES</h2><p>RUBIES is a small brand making gender-affirming underwear and swimwear for trans girls and women. No tucking, no compression, just a smooth line in something that feels like regular underwear. Every pair is tested with our community and comes with a money-back guarantee at the store. Every girl deserves to shine.</p><p><a href="${LINKS.how}">How RUBIES works</a> · <a href="${LINKS.styles}">Our styles</a> · <a href="${LINKS.about}">About us</a></p></div>
  ${illustration('beach', 'about-art')}
</section>
<section>
  <h2>Also for centres: Pass It On</h2>
  <div class="two">
    <div class="card"><h3>Pass It On</h3><p>Customers' exchanged and returned RUBIES items are routed to your closet, and your centre appears on the public donation map.</p><p class="fine">Running today with partners on three continents. Ask Jamie to add it.</p></div>
    <div class="card"><h3>What it costs</h3><p>Nothing. Stop any time.</p><p class="fine">Questions? Write to Jamie at <a href="mailto:jamie@rubyshines.com">jamie@rubyshines.com</a>.</p></div>
  </div>
</section>
<section id="signup">
  <h2>Ready to start?</h2>
  <p>Email Jamie with your centre's name, website and the address you'd like closet updates sent to. Your page is usually live the same day.</p>
  <div class="doors">${talk}</div>
</section>`;
  return page({ title: 'Virtual Closet', mode: 'programme', body });
}

/** Step 2 of 2: create the first admin's account (1r). */
function accountStep({ centre, values = {}, errors = [], centreDomain = '' }) {
  const v = values;
  const body = `<section class="card narrow">
<p class="soft">Step 2 of 2 · ${esc(centre.name)}</p>
<h1>Create your account</h1>
<p>You'll be the centre's first admin. You can hand that to someone else any time.</p>
<div class="doors"><span class="btn btn-line disabled" title="Coming soon">Continue with Google</span><span class="btn btn-line disabled" title="Coming soon">Continue with Microsoft</span></div>
<p class="soft">or with email</p>
${errorBox(errors)}
<form class="form" method="post" action="/signup/account">
  <label>Your name <input type="text" name="name" value="${esc(v.name || '')}" required></label>
  <label>Your role at the centre <input type="text" name="role_title" value="${esc(v.role_title || '')}" placeholder="e.g. Programme coordinator"></label>
  <label>Email <input type="email" name="email" value="${esc(v.email || '')}" required data-nudge-email data-centre-domain="${esc(centreDomain)}"></label>
  <div class="nudge" id="nudge" hidden><span>That looks like a personal address. Got one at the centre? Contacts change, and a centre address keeps the account with ${esc(centre.name)}.</span><div class="doors">${centreDomain ? `<button type="button" class="btn btn-small btn-line" data-suggest>Use your centre address</button>` : ''}<button type="button" class="btn btn-small btn-quiet" data-keep>Keep this one</button></div></div>
  <label>Password <input type="password" name="password" minlength="8" required autocomplete="new-password"></label>
  <button class="btn btn-fill" type="submit">Create account</button>
  <p class="fine">By continuing you agree to the <a href="/free-pair-terms">programme terms</a>. We'll send a link to confirm your email.</p>
</form></section>`;
  return page({ title: 'Create your account', mode: 'plain', body });
}

function verifySent({ email, centre, resent = false }) {
  const body = `<section class="card narrow"><h1>Verify your email</h1><p>We sent a link to <b>${esc(email)}</b>. Open it to finish creating ${centre ? esc(centre.name) + "'s" : 'your'} account.</p>${resent ? '<div class="ok">Sent again.</div>' : ''}<form method="post" action="/verify/resend" class="doors"><button class="btn btn-line" type="submit">Send again</button><a class="btn btn-quiet" href="/signup/account">Change address</a></form></section>`;
  return page({ title: 'Verify your email', mode: 'plain', body });
}

/** 1b: after verification, waiting for approval. */
function confirmation({ centre }) {
  const body = `<section class="card narrow">
<p class="soft"><span class="pill warn">Waiting for approval</span></p>
<h1>Thanks, ${esc(centre.name)}. You're in the queue.</h1>
<p>A person at RUBIES reviews every new centre. That usually takes a few days. Your closet page${centre.programmes?.pass_it_on ? ' and map listing' : ''} go live the moment we approve you, and you'll get an email with your link and everything to share.</p>
<h3>While you wait</h3>
<ol><li>Set your limits: items per request, how often one person may ask, your funding goal. Your account is ready now.</li><li>Invite a colleague so the account outlives any one of you.</li></ol>
<div class="doors"><a class="btn btn-fill" href="/settings">Set up your closet</a><a class="btn btn-line" href="mailto:jamie@rubyshines.com?subject=Virtual%20Closet%20call">Book a call</a></div>
<p class="fine">Questions? Jamie, <a href="mailto:jamie@rubyshines.com">jamie@rubyshines.com</a></p>
</section>`;
  return page({ title: 'You\'re in the queue', mode: 'centre', centre, body });
}

function signin({ errors = [], values = {}, next = '', notice = '' } = {}) {
  const body = `<section class="card narrow"><h1>Sign in</h1>${notice ? `<div class="ok">${esc(notice)}</div>` : ''}
<div class="doors"><span class="btn btn-line disabled">Continue with Google</span><span class="btn btn-line disabled">Continue with Microsoft</span></div><p class="soft">or</p>
${errorBox(errors)}
<form class="form" method="post" action="/signin"><input type="hidden" name="next" value="${esc(next)}">
<label>Email <input type="email" name="email" value="${esc(values.email || '')}" required></label>
<label>Password <input type="password" name="password" required autocomplete="current-password"></label>
<div class="doors"><button class="btn btn-fill" type="submit">Sign in</button><a class="btn btn-quiet" href="/forgot">Forgot?</a></div>
<p class="fine">New centre? <a href="/#signup">Sign up</a></p></form></section>`;
  return page({ title: 'Sign in', mode: 'plain', body });
}

function forgot({ sent = false, values = {} } = {}) {
  const body = `<section class="card narrow"><h1>Forgot your password</h1>${sent ? '<div class="ok">If that address has an account, a link is on its way. Signed up with Google or Microsoft? Use that button instead.</div>' : ''}
<form class="form" method="post" action="/forgot"><label>Email <input type="email" name="email" value="${esc(values.email || '')}" required></label><button class="btn btn-fill" type="submit">Send a reset link</button></form></section>`;
  return page({ title: 'Forgot your password', mode: 'plain', body });
}

function reset({ token, errors = [], expired = false } = {}) {
  const body = expired
    ? `<section class="card narrow"><h1>Link expired</h1><p><a href="/forgot">Send a new one</a></p></section>`
    : `<section class="card narrow"><h1>Choose a new password</h1>${errorBox(errors)}<form class="form" method="post" action="/reset/${esc(token)}"><label>New password <input type="password" name="password" minlength="8" required autocomplete="new-password"></label><label>Again <input type="password" name="password2" minlength="8" required autocomplete="new-password"></label><button class="btn btn-fill" type="submit">Save and sign in</button></form></section>`;
  return page({ title: 'Choose a new password', mode: 'plain', body });
}

function invite({ invitation, centre, invitedBy, errors = [], values = {}, signedIn = null, expired = false }) {
  if (expired) return page({ title: 'Invitation', mode: 'plain', body: `<section class="card narrow"><h1>This invitation has expired</h1><p>Ask ${esc(centre?.name || 'the centre')} to send a new one.</p></section>` });
  const body = `<section class="card narrow"><h1>${esc(invitedBy)} invited you to ${esc(centre.name)}</h1><p>Join as ${invitation.role === 'admin' ? 'an admin' : 'a member'} to help run the closet: see requests, send boxes and share the link.</p>
${signedIn ? `<form method="post" action="/invite/${esc(invitation.token)}/attach"><p>You're signed in as <b>${esc(signedIn.email)}</b>.</p><button class="btn btn-fill" type="submit">Join ${esc(centre.name)}</button></form>` : `
<div class="doors"><span class="btn btn-line disabled">Continue with Google</span><span class="btn btn-line disabled">Continue with Microsoft</span></div><p class="soft">or with email</p>
${errorBox(errors)}
<form class="form" method="post" action="/invite/${esc(invitation.token)}">
<label>Your name <input type="text" name="name" value="${esc(values.name || '')}" required></label>
<label>Email <input type="email" value="${esc(invitation.email)}" disabled> <span class="fine">(from the invitation)</span></label>
<label>Password <input type="password" name="password" minlength="8" required autocomplete="new-password"></label>
<button class="btn btn-fill" type="submit">Join ${esc(centre.name)}</button>
<p class="fine">Already have an account? <a href="/signin?next=/invite/${esc(invitation.token)}">Sign in</a> and the invitation attaches.</p></form>`}
</section>`;
  return page({ title: `Join ${centre.name}`, mode: 'plain', body });
}

module.exports = { programme, accountStep, verifySent, confirmation, signin, forgot, reset, invite, sizeChips, errorBox };
