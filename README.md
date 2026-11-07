# Lease Hunter

Finds the cheapest UK **personal** lease deals for a shortlist of cars:
10,000 miles a year, 1 or 3 months upfront, whichever term (24/36/48) is cheapest,
ranked by **effective monthly** = (initial payment + remaining payments + broker fees) ÷ term.

## Run on your laptop

```bash
npm install                      # installs Playwright
npx playwright install chromium  # one-off browser download (skip if you use CHANNEL=chrome)
npm run scrape                   # all automated sources -> data/raw/*.json (local-only ones are skipped unless HEADED=1)
npm run build                    # merge + filter -> dashboard/data.json
npm run serve                    # http://localhost:8080
```

Use a visible browser window and your installed Chrome:

```bash
HEADED=1 CHANNEL=chrome PROFILE_DIR=.profile npm run scrape
```

Run one source, or a subset of models: `node run.mjs vanarama --models=bmw-x3,volvo-xc60`.

## Sources

| Source | Kind | Runs where | How it gets prices | Status (Nov 2026) |
|---|---|---|---|---|
| Vanarama | broker | anywhere | the site's own JSON/GraphQL API | ✅ no 3 Series Touring or C-Class listed |
| Carwow | marketplace (many dealers and brokers) | anywhere | server-rendered deal cards, one offer per dealer | ✅ broker fees included; only C-Class source |
| Leasing Options | broker | anywhere | the site's own JSON API | ✅ £399.99 processing fee |
| Moneyshake | aggregator | anywhere | the site's own SvelteKit data + pricing endpoint | ✅ best offer per derivative only |
| LeaseLoco | aggregator | laptop | API is behind AWS WAF; from a datacenter only featured deals load | ⚠️ partial; untested on a home connection |
| LeaseFetcher | aggregator | anywhere | the site's filtered-list JSON | ⚠️ site currently lists no offers |
| Select Car Leasing | broker | **laptop only** | drives the site in your visible browser | 🧪 untested on the live site |
| Nationwide Vehicle Contracts | broker | **laptop only** | drives the site in your visible browser | 🧪 untested on the live site |
| Leasing.com (incl. Contract Hire and Leasing) | aggregator | **laptop only** | drives the site in your visible browser | 🧪 untested on the live site |
| Anything else | manual | laptop | `node capture.mjs <url>` or `config/manual-deals.json` | |

Mercedes C-Class Estate offers are scarce: at the time of writing only Carwow listed any (C200 AMG Line). The local-only sources or manual quotes are the way to fill the gap.

### Local-only sources (Select, NVC, Leasing.com)

These sites refuse traffic from cloud machines, so their modules only run with a visible browser on your own machine:

```bash
HEADED=1 CHANNEL=chrome PROFILE_DIR=.profile node run.mjs selectcarleasing nationwide leasingcom
```

The driver (`lib/sitedriver.mjs`, `lib/assist.mjs`) behaves like a person clicking:
- It opens each model page, collects the derivative links and, by default, visits only the ones that could match your shortlist. Set `ALL_DERIVATIVES=1` to price every trim.
- On each derivative page it opens the "Edit / Customise deal" panel if there is one. It sets mileage, term and months upfront by finding the controls that offer those values (dropdowns, button groups or sliders), whatever the site calls them.
- It reads the most prominent "£x per month" figure and checks the page's own summary shows 10,000 miles and the right term before keeping the price.
- If a site shows a verification check, it beeps and waits up to 5 minutes for you to complete it in the window.
- It never hides that it is automated, spoofs a browser fingerprint or solves CAPTCHAs.

The engine was validated on Leasing Options, where it matched the site's API prices to the penny. It has **not** been run against Select, NVC or Leasing.com, because they can't be reached from where it was built. If a run comes back empty or wrong, run it with discovery on:

```bash
DISCOVER=1 HEADED=1 CHANNEL=chrome PROFILE_DIR=.profile node run.mjs selectcarleasing --models=bmw-3-touring
```

This saves each page's HTML, the JSON it loaded and a screenshot to `data/discovery/<site>/`. Look through it before sharing, then share it so the parsers can be fixed.

These modules are for your own use: they do what you would do by hand, at a person's pace. Check each site's terms, which may restrict automated access.

## Configure

- `config/models.json`: which models to collect (all derivatives are collected).
- `config/cars.json`: the shortlist. Each spec picks derivatives with regex `match` / `exclude` and can list `options` with estimated list prices. You can also edit it in the dashboard (saved in your browser), then **Copy JSON** back into this file.
- `config/settings.json`: mileage, upfront months, terms, disabled sources.

Option add-ons are an estimate (default £25/month per £1,000 of list price, adjustable). Brokers quote standard spec, so get a requote with your options before signing.
