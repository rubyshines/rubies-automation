// Businesses already contacted, partnered with, or otherwise excluded from outreach.
// Checked during discovery before saving any prospect.

function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/,?\s*(inc\.?|llc\.?|co\.?|corp\.?|ltd\.?)$/i, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXCLUDE_LIST = [
  'Sock Drawer Heroes',
  'Illusions Lingerie',
  'Tuck and Bind',
  'Transitting',
  'underDARE',
  'Early To Bed',
  'Trans Essentials',
  'Come As You Are',
  'Broad Lingerie',
  'Tokki',
  'The Quilt Bag',
  'The Bra Room',
  'Witch Bitch Thrift',
  'Strange Ways',
  'The Smitten Kitten',
  'Self Serve',
  'She Bop',
  'Good Vibrations',
  'Babeland',
  'The Pleasure Chest',
  "Eve's Garden",
  'Lady Konfidential',
  'Please',
  'Lotus Blooms',
  'Passional Boutique',
  'Feelmore',
  'Awakening Boutique',
  "A Woman's Touch",
  'The Tool Shed',
  "Janet's Closet",
  'Transformations by Rori',
  'Glamour Boutique',
  'Forbidden Fruit',
  'As You Like It',
  'SHAG Brooklyn',
  'Fairvilla Megastore',
  'Enchantasys',
  'Story Essentials',
  'Demi Cup',
  'Jenette Bras',
  "Christina's Luxuries",
  "Lion's Lair Boutique",
  'Revelation in Fit',
  'Grail Bra Specialists',
  'Karnation',
  'Underpinnings',
  'Forty Winks',
  'Zoe and Company',
  'The Rack Shack',
  'The Pencil Test',
  'Journelle',
  'Clair de Lune',
  'Allure Fits',
  "Ashley's Lingerie & Swimwear",
  'Lace & Day',
  'Hello Gorgeous',
  'BAGLY',
  'Fenway Health',
  'Oakland Unified School District',
  'Queer Yukon',
  "Milady's Lace",
  'Valid by Brodie',
  "Big Bro's Barbershop",
  'Wild Cat Gift and Party',
];

// Pre-normalize for fast matching
const NORMALIZED_EXCLUDE = EXCLUDE_LIST.map(normalizeName);

function isExcluded(companyName) {
  if (!companyName) return false;
  const normalized = normalizeName(companyName);
  if (!normalized) return false;
  return NORMALIZED_EXCLUDE.some(
    (ex) => ex === normalized || ex.includes(normalized) || normalized.includes(ex)
  );
}

module.exports = { EXCLUDE_LIST, isExcluded, normalizeName };
