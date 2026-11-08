// LeaseCar.UK (https://leasecar.uk, Central Contracts) — Astro frontend + JSON API at api-eu1.leasecar.uk.
// No browser needed; these are the calls the site's own frontend makes:
//
//   GET  https://leasecar.uk/car-leasing/{make}/{modelSlug}/           (server-rendered model page)
//        → VariantDealsConnected island props: baseSearchParams {cars_vans:'c', make_id, range_id, ...}
//          and derivatives[] (derivative_id, derivative_name, model_name, bodystyle, slug, in_stock, ...)
//   POST https://leasecar.uk/api/auth/token                          → { token } (short-lived client JWT, scope read:frontend)
//   POST https://api-eu1.leasecar.uk/get_derivatives  (Bearer token)
//        { ...baseSearchParams, initial_rental, lease_length (YEARS), mileage, prices_inc_vat:true }
//        → every derivative of the range priced for those terms: cheapest_price_personal (£/month inc VAT,
//          no maintenance, standard colour), cheapest_price_personal_initial, echoed lease_length/mileage/initial_term.
//   (POST /get_updated_derivative_prices {derivative_id, initial_rental, lease_length, mileage, maintenance:false}
//    returns the same price_personal — used by the deal page; spot-checked identical.)
//
// Fees: deal pages show "Vehicle Sourcing Fee £348.00 inc VAT" (personal) / "£290.00 ex VAT" (business);
// read from one server-rendered deal page per model (business view → ×1.2), default £348.
export const meta = { id: 'leasecaruk', name: 'LeaseCar.UK', url: 'https://leasecar.uk', method: 'api', homeIpRecommended: false };

const SITE = 'https://leasecar.uk';
const API = 'https://api-eu1.leasecar.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const DELAY_MS = 300;
const DEFAULT_FEE_INC_VAT = 348;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Site model pages and which of their derivatives belong to each configured model.
const RULES = {
  'bmw-3-touring':  { pages: ['bmw/3-series-estate'] },
  'bmw-x3':         { pages: ['bmw/x3-4x4'] },
  'merc-c-estate':  { pages: ['mercedes-benz/c-class-estate'] },
  'volvo-xc60':     { pages: ['volvo/xc60-4x4'] },
  // a5-estate's range (A5) also contains saloons and the S5 Avant
  'audi-a5-avant':  { pages: ['audi/a5-estate'], deriv: d => !/^S5\b/i.test(d.derivative_name) },
  'audi-s5-avant':  { pages: ['audi/a5-estate'], deriv: d => /^S5\b/i.test(d.derivative_name) },
  'audi-rs5-avant': { pages: ['audi/rs5-estate'] },
};

async function req(url, { method = 'GET', body, token, json = true } = {}, ctx, tries = 3) {
  const headers = { 'user-agent': UA, accept: json ? 'application/json' : 'text/html', origin: SITE, referer: SITE + '/' };
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      if (r.status === 401 || r.status === 403) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return json ? await r.json() : await r.text();
    } catch (e) {
      last = e;
      if (e.status) throw e;
      if (ctx?.context && i === tries) {   // network error: retry through the browser's request context
        try {
          const r = await ctx.context.request.fetch(url, { method, headers, data: body ? JSON.stringify(body) : undefined, timeout: 30000 });
          if (r.ok()) return json ? await r.json() : await r.text();
        } catch {}
      }
      await sleep(1000 * i);
    }
  }
  throw last;
}

let tokenCache = null;
async function token(ctx, force = false) {
  if (!force && tokenCache && tokenCache.expires * 1000 > Date.now() + 60000) return tokenCache.token;
  tokenCache = await req(SITE + '/api/auth/token', { method: 'POST' }, ctx);
  return tokenCache.token;
}

async function api(path, body, ctx) {
  try { return await req(API + path, { method: 'POST', body, token: await token(ctx) }, ctx); }
  catch (e) { if (e.status === 401) return req(API + path, { method: 'POST', body, token: await token(ctx, true) }, ctx); throw e; }
}

// Astro island props are a [type, value] tree; decode it to plain JSON.
function astroDecode(v) {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
    const [t, x] = v;
    if (t === 1) return x.map(astroDecode);   // array
    if (t === 0) return astroDecode(x);
    return x;
  }
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'number') return undefined;
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, y]) => [k, astroDecode(y)]));
  return v;
}
const unescapeAttr = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function modelPage(path, ctx) {
  const html = await req(`${SITE}/car-leasing/${path}/`, { json: false }, ctx);
  for (const m of html.matchAll(/<astro-island([^>]*)>/g)) {
    if (!/VariantDealsConnected/.test(m[1])) continue;
    const props = m[1].match(/props="([^"]*)"/)?.[1];
    if (!props) continue;
    const p = astroDecode(JSON.parse(unescapeAttr(props)));
    return { base: p.baseSearchParams, derivatives: p.derivatives || [] };
  }
  return null;
}

async function sourcingFee(slug, ctx) {
  try {
    const html = await req(SITE + slug, { json: false }, ctx);
    const t = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const m = t.match(/Vehicle Sourcing Fee\s*£([\d,.]+)\s*(inc|ex) VAT/i);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ''));
    return m[2].toLowerCase() === 'ex' ? Math.round(v * 1.2 * 100) / 100 : v;
  } catch { return null; }
}

// fuel_type_id as observed: 1 petrol, 2 diesel, 7 plug-in hybrid (others mapped by name)
const FUEL = { 1: 'petrol', 2: 'diesel', 7: 'phev' };
function fuelOf(d) {
  const s = d.derivative_name, f = FUEL[d.fuel_type_id];
  if (f === 'phev' || /\bphev\b|plug-in|tfsi e\b|\d{3}d?e\b|\bs e\b|\bt[68]\b|kwh/i.test(s) && !/\bev\b|electric/i.test(s)) return 'phev';
  if (/\bmht\b|\bmhev\b|mild hybrid|\bb[3-6]p?\b/i.test(s)) return 'mhev';
  if (f) return f;
  if (/\btdi\b|\d{3}d\b|diesel/i.test(s + ' ' + d.model_name)) return 'diesel';
  if (/electric|\bkw\b/i.test(s)) return 'bev';
  return null;
}
const driveOf = s => /xdrive|quattro|qtro|awd|4matic/i.test(s) ? 'awd' : null;
const engineOf = s => s.match(/\b(\d\.\d)\b/)?.[1] || null;
const powerOf = s => +((s.match(/\[(\d{3})\]/) || s.match(/\b(?:TFSI|TDI|B5P?|T6|T8)\s+(?:e\s+)?(?:Quattro\s+)?(\d{3})\b/i) || s.match(/\b(\d{3})\s*(?:PS|hp|bhp)\b/i) || [])[1]) || null;

export async function scrape(ctx) {
  const { models, log } = ctx;
  const mileage = ctx.mileage || 10000;
  const terms = (ctx.terms || [24, 36, 48]).filter(t => t % 12 === 0);
  const initials = [...new Set([...(ctx.initialMonths || [1, 3]), 6])];
  const deals = [];
  const pageCache = {};

  for (const m of models) {
    const rule = RULES[m.id];
    if (!rule) { log(`${m.id}: no rule, skipped`); continue; }
    try {
      const n0 = deals.length;
      for (const path of rule.pages) {
        if (!pageCache[path]) { pageCache[path] = await modelPage(path, ctx); await sleep(DELAY_MS); }
        const pg = pageCache[path];
        if (!pg?.base) { log(`${m.id}: no deal data on /car-leasing/${path}/`); continue; }
        const prefix = `/car-leasing/${path}/`;
        const wanted = pg.derivatives.filter(d => (d.slug || '').startsWith(prefix) && (!rule.deriv || rule.deriv(d)));
        const byId = new Map(wanted.map(d => [d.derivative_id, d]));
        log(`${m.id}: ${path} range ${pg.base.range_id} → ${wanted.length} derivatives`);
        if (!wanted.length) continue;
        if (pg.fee === undefined) { pg.fee = (await sourcingFee(wanted[0].slug, ctx)) ?? DEFAULT_FEE_INC_VAT; await sleep(DELAY_MS); }

        for (const t of terms) for (const im of initials) {
          let list;
          try {
            list = await api('/get_derivatives', { ...pg.base, include_prices: true, page_size: 200, initial_rental: im, lease_length: t / 12, mileage, prices_inc_vat: true }, ctx);
          } catch (e) { log(`${m.id} ${t}m/${im}: ${e.message}`); continue; }
          await sleep(DELAY_MS);
          for (const x of Array.isArray(list) ? list : []) {
            // the API returns the whole range (all body styles); keep this model page's derivatives
            const d = byId.get(x.derivative_id) || ((x.slug || '').startsWith(prefix) && (!rule.deriv || rule.deriv(x)) ? x : null);
            if (!d || !x.cheapest_price_personal) continue;
            // only keep prices quoted for exactly the requested terms
            if (x.cheapest_price_lease_length !== t / 12 || x.cheapest_price_lease_mileage !== mileage || x.initial_term !== im) continue;
            const name = d.derivative_name;
            deals.push({
              source: meta.id, modelId: m.id,
              url: SITE + d.slug,
              make: m.make, model: m.model,
              derivative: name, trim: null, siteModel: d.model_name,
              fuel: fuelOf(d), engine: engineOf(name), powerHp: powerOf(name),
              transmission: d.transmission_code === 'A' ? 'auto' : d.transmission_code === 'M' ? 'manual' : null,
              drive: driveOf(name),
              termMonths: t, initialMonths: im, annualMileage: mileage,
              monthlyIncVat: x.cheapest_price_personal,
              initialPaymentIncVat: x.cheapest_price_personal_initial ?? null,
              fees: pg.fee,
              stock: x.in_stock ?? d.in_stock ? 'stock' : 'factory',
              delivery: (x.in_stock ?? d.in_stock) ? 'in stock' : null,
              options: [...name.matchAll(/\[([^\]]+)\]/g)].map(y => y[1]).filter(y => !/^\d+$/.test(y)),
              colour: x.colour_description || d.colour_description || null,
              offerText: [d.special_offer_msg_short_1, d.special_offer_msg_short_2].filter(Boolean).map(s => s.trim()).join(' ') || null,
              fetchedAt: new Date().toISOString(),
            });
          }
        }
      }
      log(`${m.id}: ${deals.length - n0} deals`);
    } catch (e) { log(`${m.id}: FAILED ${e.message}`); }
  }
  return deals;
}
