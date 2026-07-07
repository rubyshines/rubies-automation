// Single source of truth for RUBIES CS email sign-offs + the advocacy P.S.
// Referenced by the advisor prompt (aiAdvisor.js), the outbound composer
// (composeOutboundDraft.js), and the follow-up sender (followUp.js) so every
// customer-facing CS email signs off identically. Change the copy here, once.

// Name + title on one line. No emoji, no tagline — kept lean.
const SIGNATURE_NAME = 'Jamie Alexander, RUBIES Founder';
const SITE_URL = 'https://rubyshines.com';
const SITE_LABEL = 'rubyshines.com';

// Markdown form for AI-written emails (advisor + outbound composer). The
// dashboard send path runs autoLinkProducts(), which turns [label](url) into a
// real <a> and \n into <br>, so the site renders as a clickable link.
const SIGNATURE_BLOCK_MD = `${SIGNATURE_NAME}\n[${SITE_LABEL}](${SITE_URL})`;

// Plain-text sign-off for the code-templated follow-ups. A blank line sits
// between the valediction and the name.
function signOff(valediction = 'Talk soon,') {
  return `${valediction}\n\n${SIGNATURE_NAME}\n${SITE_LABEL}`;
}

// HTML sign-off (site as a real link, blank line after the valediction) for the
// follow-up HTML bodies.
function signOffHtml(valediction = 'Talk soon,') {
  return `<p>${valediction}<br><br>${SIGNATURE_NAME}<br><a href="${SITE_URL}">${SITE_LABEL}</a></p>`;
}

// One-time advocacy "spread the word" P.S. Phase A ships without a link — a warm
// nudge only. The advisor picks a framing on a positive resolution; Phase B (the
// /help page) appends the share link.
const ADVOCACY_PS = {
  peer_parent: 'P.S. The best way you can help RUBIES is by spreading the word to other families.',
  peer_self: 'P.S. The best way you can help RUBIES is by spreading the word to others in our community.',
};

module.exports = { SIGNATURE_NAME, SITE_URL, SITE_LABEL, SIGNATURE_BLOCK_MD, signOff, signOffHtml, ADVOCACY_PS };
