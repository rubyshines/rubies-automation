/**
 * contactDetails.js — harvest a person's name and title out of the signature
 * they sign their own replies with.
 *
 * The gap this closes: 284 active contacts, 13 titles, 26 first names. The
 * greeting on every template reads `full_name` (`greetingName` takes its first
 * word), so a contact with no name on file is written to as "Hi there," — and
 * the advisor's context block can only say "we are writing to
 * office@thebraroom.ca" when the person has been signing "Katherine Crilley,
 * Co-Owner" at the bottom of every reply for months. The information was
 * already in the inbox; nothing read it.
 *
 * Three rules shape this, and they are all in `planDetailsFill` rather than in
 * the prompt, because a model is the wrong place to keep a promise:
 *
 *   1. FILL ONLY. A field already on file is never touched, whatever the
 *      signature says. Operator edits, sheet imports and Klaviyo data all
 *      outrank a signature, and "never overwrites" is the property that makes
 *      it safe to run this over the whole book unattended.
 *   2. IT MUST BE THEIR OWN SIGNATURE. The tail of an inbound reply is far more
 *      often OUR signature than theirs, because it quotes the email we sent
 *      ("Jamie Alexander, RUBIES Founder" appears at the bottom of most replies
 *      in this table). A regex over the last lines harvests us onto them, which
 *      is why this is a model task with a deterministic gate, not a pattern.
 *   3. A NAME THAT DISAGREES WITH THE NAME ON FILE POISONS THE WHOLE RECORD.
 *      Mail arrives forwarded, hand-signed by a colleague, or with an assistant
 *      in the sig block. If we already know who this address is and the
 *      signature names someone else, the title in that signature is someone
 *      else's too — so the record is dropped entirely rather than half-used.
 *
 * The extraction is a narrow Sonnet task (CLAUDE.md model policy): one reply
 * in, three strings out, a deterministic gate after it, and nothing it produces
 * is sent to anyone without passing through a template or an operator. It fails
 * closed — a bad answer, a timeout, or an unparseable response all read as "no
 * signature found", which leaves today's behaviour exactly as it is.
 */
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

/** Our own people, by name. A signature naming one of these is the quoted copy
 *  of our own email, never the person we are writing to. */
const OUR_NAMES = ['jamie', 'jamie alexander', 'rubies', 'ruby shines', 'rubyshines'];

/** Longest a real job title gets before it stops being a title and starts being
 *  a sentence the model lifted out of the body. */
const MAX_TITLE_WORDS = 10;
const MAX_TITLE_CHARS = 80;
const MAX_NAME_CHARS = 40;

/** How many of one person's emails are worth reading for a signature before
 *  concluding they do not sign with one. Matches the backfill sweep's cap. */
const READ_ATTEMPTS = 3;

const EXTRACT_TOOL = {
  name: 'submit_signature',
  description: "Submit the sender's own name and job title as their email signature gives them.",
  input_schema: {
    type: 'object',
    properties: {
      first_name: { type: ['string', 'null'], description: 'The sender\'s first name (given name) exactly as they sign it. null if the message does not give it.' },
      last_name: { type: ['string', 'null'], description: 'The sender\'s last name (family name) exactly as they sign it. null if the message does not give it.' },
      title: { type: ['string', 'null'], description: 'Their job title or role as printed in their signature, e.g. "Co-Owner", "Program Coordinator", "Director of Community Programs". null if no title is printed. Never a department name on its own, never a company name, never an invented title.' },
      street_address: { type: ['string', 'null'], description: 'The organisation\'s street address exactly as printed in the signature, including a unit or suite number and any "c/o" line, e.g. "2097 Danforth Ave" or "1124 Finch Ave West, Unit 1" or "PO Box 2973". null if the signature prints no street address. Never a website, never an email address.' },
      city: { type: ['string', 'null'], description: 'The city of that address. null if not printed.' },
      region: { type: ['string', 'null'], description: 'The state, province or county of that address, as printed (e.g. "TX", "ON", "WA"). null if not printed.' },
      country: { type: ['string', 'null'], description: 'The country of that address, only if the signature names one. null otherwise — never infer it from the state or postal code.' },
    },
    required: ['first_name', 'last_name', 'title', 'street_address', 'city', 'region', 'country'],
  },
};

const SYSTEM_PROMPT = `You read one email that a business contact sent to RUBIES, and extract the SENDER's own name and job title from the way they signed it.

The sender is the person at [FROM]. Only their details count.

Rules:
- Read the sender's own signature, at the end of the text they wrote.
- A reply quotes the email it answers. Everything in the quoted portion (lines starting with ">", anything below "On <date> ... wrote:", "-----Original Message-----", or a repeat of an earlier email) was written by someone else. Never take a name or title from there.
- RUBIES people are never the answer. Jamie Alexander is the RUBIES founder and signs the emails these replies quote. If the only signature you can see is Jamie's or another RUBIES person's, return null for every field.
- Copy the name and title exactly as written. Never translate, expand, tidy or invent one.
- A company name, a department, a tagline, a pronoun line, an address or a phone number is not a job title.
- If the message is signed only with a first name and no title, return the first name and null for the rest. That is a good answer.
- If someone forwards mail or writes on another person's behalf, return null for every field rather than guess whose signature it is.
- When unsure about a field, return null for it. Returning null is always safe; a wrong name is written to a real person.

The signature often also prints where the organization is. Copy that address exactly as written, because it is where a sample kit gets posted:
- Only the address of the organization the sender works for. A customer's shipping address quoted in the body, a venue, an event address or a return address for someone else is never it.
- Take the street line as printed, unit or suite included. A PO Box is a real mailing address; a website, an email address or a phone number is not.
- If more than one address appears (a mailing address and a retail store, say), take the one the signature presents as the organization's own. If you cannot tell which, return null.
- Never assemble an address out of pieces from different parts of the email, and never infer a country from a state or postal code.`;

/** Trim to a string or null. */
function str(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

/** Is this one of ours? Matches a whole name or either part of it. */
function isOurs(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  return OUR_NAMES.some(o => n === o || n.startsWith(`${o} `) || n.endsWith(` ${o}`));
}

/** Normalize for comparing a name against a company name. */
function squash(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Does this look like a person's name rather than an address, a handle, or a
 * line of prose? Pure.
 */
function isPlausibleName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > MAX_NAME_CHARS) return false;
  if (/[@<>|/\\]|https?:|\d/.test(n)) return false;
  const words = n.split(/\s+/);
  if (words.length > 3) return false;
  // Letters, marks, spaces and the punctuation real names carry.
  return /^[\p{L}\p{M}'’.\- ]+$/u.test(n);
}

/**
 * Does this look like a job title rather than a sentence, a company or a URL?
 * Pure.
 */
function isPlausibleTitle(title) {
  const t = String(title || '').trim();
  if (!t || t.length > MAX_TITLE_CHARS) return false;
  if (/[@<>|]|https?:|\n/.test(t)) return false;
  if (t.split(/\s+/).length > MAX_TITLE_WORDS) return false;
  return /\p{L}/u.test(t);
}

/**
 * Work out what to write for one contact. PURE — the whole safety story of this
 * module is testable here, with no I/O and no model in the way.
 *
 * @param existing   the b2b_contacts row (first_name, last_name, full_name, title)
 * @param extracted  { first_name, last_name, title } from the signature
 * @param companyName the company's name, so an org signature is not read as a person
 * @returns {{ patch: object, why: string }|null}  null when there is nothing safe to write
 */
function planDetailsFill(existing = {}, extracted = {}, { companyName } = {}) {
  const first = str(extracted.first_name, MAX_NAME_CHARS);
  const last = str(extracted.last_name, MAX_NAME_CHARS);
  const title = str(extracted.title, MAX_TITLE_CHARS);
  if (!first && !last && !title) return null;

  const signed = [first, last].filter(Boolean).join(' ');

  // Rule 2: our own signature, quoted back at us.
  if (isOurs(signed) || isOurs(first) || isOurs(last)) return null;

  // An org signing as itself ("Colors+ Team") is not a person's name.
  if (signed && companyName && squash(signed) === squash(companyName)) return null;

  const nameOk = (!first || isPlausibleName(first)) && (!last || isPlausibleName(last));
  const titleOk = !title || (isPlausibleTitle(title) && squash(title) !== squash(companyName));

  // Rule 3: if we already know who this address is, the signature has to agree
  // before anything it says is believed. A colleague's sig block on a forwarded
  // message would otherwise hand this person someone else's job title, and a
  // shared mailbox signed by three different coordinators would take whichever
  // one wrote last.
  //
  // Two things a name on file can be. A PERSON is a real claim about who this
  // address is, and a signature naming someone else contradicts it. The company
  // name sitting in the name field is not a claim about anyone — it is what the
  // sheet import left behind — so it blocks nothing. (It is still never
  // overwritten: that is rule 1's job, not this one's.)
  const onFile = squash(existing.full_name);
  const onFileIsCompany = onFile && companyName && onFile === squash(companyName);
  if (onFile && signed && !onFileIsCompany) {
    const known = onFile.split(' ').filter(Boolean);
    // The same token always agrees, however short — "Ez" on file signing "Ez"
    // is the same person, and demanding three letters quietly excluded every
    // short name. A shortened first name agrees too ("Jess" on file against a
    // signature reading "Jessica Bernacki"), but only from three characters up,
    // so no two unrelated names collide on an initial.
    const agrees = squash(signed).split(' ').filter(Boolean)
      .some(p => known.some(k => k === p
        || (p.length > 2 && k.length > 2 && (k.startsWith(p) || p.startsWith(k)))));
    if (!agrees) return null;
  }

  // Rule 1: fill only. A field with anything in it is left exactly as it is.
  const patch = {};
  const filled = [];
  if (nameOk && first && !str(existing.first_name)) { patch.first_name = first; filled.push('first_name'); }
  if (nameOk && last && !str(existing.last_name)) { patch.last_name = last; filled.push('last_name'); }
  if (nameOk && signed && !str(existing.full_name)) { patch.full_name = signed; filled.push('full_name'); }
  if (titleOk && title && !str(existing.title)) { patch.title = title; filled.push('title'); }

  if (!filled.length) return null;
  return { patch, why: `signature gave ${filled.join(', ')}` };
}

/** Countries the same place is written several ways. Only what this book
 *  actually contains — an unknown value falls through to a string compare. */
const COUNTRY_ALIASES = new Map([
  ['us', 'united states'], ['usa', 'united states'], ['u s a', 'united states'],
  ['united states of america', 'united states'],
  ['uk', 'united kingdom'], ['great britain', 'united kingdom'], ['england', 'united kingdom'],
  ['ca', 'canada'], ['can', 'canada'],
  ['au', 'australia'], ['aus', 'australia'],
  ['nz', 'new zealand'], ['de', 'germany'], ['deutschland', 'germany'],
  ['ch', 'switzerland'], ['dk', 'denmark'], ['se', 'sweden'],
]);

/**
 * Same city? One being a superset of the other's words counts, because what is
 * recorded is not always just a city: rows in this book carry "Portland, OR" as
 * the city, and refusing a signature that says "Portland" would be refusing the
 * right address over our own formatting.
 */
function samePlace(a, b) {
  const x = squash(a), y = squash(b);
  if (!x || !y) return true;
  if (x === y) return true;
  const xs = new Set(x.split(' ')), ys = new Set(y.split(' '));
  const [small, big] = xs.size <= ys.size ? [xs, ys] : [ys, xs];
  return [...small].every(w => big.has(w));
}

function sameCountry(a, b) {
  const norm = (v) => { const s = squash(v); return COUNTRY_ALIASES.get(s) || s; };
  return norm(a) === norm(b);
}

/**
 * Work out what to write on the COMPANY from the address in a signature. PURE.
 *
 * Why this rides along with the name and title: "send the sample kit and that
 * information" is a real reply we have received, and answering it meant going
 * to find an address we were never told — while the address sat in the
 * signature of the very email asking for the kit.
 *
 * Same fill-only rule as the contact fields, plus one more that the geocoding
 * work already settled (2026-08-28): an address that CONTRADICTS what we hold
 * is not an improvement, it is a different place. A signature whose city or
 * country disagrees with the company's recorded location is refused whole —
 * usually a person's home address, a parent organisation, or a second site —
 * rather than half-written into the row.
 *
 * @returns {{ patch: object, why: string }|null}
 */
function planLocationFill(company = {}, extracted = {}, { requireStreet = true } = {}) {
  const street = str(extracted.street_address, 200);
  const city = str(extracted.city, 100);
  const region = str(extracted.region, 100);
  const country = str(extracted.country, 100);

  // A street with no city is still postable; a city on its own is not worth the
  // risk of contradicting a hand-set location.
  if (requireStreet && !street) return null;
  if (street && (/https?:|@|^www\./i.test(street) || street.length < 5)) return null;

  // City and country are the guard; the region is not. Recorded regions are a
  // mix of "ON" and "Ontario", "TX" and "Texas", so a strict compare refuses
  // correct addresses far more often than it catches wrong ones — and a street
  // that agrees on city and country is not in another state. The region is
  // still fill-only below.
  if (city && company.city && !samePlace(city, company.city)) return null;
  if (country && company.country && !sameCountry(country, company.country)) return null;

  const patch = {};
  const filled = [];
  const put = (key, value) => {
    if (value && !str(company[key])) { patch[key] = value; filled.push(key); }
  };
  put('address', street);
  put('city', city);
  put('region', region);
  put('country', country);

  if (!filled.length) return null;
  return { patch, why: `signature gave ${filled.join(', ')}` };
}

/** What is still missing on a contact row — the cost gate for the model call. */
function missingDetails(contact = {}) {
  const gaps = [];
  if (!str(contact.first_name)) gaps.push('first_name');
  if (!str(contact.last_name)) gaps.push('last_name');
  if (!str(contact.full_name)) gaps.push('full_name');
  if (!str(contact.title)) gaps.push('title');
  return gaps;
}

/**
 * Ask Sonnet for the sender's own signature details. Fail-closed: any error or
 * malformed answer reads as "no signature found".
 */
async function extractContactDetails({ subject, body, sender, companyName } = {}) {
  const empty = { first_name: null, last_name: null, title: null };
  const text = String(body || '').trim();
  if (!text) return empty;
  let response;
  try {
    response = await callClaude({
      // Sonnet on purpose: narrow structured extraction with a deterministic
      // gate after it, and nothing it writes reaches a customer unreviewed.
      component: 'b2b_contact_details_extract',
      model: MODELS.SONNET,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'submit_signature' },
      messages: [{ role: 'user', content:
        `[ORGANIZATION] ${companyName || '(unknown)'}\n` +
        `[FROM] ${sender || '(unknown)'}\n` +
        `[SUBJECT] ${subject || ''}\n\n` +
        `[EMAIL]\n${text.slice(0, 4000)}` }],
    });
  } catch (err) {
    console.warn(`[contact-details] extraction failed for ${sender}: ${err.message}`);
    return empty;
  }
  const toolUse = (response.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_signature');
  if (!toolUse?.input) return empty;
  return {
    first_name: str(toolUse.input.first_name, MAX_NAME_CHARS),
    last_name: str(toolUse.input.last_name, MAX_NAME_CHARS),
    title: str(toolUse.input.title, MAX_TITLE_CHARS),
  };
}

/**
 * Fill in whatever this reply tells us about who wrote it.
 *
 * Called from the inbound correlator on a human reply, and by the backfill
 * sweep over stored mail. Never throws: a contact detail is a nice-to-have
 * riding on the correlation path, and nothing about it is worth failing the
 * message insert that carries it.
 *
 * @returns {{ filled: string[], patch: object }|null}
 */
async function harvestContactDetails(sb, { company_id, sender, subject, body, companyName, extract = extractContactDetails } = {}) {
  try {
    const email = String(sender || '').trim().toLowerCase();
    if (!email || !company_id) return null;

    const { data: contact, error } = await sb.from('b2b_contacts')
      .select('email, company_id, first_name, last_name, full_name, title')
      .eq('email', email).maybeSingle();
    if (error) throw new Error(error.message);
    // Only someone already filed under this company. Registering a contact is
    // the correlator's decision and its rules (system mailboxes, domain match)
    // are not ours to re-derive.
    if (!contact || contact.company_id !== company_id) return null;

    const { data: company, error: cErr } = await sb.from('b2b_companies')
      .select('id, name, address, city, region, country')
      .eq('id', company_id).maybeSingle();
    if (cErr) throw new Error(cErr.message);
    const name = companyName || company?.name || null;

    // The cost gate comes BEFORE the model call, not after it: most replies
    // arrive from contacts we already know everything about, and paying for an
    // extraction whose every field would be discarded by the fill-only rule is
    // the calls-per-output trap. The company's own gaps count here too: one
    // read of a signature answers both "who is this" and "where do we post
    // their sample kit", so a known person at a company with no address on
    // file is still worth reading.
    const contactGaps = missingDetails(contact);
    const companyGaps = ['address'].filter(k => !str(company?.[k]));
    if (!contactGaps.length && !companyGaps.length) return null;

    // The other half of that trap, in slow motion: plenty of people never print
    // a job title, so their `title` stays null forever and the gap above stays
    // open forever — one extraction on every reply they ever send, for an
    // answer that was already established to be "they don't sign with one".
    // Their stored mail is the attempt counter we would otherwise need a column
    // for: after this many of their emails have been read, stop asking. The
    // message that triggered this is already inserted, so the first reply
    // counts as the first attempt.
    const { count, error: nErr } = await sb.from('b2b_messages')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'inbound').eq('from_email', email);
    if (nErr) throw new Error(nErr.message);
    if ((count || 0) > READ_ATTEMPTS) return null;

    const extracted = await extract({ subject, body, sender: email, companyName: name });

    const plan = planDetailsFill(contact, extracted, { companyName: name });
    if (plan) {
      const { error: uErr } = await sb.from('b2b_contacts')
        .update({ ...plan.patch, updated_at: new Date().toISOString() }).eq('email', contact.email);
      if (uErr) throw new Error(uErr.message);
    }

    // The address is the company's, not the contact's — a colleague's signature
    // still gives the right shop. So it is written even when the name in the
    // signature failed the agreement check above.
    const location = company ? planLocationFill(company, extracted) : null;
    if (location) {
      const { error: lErr } = await sb.from('b2b_companies')
        .update({ ...location.patch, updated_at: new Date().toISOString() }).eq('id', company_id);
      if (lErr) throw new Error(lErr.message);
    }

    if (!plan && !location) return null;
    return {
      email: contact.email,
      patch: plan?.patch || {},
      filled: Object.keys(plan?.patch || {}),
      company_patch: location?.patch || {},
      company_filled: Object.keys(location?.patch || {}),
    };
  } catch (err) {
    console.warn(`[contact-details] harvest failed for ${sender}: ${err.message}`);
    return null;
  }
}

module.exports = {
  extractContactDetails,
  harvestContactDetails,
  planDetailsFill,
  planLocationFill,
  missingDetails,
  isPlausibleName,
  isPlausibleTitle,
  isOurs,
  SYSTEM_PROMPT,
  EXTRACT_TOOL,
};
