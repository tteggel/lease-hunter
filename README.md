# Lease Hunter

Finds the cheapest UK **personal** lease deals for a shortlist of cars (BMW 3 Series Touring and X3, Mercedes C-Class Estate, Volvo XC60 and EX60, Audi A5/S5/RS5 Avant, Polestar 4 SUV):
10,000 miles a year, 1 or 3 months upfront, whichever term (24/36/48) is cheapest,
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
| LeaseLoco | aggregator | laptop | API is behind AWS WAF; from a datacenter only featured deals load | ⛔ disabled: price API behind a bot firewall |
| Rivervale | broker | anywhere | the site's public Algolia index + its own deal endpoint | ✅ £262.80 processing fee; big C-Class Estate range |
| LeaseCar.UK | broker | anywhere | the site's own JSON API | ✅ £348 sourcing fee; C-Class Estate included |
| VIPGateway | broker (Jacit platform) | anywhere | server-rendered listing pages with the site's own filter params | ✅ £384.99 arrangement fee |
| Motorlet | broker (Jacit platform) | anywhere | same platform as VIPGateway | ✅ £295 broker fee |
| Car Leasing Made Simple | broker | anywhere | per-derivative rate table in the page | ✅ no fees; C-Class personal is POA |
| Hippo Leasing | broker | anywhere | the site's own price endpoint | ✅ £330 admin fee; no C-Class or RS5 |
| AA Leasing | broker | anywhere | the site's own JSON API (CarDataApi) | ✅ £299 admin fee; no 3 Series Touring, C-Class or RS5 listed |
| What Car? | aggregator (prices from Auto Trader) | laptop | server-rendered HTML | ⛔ disabled: example deals only (5–6k miles, 12 upfront), never matches 10k / 1–3 |
| LeaseFetcher | aggregator | anywhere | the site's filtered-list JSON | ⚠️ site currently lists no offers |
| Select Car Leasing | broker | **laptop only** | drives the site in your visible browser | ⛔ disabled: blocks automated visitors |
| Nationwide Vehicle Contracts | broker | **laptop only** | drives the site in your visible browser | ⛔ disabled: blocks automated visitors |
| Leasing.com (incl. Contract Hire and Leasing) | aggregator | **laptop only** | drives the site in your visible browser | ⛔ disabled: blocks automated visitors |
| Pink Car Leasing | broker | **laptop only** | drives the site in your visible browser | ⛔ disabled: blocks automated visitors |
| Gateway2Lease | broker (has C-Class Estate) | **laptop only** | drives the site in your visible browser | ⛔ disabled: blocks automated visitors |
| Synergy Car Leasing | broker | **laptop only** | drives the site in your visible browser | ⛔ disabled: blocks automated visitors |
| Carparison Leasing | broker | **laptop only** | drives the site in your visible browser | ⛔ disabled: blocks automated visitors |
| Anything else | manual | laptop | `node capture.mjs <url>` or `config/manual-deals.json` | |

Mercedes C-Class Estate offers come from Carwow (including Mercedes-Benz UK's own C200 deals), Rivervale, LeaseCar.UK, VIPGateway and Motorlet. Broker prices for the C-Class are far higher than the manufacturer's own offers.

### Local-only sources (disabled)

Select, NVC, Leasing.com, Pink, Gateway2Lease, Synergy and Carparison block automated visitors, including from a home connection, so they are listed in `disabledSources` and skipped. The modules still work as a reference for the browser driver: run one by name to try it anyway.

#### How the browser driver works

These sites refuse traffic from cloud machines, so their modules only run with a visible browser on your own machine:

```bash
HEADED=1 PROFILE_DIR=.profile node run.mjs selectcarleasing nationwide leasingcom pink gateway2lease synergy carparison
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

- `config/models.json`: which models to collect (all derivatives are collected). `"fuel": "bev"` marks all-electric models. `polestar-4` is the **4 SUV** only (launched Sept 2026); every scraper excludes the 4 Coupe, which uses the same derivative names, by range or model id. Adding a model means adding an entry to each scraper's per-model table.
- `config/cars.json`: the shortlist. Each spec picks derivatives with regex `match` / `exclude` and can list `options` with estimated list prices. You can also edit it in the dashboard (saved in your browser), then **Copy JSON** back into this file.
- `config/settings.json`: mileage, upfront months (`initialMonths`, default 1 and 3; a test with 1–12 showed bigger upfronts barely change the effective monthly), terms, disabled sources.

Option add-ons are an estimate (default £25/month per £1,000 of list price, adjustable). Brokers quote standard spec, so get a requote with your options before signing.
