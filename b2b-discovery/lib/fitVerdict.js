/**
 * fitVerdict.js — does this store belong in the outreach book?
 *
 * The 1-10 discovery score cannot answer that, and reweighting it does not
 * help. Measured over the 113 retailers imported in September 2026: 175 of the
 * 207 qualified prospects would fall below the threshold without the points
 * awarded for merely existing (independent, physical store, findable email),
 * and 54 scored the LGBTQ+ bonus with no LGBTQ+ or trans mention anywhere —
 * generic "for every body" copy was enough. Worse, a stricter score tested
 * against the operator's own 30 decisions kept 12 of his 14 keeps and let
 * through ALL 16 of his drops: Pink Pussycat, Stag Shop and HUMANITY! all
 * score 8 of 8 on earned signal and were all dropped by hand.
 *
 * The reason is structural. Every one of those drops turned on something the
 * score has no field for: the audience is men, the store is in Canada, the
 * underwear is under $15, the shop takes consignment or makes its own goods,
 * or the catalog holds no gear whatever its category names claim. Those facts
 * are now gathered (location from Maps, gear and prices from catalog.js) and
 * the judgment left over is a reading of the store, which is a model's job.
 *
 * So the score stays as a RANKING signal and stops being the gate. This is the
 * gate, and its three answers matter equally: `hand` is a real answer, not a
 * failure, and the prompt is written to prefer it over a coin flip. Half of
 * stores have no readable catalog, and "cannot tell" must never silently
 * become "no".
 *
 * Sonnet rather than Opus: a narrow classification with a downstream check
 * (the operator reviews every verdict in the Vet panel before a word is sent),
 * which is exactly the case the model guidance says does not need Opus.
 */
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

const RULES = `You are vetting retail prospects for RUBIES, which makes gender-affirming underwear and swimwear for TRANS WOMEN AND GIRLS, sold wholesale to stores. Decide whether a store belongs in the first wave of cold outreach.

The rules, in priority order:

1. DROP anything in Canada. US and other countries are fine; Canada is out for this wave.
2. DROP stores whose AUDIENCE is men: gay men's shops, menswear, men's leather and fetish shops. Binders and packers serve trans masc customers, the other side of the catalog from what we sell. A shop that merely CARRIES some menswear alongside women's lingerie is NOT a men's store.
3. DROP cheap stores and resellers: Poshmark and Depop resellers, dropshippers, and stores whose women's underwear sells under about $15 (they buy direct from China and our margins will not work).
4. DROP consignment shops and maker collectives that sell local makers' own small-run or handmade goods, and brands that only sell their own single line. A boutique that CURATES or BUYS FROM many independent brands is the opposite of this and must NOT be dropped for it. The test is whether the store buys wholesale from brands.
5. ADULT AND SEX SHOPS must show a gender-affirming category, ideally a real product in it (gaff, tucking underwear, breast form, hip padding). Gear that is all masc (packers, binders) does not satisfy this, because it is not what we sell. A sex shop with no gender-affirming gear is out of the first wave.
6. BRA, LINGERIE, INTIMATES and SWIMWEAR shops are judged differently: no gear required, but they must read as LGBTQ+ friendly to make this first wave.

Answer with exactly one verdict:
  keep — belongs in the first wave
  drop — fails a rule; name which
  hand — cannot be decided from the evidence (catalog unreadable, no online store, genuinely ambiguous)

Prefer "hand" over a coin flip. An unreadable catalog is never evidence of absence. The operator checks every "hand" himself, so a wrong "drop" costs more than an honest "hand".

Reply as JSON only, nothing before or after it:
{"verdict":"keep|drop|hand","rule":<1-6 or null>,"why":"<AT MOST 20 WORDS naming the evidence>"}

Keep "why" under 20 words. A longer answer is truncated and lost entirely.`;

/** The evidence a verdict is allowed to rest on. Pure. */
function buildEvidence({ prospect = {}, catalog = null } = {}) {
  return {
    name: prospect.company_name,
    location: [prospect.city, prospect.state, prospect.country].filter(Boolean).join(', ') || null,
    store_type: prospect.subcategory || null,
    has_online_store: prospect.has_online_store ?? null,
    brands_they_carry: (prospect.brands_list || []).slice(0, 15),
    research_profile: prospect.raw_profile || null,
    catalog: catalog || { readable: false, reason: 'not read' },
  };
}

/** Pull the JSON object out of a reply. Pure; null when there is not one. */
function parseVerdict(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!['keep', 'drop', 'hand'].includes(obj.verdict)) return null;
  const rule = Number.isInteger(obj.rule) && obj.rule >= 1 && obj.rule <= 6 ? obj.rule : null;
  return { verdict: obj.verdict, rule, why: String(obj.why || '').slice(0, 300) };
}

/**
 * One verdict for one prospect. Fails to 'hand' on any error: the operator
 * looking at a row himself is always a safe outcome, a wrong drop is not.
 */
async function fitVerdict({ prospect, catalog, model = MODELS.SONNET_5, callImpl = callClaude } = {}) {
  const evidence = buildEvidence({ prospect, catalog });
  let res;
  try {
    res = await callImpl({
      component: 'b2b_prospect_vetting',
      model,
      max_tokens: 1000,
      // The rules are identical for every prospect in a run, so they cache.
      system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(evidence) }],
    });
  } catch (err) {
    return { verdict: 'hand', rule: null, why: `vetting call failed: ${err.message}`.slice(0, 300) };
  }
  const parsed = parseVerdict(res?.content?.find(c => c.type === 'text')?.text);
  if (!parsed) return { verdict: 'hand', rule: null, why: 'vetting reply could not be read' };
  return parsed;
}

module.exports = { fitVerdict, buildEvidence, parseVerdict, RULES };
