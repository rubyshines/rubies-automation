'use strict';
/** Programme page with sign-up (1a), confirmation (1b), account pages (1r, 1s, 1u). */
const { page, esc, LINKS, placeholder } = require('./layout');
const { SIZES } = require('../lib/catalog');

function errorBox(errors) {
  if (!errors || !errors.length) return '';
  return `<div class="error"><ul class="list">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
}

function sizeChips(selected, { kids = false, name = 'sizes' } = {}) {
  const sel = new Set(selected || SIZES);
  return `<div class="chips">${SIZES.map(s => `<label class="chip"><input type="checkbox" name="${name}" value="${s}" ${sel.has(s) ? 'checked' : ''}> ${s}</label>`).join('')}<label class="chip"><input type="checkbox" name="kids_sizes" value="1" ${kids ? 'checked' : ''}> Kids sizes</label></div>`;
}

function programme({ values = {}, errors = [] } = {}) {
  const v = values;
  const body = `
<section class="hero">
  <div class="hero-copy">
    <h1>A closet for your community, stocked by your community.</h1>
    <p class="lede">RUBIES makes gender-affirming underwear and swimwear for trans girls and women. Your community shops, requests and sponsors; RUBIES matches every dollar. You receive a box and hand it out. It costs your centre nothing.</p>
    <div class="doors"><a class="btn btn-fill" href="#signup">Sign up your centre</a><a class="btn btn-line" href="mailto:jamie@rubyshines.com?subject=Virtual%20Closet%20call">Book a call, if you'd like one</a></div>
  </div>
  ${placeholder('illustration: a stocked closet, flat vector, site style', 'ph-hero')}
</section>
<section>
  <h2>Three ways your community can help</h2>
  <div class="three">
    <div class="card"><h3>Shop</h3><p>20% off one order, applied from your link. For every two items bought, the closet gets one.</p></div>
    <div class="card"><h3>Request</h3><p>Anyone in your community requests a pair on your page. Approved within the limits you set. They pick it up at the centre or have it shipped home.</p></div>
    <div class="card"><h3>Sponsor</h3><p>Pick an amount, from $16 for a pair to $300 for a full shipment. It goes into the box, and RUBIES matches it.</p></div>
  </div>
  <p class="soft">Everything lands in one box. When the box reaches its goal, it ships to you with everyone's request inside.</p>
</section>
<section id="how">
  <h2>How it works</h2>
  <ol class="steps steps-4">
    <li><b>Sign up.</b> Five minutes. Tick the programmes you want. Set your sizes.</li>
    <li><b>We say hello.</b> A person at RUBIES approves new centres, usually within a few days.</li>
    <li><b>Share your link.</b> On your site, your socials, your noticeboard. That is all the upkeep there is.</li>
    <li><b>Receive the box.</b> Requested items first, the rest filled by you or by us. Hand it out.</li>
  </ol>
</section>
<section class="two">
  ${placeholder('photo or illustration: RUBIES product on models', 'ph-hero')}
  <div><h2>About RUBIES</h2><p>RUBIES is a small brand making gender-affirming underwear and swimwear for trans girls and women: tuck-friendly, comfortable, and made to be worn every day. Every pair a centre hands out is one someone can feel like themselves in.</p><p><a href="${LINKS.how}">How RUBIES works</a> · <a href="${LINKS.styles}">Our styles</a></p></div>
</section>
<section>
  <h2>Two programmes. Tick one or both.</h2>
  <div class="two">
    <div class="card"><h3>Pass It On</h3><p>Customers' exchanged and returned RUBIES items are routed to your closet. Your centre appears on the public donation map, and its pin links to your closet page.</p><p class="fine">Running today with partners on three continents.</p></div>
    <div class="card"><h3>Virtual Closet</h3><p>A page in your centre's name where people can shop, request a pair or sponsor. Everything goes into a box that RUBIES matches dollar for dollar.</p><p class="fine">You can also add from your own budget any time, paid by card, matched like every other dollar.</p></div>
  </div>
  <div class="three" style="margin-top:16px">
    <div><h3>What we ask of you</h3><p>Receive the box and hand things out. Keep one contact reachable. Tell us your sizes once.</p></div>
    <div><h3>What it costs</h3><p>Nothing. Leave any time; anything raised still ships.</p></div>
    <div><h3>Questions?</h3><p>Write to Jamie at <a href="mailto:jamie@rubyshines.com">jamie@rubyshines.com</a>.</p></div>
  </div>
</section>
<section id="signup">
  <h2>Sign up your centre</h2>
  ${errorBox(errors)}
  <form class="form" method="post" action="/signup">
    <label>Centre name <input type="text" name="name" value="${esc(v.name || '')}" placeholder="e.g. Uniting Pride" required></label>
    <label>Website <input type="url" name="website" value="${esc(v.website || '')}" placeholder="https://"></label>
    <fieldset><legend>Programmes</legend>
      <label class="check"><input type="checkbox" name="closet" value="1" ${v.closet !== false ? 'checked' : ''}> <span><b>Virtual Closet</b></span></label>
      <label class="check"><input type="checkbox" name="pass_it_on" value="1" ${v.pass_it_on ? 'checked' : ''}> <span><b>Pass It On</b></span></label>
    </fieldset>
    <fieldset><legend>Sizes your closet takes and offers</legend>${sizeChips(v.sizes, { kids: !!v.kids_sizes })}<p class="fine">One sizes question serves both programmes.</p></fieldset>
    <button class="btn btn-fill" type="submit">Continue to create your account</button>
    <p class="fine">Next: your name, email and password. Then we review and email you when your page is live.</p>
  </form>
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
  <p class="fine">By continuing you agree to the <a href="/free-pair-terms">programme terms</a>. Any address works; we'll ask you to verify it.</p>
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
