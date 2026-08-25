// Which queue a tombstone applies to.
//
// When an operator actions a ticket (send, close, snooze, park, On Me, spam,
// delete) the dashboard removes it from the queue immediately and remembers the
// id for ~90s, because the server snapshot keeps returning it until the status
// flip lands in Gorgias + Supabase. Without that, the 30s poll rebuilds the
// cycle order from the lagging snapshot and j/k lands you back on a ticket you
// already finished.
//
// That is a statement about the WORK CYCLE, not about the ticket. The Bug tab
// is not a work cycle: it lists tickets flagged as blocked on an advisor fix,
// spanning open, On Me and closed, and the single most common way to get onto it
// is to flag a bad draft and then answer the customer by hand. So the ticket you
// just actioned belonging there is the entire point of the feature — and
// filtering it out gave the exact symptom that surfaced this: a Bug tab
// reporting a count with nothing under it.
//
// Closed is excluded for the same reason. It is a history log, and the whole
// content of "I just closed this" is that it now belongs there.
//
// Pure functions, no DOM — loaded as a plain script in the browser
// (window.queueSuppression) and required directly by the tests.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.queueSuppression = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // The tabs an operator cycles through to clear work. A tombstone means "gone
  // from this cycle"; on any other tab it means nothing.
  const CYCLING_TABS = ['new', 'followup', 'onme', 'parked', 'snoozed'];

  function suppressionAppliesTo(tab) {
    return CYCLING_TABS.includes(tab);
  }

  /**
   * The rows to actually render. Off a cycling tab the tombstones are simply not
   * this list's business, so every ticket the server returned is shown.
   */
  function filterSuppressed(tickets, tab, suppressedIds) {
    if (!suppressionAppliesTo(tab)) return tickets;
    if (!suppressedIds || !suppressedIds.size) return tickets;
    return tickets.filter(t => !suppressedIds.has(t.id));
  }

  /**
   * Tombstones whose status flip has landed: the cycling queue no longer returns
   * them, so they can stop being suppressed ahead of the TTL backstop.
   *
   * Scoped to cycling tabs for a second reason beyond symmetry — the absence of
   * a ticket from a NON-cycling list says nothing about whether its flip landed.
   * Sitting on the Bug tab would otherwise clear every tombstone from New,
   * resurrecting tickets into the cycle that had just been actioned.
   */
  function idsToUnsuppress(tickets, tab, suppressedIds) {
    if (!suppressionAppliesTo(tab) || !suppressedIds || !suppressedIds.size) return [];
    const serverIds = new Set(tickets.map(t => t.id));
    return [...suppressedIds.keys()].filter(id => !serverIds.has(id));
  }

  return { CYCLING_TABS, suppressionAppliesTo, filterSuppressed, idsToUnsuppress };
});
