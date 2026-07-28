/**
 * Short donation-partner description generator.
 *
 * Partner descriptions are stored verbatim from the org's survey submission
 * (often multi-paragraph mission statements — some even arrive with the text
 * pasted twice). The website shows the full text; CS advisor emails need a
 * 1-2 sentence version so the donation instructions stay scannable.
 *
 * Opus per the model policy: the output is customer-facing final text (it
 * lands verbatim in exchange/refund emails with no operator rewrite step).
 * All calls go through shared/aiClient.js with a component tag.
 */

const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

const COMPONENT_TAG = 'donation_partner_desc_short';

/**
 * @param {{ name: string, description: string }} partner
 * @returns {Promise<string|null>} 1-2 sentence description, or null if the
 *   source description is empty or generation fails (callers fall back to
 *   the full description).
 */
async function generateShortDescription({ name, description }) {
  const source = (description || '').trim();
  if (!source) return null;

  const prompt = [
    'You write customer emails for RUBIES, a brand making gender-affirming underwear and swimwear for trans girls and women. When a customer returns items, we ask them to mail the items to a partner LGBTQ+ organization as a donation, and the email includes a one-breath note about who that organization is.',
    '',
    'Below is the organization\'s own self-written description. Condense it into 1-2 standalone sentences (at most 35 words total, and always shorter than the original) that tell the customer what the organization does and who it serves.',
    '',
    'Write it like this:',
    '- Start with the organization\'s name and use only facts from their description. Never add programs, locations, or claims they did not write.',
    '- Third person, present tense, complete sentences that can stand alone in an email.',
    '- Collapse lists of specific products into one category phrase (write "free gender-affirming clothing and gear", not "binders, breast forms, gaffs, packers, and tape").',
    '- Drop operating hours, appointment logistics, request procedures, and mission-statement framing. Keep who they serve and what they provide.',
    '- Warm, positive, plain language. Use commas, parentheses, or short sentences for rhythm (never an em dash).',
    '- Keep the focus on the clothing/donation program if they mention one.',
    '',
    'Reply with ONLY the 1-2 sentences. No quotes, no preamble.',
    '',
    `Organization: ${name}`,
    '--- Their description ---',
    source,
  ].join('\n');

  const response = await callClaude({
    component: COMPONENT_TAG,
    model: MODELS.OPUS,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (response?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  return text || null;
}

module.exports = { generateShortDescription, COMPONENT_TAG };
