// AA Lease (www.theaa.com/leasing) — Umbraco site; uses the JSON endpoints its jQuery frontend calls. No browser needed.
//
//   GET /leasing/umbraco/api/CarDataApi/Search?VehicleType=Car&PurchaseType=PCH&ManufacturerIds={id}&PageSize=..&CurrentPageIndex=..
//        -> { totalVehiclesInResultCount, pageOfVehicles: [{ derivativeId, capCode, manufacturer, range, model, derivative, alias,
//              fuelType (0 EV,1 hybrid,2 petrol,3 diesel), transmission, stockType (0 in stock, 1 factory order, 2 open-market),
//              deliveryInfo, marketingMessage, price{...cheapest headline...} }] }   (one row per derivative)
//   GET /leasing/Umbraco/Api/CarDataApi/GetPrice?derivativeId=..&mileage=10000&term=36&upFrontMonths=3&purchaseType=PCH
//        -> { totalMonthlyCost (PCH = inc VAT), upFrontCost, adminFee, ... }   (what the deal page's mileage/term/upfront radios call)
// Deal page: /leasing/cars/{make-slug}/{range-slug}/{alias}  — opens at 5,000mi / 36m / 12 upfront; the visitor re-selects
// mileage (5k/8k/10k/12k/15k), term (24/36/48) and upfront months (1/3/6/9/12) on the page.
// Manufacturer ids come from the search page's filter checkboxes (Audi 4, BMW 7, Mercedes-Benz 34, Volvo 58).

export const meta = { id: 'aa', name: 'AA Lease', url: 'https://www.theaa.com/leasing', method: 'api', homeIpRecommended: false };

const SITE = 'https://www.theaa.com';
const API = SITE + '/leasing/Umbraco/Api/CarDataApi';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: SITE + '/leasing/cars/search',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAKE_ID = { 'Audi': 4, 'BMW': 7, 'Mercedes-Benz': 34, 'Volvo': 58 };

// Which AA rows (range / model / derivative) belong to each configured model.
const RULES = {
  'bmw-3-touring':  v => /^3 Series$/i.test(v.range) && /touring|estate/i.test(v.model),
  'bmw-x3':         v => /^X3$/i.test(v.range),
  'merc-c-estate':  v => /^C[- ]?Class$/i.test(v.range) && /estate/i.test(v.model),
  'volvo-xc60':     v => /^XC60$/i.test(v.range),
  'audi-a5-avant':  v => /^A5$/i.test(v.range) && /avant|estate/i.test(v.model) && !/^S5\b/i.test(v.derivative),
  'audi-s5-avant':  v => (/^S5$/i.test(v.range) || (/^A5$/i.test(v.range) && /^S5\b/i.test(v.derivative))) && /avant|estate/i.test(v.model),
  'audi-rs5-avant': v => /^RS ?5$/i.test(v.range) && /avant|estate/i.test(v.model),
};
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function getJson(url, ctx, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      const txt = await r.text();
      if (/<title>[^<]*(Just a moment|Attention Required)|cf-chl|challenge-platform/i.test(txt)) throw Object.assign(new Error('Cloudflare challenge'), { fatal: true });
      if (r.status === 500 && /NullReferenceException/.test(txt)) return null;          // unknown derivative / no price
      if (r.ok) return JSON.parse(txt);
      if (r.status === 403 || r.status === 429) throw Object.assign(new Error('HTTP ' + r.status), { fatal: r.status === 403 });
      throw new Error('HTTP ' + r.status);
    } catch (e) {
      if (e.fatal || i === tries) {
        if (!e.fatal && ctx?.context) {
          try { const r = await ctx.context.request.get(url, { headers: HEADERS, timeout: 30000 }); if (r.ok()) return await r.json(); } catch {}
        }
        throw e;
      }
      await sleep(1500 * i);
    }
  }
}

async function pool(items, n, fn) {
  let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (idx < items.length) { const i = idx++; await fn(items[i], i); } }));
}

function fuelOf(v) {
  const d = v.derivative;
  if (v.fuelType === 0) return 'bev';
  if (v.fuelType === 3) return 'diesel';
  if (/\bkwh\b|tfsi \d+ e\b|tfsi e\b|\b\d{2,3}e\b|\bT[68]\b|plug-?in|phev/i.test(d)) return 'phev';
  if (/\bMHT\b|MHEV|mild|\bB[3-6]P?\b/i.test(d)) return 'mhev';
  if (v.fuelType === 1) return 'hybrid';
  if (v.fuelType === 2) return 'petrol';
  return null;
}
const stockOf = t => t === 0 ? 'stock' : (t === 1 || t === 2) ? 'factory' : null;

async function searchMake(makeId, ctx) {
  const rows = []; const size = 100;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ CurrentPageIndex: page, PageSize: size, VehicleType: 'Car', PurchaseType: 'PCH', GetSearchFacets: 'False',
      IncludeMaintenance: 'False', StockType: '', ProcurementType: '', Sort: 'ImportOrder', UpFrontMonths: 12, ManufacturerIds: makeId });
    const j = await getJson(`${API}/Search?${q}`, ctx);
    const list = j?.pageOfVehicles || [];
    rows.push(...list);
    if (!list.length || rows.length >= (j.totalVehiclesInResultCount || 0)) break;
    await sleep(400);
  }
  return rows;
}

export async function scrape(ctx) {
  const { models, log } = ctx;
  const mileage = ctx.mileage || 10000;
  const terms = (ctx.terms || [24, 36, 48]).filter(t => [24, 36, 48].includes(t));
  const initials = (ctx.initialMonths || [1, 3]).filter(n => [1, 3, 6, 9, 12].includes(n));
  const deals = [];
  const byMake = {};
  let blocked = false;

  for (const m of models) {
    if (blocked) break;
    try {
      const makeId = MAKE_ID[m.make];
      if (makeId == null) { log(`${m.id}: unknown AA manufacturer id for ${m.make}`); continue; }
      byMake[makeId] ??= await searchMake(makeId, ctx);
      const rule = RULES[m.id] || (v => (m.aliases || [m.model]).some(a => slug(v.model).startsWith(slug(a))));
      const rows = byMake[makeId].filter(rule);
      log(`${m.id}: ${rows.length} derivatives (of ${byMake[makeId].length} ${m.make} PCH rows)`);
      if (!rows.length) continue;
      const n0 = deals.length;
      await pool(rows, 2, async v => {
        if (blocked) return;
        const url = `${SITE}/leasing/cars/${slug(v.manufacturer)}/${slug(v.range)}/${v.alias}`;
        const opts = [...v.derivative.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]);
        for (const term of terms) for (const im of initials) {
          if (blocked) return;
          let p;
          try {
            p = await getJson(`${API}/GetPrice?derivativeId=${v.derivativeId}&mileage=${mileage}&term=${term}&upFrontMonths=${im}&purchaseType=PCH`, ctx);
          } catch (e) {
            if (e.fatal) { blocked = true; log(`STOP: ${e.message} — AA appears to be blocking; not retrying`); return; }
            log(`${v.derivativeId} ${term}/${im}: ${e.message}`); continue;
          }
          await sleep(200);
          if (!p || !(p.totalMonthlyCost > 0)) continue;
          deals.push({
            source: meta.id, modelId: m.id, url,
            make: m.make, model: m.model,
            derivative: v.derivative, trim: null, siteModel: v.model,
            fuel: fuelOf(v),
            engine: (v.derivative.match(/^(\d\.\d)\b/) || v.derivative.match(/\b(\d\.\d)\b/) || [])[1] || null,
            powerHp: Number((v.derivative.match(/\b(?:TFSI|TDI)\s?(?:Quattro\s)?(\d{3})\b/i) || [])[1]) || null,
            transmission: /auto/i.test(v.transmission) ? 'auto' : /manual/i.test(v.transmission) ? 'manual' : null,
            drive: /xdrive|quattro|qtro|awd|4matic/i.test(v.derivative) ? 'awd' : null,
            termMonths: term, initialMonths: im, annualMileage: mileage,
            monthlyIncVat: p.totalMonthlyCost,
            initialPaymentIncVat: p.upFrontCost ?? null,
            fees: p.adminFee ?? null,
            stock: stockOf(v.stockType),
            delivery: v.deliveryInfo || null,
            options: opts,
            note: v.marketingMessage || null,
            derivativeId: v.derivativeId, capCode: (v.capCode || '').trim() || null,
            fetchedAt: new Date().toISOString(),
          });
        }
      });
      log(`${m.id}: ${deals.length - n0} deals`);
    } catch (e) {
      if (e.fatal) { blocked = true; log(`STOP: ${e.message} — AA appears to be blocking; not retrying`); break; }
      log(`${m.id}: FAILED ${e.message}`);
    }
  }
  return deals;
}
