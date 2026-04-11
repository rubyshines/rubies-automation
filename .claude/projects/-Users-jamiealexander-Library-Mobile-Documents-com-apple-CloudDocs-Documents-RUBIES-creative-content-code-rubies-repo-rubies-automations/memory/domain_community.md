---
name: Community & Partnerships
description: LGBTQ+ org partnerships, donation routing, free swimwear program
type: project
---

## What's Built

**Donation Partner Registry:** 13 partners (US: 9, CA: 3, CH: 1) stored in Supabase with name, region, city, address, description, donations_routed counter, active flag.

**Geographic Donation Routing:** Google Maps geocoding of customer address → haversine distance to all active partners in customer's country → selects 3 closest → load-balances by fewest prior donations. Fallback: single-item returns suggest local donation. No partners in country → suggest local + ask for referral.

**Donation Logging:** Tracks customer email, order number, partner assigned, item count, routing type (partner/local_single/local_no_partner). Enables impact reporting.

**Integration with CS Advisor:** When exchange confirmed, advisor calls get_donation_partner tool and composes customer message with org address, description, washing reminder. Framed as "gender-affirming programs" — not charity/waste.

**Free Swimwear Program:** Referenced on website but no explicit automation integration visible in codebase.

## Advisor Prompt Candidates

- Donation messaging: always full explanation about LGBTQ+ program. Skip explanation for defects. Wash instructions only for named partner (not local donation).

## Current Status

- **Production:** Core routing logic working. Partners table populated. Load-balancing active.
- **Gaps:** No partner onboarding/management UI. No feedback from partners on items received. International expansion needs partner data (only US/CA/CH currently). No donation impact dashboard. Free swimwear program not automated.

## Key Decisions

- **Geographic + load-balance hybrid:** Not pure geographic (would overload nearest org). Closest 3 candidates balanced by prior donation count.
- **Defect exclusion:** Customers with defects keep originals. Only exchanges get donated.
- **Silent geocoding failures:** If Google Maps API key missing or call fails, falls back to pure load-balancing. Doesn't break the flow.

## What's Next

- Expand partner network (more countries, more US partners)
- Build donation impact reporting/dashboard
- Automate free swimwear program
- Partner feedback loop (items received, condition)
