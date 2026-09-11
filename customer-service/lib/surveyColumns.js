/**
 * surveyColumns.js — resolve a Google Form response sheet's columns to fields,
 * resiliently, and refuse rather than guess.
 *
 * The problem this replaces: readers keyed on POSITION (`row[8]` is the address).
 * A question added anywhere but the end shifts every column after it, and the
 * reader carries on happily parsing the address as the size range. Nothing
 * throws; the data is just wrong from then on.
 *
 * Matching on header text alone only moves the fragility: the operator owns that
 * text and reworks it. So resolution is layered, and every layer can only ever
 * produce a right answer or a loud failure:
 *
 *   1. MATCH on the meaning-carrying fragment, not the sentence. The header
 *      "What is the website of you organization" (sic) resolves on `website`,
 *      and keeps resolving through a rewrite, a typo fix, or added politeness.
 *   2. VERIFY the resolved column against the shape of its data. An email column
 *      holds "@", a timestamp parses as a date. This is what catches a reworded
 *      header that happens to match the wrong field: the two signals have to
 *      agree, and disagreement is an error rather than a coin toss.
 *   3. REFUSE on ambiguity. Two headers matching one field is not "take the
 *      first" — it is a question that got duplicated, and picking one silently
 *      is how you get a plausible wrong answer.
 *   4. REPORT what went unmapped, so a newly added question surfaces in the tool
 *      output instead of being invisible until someone wonders where it went.
 *
 * Verification only runs over non-empty sample values: a question added today
 * has no responses yet, and an empty column must not read as a failed match.
 */

/** "What is the WEBSITE of you org?" → "what is the website of you org". Pure. */
function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Resolve headers to fields.
 *
 * @param headers  the sheet's first row
 * @param spec     { field: { match(normalizedHeader), verify?(value), required?, label } }
 * @param rows     data rows, used only to verify; may be empty
 * @returns { index: {field: columnNumber}, unmapped: [{index, header}] }
 * @throws  when a required field is unresolved, ambiguous, or fails verification
 */
function resolveSurveyColumns(headers, spec, rows = []) {
  const norm = (headers || []).map(normalizeHeader);
  const index = {};
  const claimed = new Set();
  const problems = [];

  for (const [field, def] of Object.entries(spec)) {
    const hits = [];
    for (let i = 0; i < norm.length; i++) if (norm[i] && def.match(norm[i])) hits.push(i);

    if (hits.length === 0) {
      if (def.required) problems.push(`${field}: no column matched (${def.label || field})`);
      continue;
    }
    if (hits.length > 1) {
      problems.push(`${field}: ${hits.length} columns matched (${hits.map(i => `"${headers[i]}"`).join(', ')}) — resolve the duplicate question rather than guessing`);
      continue;
    }

    const col = hits[0];
    if (def.verify) {
      // Only non-empty values can say anything. A question with no responses yet
      // verifies vacuously, which is correct: there is nothing to disagree with.
      const samples = rows.map(r => (r || [])[col]).filter(v => String(v ?? '').trim()).slice(0, 25);
      const bad = samples.filter(v => !def.verify(String(v).trim()));
      // One malformed answer in a free-text form is normal; a column that is
      // mostly the wrong shape is a mis-resolution.
      if (samples.length >= 3 && bad.length > samples.length / 2) {
        problems.push(`${field}: matched "${headers[col]}" but ${bad.length}/${samples.length} values are the wrong shape (e.g. ${JSON.stringify(String(bad[0]).slice(0, 60))}) — the header probably moved`);
        continue;
      }
    }

    index[field] = col;
    claimed.add(col);
  }

  if (problems.length) {
    throw new Error(
      `Survey columns could not be resolved:\n  ${problems.join('\n  ')}\n`
      + `Headers on the sheet: ${(headers || []).map((h, i) => `[${i}] ${h}`).join(' | ')}`,
    );
  }

  const unmapped = (headers || [])
    .map((h, i) => ({ index: i, header: h }))
    .filter(x => x.header && !claimed.has(x.index));

  return { index, unmapped };
}

module.exports = { resolveSurveyColumns, normalizeHeader };
