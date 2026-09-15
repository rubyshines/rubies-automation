/**
 * The products that get a tab on the inspector's QC Master workbook — one row
 * per catalog SKU prefix: the tab name the inspector sees, the tech-pack
 * handle(s) whose grading fills the tab, and the category the sheet belongs to
 * (one workbook per category per order).
 *
 * Shared by the sheet generator (prefix -> tab + specs) and the ingest
 * (tab -> handles), so the two can never disagree about a tab's name.
 * Sky's grading is split youth/adult, so its tab maps to both handles and the
 * size picks the handle at validation time.
 *
 * Accessories (pads, pins, flags, earrings) are not measured and are absent
 * on purpose.
 */

const QC_PRODUCTS = [
  { prefix: 'AJ',   handles: 'aj',                      tab: 'AJ Underwear',            category: 'underwear' },
  { prefix: 'HLA',  handles: 'sassy',                   tab: 'Sassy Underwear',         category: 'underwear' },
  { prefix: 'FLO',  handles: 'flo',                     tab: 'Flo Dance Underwear',     category: 'underwear' },
  { prefix: 'UNW',  handles: 'charlie',                 tab: 'Charlie Underwear',       category: 'underwear' },
  { prefix: 'GAF',  handles: 'naomi',                   tab: 'Naomi Gaff',              category: 'underwear' },
  { prefix: 'BB',   handles: 'brooke',                  tab: 'Brooke Bra',              category: 'underwear' },
  { prefix: 'SB',   handles: 'ava',                     tab: 'Ava Seamless Bra',        category: 'underwear' },
  { prefix: 'SPB',  handles: 'sportsbra',               tab: 'Evey Sports Bra',         category: 'underwear' },
  { prefix: 'CM',   handles: 'cami',                    tab: 'Cami Top',                category: 'underwear' },
  { prefix: 'BXR',  handles: 'boxer',                   tab: 'Quinn Boxers',            category: 'underwear' },
  { prefix: 'RUBY', handles: 'ruby',                    tab: 'Ruby Bikini Bottom',      category: 'swimwear' },
  { prefix: 'CKY',  handles: 'cheeky',                  tab: 'Cheeky Bikini Bottom',    category: 'swimwear' },
  { prefix: 'MIA',  handles: 'mia',                     tab: 'Mia Halter Bikini Top',   category: 'swimwear' },
  { prefix: 'TNK',  handles: 'tankini',                 tab: 'Sunny Tankini',           category: 'swimwear' },
  { prefix: 'SHS',  handles: 'shorty',                  tab: 'Serena Shorty Shorts',    category: 'swimwear' },
  { prefix: 'SKY2', handles: ['sky_youth', 'sky_reg'],  tab: 'Sky One Piece',           category: 'swimwear' },
  { prefix: 'SWS',  handles: 'genesis',                 tab: 'Genesis Surf Shorts',     category: 'swimwear' },
  { prefix: 'RHW',  handles: 'stella',                  tab: 'Stella High Waisted Bottom', category: 'swimwear' },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function qcProductForPrefix(prefix) {
  const p = String(prefix || '').toUpperCase();
  return QC_PRODUCTS.find((x) => x.prefix === p) || null;
}

// Match a product by prefix ("GAF"), tech-pack handle ("naomi") or a word of
// the tab name ("Naomi Gaff", "naomi"). Returns the matches in catalog order;
// throws on a term that matches nothing so a typo can't silently drop a tab.
function findQcProducts(terms) {
  const out = [];
  for (const term of [].concat(terms)) {
    const t = norm(term);
    const hits = QC_PRODUCTS.filter((p) =>
      norm(p.prefix) === t
      || [].concat(p.handles).some((h) => norm(h) === t)
      || norm(p.tab) === t
      || p.tab.toLowerCase().split(/\s+/).includes(String(term).toLowerCase().trim()));
    if (!hits.length) throw new Error(`no QC product matches "${term}" (use a SKU prefix, tech-pack handle or tab name)`);
    for (const h of hits) if (!out.includes(h)) out.push(h);
  }
  return QC_PRODUCTS.filter((p) => out.includes(p));
}

// tab name -> handle(s), the shape the ingest validates against.
const TAB_HANDLES = Object.fromEntries(QC_PRODUCTS.map((p) => [p.tab, p.handles]));

module.exports = { QC_PRODUCTS, TAB_HANDLES, qcProductForPrefix, findQcProducts };
