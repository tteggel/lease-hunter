// LeaseLoco (www.leaseloco.com) — Next.js site; prices come from the JSON API its frontend calls:
//   GET https://api.leaseloco.com/search/url-path?urlKey=car-leasing/<make>/<range>   -> search params for that page
//   GET https://api.leaseloco.com/search/v2?manufacturers=..&ranges=..&leaseTypes=2&mileages=10000&terms=24,36,48
//                                           &initialPaymentInMonths=1,3,6&grouping=1&sortBy=1&vehicleTypes=1&pageSize=24&page=N
//       -> { results: [{ vehicle, vehiclePrice }] }   (same shape as the SSR lists in __NEXT_DATA__)
// The API sits behind AWS WAF: the frontend sends `x-aws-waf-token` (from the aws-waf-token cookie set by the
// WAF JS) + `x-visitor-key`. From a headless cloud browser the WAF answers 403 {"message":"Forbidden"} to every API
// call, so here we only reuse headers the page itself sent; we never try to work around the WAF. Run on a laptop with
// HEADED=1 CHANNEL=chrome for the API path to work.
//
// Fallback (always works, but thin): SSR __NEXT_DATA__ of /car-leasing/<make>/<range> carries ~24-50 "best" deals
// (vehiclePrice.monthlyPayment etc.) at whatever profile is cheapest/featured — often not 10k miles. We keep only
// those matching the requested mileage/terms.
//
// Prices in vehiclePrice are EX VAT; personal (leaseType 2) display price = x1.2 (verified: 396.825 -> "£476.19 per
// month"; documentFee 245.8333 -> £295). No broker name is exposed in these lists (dealer: null).

export const meta = { id: 'leaseloco', name: 'LeaseLoco', url: 'https://www.leaseloco.com', method: 'browser', homeIpRecommended: true };

const SITE = 'https://www.leaseloco.com';
const API = 'https://api.leaseloco.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BUDGET_MS = 9 * 60 * 1000;

const RULES = {
  'bmw-3-touring':  { path: 'bmw/3-series',          model: /^3 Series Touring$/i },
  'bmw-x3':         { path: 'bmw/x3',                model: /^X3$/i },
  'merc-c-estate':  { path: 'mercedes-benz/c-class', model: /^C[- ]?Class Estate/i },
  'volvo-xc60':     { path: 'volvo/xc60',            model: /^XC60$/i },
  'audi-a5-avant':  { path: 'audi/a5',               model: /^A5 Avant$/i, deriv: d => !/^S\s?5\b/i.test(d) },
  'audi-s5-avant':  { path: 'audi/a5',               model: /^(S\s?5 Avant|A5 Avant)$/i, deriv: d => /^S\s?5\b/i.test(d) },
  'audi-rs5-avant': { path: 'audi/rs-5',             model: /^RS\s?5 Avant$/i },
};

const slug = s => String(s || '').toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const r2 = x => Math.round(x * 100) / 100;

const fuelOf = (name, id) => {
  const f = (name || '').toLowerCase();
  if (/plug/.test(f) || /phev/.test(f) || id === 3) return 'phev';
  if (/mild|mhev/.test(f)) return 'mhev';
  if (/hybrid/.test(f)) return 'hybrid';
  if (/electric/.test(f)) return 'bev';
  if (/diesel/.test(f)) return 'diesel';
  if (/petrol/.test(f)) return 'petrol';
  return null;
};

function toDeal(item, m, src, ctx) {
  const v = item.vehicle || {}, p = item.vehiclePrice || {};
  const derivative = p.derivativeName || v.derivativeName;
  const modelName = p.modelName || v.modelName;
  const personal = (p.leaseType ?? 2) === 2;
  const vat = personal ? 1.2 : 1;
  const leaseProfile = `${p.leaseType ?? 2}-${p.term}-${p.mileage}-${p.initialPaymentInMonths}-${p.stockStatus ?? 0}`;
  const url = p.id && (p.vehicleId || v.id)
    ? `${SITE}/car-leasing/${slug(p.manufacturerName || v.manufacturerName)}/${slug(modelName)}/${slug(derivative)}/${p.vehicleId || v.id}/${leaseProfile}/${p.id}/config`
    : `${SITE}/car-leasing/${RULES[m.id].path}`;
  const der = derivative || '';
  const monthly = r2(p.monthlyPayment * vat);
  const fee = p.documentFee != null ? r2(p.documentFee * vat) : null;
  return {
    source: meta.id, modelId: m.id, url,
    make: m.make, model: m.model,
    derivative: der, trim: v.trimName || null,
    fuel: fuelOf(v.fuelTypeName, v.fuelType),
    engine: (der.match(/^(?:[A-Z]+\s?\d\s+)?(\d\.\d)\b/) || [])[1] || null,
    powerHp: +((der.match(/\b(?:TFSI|TDI|TSI|B\d|T\d)\s*(?:e\s+)?(?:quattro\s+)?\[?(\d{3})\]?/i) || [])[1]) || null,
    transmission: /manual/i.test(v.transmissionTypeName || der) ? 'manual' : 'auto',
    drive: /xdrive|quattro|qtro|awd|4matic/i.test(der) || /four wheel/i.test(v.driveTypeName || '') ? 'awd' : (/sdrive/i.test(der) ? 'rwd' : null),
    termMonths: p.term, initialMonths: p.initialPaymentInMonths, annualMileage: p.mileage,
    monthlyIncVat: monthly,
    initialPaymentIncVat: r2(monthly * p.initialPaymentInMonths),
    fees: fee,
    stock: p.stockStatus === 1 ? 'stock' : 'factory',
    delivery: null,
    options: (der.match(/\[([^\]]+)\]/) || [])[1] ? [der.match(/\[([^\]]+)\]/)[1]] : [],
    dealer: p.supplierName || p.supplier?.name || item.supplier?.name || null,
    locoScore: p.rating ?? null,
    viaApi: src === 'api',
    fetchedAt: new Date().toISOString(),
  };
}

function keep(item, rule, ctx) {
  const p = item.vehiclePrice || {}, v = item.vehicle || {};
  const modelName = p.modelName || v.modelName || '';
  const der = p.derivativeName || v.derivativeName || '';
  if (!rule.model.test(modelName)) return false;
  if (rule.deriv && !rule.deriv(der)) return false;
  if ((p.leaseType ?? 2) !== 2) return false;
  if (p.mileage !== ctx.mileage) return false;
  if (!ctx.terms.includes(p.term)) return false;
  if (!(p.initialPaymentInMonths <= 6 || ctx.initialMonths.includes(p.initialPaymentInMonths))) return false;
  return typeof p.monthlyPayment === 'number' && p.monthlyPayment > 0;
}

async function ssrItems(path) {
  const r = await fetch(`${SITE}/car-leasing/${path}`, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-GB' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`SSR HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__');
  const pp = JSON.parse(m[1]).props?.pageProps || {};
  return [...(pp.originalSearchResultDeals || []), ...(pp.originalBestDealList || []), ...(pp.originalInStockDealList || [])];
}

// Load the range page in the browser, capture the frontend's own API request headers and its url-path response,
// then page through search/v2 with in-page fetch (same origin/cookies/headers as the frontend).
async function apiItems(ctx, path, state) {
  const page = await ctx.context.newPage();
  let hdrs = null, urlPath = null, status403 = 0;
  page.on('request', r => { if (r.url().startsWith(API) && !hdrs) { const h = r.headers(); if (h['x-aws-waf-token']) hdrs = { 'x-aws-waf-token': h['x-aws-waf-token'], ...(h['x-visitor-key'] ? { 'x-visitor-key': h['x-visitor-key'] } : {}) }; } });
  page.on('response', async r => {
    if (!r.url().startsWith(API)) return;
    if (r.status() === 403) status403++;
    if (r.url().includes('/search/url-path') && r.ok()) { try { urlPath = await r.json(); } catch {} }
  });
  try {
    await page.goto(`${SITE}/car-leasing/${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 20 && !(urlPath || status403 >= 2); i++) await sleep(750);
    if (!urlPath) { state.blocked = status403 > 0; return null; }
    const sp = urlPath.searchParameters || urlPath.parameters || urlPath;
    const manufacturers = [].concat(sp.manufacturers || sp.manufacturer || []).map(x => x?.id ?? x);
    const ranges = [].concat(sp.ranges || sp.range || []).map(x => x?.id ?? x);
    if (!manufacturers.length || !ranges.length) { ctx.log(`${path}: url-path gave no range ids: ${JSON.stringify(urlPath).slice(0, 300)}`); return null; }
    const initials = [...new Set([...ctx.initialMonths, 6])];
    const out = [];
    for (let pg = 1; pg <= 25; pg++) {
      const q = new URLSearchParams({
        grouping: '1', inStock: '0', leaseTypes: '2', mileages: String(ctx.mileage), terms: ctx.terms.join(','),
        initialPaymentInMonths: initials.join(','), manufacturers: manufacturers.join(','), ranges: ranges.join(','),
        sortBy: '1', vehiclePriceTags: '[]', vehicleTypes: '1', pageSize: '24', page: String(pg),
      });
      const res = await page.evaluate(async ([u, h]) => {
        const r = await fetch(u, { headers: h, credentials: 'include' });
        return { status: r.status, body: r.ok ? await r.json() : null };
      }, [`${API}/search/v2?${q}`, hdrs || {}]);
      if (res.status === 403) { state.blocked = true; break; }
      const results = res.body?.results || res.body?.deals || [];
      out.push(...results);
      if (results.length < 24) break;
      await sleep(800 + Math.random() * 700);
    }
    return out;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrape(ctx) {
  const c = { ...ctx, mileage: ctx.mileage ?? 10000, terms: ctx.terms ?? [24, 36, 48], initialMonths: ctx.initialMonths ?? [1, 3] };
  const { log } = ctx;
  const t0 = Date.now();
  const deals = [];
  const state = { blocked: false };
  const cache = new Map(); // path -> { items, src }

  for (const m of ctx.models) {
    const rule = RULES[m.id];
    if (!rule) { log(`${m.id}: no rule`); continue; }
    if (Date.now() - t0 > BUDGET_MS) { log('time budget exhausted'); break; }
    try {
      if (!cache.has(rule.path)) {
        let items = null, src = 'api';
        if (ctx.context && !state.blocked) {
          try { items = await apiItems(c, rule.path, state); }
          catch (e) { log(`${m.id}: browser/API error ${e.message}`); }
          if (state.blocked) log(`${m.id}: api.leaseloco.com answered 403 (AWS WAF) — not retrying API this run; using SSR fallback`);
        }
        if (!items || !items.length) { src = 'ssr'; items = await ssrItems(rule.path); await sleep(1000); }
        cache.set(rule.path, { items, src });
      }
      const { items, src } = cache.get(rule.path);
      const seen = new Set();
      const mine = items.filter(it => keep(it, rule, c)).filter(it => { const k = it.vehiclePrice.id; if (seen.has(k)) return false; seen.add(k); return true; });
      const all = items.filter(it => rule.model.test(it.vehiclePrice?.modelName || it.vehicle?.modelName || '') && (!rule.deriv || rule.deriv(it.vehiclePrice?.derivativeName || '')));
      deals.push(...mine.map(it => toDeal(it, m, src, c)));
      log(`${m.id}: ${mine.length} deals at ${c.mileage}mi via ${src} (${all.length} listed for model at any profile, ${items.length} on page)`);
    } catch (e) {
      log(`${m.id}: ERROR ${e.message || e}`);
    }
  }
  return deals;
}
