# Lease Hunter

Finds the cheapest UK **personal** lease deals for a shortlist of cars:
10,000 miles a year, 1 or 3 months upfront, whichever term (24/36/48) is cheapest,
ranked by **effective monthly** = (initial payment + remaining payments + broker fees) ÷ term.

## Run on your laptop

```bash
npm install                      # installs Playwright
npx playwright install chromium  # one-off browser download (skip if you use CHANNEL=chrome)
npm run scrape                   # all automated sources -> data/raw/*.json
npm run build                    # merge + filter -> dashboard/data.json
npm run serve                    # http://localhost:8080
```

Use a visible browser window and your installed Chrome:

```bash
HEADED=1 CHANNEL=chrome PROFILE_DIR=.profile npm run scrape
```

Run one source, or a subset of models: `node run.mjs vanarama --models=bmw-x3,volvo-xc60`.

## Sources

| Source | Kind | How |
|---|---|---|
| see `scrapers/*.mjs` | broker / aggregator | each module documents its endpoints in its header |
| Leasing.com, Select Car Leasing, Nationwide Vehicle Contracts, others | blocked to automation | `node capture.mjs <url>`: you browse; press Enter to record the page's deal |
| anything else (email quotes, dealer quotes) | manual | add to `config/manual-deals.json` |

## Configure

- `config/models.json`: which models to collect (all derivatives are collected).
- `config/cars.json`: the shortlist. Each spec picks derivatives with regex `match` / `exclude` and can list `options` with estimated list prices. You can also edit it in the dashboard (saved in your browser), then **Copy JSON** back into this file.
- `config/settings.json`: mileage, upfront months, terms, disabled sources.

Option add-ons are an estimate (default £25/month per £1,000 of list price, adjustable). Brokers quote standard spec, so get a requote with your options before signing.
