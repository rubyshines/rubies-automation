---
name: USPS API registration needed
description: Need USPS Web Tools user ID to enable detailed USPS tracking. Free registration, add to .env as USPS_USER_ID. New USPS API launching April 2026.
type: project
---

## USPS Tracking API

Currently USPS tracking falls back to Shopify fulfillment status (basic) because USPS website blocks scraping.

**To enable detailed USPS tracking:**
1. Register at https://registration.shippingapis.com/ (free, instant)
2. Add `USPS_USER_ID` to `.env`
3. Update `customer-service/lib/tracking/scraper.js` to call the XML API:
   ```
   https://production.shippingapis.com/ShippingAPI.dll?API=TrackV2&XML=<TrackRequest USERID="{USPS_USER_ID}"><TrackID ID="{number}"></TrackID></TrackRequest>
   ```
4. Feed XML response to Sonnet for parsing (same pattern as HTML scraping)

**Note:** USPS launching new OAuth-based API in April 2026. May want to use that instead.

**Why:** USPS is ~80% of US domestic shipments. Currently only get basic status from Shopify. With the API we'd get full scan history, locations, estimated delivery — same quality as Passport tracking.
