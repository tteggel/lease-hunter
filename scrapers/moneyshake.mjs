// Moneyshake (www.moneyshake.com) — SvelteKit site; uses the same endpoints its own frontend calls. No browser needed.
//
//   GET  /compare-car-leasing/__data.json?manufacturer[]=<mid>&range[]=<rid>&bodyType[]=Estate&page=N
//        -> SvelteKit "devalue" payload: { vehicles[12/page], total, totalPages, filterRanges[{manufacturerId, ranges[{value,label}]}] }
//   POST /vehicles/<id>/pricing  {contractLength, annualMileage, initialRental, personal:true}
//        -> best offer for that profile: { monthlyPrice (inc VAT, whole £), initialPayment, documentFee, totalCost,
//             inStockOffer, brandName (broker), offerId, contractLength/annualMileage/initialRental actually used }
//        If a profile isn't available the endpoint silently falls back to another profile, so we check the echo.
//   Deal page a human can open: /vehicles/<id>?term=36&annualMileage=10000&initialRental=3 (SSR renders that profile)
//
// Moneyshake returns ONE (cheapest) offer per derivative+profile, not every broker's quote.

export const meta = { id: 'moneyshake', name: 'Moneyshake', url: 'https://www.moneyshake.com', method: 'api', homeIpRecommended: false };

const SITE = 'https://www.moneyshake.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept: 'application/json', 'Accept-Language': 'en-GB,en;q=0.9', Origin: SITE, Referer: SITE + '/compare-car-leasing',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BUDGET_MS = 9 * 60 * 1000;

// manufacturer ids / range labels on Moneyshake. Range ids are resolved from filterRanges at run time (fallback ids below).
const RULES = {
  'bmw-3-touring':  { mid: 869,   range: /^3 SERIES$/i,     rid: 35,   body: 'Estate' },
  'bmw-x3':         { mid: 869,   range: /^X3$/i,           rid: 755 },
  'merc-c-estate':  { mid: 5509,  range: /^C[ -]?CLASS$/i,  rid: null, body: 'Estate' },
  'volvo-xc60':     { mid: 12764, range: /^XC60$/i,         rid: 953 },
  // A5 range carries both A5 and S5 ("S5 3.0 TFSI ...") derivatives; Avant = bodyType Estate
  'audi-a5-avant':  { mid: 164,   range: /^A5$/i,           rid: 899,  body: 'Estate', deriv: d => !/^S\s?5\b/i.test(d) },
  'audi-s5-avant':  { mid: 164,   range: /^(A5|S5)$/i,      rid: 899,  body: 'Estate', deriv: d => /^S\s?5\b/i.test(d) },
  'audi-rs5-avant': { mid: 164,   range: /^RS\s?5$/i,       rid: 1054, body: 'Estate' },
};

// --- minimal SvelteKit devalue decoder ---
function unflatten(arr) {
  const cache = new Map();
  const h = i => {
    if (i < 0) return i === -3 ? NaN : i === -6 ? -0 : undefined;
    if (cache.has(i)) return cache.get(i);
    const v = arr[i];
    if (v === null || typeof v !== 'object') { cache.set(i, v); return v; }
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string') {
        if (v[0] === 'Date') return new Date(v[1]);
        if (v[0] === 'Set') return new Set(v.slice(1).map(h));
        if (v[0] === 'Map') { const m = new Map(); for (let k = 1; k < v.length; k += 2) m.set(h(v[k]), h(v[k + 1])); return m; }
        if (v[0] === 'null') { const o = Object.create(null); for (let k = 1; k < v.length; k += 2) o[v[k]] = h(v[k + 1]); return o; }
      }
      const out = []; cache.set(i, out); for (const x of v) out.push(h(x)); return out;
    }
    const o = {}; cache.set(i, o); for (const k in v) o[k] = h(v[k]); return o;
  };
  return h(0);
}

async function req(url, opts = {}, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
      if (r.status === 403 || r.status === 429) throw Object.assign(new Error(`HTTP ${r.status}`), { fatal: r.status === 403 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e.fatal || i === tries) throw e;
      await sleep(1500 * i);
    }
  }
}

async function listPage(params, page) {
  const qs = new URLSearchParams();
  for (const [k, v] of params) qs.append(k, v);
  if (page > 1) qs.set('page', String(page));
  const j = await req(`${SITE}/compare-car-leasing/__data.json?${qs}`);
  const node = (j.nodes || []).find(n => n?.type === 'data' && n.data && JSON.stringify(n.data).includes('"vehicles"'));
  if (!node) throw new Error('no listing node in __data.json');
  return unflatten(node.data);
}

const fuelOf = f => {
  f = (f || '').toLowerCase();
  if (/plug/.test(f)) return 'phev';
  if (/electric hybrid|hybrid/.test(f)) return /diesel/.test(f) ? 'mhev' : 'hybrid';
  if (/electric/.test(f)) return 'bev';
  if (/diesel/.test(f)) return 'diesel';
  if (/petrol/.test(f)) return 'petrol';
  return null;
};

// "2.0 TFSI 150 S line 5dr S Tronic [Tech Pack] [s line [tech pack]]" -> derivative w/o the trailing trim tag; trim = tag
function splitTrim(d) {
  const m = d.match(/^(.*?)\s*\[([^\[\]]*(?:\[[^\]]*\][^\[\]]*)*)\]\s*$/);
  if (!m || !m[1]) return { derivative: d.trim(), trim: null };
  return { derivative: m[1].trim(), trim: m[2].trim() || null };
}

function specs(der, v) {
  const engine = (der.match(/^(?:S\s?5\s+|RS\s?5\s+)?(\d\.\d)\b/) || [])[1] || null;
  let powerHp = v.bhp || null;
  if (!powerHp) { const m = der.match(/\b(?:TFSI|TDI|TSI)\s+(?:e\s+)?(?:Quattro\s+)?(\d{3})\b/i) || der.match(/\[(\d{3})\]/); if (m) powerHp = +m[1]; }
  const transmission = /manual/i.test(v.transmission || '') ? 'manual' : (v.transmission ? 'auto' : null);
  const drive = /xdrive|quattro|qtro|awd|4matic|4x4/i.test(der) ? 'awd' : (/sdrive/i.test(der) ? 'rwd' : null);
  return { engine, powerHp, transmission, drive };
}

export async function scrape(ctx) {
  const { models, log } = ctx;
  const mileage = ctx.mileage ?? 10000;
  const terms = ctx.terms ?? [24, 36, 48];
  const initials = [...new Set([...(ctx.initialMonths ?? [1, 3]), 6])].sort((a, b) => a - b);
  const t0 = Date.now();
  const deals = [];
  const rangeCache = new Map(); // mid -> ranges[]
  const listCache = new Map();  // listing params -> vehicles[]

  for (const m of models) {
    const rule = RULES[m.id];
    if (!rule) { log(`${m.id}: no rule, skipping`); continue; }
    if (Date.now() - t0 > BUDGET_MS) { log('time budget exhausted, stopping'); break; }
    try {
      // 1. resolve range id from the site's own filter list
      if (!rangeCache.has(rule.mid)) {
        const first = await listPage([['manufacturer[]', rule.mid]], 1);
        const fr = (first.filterRanges || []).find(x => x.manufacturerId === rule.mid);
        rangeCache.set(rule.mid, { ranges: fr?.ranges || [], total: first.total });
        await sleep(400);
      }
      const { ranges, total: makeTotal } = rangeCache.get(rule.mid);
      const range = ranges.find(r => rule.range.test(r.label));
      const rid = range?.value ?? (ranges.length ? null : rule.rid);
      if (!rid) { log(`${m.id}: no matching range on Moneyshake (make has ${makeTotal} vehicles; ranges: ${ranges.map(r => r.label).join(', ') || 'none'})`); continue; }

      // 2. list every derivative in range (+ body type)
      const params = [['manufacturer[]', rule.mid], ['range[]', rid]];
      if (rule.body) params.push(['bodyType[]', rule.body]);
      const lkey = JSON.stringify(params);
      if (!listCache.has(lkey)) {
        const vs = [];
        let page = 1, totalPages = 1;
        do {
          const L = await listPage(params, page);
          totalPages = L.totalPages || 1;
          vs.push(...(L.vehicles || []));
          page++;
          await sleep(400);
        } while (page <= totalPages && page <= 20);
        listCache.set(lkey, vs);
      }
      const vehicles = listCache.get(lkey);
      const uniq = [...new Map(vehicles.map(v => [v.id, v])).values()]
        .filter(v => !rule.body || v.bodyType === rule.body)
        .filter(v => !rule.deriv || rule.deriv(v.derivative || ''));
      log(`${m.id}: range ${range?.label ?? rid} -> ${uniq.length} derivatives`);

      // 3. price every derivative x term x initial at the target mileage (concurrency 2)
      const jobs = [];
      for (const v of uniq) for (const term of terms) for (const ini of initials) jobs.push({ v, term, ini });
      let idx = 0, got = 0, miss = 0;
      const worker = async () => {
        while (idx < jobs.length) {
          if (Date.now() - t0 > BUDGET_MS) return;
          const { v, term, ini } = jobs[idx++];
          try {
            const p = await req(`${SITE}/vehicles/${v.id}/pricing`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', Referer: `${SITE}/vehicles/${v.id}` },
              body: JSON.stringify({ contractLength: term, annualMileage: mileage, initialRental: ini, personal: true }),
            });
            if (!p || !p.monthlyPrice || p.contractLength !== term || p.annualMileage !== mileage || p.initialRental !== ini || p.personal === false) { miss++; continue; }
            const { derivative, trim } = splitTrim(v.derivative || '');
            deals.push({
              source: meta.id, modelId: m.id,
              url: `${SITE}/vehicles/${v.id}?term=${term}&annualMileage=${mileage}&initialRental=${ini}`,
              make: m.make, model: m.model,
              derivative, trim,
              fuel: fuelOf(v.fuelType),
              ...specs(derivative, v),
              termMonths: term, initialMonths: ini, annualMileage: mileage,
              monthlyIncVat: p.monthlyPrice,
              initialPaymentIncVat: p.initialPayment ?? null,
              fees: p.documentFee ?? null,
              stock: p.inStockOffer ? 'stock' : null,
              delivery: null,
              options: /\[(tech|pro|tech\/pro)[^\]]*\]/i.test(derivative) ? [derivative.match(/\[([^\]]+)\]/)[1]] : [],
              dealer: p.brandName || null,
              totalCostIncVat: p.totalCost ?? null,
              siteVehicleId: v.id, offerId: p.offerId ?? null,
              fetchedAt: new Date().toISOString(),
            });
            got++;
          } catch (e) {
            if (e.fatal) { log(`blocked (${e.message}) — stopping pricing`); idx = jobs.length; return; }
            miss++;
          }
          await sleep(250 + Math.random() * 250);
        }
      };
      await Promise.all([worker(), worker()]);
      log(`${m.id}: ${got} priced offers (${miss} profiles unavailable/failed)`);
    } catch (e) {
      log(`${m.id}: ERROR ${e.message || e}`);
    }
  }
  return deals;
}
