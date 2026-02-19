# RUBIES Automations

Collection of automation scripts for RUBIES operations.

## Projects

### Analytics (`/analytics`)
Daily SEO tracking automation that pulls data from Google Analytics 4 and Google Search Console into a Google Sheet.

- Tracks organic sessions, users, and conversion rate
- Monitors top 10 keyword rankings daily
- Prevents duplicate runs on the same day
- Runs automatically at 9 AM UTC via GitHub Actions

**Setup:** See [analytics/README.md](analytics/README.md)

### Future Automations
- `wholesale/` — Wholesale lead management *(coming soon)*
- `inventory/` — Inventory sync *(coming soon)*

## GitHub Actions

Automated workflows live in `.github/workflows/`. Each project has its own workflow file. Workflows are triggered on a daily schedule and can also be run manually from the GitHub UI.

## Repository Secrets

To run automations via GitHub Actions, add the following secrets in:  
**Repository → Settings → Secrets and variables → Actions**

### Analytics secrets

| Secret Name | Description |
|---|---|
| `GA4_PROPERTY_ID` | Google Analytics 4 property ID |
| `GOOGLE_SHEET_ID` | ID from the target Google Sheet URL |
| `SERVICE_ACCOUNT_KEY` | Full JSON content of `service-account-key.json` |

**Never commit credential files to this repository.**
