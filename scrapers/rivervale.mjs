// Rivervale "hub" leasing platform (www.rivervale.co.uk; rivervaleleasing.co.uk redirects there).
// One module for any site on the platform, parameterised by base URL; each brand is a separate `dealer`.
//
// The platform is a Laravel + Vue site whose listing pages are rendered client-side from Algolia.
// Everything below is what the site's own frontend does:
//   1. GET {base}/car/leasing → window.vueHubData gives algolia_app_id, algolia_search_key (public,
//      search-only) and dealpackage_index (Rivervale: "_dealpackages_production").
//   2. POST https://{appId}-dsn.algolia.net/1/indexes/*/queries  (facetFilters manufacturer_name + subsite:car)
//      → one hit per "deal package" (derivative + package), with every personal price pre-computed as
//        deals_personal_{initialMonths}_{annualMileage}_{termMonths} (£/month inc VAT, non-maintained),
//        model_identifier ("C Class Estate"), derivative_name, fuel_type, transmission, in_stock, slug.
//      Deal page URL = {base}/{slug}.
//   3. POST {base}/vehicle/deals {vehicle_id, package_uid, is_business:false, compact:1}  (needs the page's
//      CSRF token, so it runs in-page) → data[initial][mileage][term][maintained 0|1] with monthly_price
//      (pence inc VAT), admin_fee (pence inc VAT, shown on the page as "Processing Fee"), lead_time,
//      stock_due_date. Used for fees/lead time and as the authoritative price (Algolia is the fallback).
//
// Brands: other broker sites that were suggested as being on this platform either block automated
// access or do not answer from this network (see BRANDS); they are kept in the list but skipped by
// default so we do not hit a challenge page on every run. RIVERVALE_BRANDS=all (or a comma list of
// dealer names/hosts) tries them anyway; a challenge page or a site without vueHubData is skipped.
export const meta = { id: 'rivervale', name: 'Rivervale (hub platform brands)', url: 'https://www.rivervale.co.uk', method: 'browser', homeIpRecommended: false };

export const BRANDS = [
  { dealer: 'Rivervale', base: 'https://www.rivervale.co.uk' },
  // 2026-11-08: Cloudflare "Just a moment..." managed challenge to both curl and headless Chromium.
  { dealer: 'Central UK Vehicle Leasing', base: 'https://centralukvehicleleasing.co.uk', skip: 'Cloudflare verification challenge' },
  // 2026-11-08: connection reset by the server (curl and Chromium); site appears down / blocking.
  { dealer: 'Blue Chilli Van Leasing', base: 'https://www.bluechillivanleasing.co.uk', skip: 'connection reset (unreachable)' },
  // Salary-sacrifice only (salsac.rivervale.co.uk) — not personal leasing, deliberately not listed.
];

// Fallback if a page does not expose vueHubData (values as published by www.rivervale.co.uk).
const DEFAULT_HUB = { algolia_app_id: '247C4BWBA4', algolia_search_key: '6e00cb0e9aefa2b7ac0262ebebd7e0d5', dealpackage_index: '_dealpackages_production' };

// model_identifier as the platform names it ("C Class Estate", "A5 Avant Estate", "Rs 5 Avant Estate", ...)
const RULES = {
  'bmw-3-touring':  { make: 'BMW', mi: /^3 series touring\b/i },
  'bmw-x3':         { make: 'BMW', mi: /^x3\b/i },
  'merc-c-estate':  { make: 'Mercedes-Benz', mi: /^c class (amg )?estate\b/i },
  'volvo-xc60':     { make: 'Volvo', mi: /^xc60\b/i },
  // S5 Avant is listed under "A5 Avant Estate" with derivative names starting "S5 ..."
  'audi-a5-avant':  { make: 'Audi', mi: /^a5 avant\b/i, deriv: d => !/^S5\b/i.test(d) },
  'audi-s5-avant':  { make: 'Audi', mi: /^(a5|s5) avant\b/i, deriv: d => /^S5\b/i.test(d) },
  'audi-rs5-avant': { make: 'Audi', mi: /^rs ?5 avant\b/i },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CONCURRENCY = 2;
const DELAY_MS = 250;

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function fuelOf(ft, d) {
  const f = String(ft || '').toLowerCase();
  if (f === 'electric') return 'bev';
  if (f.includes('plug-in') || /\bphev\b|\d+e\b|tfsi e\b|\bt[68]\b/i.test(d)) return 'phev';
  if (f === 'hybrid') return /mhev|mild/i.test(d) ? 'mhev' : 'hybrid';
  if (f === 'diesel') return 'diesel';
  if (/\bmht\b|mhev|mild hybrid|\bb[3-6]p?\b/i.test(d)) return 'mhev';
  if (f === 'petrol') return 'petrol';
  return null;
}
const driveOf = d => /xdrive|quattro|qtro|awd|4matic/i.test(d) ? 'awd' : null;
const engineOf = d => d.match(/\b(\d\.\d)\b/)?.[1] || null;
const powerOf = d => {
  const m = d.match(/\[(\d{3})\]/) || d.match(/\b(?:TFSI|TDI|TSI|B5P?|T6|T8)\s+(?:e\s+)?(?:Quattro\s+)?(\d{3})\b/i) || d.match(/\b(\d{3})\s*(?:PS|hp|bhp)\b/i);
  return m ? +m[1] : null;
};

// ---- in-page calls (run inside the brand's page, exactly as its frontend does) ----
async function algoliaMake(page, hub, make, fields) {
  return page.evaluate(async ({ hub, make, fields }) => {
    const out = []; let pageNo = 0, nbPages = 1;
    while (pageNo < nbPages && pageNo < 10) {
      const params = new URLSearchParams({
        query: '', hitsPerPage: '1000', page: String(pageNo),
        facetFilters: JSON.stringify([[`manufacturer_name:${make}`], ['subsite:car']]),
        attributesToRetrieve: JSON.stringify(fields), attributesToHighlight: '[]',
      }).toString();
      const r = await fetch(`https://${hub.algolia_app_id.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`, {
        method: 'POST',
        headers: { 'x-algolia-application-id': hub.algolia_app_id, 'x-algolia-api-key': hub.algolia_search_key, 'content-type': 'application/x-www-form-urlencoded' },
        body: JSON.stringify({ requests: [{ indexName: hub.dealpackage_index, params }] }),
      });
      if (!r.ok) throw new Error('algolia HTTP ' + r.status);
      const j = (await r.json()).results[0];
      out.push(...j.hits); nbPages = j.nbPages || 1; pageNo++;
    }
    return out;
  }, { hub, make, fields });
}

async function vehicleDeals(page, vehicleId, packageUid, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await vehicleDealsOnce(page, vehicleId, packageUid); } catch (e) {
      if (i >= tries || !/context was destroyed|navigat/i.test(e.message)) throw e;
      await page.waitForLoadState('load').catch(() => {}); await sleep(1500);
    }
  }
}
async function vehicleDealsOnce(page, vehicleId, packageUid) {
  return page.evaluate(async ({ vehicleId, packageUid }) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
    const r = await fetch('/vehicle/deals', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: JSON.stringify({ vehicle_id: vehicleId, package_uid: packageUid, is_business: false, compact: 1 }),
    });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json().catch(() => null);
    return { data: j?.data ?? null };
  }, { vehicleId, packageUid });
}

function pickBrands() {
  const sel = process.env.RIVERVALE_BRANDS;
  if (!sel) return BRANDS.filter(b => !b.skip);
  if (sel === 'all') return BRANDS;
  const want = sel.split(',').map(s => s.trim().toLowerCase());
  return BRANDS.filter(b => want.some(w => b.dealer.toLowerCase().includes(w) || b.base.toLowerCase().includes(w)));
}

async function scrapeBrand(ctx, brand) {
  const { log, models } = ctx;
  const mileage = ctx.mileage || 10000;
  const terms = ctx.terms || [24, 36, 48];
  const initials = [...new Set([...(ctx.initialMonths || [1, 3]), 6])];
  const deals = [];
  const page = await ctx.context.newPage();
  try {
    const resp = await page.goto(brand.base + '/car/leasing', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // the page may soft-navigate once after load (search "remember" + router); let it settle first
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const title = await page.title();
    if (/just a moment|attention required|verify you are human|access denied/i.test(title) || resp?.status() === 403) {
      log(`${brand.dealer}: verification challenge / blocked (HTTP ${resp?.status()}, "${title}") — skipped`);
      return deals;
    }
    const hubRaw = await page.evaluate(() => window.vueHubData ? { algolia_app_id: vueHubData.algolia_app_id, algolia_search_key: vueHubData.algolia_search_key, dealpackage_index: vueHubData.dealpackage_index, base_url: vueHubData.base_url } : null);
    if (!hubRaw) { log(`${brand.dealer}: no vueHubData on ${page.url()} — not on the Rivervale hub platform, skipped`); return deals; }
    const hub = { ...DEFAULT_HUB, ...Object.fromEntries(Object.entries(hubRaw).filter(([, v]) => v)) };
    const base = (hub.base_url || brand.base).replace(/\/$/, '');

    const priceFields = [];
    for (const im of initials) for (const t of terms) priceFields.push(`deals_personal_${im}_${mileage}_${t}`);
    const fields = ['derivative_name', 'derivative', 'derivative_id', 'slug', 'model_identifier', 'model_name', 'manufacturer_name', 'range',
      'fuel_type', 'transmission', 'trim', 'in_stock', 'hot', 'offer_text', 'model_year', 'body_style', 'basic_price', 'basic_vat', ...priceFields];

    const byMake = {};
    for (const m of models) {
      const rule = RULES[m.id];
      if (!rule) { log(`${brand.dealer} ${m.id}: no rule, skipped`); continue; }
      try {
        if (!byMake[rule.make]) { byMake[rule.make] = await algoliaMake(page, hub, rule.make, fields); await sleep(DELAY_MS); }
        const hits = byMake[rule.make].filter(h => rule.mi.test(h.model_identifier || '') && (!rule.deriv || rule.deriv(h.derivative_name || '')));
        log(`${brand.dealer} ${m.id}: ${hits.length} deal packages`);
        const n0 = deals.length;
        await pool(hits, CONCURRENCY, async h => {
          const uid = String(h.slug || '').match(/-p-([0-9a-f-]{36})$/)?.[1];
          let vd = null;
          if (uid && (h.derivative_id || h.derivative)) {
            try {
              const res = await vehicleDeals(page, h.derivative_id || h.derivative, uid);
              if (res?.error) log(`${brand.dealer} /vehicle/deals ${h.derivative_name}: ${res.error}`);
              else if (!res?.data || !Object.keys(res.data).length) {
                // stale index entry: the deal page redirects to the make listing and no deals are returned
                log(`${brand.dealer} ${h.derivative_name}: package has no live deals (stale index entry) — skipped`);
                return;
              } else vd = res.data;
            } catch (e) { log(`${brand.dealer} /vehicle/deals ${h.derivative_name}: ${e.message}`); }
            await sleep(DELAY_MS);
          }
          const d = h.derivative_name || '';
          for (const t of terms) for (const im of initials) {
            const q = vd?.[im]?.[mileage]?.[t]?.['0'];   // '0' = without maintenance
            const monthly = q?.monthly_price ? q.monthly_price / 100 : h[`deals_personal_${im}_${mileage}_${t}`];
            if (!monthly) continue;
            const lead = q?.lead_time || (q?.stock_due_date ? `due ${q.stock_due_date}` : null) || q?.delivery || null;
            deals.push({
              source: meta.id, dealer: brand.dealer, modelId: m.id,
              url: `${base}/${h.slug}`,
              make: m.make, model: m.model,
              derivative: d, trim: h.trim || null,
              siteModel: h.model_identifier || null, modelYear: h.model_year || null,
              fuel: fuelOf(h.fuel_type, d),
              engine: engineOf(d), powerHp: powerOf(d),
              transmission: /auto/i.test(h.transmission || '') ? 'auto' : /manual/i.test(h.transmission || '') ? 'manual' : null,
              drive: driveOf(d),
              termMonths: t, initialMonths: im, annualMileage: mileage,
              monthlyIncVat: Math.round(monthly * 100) / 100,
              initialPaymentIncVat: Math.round(monthly * im * 100) / 100,   // page: "Initial rental" = monthly × months
              fees: q ? (q.admin_fee != null ? +q.admin_fee / 100 : 0) : null,   // "Processing Fee ... Inc VAT"
              stock: h.in_stock === true ? 'stock' : 'factory',
              delivery: lead ? String(lead) : (h.in_stock === true ? 'in stock' : null),
              options: [...d.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]).filter(x => !/^\d+$/.test(x)),
              hotDeal: !!h.hot, offerText: h.offer_text || null,
              priceFrom: q ? 'vehicle/deals' : 'algolia',
              fetchedAt: new Date().toISOString(),
            });
          }
        });
        log(`${brand.dealer} ${m.id}: ${deals.length - n0} deals`);
      } catch (e) { log(`${brand.dealer} ${m.id}: FAILED ${e.message}`); }
    }
  } finally { await page.close().catch(() => {}); }
  return deals;
}

export async function scrape(ctx) {
  const all = [];
  for (const brand of pickBrands()) {
    if (brand.skip && process.env.RIVERVALE_BRANDS == null) continue;
    try {
      const d = await scrapeBrand(ctx, brand);
      ctx.log(`${brand.dealer}: ${d.length} deals`);
      all.push(...d);
    } catch (e) { ctx.log(`${brand.dealer}: FAILED ${e.message}`); }
    await sleep(1000);
  }
  for (const b of BRANDS.filter(b => b.skip)) if (!process.env.RIVERVALE_BRANDS) ctx.log(`${b.dealer}: skipped (${b.skip})`);
  return all;
}
