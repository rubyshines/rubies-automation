/**
 * Pausing a donation partner — taking an org out of return routing, with the
 * reason attached.
 *
 * `active` alone could always stop the boxes, but it could not say why, so a
 * paused org and a dropped one looked identical and the reason survived only in
 * somebody's inbox. Six months later "why did we stop sending to this org?" is
 * the only question anyone asks, and it was unanswerable from the registry.
 *
 * Deliberately mirrors b2b-outreach/lib/triage.js: a pure function the tool and
 * any future panel both call, indefinite by design (an org saying "we are
 * oversupplied" has no end date, and inventing one produces a reminder on a day
 * nobody chose), and the reason is mandatory rather than encouraged.
 *
 * NOTE this is a different axis from the b2b outreach pause. This one stops
 * DONATIONS; that one stops EMAIL. An org can very reasonably want one and not
 * the other — both orgs paused on 2026-08-20 stopped taking returns while
 * explicitly asking to keep buying.
 */

function computePause(action, { reason = null, now = new Date() } = {}) {
  switch (action) {
    case 'pause': {
      if (!reason || !String(reason).trim()) {
        throw new Error('pause requires a reason — an org that stops receiving donations with no explanation gets re-litigated, or worse, silently re-added');
      }
      return {
        active: false,
        paused_at: now.toISOString(),
        paused_reason: String(reason).trim(),
      };
    }
    case 'resume':
      // Clears the reason too: a stale "they were oversupplied in 2026" sitting
      // on a partner actively receiving boxes is worse than no note at all.
      return { active: true, paused_at: null, paused_reason: null };
    default:
      throw new Error(`unknown action '${action}' — expected pause or resume`);
  }
}

/**
 * Render the pause state for the operator console. Returns '' for a partner
 * that is simply active, so the common case adds no noise.
 */
function formatPauseState(partner) {
  if (!partner || partner.active) return '';
  if (!partner.paused_reason) return 'PAUSED — no reason recorded';
  const when = partner.paused_at ? ` (${partner.paused_at.slice(0, 10)})` : '';
  return `PAUSED${when} — ${partner.paused_reason}`;
}

module.exports = { computePause, formatPauseState };
