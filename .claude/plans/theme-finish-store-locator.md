# Theme-repo prompt: finish wiring the store locator

Open a Claude session in the `rubies-ecom-v4` theme repo on branch `feature/store-locator` (worktree: `/Users/jamiealexander/Code/rubies-repo/rubies-ecom-v4-worktrees/store-locator`). Paste everything below this line.

---

The real store locator data has just been published from rubies-automations and committed as `assets/store-locators.json` (commit `498c1915`). You're picking up from there. The branch already has two untracked files alongside the JSON: `sections/store-locator-map.liquid` and `templates/page.store-locator.json`. Both are work-in-progress and not yet committed — please finalize them, commit, and ship via `/preview` then `/ship` when ready.

## What's in assets/store-locators.json

Seven RUBIES retail partners. Schema per entry:

```ts
{
  name: string,
  address: string,              // "\n" for line breaks. May be a status message instead of a real address (see Sock Drawer Heroes)
  description: string,          // 1-3 sentences, brand voice (friendly + neutral, no em dashes, no gender assumptions)
  hours: string,                // freeform; may be empty, may say "By appointment only, …" (see Underdare)
  products: string[],           // subset of ["swimwear","underwear"]
  imageUrl: string,             // currently empty for all 7 — section should hide the img el when empty
  storeUrl: string,             // always present
  lat: number,                  // ~4 decimals
  lng: number,
}
```

The seven entries:
1. Sock Drawer Heroes (Sydney pin, address field carries a "currently closed in transition" message instead of street address)
2. Illusions Lingerie (Melbourne, full data)
3. Early to Bed (Chicago, full data)
4. Underdare (Minneapolis city-level pin, appointment-only)
5. She Bop (Portland, full data)
6. Transting (pins at Buens Bogcafe in Aalborg where their products can be tried on)
7. The Tool Shed (Milwaukee, full data)

**Do not hand-edit this JSON** — it will be regenerated and republished from rubies-automations as the partner list changes (similar pattern to `assets/donation-partners.json`).

## What to finish on the theme side

The untracked `sections/store-locator-map.liquid` already does the right thing in spirit — it fetches `{{ 'store-locators.json' | asset_url }}`, instantiates a Google Map, drops a marker per entry, and renders an info panel with name/image/products/description/hours/address/storeUrl. Review it against the real data and polish:

1. **Empty `imageUrl` handling.** All 7 entries currently have `imageUrl: ""`. Confirm `displayStoreInfo` hides the `<img>` (or replaces with a placeholder) when imageUrl is empty. The current logic already does `display: none` on empty — verify it actually works visually.

2. **Empty `hours` handling.** Sock Drawer Heroes has `hours: ""` (they're in transition). The current code falls back to "Contact store for hours" — consider whether that's the right copy for a closed-in-transition store, or whether to suppress the hours row entirely when empty.

3. **Status-message address rendering.** Sock Drawer Heroes' `address` is the sentence "Physical location currently closed as they are in transition" rather than an address. It should still render in the info panel (it's the message the customer needs to see). Confirm the panel renders multi-line addresses correctly via `replace(/\n/g, '<br>')`.

4. **Products badges.** The current code creates `.store-locator__product-badge` spans capitalising the first letter of each product ("Swimwear", "Underwear"). Confirm the badge styling matches what the design called for, and that the badges look right when there are 1 or 2 of them per store.

5. **Default products fallback.** A store missing `products` is unlikely but defensive: `(store.products || [])` already covers it. Leave as is.

6. **Map center / zoom.** Current center is `{ lat: 39.8283, lng: -98.5795 }` (continental US centroid) with zoom 4 desktop / 2.5 mobile. With 7 stores spanning Australia (2), US (4), Denmark (1), 2.5/4 zoom may not show all pins on first load. Consider auto-fitting bounds to all markers via `LatLngBounds`. Or accept that customers scroll/zoom.

7. **Page template (`templates/page.store-locator.json`).** Confirm the page is named correctly so it renders at `/pages/<handle>` (presumably `store-locator` or `find-a-store`). Add to navigation if needed.

8. **Commit + ship.** Once you're happy:
   ```bash
   git add sections/store-locator-map.liquid templates/page.store-locator.json
   git commit -m "store-locator: section + page template wiring"
   ```
   Then `/preview` to verify on a branch theme, then `/ship` to merge to main and let Shopify auto-deploy.

## What I'll handle from rubies-automations

Whenever a partner changes (new store added, address updates, status flips, etc.):
- Operator updates `b2b_companies` via MCP (or directly for now)
- A future `store_locator_publish` tool will regenerate `store-locators.json` and push another branch the same way `donation_partner_publish` does today
- You merge that branch, Shopify redeploys
