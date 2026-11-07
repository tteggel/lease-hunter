// Vanarama scraper — uses the public GraphQL API the site's own Next.js frontend calls
// (https://www.vanarama.com/graphql). No browser needed: plain fetch gets HTTP 200, whereas a
// headless Chromium page load is blocked by Cloudflare ("Attention Required").
//
//   1. vehicleListV2(filter:{vehicleTypes:[CAR], manufacturerSlug}) → every priced car of a make
//      (rangeSlug filtering is broken on the public endpoint, so we list the make and filter locally)
//   2. combinedVehicleDetails(vehicleId) + leaseAdjustParams → derivative name, fuel, power,
//      and which mileages / terms / upfronts the vehicle supports
//   3. quoteByVehicleId(vehicleId, leaseType:PERSONAL, mileage, term, upfront) → personal price
//      (inc VAT), processing fee, lead time
export const meta = {
  id: 'vanarama',
  name: 'Vanarama',
  url: 'https://www.vanarama.com',
  method: 'api',
  homeIpRecommended: false,
};

const ENDPOINT = 'https://www.vanarama.com/graphql';
const ORIGIN = 'https://www.vanarama.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const CONCURRENCY = 2;
const DELAY_MS = 150;
const EXTRA_UPFRONTS = [6]; // cheap to collect; pipeline filters

// How each configured model appears in Vanarama's catalogue.
const MODEL_MAP = {
  'bmw-3-touring':  { makes: ['bmw'], range: /^3 series$/i, model: /touring|estate/i },
  'bmw-x3':         { makes: ['bmw'], range: /^x3$/i },
  'merc-c-estate':  { makes: ['mercedes-benz', 'mercedes'], range: /^c[ -]?class$/i, model: /estate/i },
  'volvo-xc60':     { makes: ['volvo'], range: /^xc60$/i },
  'audi-a5-avant':  { makes: ['audi'], range: /^a5( avant)?$/i, model: /avant|estate/i },
  'audi-s5-avant':  { makes: ['audi'], range: /^s5( avant)?$/i, model: /avant|estate/i },
  'audi-rs5-avant': { makes: ['audi'], range: /^rs ?5( avant)?$/i, model: /avant|estate/i },
};

const LIST_Q = `query vehicleList($vehicleTypes:[VehicleTypeEnum!],$manufacturerSlug:String,$pagination:Pagination,$sort:[Sort!]){
  vehicleListV2(filter:{vehicleTypes:$vehicleTypes,manufacturerSlug:$manufacturerSlug},pagination:$pagination,sort:$sort){
    totalVehicles
    vehicleList{ vehicleId capId derivativeName manufacturerName rangeName modelName url availability availabilityLabel
      personalRate processingFee term mileage onOffer optionalExtras{name value} }
  }}`;

const DETAILS_Q = `query GetVehicleDetails($vehicleId:ID!,$vehicleType:VehicleTypeEnum,$leaseType:LeaseTypeEnum){
  combinedVehicleDetails(vehicleId:$vehicleId,vehicleType:$vehicleType,leaseType:$leaseType){
    capDerivativeDescription capModelDescription
    derivativeInfo{ name fuelType{name} transmission{name} bodyStyle{name} }
    technicalData{ technicalData{ id name value } }
    optionalExtras{ name value }
  }
  leaseAdjustParams{ mileages terms upfronts }
}`;

const QUOTE_Q = `query GetQuoteDetails($vehicleId:ID!,$vehicleType:VehicleTypeEnum,$leaseType:LeaseTypeEnum,$mileage:Int,$term:Int,$upfront:Int){
  quoteByVehicleId(vehicleId:$vehicleId,mileage:$mileage,term:$term,upfront:$upfront,vehicleType:$vehicleType,leaseType:$leaseType){
    availabilityLabel term mileage upfront leadTime stock stockBatchId processingFee leaseType
    leaseCost{ monthlyRental initialRental totalInitialPayment }
  }}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, variables, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json', 'user-agent': UA,
          origin: ORIGIN, referer: ORIGIN + '/car-leasing',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.errors?.length && !j.data) throw new Error(j.errors.map(e => e.message).join('; '));
      await sleep(DELAY_MS);
      return j.data;
    } catch (e) {
      lastErr = e;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

// List all priced cars for a make. Pagination on this endpoint is quirky (pages overlap), so
// we de-duplicate by vehicleId and stop on an empty page or when nothing new turns up.
async function listMake(slug) {
  const byId = new Map();
  const size = 50;
  let total = null;
  for (let from = 0, stale = 0; from < 3000 && stale < 2; from += size) {
    const d = await gql(LIST_Q, { vehicleTypes: ['CAR'], manufacturerSlug: slug, pagination: { from, size }, sort: [{ field: 'rate', direction: 'ASC' }] });
    const l = d?.vehicleListV2?.vehicleList || [];
    if (total == null) total = d?.vehicleListV2?.totalVehicles ?? 0;
    if (!l.length) break;
    const before = byId.size;
    for (const v of l) if (v.vehicleId && !byId.has(v.vehicleId)) byId.set(v.vehicleId, v);
    stale = byId.size === before ? stale + 1 : 0;
    if (total && byId.size >= total) break;
  }
  return { total, vehicles: [...byId.values()] };
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function matchesModel(m, v) {
  const spec = MODEL_MAP[m.id];
  if (spec) {
    if (!spec.range.test(v.rangeName || '')) return false;
    if (spec.model && !spec.model.test(`${v.rangeName} ${v.modelName}`)) return false;
    return true;
  }
  // generic fallback: model name (minus body suffix) or range equals one of the aliases
  const names = [m.model, ...(m.aliases || [])].map(norm);
  const mn = norm(v.modelName).replace(/ (suv|estate|hatchback|saloon|coupe|convertible)$/, '');
  return names.includes(norm(v.rangeName)) || names.includes(mn);
}

function makeSlugs(m) {
  if (MODEL_MAP[m.id]) return MODEL_MAP[m.id].makes;
  const s = norm(m.make).replace(/ /g, '-');
  return [...new Set([s, s.split('-')[0]])];
}

function mapFuel(fuelName, name) {
  const f = String(fuelName || '').toLowerCase();
  const n = String(name || '');
  if (/electric/.test(f) && !/hybrid/.test(f)) return 'bev';
  if (/plug-?in/.test(f) || /\d(\.\d)?\s?kwh|e-hybrid|phev/i.test(n)) return 'phev';
  if (/hybrid/.test(f) || /\bMHEV\b|\bMHT\b|mild hybrid/i.test(n)) return 'mhev';
  if (/diesel/.test(f)) return 'diesel';
  if (/petrol/.test(f)) return 'petrol';
  return null;
}

function mapDrive(name) {
  if (/xdrive|quattro|\bawd\b|4matic|4motion|all.wheel/i.test(name)) return 'awd';
  if (/sdrive/i.test(name)) return 'rwd';
  return null;
}

// Vanarama has no separate trim field; pick the longest known trim phrase in the derivative name.
const TRIMS = [
  'Performance Vorsprung', 'Carbon Black', 'Launch Edition', 'Black Edition', 'Vorsprung', 'Technik', 'S line', 'Edition 1',
  'M Sport Pro', 'M Sport', 'xLine', 'Sport',
  'Plus Pro Black Edition', 'Plus Pro', 'Plus Black Edition', 'Ultra Black Edition', 'Ultra Bright', 'Ultra Dark', 'Ultra', 'Plus', 'Core',
  'AMG Line Premium Plus', 'AMG Line Premium', 'AMG Line', 'Avantgarde', 'Exclusive',
];
function guessTrim(name) {
  const hits = TRIMS.filter(t => new RegExp(`(^|\\s)${t.replace(/ /g, '\\s+')}(\\s|$)`, 'i').test(name));
  return hits.sort((a, b) => b.length - a.length)[0] || null;
}

function stockFlag(q) {
  if (q.stockBatchId) return 'stock';
  const s = `${q.stock || ''}`;
  if (/pre.?reg/i.test(s)) return 'prereg';
  if (/in stock/i.test(s)) return 'stock';
  return 'factory';
}

export async function scrape(ctx) {
  const { models, log } = ctx;
  const mileage = ctx.mileage ?? 10000;
  const terms = ctx.terms ?? [24, 36, 48];
  const upfronts = [...new Set([...(ctx.initialMonths ?? [1, 3]), ...EXTRA_UPFRONTS])];
  const fetchedAt = new Date().toISOString();
  const deals = [];
  const makeCache = new Map();

  for (const m of models) {
    try {
      let vehicles = [];
      for (const slug of makeSlugs(m)) {
        if (!makeCache.has(slug)) {
          try { makeCache.set(slug, await listMake(slug)); }
          catch (e) { log(`list ${slug} failed: ${e.message}`); makeCache.set(slug, { total: 0, vehicles: [] }); }
        }
        vehicles.push(...makeCache.get(slug).vehicles.filter(v => matchesModel(m, v)));
      }
      vehicles = [...new Map(vehicles.map(v => [v.vehicleId, v])).values()];
      if (!vehicles.length) { log(`${m.id}: no priced vehicles on Vanarama (range not listed)`); continue; }
      log(`${m.id}: ${vehicles.length} vehicles`);

      const perVehicle = await pool(vehicles, CONCURRENCY, async v => {
        const out = [];
        try {
          const d = await gql(DETAILS_Q, { vehicleId: v.vehicleId, vehicleType: 'CAR', leaseType: 'PERSONAL' });
          const cvd = d?.combinedVehicleDetails || {};
          const adj = d?.leaseAdjustParams || {};
          if (adj.mileages?.length && !adj.mileages.includes(mileage)) { log(`${v.vehicleId}: ${mileage} miles not offered`); return out; }
          const vTerms = terms.filter(t => !adj.terms?.length || adj.terms.includes(t));
          const vUp = upfronts.filter(u => !adj.upfronts?.length || adj.upfronts.includes(u));
          const tech = (cvd.technicalData || []).flatMap(g => g.technicalData || []);
          const hp = parseInt((tech.find(t => t.id === 'engine-power')?.value || '').replace(/[^\d]/g, ''), 10) || null;
          const capName = cvd.capDerivativeDescription || v.derivativeName || '';
          const niceName = cvd.derivativeInfo?.name || capName;
          const fuelName = cvd.derivativeInfo?.fuelType?.name;
          const trans = cvd.derivativeInfo?.transmission?.name || '';
          const extras = (cvd.optionalExtras?.length ? cvd.optionalExtras : v.optionalExtras || []).map(o => o.name || o.value).filter(Boolean);
          const engine = (capName.match(/^(\d\.\d)\b/) || niceName.match(/\b(\d\.\d)\b/) || [])[1] || null;
          for (const term of vTerms) for (const up of vUp) {
            try {
              const qd = await gql(QUOTE_Q, { vehicleId: v.vehicleId, vehicleType: 'CAR', leaseType: 'PERSONAL', mileage, term, upfront: up });
              const q = qd?.quoteByVehicleId;
              const lc = q?.leaseCost;
              if (!q || !lc?.monthlyRental) continue;
              if (q.term !== term || q.mileage !== mileage || q.upfront !== up) continue; // site substituted a different config
              const fee = q.processingFee ?? null;
              out.push({
                source: meta.id,
                modelId: m.id,
                url: `${ORIGIN}/${String(v.url || '').replace(/^\/+/, '')}`,
                make: m.make,
                model: m.model,
                derivative: niceName,
                capDerivative: capName,
                trim: guessTrim(capName) || guessTrim(niceName),
                fuel: mapFuel(fuelName, `${capName} ${niceName}`),
                engine,
                powerHp: hp,
                transmission: /auto|tronic|dct|dsg|geartronic|steptronic/i.test(`${trans} ${capName}`) ? 'auto' : (/manual/i.test(trans) ? 'manual' : null),
                drive: mapDrive(`${capName} ${niceName}`),
                termMonths: term,
                initialMonths: up,
                annualMileage: mileage,
                monthlyIncVat: lc.monthlyRental,
                initialPaymentIncVat: lc.initialRental ?? +(lc.monthlyRental * up).toFixed(2), // excl. processing fee
                totalInitialIncFees: lc.totalInitialPayment ?? null,
                fees: fee,
                feeLabel: fee ? 'processing fee (inc VAT, paid with initial rental)' : null,
                stock: stockFlag(q),
                delivery: q.leadTime || q.availabilityLabel || v.availabilityLabel || null,
                options: extras,
                vehicleId: v.vehicleId,
                fetchedAt,
              });
            } catch (e) { log(`quote ${v.vehicleId} ${term}m/${up}up failed: ${e.message}`); }
          }
        } catch (e) { log(`vehicle ${v.vehicleId} failed: ${e.message}`); }
        return out;
      });
      const got = perVehicle.flat();
      deals.push(...got);
      log(`${m.id}: ${got.length} deals`);
    } catch (e) {
      log(`${m.id} failed: ${e.message}`);
    }
  }
  return deals;
}
