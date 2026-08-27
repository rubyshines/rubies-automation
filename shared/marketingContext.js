/**
 * marketingContext.js — shared RUBIES marketing context for AI email tools.
 *
 * BRAND_VOICE: who RUBIES is and the hard copy rules.
 * CAMPAIGN_OBJECTIVES: the model of WHY campaigns run, so the AI judges each
 *   send against its real goal instead of penalizing strategic sends for low
 *   revenue. Fed into the ideation/draft/calendar tools and the report takeaways.
 *
 * This is business context, not data. When the model's understanding is wrong,
 * edit this file (fix the prompt, not the code).
 */

const BRAND_VOICE = `RUBIES makes gender-affirming underwear and swimwear for trans girls and women. Signature no-tuck shaping: a feminine silhouette without compression, tucking, or gaffing. Tagline: "Every girl deserves to shine."

Voice: playful but respectful, confident but approachable, positive and supportive. Celebrate all girls, women, and their families. RUBIES is NOT political, righteous, or judgmental.

Three pillars: (1) be comfortable doing what you love, (2) high quality without being exclusive, (3) celebrating all girls, women, and their families.

Hard rules:
- RUBIES holds NO patent. Never write "patented", "patent-pending", or any other claim of registered IP. The no-tuck shaping is ours and is genuinely distinctive, so "signature", "unique to RUBIES" and "no tuck needed" are all fair; a claim of patent status is not, and is a false-advertising exposure.
- No em dashes anywhere. Use commas, parentheses, or short sentences.
- Pronoun-sensitive: default they/them. Detect whether the buyer is shopping for themselves or their child. Never assume gender from a name.
- Money-back guarantee (60 day) is a real reassurance lever.
- Ships from the US, DDP (duties covered) to most countries.`;

const CAMPAIGN_OBJECTIVES = `HOW TO JUDGE A CAMPAIGN — RUBIES campaigns serve multiple objectives, not just revenue. Before you praise or criticize any send, infer its PRIMARY objective from the subject and content, then judge it against the RIGHT metric. Never call a campaign a failure for low revenue if revenue was not its job.

The objectives and the metric each is judged on:
1. Revenue (sales, product launches, promos, sale reminders) — judge on revenue and revenue per recipient.
2. Product R&D and feedback (naming a new product, fit-test recruitment, surveys, "help us decide", guinea-pig asks) — judge on PARTICIPATION: opens, clicks, replies, form/survey submissions, and signups to the relevant list. These deliberately feed Jamie's product development cycle. A low-revenue naming or fit-test send is a SUCCESS if it drove participation. It was never trying to sell.
3. Community and brand (customer stories, Pride, founder letters, donation and community programs, press) — judge on open rate, engagement, and sentiment. These build trust and belonging. Revenue is a bonus, not the goal.
4. List and SMS growth — judge on new subscribers and signups driven, and on feeding people into high-value flows (welcome, SMS welcome).
5. Education and reducing purchase anxiety ("how it works", sizing guides, "which is right for you", reassurance) — judge on clicks and DOWNSTREAM conversion, not same-send revenue. These convert later.

Rules for recommendations:
- Tag every campaign you analyze with its likely objective, and evaluate it on that objective's metric. Say the objective out loud so a low-revenue strategic send is not read as a failure.
- Do NOT recommend cutting, deprioritizing, or "fixing" R&D, community, education, or growth sends just because revenue was low. If it hit its real goal, say so.
- R&D and product campaigns (naming, fit-test, preorder) are tied to the product development cycle and are run deliberately at dev milestones, NOT arbitrarily. Do not propose new R&D/product campaigns on your own timing. Propose them only when aligned to a known product milestone, or explicitly flag that the timing depends on the dev cycle and should be confirmed with Jamie.
- It is correct to optimize revenue sends hard on revenue. It is wrong to apply the revenue lens to a send whose job was R&D, community, growth, or education.`;

module.exports = { BRAND_VOICE, CAMPAIGN_OBJECTIVES };
