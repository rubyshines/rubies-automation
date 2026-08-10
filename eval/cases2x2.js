/**
 * The 20 cases for the 2x2.
 *
 * Chosen to span all three measured defects rather than to be representative
 * of the inbox — the question is whether an arm fixes a KNOWN failure, and a
 * proportional sample would drown each defect in ordinary traffic.
 *
 * Weighted deliberately toward shipping / general_inquiry / sizing. Those are
 * the worst categories (68% / 65% / 57% edit rate, over half wholesale
 * rewritten) and the only ones no prompt work has ever targeted, so they are
 * where an honest test has the most room to move and the least chance of
 * measuring our own past tuning.
 */

module.exports = {
  // Defect 1 — asks when the customer already gave it everything.
  // Drawn from the 21 "pure" steered cases (a short steer adding no fact the
  // advisor could not already see). Control baseline on these is 32% acted
  // over three runs, so there is a measured number to beat.
  // 3050 is the ticket-2949 case and acts as a positive control: two
  // independent batches had control acting 2/5 and the carve-out cut 5/5, so
  // an arm that cannot move THIS one is not moving anything.
  act_vs_ask: [3050, 694, 896, 1084, 1768, 2534, 2943],

  // Defect 2 — unrequested sentences bolted onto a correct action.
  // Jamie's own flags from the tolerance review, so ground truth is his, and
  // the judge is already known to reproduce every one of them.
  padding: [1376, 1405, 1367, 1461, 1770, 1529],

  // Defect 3 — the draft gets discarded and rewritten from scratch. Measured
  // by how much of the draft's distinctive vocabulary fails to survive into
  // what Jamie sent; every case here lost 75%+ of it. Undiagnosed, untouched,
  // and roughly 200 drafts a period, so it is the biggest unclaimed prize.
  // 2439 and 1643 are the shipping stall specifically: the draft wrote "let me
  // look into this and get back to you" and Jamie replaced it with a concrete
  // recourse.
  wholesale_rewrite: [2439, 1643, 1962, 1726, 1532, 1485, 2409],

  // Swapped in if a case above turns out not to be replayable from stored
  // history. Same defect groups, next in rank.
  alternates: {
    act_vs_ask: [757, 793, 876, 1017, 1192],
    padding: [3003, 1379, 1767, 1814, 1556],
    wholesale_rewrite: [1378, 2713, 2372, 1381, 1491, 2212, 1698],
  },
};
