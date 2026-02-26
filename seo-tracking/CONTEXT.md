# SEO Tracking — Context

## Purpose
Daily automated pipeline to track SEO performance and surface insights that drive organic revenue growth. Target: grow organic search revenue from $183K to $300-400K within 6 months.

## What It Does
1. Queries GA, Search Console, and Shopify daily via GitHub Actions
2. Stores raw data in Supabase
3. Writes summary data to Google Sheets
4. Calls Claude API to identify insights and anomalies (in progress)

## Data Sources
- Google Analytics 4
- Google Search Console
- Shopify (orders, revenue attribution)

## Outputs
- Supabase: raw daily data (full history)
- Google Sheets: summary dashboard
- Claude API insights: anomalies, trends, recommendations (format TBD)

## Known Issues
