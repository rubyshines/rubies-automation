---
title: RUBIES Return & Exchange Policy (Donation Program)
category: policy
tags: [returns, exchanges, refunds, donations, policy, gender affirming]
priority: 10
---

# Return & Exchange Policy

## Donation-Based Returns Program (Since ~mid 2024)

Instead of returning items to RUBIES, we ask customers to donate their pre-loved items to organizations that run gender-affirming programs.

### How It Works

**1 item to return/exchange:**
- Ask the customer to donate locally to any organization that supports the gender-diverse community.
- Not worth shipping a single item to a partner org — local donation is best.

**Multiple items to return/exchange:**
- Look up the customer's shipping address/country.
- Find the 3 geographically closest donation partners in the customer's country.
- Pick the partner with the fewest donations routed (load-balancing).
- Provide the customer with that organization's details for donation.

**Customer in a country without donation partners:**
- Ask them to donate locally, regardless of the number of items.
- Ask if they know of any LGBTQ+ organizations we could partner with in their country.

### Donation Routing Rules

1. **Never** cross-border shipping — always route within the customer's country.
2. **Always** explain the donation program and its community impact. CS is a brand loyalty moment — this is an opportunity to connect, not just a logistics step.
3. Use the `donation_partners` table in Supabase to look up partners by country.
4. After routing, log the recommendation in `donation_routings` to track load-balancing.

### Donation Partner Organizations
Full list at: https://rubyshines.com/pages/donate-your-pre-loved-rubies-clothing

Partners exist in: US (9 orgs), Canada (3 orgs), Switzerland (1 org).

## Exchanges

- We offer free exchanges for sizing issues.
- Exchanges are processed as $0 draft orders in Shopify.
- The customer receives a new item shipped to them — no need to return first.
- The original item should be donated per the donation program above.
- Exchange orders are created in two phases: first a draft for review, then confirmed.
- See `exchange-decision-guide` for the full exchange decision tree.

## Refund Policy

- **60-day guarantee** from date of delivery.
- Full refund available, no questions asked.
- Always gently nudge toward exchange with genuine reasoning (better fit, different product) — never shame or pressure.
- If the customer insists on a refund, process it gracefully with no pushback.
- Include donation information and mention future products to keep the door open.

## Timeframe

- Exchanges and returns should be requested within **60 days** of delivery.
- In practice, we accommodate returns/exchanges beyond 60 days on a case-by-case basis — be generous.

## How to Request

- Email hello@rubyshines.com or use the website contact form.
- Include order number and what you'd like to exchange for.
