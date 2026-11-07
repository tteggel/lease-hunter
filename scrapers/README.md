# Scraper interface

Each `scrapers/<id>.mjs` exports:

```js
export const meta = { id: 'vanarama', name: 'Vanarama', url: 'https://www.vanarama.com', method: 'api' | 'browser', homeIpRecommended: false };
export async function scrape(ctx) { return RawDeal[] }
```

`ctx`:
- `models`: `[{ id: 'bmw-3-touring', make: 'BMW', model: '3 Series Touring' }, ...]` (from config/cars.json `models`)
- `mileage`: 10000 (annual)
- `initialMonths`: [1, 3]   — acceptable "months up front" multipliers (collect any in this set; also fine to collect 6/9 and let the pipeline filter)
- `terms`: [24, 36, 48]     — collect every term the site offers in this set
- `context`: Playwright BrowserContext (may be used for page loads / in-page fetch to inherit cookies)
- `log(...args)`

Scrapers collect **all derivatives/trims** of each model (not just configured ones); matching to the user's spec happens centrally in `lib/match.mjs`.

## RawDeal
```js
{
  source: 'vanarama',            // meta.id
  modelId: 'bmw-3-touring',      // ctx.models[].id it was found for
  url: 'https://...',            // deep link a human can open to see this deal
  make: 'BMW', model: '3 Series Touring',
  derivative: '330e M Sport 5dr Step Auto',  // full name as the site shows it
  trim: 'M Sport',               // if site exposes separately, else null
  fuel: 'petrol'|'diesel'|'phev'|'mhev'|'bev'|'hybrid'|null,
  engine: '2.0', powerHp: 292, transmission: 'auto', drive: 'rwd'|'awd'|null,
  termMonths: 36, initialMonths: 3, annualMileage: 10000,
  monthlyIncVat: 389.99,         // £, personal (inc VAT)
  initialPaymentIncVat: 1169.97, // £, if site states it, else null (pipeline derives monthly*initialMonths)
  fees: 0,                       // admin/doc/arrangement fees £, null if unknown
  stock: 'factory'|'stock'|'prereg'|null,
  delivery: '4-6 weeks' | null,
  options: ['Technology Pack'] ,  // included options if the deal lists them
  fetchedAt: ISOString,
}
```
