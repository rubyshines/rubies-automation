const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { readCatalog, summarizeProducts, catalogHost } = require('../../b2b-discovery/lib/catalog');
const { fitVerdict, buildEvidence, parseVerdict } = require('../../b2b-discovery/lib/fitVerdict');

const product = (title, price = '30.00', extra = {}) => ({
  title, product_type: extra.type || '', tags: extra.tags || [],
  variants: [{ price }], ...extra,
});

describe('catalog read', () => {
  it('finds femme gear by its real product titles', () => {
    // The three titles that a homepage summary missed entirely and the
    // operator found by hand.
    const s = summarizeProducts([
      product('Classic Gaff'), product('Bandage Tucking Shorts'),
      product('Dragonfly Tucking Thong'), product('Scented Candle'),
    ]);
    assert.equal(s.femme_gear_count, 3);
    assert.ok(s.femme_gear.includes('Classic Gaff'));
    assert.equal(s.masc_gear_count, 0);
  });

  it('counts masc gear apart from femme gear', () => {
    const s = summarizeProducts([product('Packer Gear 5" Silicone Packing Penis'), product('Chest Binder - Black')]);
    assert.equal(s.masc_gear_count, 2);
    assert.equal(s.femme_gear_count, 0, 'packers and binders are not what we sell');
  });

  it('prices women\'s underwear and ignores the men\'s line', () => {
    const s = summarizeProducts([
      product('Lace Thong', '7.00'), product('Cotton Brief', '9.00'),
      product("Men's Boxer Brief", '3.00'), product('Jockstrap', '2.00'),
    ]);
    assert.equal(s.womens_underwear_count, 2);
    assert.equal(s.cheapest_womens_underwear, 7, 'the $2 jockstrap is not a panty price');
    assert.equal(s.mens_share, 0.5);
  });

  it('reports whether the read was complete, so absence can be trusted or not', () => {
    assert.equal(summarizeProducts([product('x')], { complete: true }).complete, true);
    assert.equal(summarizeProducts([product('x')], { complete: false }).complete, false);
  });

  it('matches gear named only in tags or product type', () => {
    const s = summarizeProducts([product('The Daphne', '40', { type: 'Gaff', tags: [] })]);
    assert.equal(s.femme_gear_count, 1);
  });

  it('an unreadable store is a fact, never an empty catalog', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, headers: { get: () => 'text/html' } });
    const r = await readCatalog('https://example.com', { fetchImpl });
    assert.equal(r.readable, false);
    assert.equal(r.femme_gear_count, undefined, 'must not look like a catalog with no gear');
  });

  it('a store with no website is unreadable, not empty', async () => {
    assert.deepEqual(await readCatalog(null), { readable: false, reason: 'no website' });
    assert.deepEqual(await readCatalog(''), { readable: false, reason: 'no website' });
  });

  it('never throws when the network does', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const r = await readCatalog('https://example.com', { fetchImpl });
    assert.equal(r.readable, false);
    assert.match(r.reason, /fetch failed/);
  });

  it('pages until a short page ends the feed', async () => {
    const pages = { 1: Array.from({ length: 250 }, (_, i) => product(`p${i}`)), 2: [product('Classic Gaff')] };
    let seen = 0;
    const fetchImpl = async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      seen++;
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ products: pages[page] || [] }) };
    };
    const r = await readCatalog('https://example.com', { fetchImpl });
    assert.equal(seen, 2);
    assert.equal(r.products_read, 251);
    assert.equal(r.femme_gear_count, 1, 'gear on page 2 is still gear');
  });

  it('marks a capped read incomplete rather than concluding there is no gear', async () => {
    const full = Array.from({ length: 250 }, (_, i) => product(`p${i}`));
    const fetchImpl = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ products: full }) });
    const r = await readCatalog('https://example.com', { maxPages: 2, fetchImpl });
    assert.equal(r.readable, true);
    assert.equal(r.complete, false, 'the page cap was hit: absence proves nothing');
    assert.equal(r.femme_gear_count, 0);
  });

  it('strips a URL down to its host', () => {
    assert.equal(catalogHost('https://www.Jellywink.com/collections/all?x=1'), 'jellywink.com');
    assert.equal(catalogHost('http://shop.room801.com/'), 'shop.room801.com');
  });
});

describe('fit verdict', () => {
  it('reads a well-formed reply', () => {
    assert.deepEqual(parseVerdict('{"verdict":"drop","rule":2,"why":"gay men\'s leather shop"}'),
      { verdict: 'drop', rule: 2, why: "gay men's leather shop" });
  });

  it('tolerates prose around the JSON', () => {
    assert.equal(parseVerdict('Here you go:\n{"verdict":"keep","rule":6,"why":"pride-forward lingerie"}\nThanks').verdict, 'keep');
  });

  it('rejects a truncated reply rather than inventing a verdict', () => {
    // The real failure: max_tokens cut the JSON mid-string on 19 of 82 rows,
    // and a silent "hand" hid it. Parsing must return null so the caller can.
    assert.equal(parseVerdict('{"verdict":"drop","rule":5'), null);
    assert.equal(parseVerdict(''), null);
    assert.equal(parseVerdict(null), null);
  });

  it('rejects a verdict that is not one of the three', () => {
    assert.equal(parseVerdict('{"verdict":"maybe","rule":1,"why":"x"}'), null);
  });

  it('discards a rule number outside 1-6 but keeps the verdict', () => {
    assert.equal(parseVerdict('{"verdict":"drop","rule":9,"why":"x"}').rule, null);
    assert.equal(parseVerdict('{"verdict":"drop","rule":null,"why":"x"}').rule, null);
  });

  it('fails to hand when the model call throws', async () => {
    const r = await fitVerdict({ prospect: { company_name: 'X' }, callImpl: async () => { throw new Error('529'); } });
    assert.equal(r.verdict, 'hand', 'a wrong drop costs more than an honest hand');
    assert.match(r.why, /529/);
  });

  it('fails to hand when the reply cannot be read', async () => {
    const callImpl = async () => ({ content: [{ type: 'text', text: 'I think probably drop it' }] });
    assert.equal((await fitVerdict({ prospect: { company_name: 'X' }, callImpl })).verdict, 'hand');
  });

  it('hands the model the catalog and the location as evidence', () => {
    const e = buildEvidence({
      prospect: { company_name: 'Stag Shop', city: 'Windsor', state: 'ON', country: 'Canada', subcategory: 'adult-retail', brands_list: ['Lovense'] },
      catalog: { readable: true, femme_gear_count: 0 },
    });
    assert.equal(e.location, 'Windsor, ON, Canada');
    assert.equal(e.catalog.readable, true);
    assert.deepEqual(e.brands_they_carry, ['Lovense']);
  });

  it('says plainly when no catalog was read', () => {
    assert.deepEqual(buildEvidence({ prospect: {} }).catalog, { readable: false, reason: 'not read' });
  });

  it('caps the brand list so one store cannot dominate the prompt', () => {
    const brands = Array.from({ length: 40 }, (_, i) => `b${i}`);
    assert.equal(buildEvidence({ prospect: { brands_list: brands } }).brands_they_carry.length, 15);
  });
});

describe('import admission', () => {
  const { isAdmissible } = require('../../b2b-outreach/lib/importProspects');
  const p = (extra = {}) => ({ status: 'qualified', score: 6, ...extra });

  it('admits keep and hand, refuses drop', () => {
    assert.equal(isAdmissible(p({ fit_verdict: 'keep' })), true);
    assert.equal(isAdmissible(p({ fit_verdict: 'hand' })), true, 'the Vet panel is where a human looks');
    assert.equal(isAdmissible(p({ fit_verdict: 'drop' })), false);
  });

  it('a high score cannot override a drop', () => {
    // Pink Pussycat, Stag Shop and HUMANITY! all scored 8+ and were all
    // dropped by hand. Score is the order, not the gate.
    assert.equal(isAdmissible(p({ score: 10, fit_verdict: 'drop' })), false);
  });

  it('a low score still comes in when the fit pass kept it', () => {
    assert.equal(isAdmissible(p({ score: 1, fit_verdict: 'keep' })), true);
  });

  it('rows researched before the fit pass keep the old behaviour', () => {
    assert.equal(isAdmissible(p({ fit_verdict: null })), true);
    assert.equal(isAdmissible(p()), true);
  });

  it('still respects status and an explicit minimum score', () => {
    assert.equal(isAdmissible(p({ status: 'dismissed', fit_verdict: 'keep' })), false);
    assert.equal(isAdmissible(p({ score: 3, fit_verdict: 'keep' }), { minScore: 5 }), false);
  });
});
