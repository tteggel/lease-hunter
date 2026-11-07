# Lease Hunter

Finds the cheapest UK **personal** lease deals for a shortlist of cars:
10,000 miles a year, 1, 3, 6, 9 or 12 months upfront (filterable in the dashboard), whichever term (24/36/48) is cheapest,
ranked by **effective monthly** = (initial payment + remaining payments + broker fees) ÷ term.

## Run on your laptop

### With Nix (recommended)

`flake.nix` gives you Node 22 and the Chromium that nixpkgs builds for Playwright, patched to run on NixOS. Playwright never downloads its own browsers.

```bash
nix develop            # or: direnv allow  (an .envrc with `use flake` is included)
npm install
npm run scrape && npm run build && npm run serve   # http://localhost:8080
```

Local-only brokers, in a visible window with a profile that remembers cookie choices:

```bash
HEADED=1 PROFILE_DIR=.profile node run.mjs selectcarleasing nationwide leasingcom
```

Commit the `flake.lock` that the first `nix develop` writes.

**Keeping Playwright and nixpkgs in step.** The npm `playwright` package looks for one browser revision, and nixpkgs ships the one matching its own Playwright version: 1.64.1 / Chromium 1248 as of Nov 2026, which `package.json` pins. When you update nixpkgs, the shell prints the command to re-pin if the versions drift. Until you run it, `lib/pw.mjs` launches the Nix Chromium directly, which works across small version gaps.

### Without Nix

```bash
npm install
npx playwright install chromium   # one-off browser download
npm run scrape && npm run build && npm run serve
```

### Choosing the browser

| Setting | Uses |
|---|---|
| (nothing) | Playwright's Chromium, or the Nix shell's |
| `CHANNEL=chrome` | your installed Google Chrome (not available on NixOS unless you install `google-chrome`) |
| `CHROME_PATH=/path/to/binary` | any Chrome or Chromium binary |
| `HEADED=1` | a visible window (needed for the local-only sources) |
| `PROFILE_DIR=.profile` | a persistent profile, so cookie choices and logins are kept between runs |

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
HEADED=1 PROFILE_DIR=.profile node run.mjs selectcarleasing nationwide leasingcom
```

The driver (`lib/sitedriver.mjs`, `lib/assist.mjs`) behaves like a person clicking:
- It opens each model page, collects the derivative links and, by default, visits only the ones that could match your shortlist. Set `ALL_DERIVATIVES=1` to price every trim.
- On each derivative page it opens the "Edit / Customise deal" panel if there is one. It sets mileage, term and months upfront by finding the controls that offer those values (dropdowns, button groups or sliders), whatever the site calls them.
- It reads the most prominent "£x per month" figure and checks the page's own summary shows 10,000 miles and the right term before keeping the price.
- If a site shows a verification check, it beeps and waits up to 5 minutes for you to complete it in the window.
- It never hides that it is automated, spoofs a browser fingerprint or solves CAPTCHAs.

The engine was validated on Leasing Options, where it matched the site's API prices to the penny. It has **not** been run against Select, NVC or Leasing.com, because they can't be reached from where it was built. If a run comes back empty or wrong, run it with discovery on:

```bash
DISCOVER=1 HEADED=1 PROFILE_DIR=.profile node run.mjs selectcarleasing --models=bmw-3-touring
```

This saves each page's HTML, the JSON it loaded and a screenshot to `data/discovery/<site>/`. Look through it before sharing, then share it so the parsers can be fixed.

These modules are for your own use: they do what you would do by hand, at a person's pace. Check each site's terms, which may restrict automated access.

## Configure

- `config/models.json`: which models to collect (all derivatives are collected).
- `config/cars.json`: the shortlist. Each spec picks derivatives with regex `match` / `exclude` and can list `options` with estimated list prices. You can also edit it in the dashboard (saved in your browser), then **Copy JSON** back into this file.
- `config/settings.json`: mileage, upfront months (`initialMonths`, default 1/3/6/9/12), terms, disabled sources. More upfront options mean more page visits for the local-only sources (5 upfronts × 3 terms per derivative).

Option add-ons are an estimate (default £25/month per £1,000 of list price, adjustable). Brokers quote standard spec, so get a requote with your options before signing.
