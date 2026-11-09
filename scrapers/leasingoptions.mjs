// Leasing Options (www.leasingoptions.co.uk) — uses the JSON API the Next.js frontend calls
// (https://dubs0wtv3hzi0.cloudfront.net/api/...). No browser needed.
//
//   GET /api/vehicles/info/1/{make}/models                       -> [{text:'3 Series Touring', id:'3-series-touring'}]
//   GET /api/vehicles/info/1/{make}/{modelUrl}/derivatives       -> [{text: derivative, id: vehicleRef}]  (every trim)
//   GET /api/vehicles/1/{vehicleRef}/details?pricingtype=1       -> specs, isInStock, leadTime, url slugs
//   GET /api/vehicles/1/{vehicleRef}/{termYears}/{mileage}/false/{initialMonths}/pricing?pricingtype=1
//        -> deals[]: contractType 2 = Personal (PCH, inc VAT), 1 = Business; fullPrice, initialRental, processingFee
// termYears: 2 = 24m, 3 = 36m, 4 = 48m. pricingtype=1 = standard (non-maintained) pricing.

export const meta = { id: 'leasingoptions', name: 'Leasing Options', url: 'https://www.leasingoptions.co.uk', method: 'api', homeIpRecommended: false };

const API = 'https://dubs0wtv3hzi0.cloudfront.net/api';
const SITE = 'https://www.leasingoptions.co.uk';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept: 'application/json', Origin: SITE, Referer: SITE + '/',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Site make slugs + which site "models" (body/fuel splits) belong to each configured model.
const MAKE_SLUG = { 'BMW': 'bmw', 'Mercedes-Benz': 'mercedes-benz', 'Volvo': 'volvo', 'Audi': 'audi', 'Polestar': 'polestar' };
const RULES = {
  'bmw-3-touring':  { models: /^3-series-(diesel-)?touring$/ },
  'bmw-x3':         { models: /^x3-(diesel-)?estate$/ },
  'merc-c-estate':  { models: /^c-class-(diesel-|hybrid-)?estate/ },
  'volvo-xc60':     { models: /^xc60-(diesel-)?estate$/ },
  // The A5 Avant range on LO also carries the S5 derivatives ("S5 3.0 TFSI ...")
  'audi-a5-avant':  { models: /^a5-(diesel-)?avant$/, deriv: d => !/^S5\b/i.test(d) },
  'audi-s5-avant':  { models: /^(a5|s5)-(diesel-)?avant$/, deriv: d => /^S5\b/i.test(d) || /\bS5\b/.test(d) },
  'audi-rs5-avant': { models: /^rs-?5-avant$/ },
  // "4 Estate" is the new (2026) 4 SUV body (CAP 111293+); "4 Coupe" is the original car and is excluded
  'polestar-4':     { models: /^4-estate$/ },
  'volvo-ex60':     { models: /^ex60-estate$/ },
};
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function getJson(url, ctx, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      const j = await r.json().catch(() => null);
      if (j) return j;
      if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status);
      return null;
    } catch (e) {
      // fall back to the browser's request context (inherits proxy/cookies) on network errors
      if (ctx?.context && i === tries) {
        try { const r = await ctx.context.request.get(url, { headers: HEADERS, timeout: 30000 }); return await r.json(); } catch {}
      }
      if (i === tries) throw e;
      await sleep(1000 * i);
    }
  }
}

async function pool(items, n, fn) {
  const out = []; let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

function fuelOf(d, det) {
  const s = d.toLowerCase();
  if (det.fuelType === 3) return 'bev';
  if (/phev|kwh|\d+e\b|\d+ e\b|\b\d{2}e\b|tfsi e\b|tfsi e |plug-in|\be-hybrid|\bt[68]\b/.test(s)) return 'phev';
  if (det.fuelType === 2 || /\btdi\b|\d+d\b|diesel/.test(s)) return 'diesel';
  if (/\bmht\b|mhev|\bb[3-6]p?\b|mild/.test(s)) return 'mhev';
  if (det.fuelType === 4) return 'hybrid';
  if (det.fuelType === 1) return 'petrol';
  return null;
}
const driveOf = (dt, d) => dt === '4' || /xdrive|quattro|qtro|awd|4matic/i.test(d) ? 'awd' : dt === 'R' ? 'rwd' : dt === 'F' ? 'fwd' : null;

export async function scrape(ctx) {
  const { models, log } = ctx;
  const mileage = ctx.mileage || 10000;
  const terms = (ctx.terms || [24, 36, 48]).filter(t => t % 12 === 0);
  const initials = [...new Set([...(ctx.initialMonths || [1, 3]), 6])].filter(n => [1, 3, 6, 9, 12].includes(n));
  const deals = [];
  const modelLists = {};

  for (const m of models) {
    try {
      const make = MAKE_SLUG[m.make] || slug(m.make);
      if (!modelLists[make]) modelLists[make] = (await getJson(`${API}/vehicles/info/1/${make}/models`, ctx))?.data || [];
      const rule = RULES[m.id] || { models: new RegExp('^' + (m.aliases || [m.model]).map(a => slug(a)).join('|') + '$') };
      const siteModels = modelLists[make].filter(x => rule.models.test(x.id));
      if (!siteModels.length) { log(`${m.id}: no matching models on site (make ${make} has ${modelLists[make].length} models)`); continue; }

      // all derivatives across the matching site models
      const derivs = [];
      for (const sm of siteModels) {
        const list = (await getJson(`${API}/vehicles/info/1/${make}/${sm.id}/derivatives`, ctx))?.data || [];
        for (const d of list) if (!rule.deriv || rule.deriv(d.text)) derivs.push({ ref: d.id, text: d.text, siteModel: sm });
        await sleep(150);
      }
      log(`${m.id}: ${siteModels.map(s => s.id).join(',')} -> ${derivs.length} derivatives`);

      let n0 = deals.length;
      await pool(derivs, 2, async dv => {
        try {
          const det = (await getJson(`${API}/vehicles/1/${dv.ref}/details?pricingtype=1`, ctx))?.data;
          if (!det) return;
          if (det.isPOA) return;
          const baseUrl = `${SITE}/car-leasing/${det.manufacturerUrl}/${det.shortModTextUrl}/${det.modelUrl}/${det.derivativeUrl}/${dv.ref}/vehicle`;
          const opts = [...dv.text.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]);
          for (const term of terms) {
            for (const im of initials) {
              const tY = term / 12;
              const pr = await getJson(`${API}/vehicles/1/${dv.ref}/${tY}/${mileage}/false/${im}/pricing?pricingtype=1`, ctx).catch(e => { log('pricing err', dv.ref, e.message); return null; });
              await sleep(120);
              const pch = pr?.data?.deals?.find(d => d.contractType === 2);
              if (!pch || !pch.fullPrice || pr.data.isPOA) continue;
              deals.push({
                source: meta.id, modelId: m.id,
                // term + mileage are honoured by the page URL; initial-months must be re-selected via "Edit this deal"
                url: `${baseUrl}?mileage=${mileage}&initialrentals=${im}&term=${tY}&pricingType=1`,
                make: m.make, model: m.model,
                derivative: dv.text, trim: det.shortDerText || null,
                siteModel: det.model,
                fuel: fuelOf(dv.text, det),
                engine: det.engineSize ? (det.engineSize / 1000).toFixed(1) : null,
                powerHp: det.bhp || null,
                transmission: det.transmission === 2 ? 'auto' : det.transmission === 1 ? 'manual' : null,
                drive: driveOf(det.driveTrain, dv.text),
                termMonths: term, initialMonths: im, annualMileage: mileage,
                monthlyIncVat: pch.fullPrice,
                initialPaymentIncVat: pch.initialRental ?? null,
                fees: pch.processingFee ?? null,
                stock: det.isInStock ? 'stock' : 'factory',
                delivery: det.leadTime ? String(det.leadTime) : null,
                options: opts,
                p11d: det.manufacturerRRP || pr.data.p11D || null,
                fetchedAt: new Date().toISOString(),
              });
            }
          }
        } catch (e) { log(`${m.id} ${dv.ref} ${dv.text}: ${e.message}`); }
      });
      log(`${m.id}: ${deals.length - n0} deals`);
    } catch (e) {
      log(`${m.id}: FAILED ${e.message}`);
    }
  }
  return deals;
}
