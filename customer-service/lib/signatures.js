// Single source of truth for RUBIES CS email sign-offs + the advocacy P.S.
// Referenced by the advisor prompt (aiAdvisor.js), the outbound composer
// (composeOutboundDraft.js), and the follow-up sender (followUp.js) so every
// customer-facing CS email signs off identically. Change the copy here, once.

// Founder identity block that follows the valediction line. No emoji — the
// advisor's writing rules forbid emojis in customer-facing copy.
const SIGNATURE_NAME_BLOCK = `Jamie Alexander
RUBIES Founder
Every girl deserves to shine
rubyshines.com`;

// Full sign-off given a valediction. "Talk soon," when a reply is expected,
// "Take care," when the conversation is resolved.
function signOff(valediction = 'Talk soon,') {
  return `${valediction}\n${SIGNATURE_NAME_BLOCK}`;
}

// HTML variant of a sign-off (for the SendGrid follow-up path, which builds
// both text and HTML bodies).
function signOffHtml(valediction = 'Talk soon,') {
  return `<p>${signOff(valediction).replace(/\n/g, '<br>')}</p>`;
}

// One-time advocacy "spread the word" P.S. Phase A ships without a link — a warm
// nudge only. The advisor picks a framing via the `closing_ask` field on a
// positive resolution; Phase B (the /help page) appends the share link.
const ADVOCACY_PS = {
  peer_parent: 'P.S. The best way you can help RUBIES is by spreading the word to other families.',
  peer_self: 'P.S. The best way you can help RUBIES is by spreading the word to others in our community.',
};

module.exports = { SIGNATURE_NAME_BLOCK, signOff, signOffHtml, ADVOCACY_PS };
