const DEFAULT_SCORE_THRESHOLD = 5;

// Calculate a 1-10 fit score from AI analysis + contact results
function scoreProspect(analysis, contacts, communityMentionCount = 0) {
  const breakdown = {};
  let score = 0;

  // Positive signals
  if (analysis.mentionsTransOrGenderAffirming) {
    score += 3;
    breakdown.mentionsTrans = 3;
  }

  if (analysis.mentionsLGBTQ || analysis.mentionsInclusivity) {
    score += 2;
    breakdown.mentionsLGBTQOrInclusivity = 2;
  }

  if (analysis.carriesGenderProducts) {
    score += 2;
    breakdown.carriesGenderProducts = 2;
  }

  if (analysis.carriesUnderwearOrSwimwear) {
    score += 1;
    breakdown.carriesUnderwearSwimwear = 1;
  }

  if (analysis.independentlyOwned) {
    score += 1;
    breakdown.independentlyOwned = 1;
  }

  if (analysis.hasPhysicalStore) {
    score += 1;
    breakdown.hasPhysicalStore = 1;
  }

  if (contacts && contacts.emailType === 'personal') {
    score += 1;
    breakdown.personalEmail = 1;
  }

  // Community mentions (max +3)
  const mentionBonus = Math.min(communityMentionCount, 3);
  if (mentionBonus > 0) {
    score += mentionBonus;
    breakdown.communityMentions = mentionBonus;
  }

  // Negative signals
  if (analysis.independentlyOwned === false) {
    score -= 2;
    breakdown.chainStore = -2;
  }

  if (!analysis._hasWebsite) {
    score -= 2;
    breakdown.noWebsite = -2;
  }

  if (contacts && contacts.contactMethod === 'none') {
    score -= 1;
    breakdown.noContactMethod = -1;
  }

  if (analysis.isRelevant === false) {
    score -= 3;
    breakdown.notRelevant = -3;
  }

  // Clamp to 1–10
  score = Math.max(1, Math.min(10, score));

  return { score, scoreBreakdown: breakdown };
}

function getStatus(score, isRelevant, threshold = DEFAULT_SCORE_THRESHOLD) {
  if (isRelevant === false) return 'dismissed';
  return score >= threshold ? 'qualified' : 'dismissed';
}

module.exports = { scoreProspect, getStatus };
