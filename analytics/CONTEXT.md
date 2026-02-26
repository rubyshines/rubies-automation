# Analytics — Context

## Purpose
Daily automated sales report with year-over-year comparisons. Runs just after midnight ET, queries Shopify for sales and conversion data, and sends a formatted HTML email via SendGrid.

## Metrics Reported
1. Yesterday's sales (revenue + orders)
2. Month-to-date revenue & orders vs same period last year
3. Year-to-date revenue & orders vs same period last year
4. Conversion rate (excl. China sessions): last 7 days and MTD, vs last year

## Data Sources
- Shopify (ShopifyQL via Admin API)

## Outputs
- HTML email via SendGrid to configured recipient

## Known Issues
