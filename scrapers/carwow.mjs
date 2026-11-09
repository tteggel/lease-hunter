// Carwow scraper — server-rendered HTML fragments that the site's own lease-deals page fetches
// (Rails + Turbo frames, no JSON API). Plain fetch gets HTTP 200, no browser needed.
//
//   1. https://www.carwow.co.uk/{brand}/{model}/lease          → model_review_slug (e.g. x3-2024)
//   2. https://quotes.carwow.co.uk/lease-deals?...              → trim / sub-trim (pack) slugs
//   3. https://quotes.carwow.co.uk/lease-deals/index-deal-cards → 9 dealer offers per page with
//        type=PCH (personal), contract_distance, contract_length, timescale_upfront, vehicle_state,
//        [vehicle_sub_trim_slug], page
//      Each card = one dealer/broker offer: monthly, initial payment (incl. fees), fee amount,
//      dealer name, engine, trim, deal id. vehicle_state=UNBUILT → factory order,
//      UNREGISTERED → in stock, PREREGISTERED → pre-reg. Packs are tagged by re-querying per
//      sub-trim slug (deal ids are stable across filters for the same terms).
//   4. https://quotes.carwow.co.uk/deals/{id} (one per engine) → bhp, fuel, engine size.
export const meta = {
  id: 'carwow',
  name: 'Carwow',
  url: 'https://www.carwow.co.uk',
  method: 'api',
  homeIpRecommended: false,
};

const WWW = 'https://www.carwow.co.uk';
const QUOTES = 'https://quotes.carwow.co.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const CONCURRENCY = 2;
const DELAY_MS = 250;
const PER_PAGE = 9; // fixed by the site
const STATES = [['UNBUILT', 'factory'], ['UNREGISTERED', 'stock'], ['PREREGISTERED', 'prereg']];

const BRAND = { bmw: 'bmw', 'mercedes-benz': 'mercedes', mercedes: 'mercedes', volvo: 'volvo', audi: 'audi', polestar: 'polestar' };
// carwow model path + known review slug fallback (resolved live from the model page when possible)
const MODEL_MAP = {
  'bmw-3-touring':  { path: '3-series-touring', slug: '3-series-touring-2019' },
  'bmw-x3':         { path: 'x3', slug: 'x3-2024' },
  'merc-c-estate':  { path: 'c-class-estate', slug: 'c-class-estate-2025' },
  'volvo-xc60':     { path: 'xc60', slug: 'xc60-2017' },
  'audi-a5-avant':  { path: 'a5-avant', slug: 'a5-avant-2024' },
  'audi-s5-avant':  { path: 's5-avant', slug: 's5-avant-2024' },
  'audi-rs5-avant': { path: 'rs5-avant', slug: 'rs5-avant-2026' },
  'polestar-4':     { path: '4-suv', slug: '4-suv-2026' }, // SUV body only (the 4 Coupe is model_review_slug 4-2024)
  'volvo-ex60':     { path: 'ex60', slug: 'ex60-2026' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const decode = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const clean = s => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const money = s => (s == null ? null : parseFloat(String(s).replace(/[£,\s]/g, '')));

async function get(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-GB,en;q=0.9' },
        signal: AbortSignal.timeout(45000),
      });
      if (res.status === 404) { await sleep(DELAY_MS); return { status: 404, text: '' }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await sleep(DELAY_MS);
      return { status: res.status, text };
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

function parseCards(html) {
  const count = parseInt((html.match(/results-count-value='(\d+)'/) || [])[1] || '0', 10);
  const parts = html.split("class='deal-card deal-card__deal_card'").slice(1);
  const cards = [];
  for (const c of parts) {
    const id = (c.match(/\/deals\/([0-9a-f]{32})/) || [])[1];
    if (!id) continue;
    const monthly = money((c.match(/deal-card__price-cost'>\s*£([\d,.]+)/) || [])[1]);
    if (!monthly) continue;
    cards.push({
      id,
      monthly,
      initial: money((c.match(/deal-card__price-terms'>\s*£([\d,.]+)\s*Initial payment/) || [])[1]),
      fees: money((c.match(/additional fees \(£([\d,.]+)\)/) || [])[1]) ?? 0,
      total: money((c.match(/deal-card__total-cost'>\s*<div>\s*£([\d,.]+)/) || [])[1]),
      dealer: clean((c.match(/class='deal-card__dealer-name'[^>]*>([\s\S]*?)<\/a>/) || [])[1]) || (/dealer-leasey|carwow_leasey/.test(c) ? 'Carwow Leasey' : null),
      dealerType: clean((c.match(/class='deal-card__distance'>([\s\S]*?)<\/div>/) || [])[1]) || null,
      dealershipId: (c.match(/data-dealership-id="([^"]+)"/) || [])[1] || null,
      dealScore: parseFloat((c.match(/data-deal-score="([\d.]+)"/) || [])[1]) || null,
      callouts: decode((c.match(/data-interaction-callouts="([^"]*)"/) || [])[1] || '').split(',').map(s => s.trim()).filter(Boolean),
      engine: clean((c.match(/Engine:\s*<\/strong>([\s\S]*?)<\/div>/) || [])[1]) || null,
      trim: clean((c.match(/Trim:\s*<\/strong>([\s\S]*?)<\/div>/) || [])[1]) || null,
    });
  }
  return { count, cards };
}

function cardsUrl(brand, slug, { term, up, mileage, state, subTrim, page }) {
  const p = new URLSearchParams({
    brand_slug: brand, cards_show_trim_and_engine: 'true', contract_distance: String(mileage),
    contract_length: String(term), model_review_slug: slug, timescale_upfront: String(up), type: 'PCH', vehicle_state: state,
  });
  if (subTrim) p.set('vehicle_sub_trim_slug', subTrim);
  if (page > 1) p.set('page', String(page));
  return `${QUOTES}/lease-deals/index-deal-cards?${p}`;
}

// Fetch every page of a filtered result set.
async function fetchAll(brand, slug, opts) {
  const first = parseCards((await get(cardsUrl(brand, slug, { ...opts, page: 1 }))).text);
  const cards = [...first.cards];
  const pages = Math.min(Math.ceil(first.count / PER_PAGE), 60);
  for (let page = 2; page <= pages; page++) {
    const r = parseCards((await get(cardsUrl(brand, slug, { ...opts, page }))).text);
    if (!r.cards.length) break;
    cards.push(...r.cards);
  }
  return { count: first.count, cards };
}

async function resolveSlug(m, brand, log) {
  const spec = MODEL_MAP[m.id] || {};
  const paths = [...new Set([spec.path, slugify(m.model), ...(m.aliases || []).map(slugify)].filter(Boolean))];
  for (const p of paths) {
    try {
      const r = await get(`${WWW}/${brand}/${p}/lease`);
      if (r.status !== 200) continue;
      const s = (r.text.match(/"model_slug":"([a-z0-9-]+)"/) || r.text.match(/model_review_slug=([a-z0-9-]+)/) || [])[1];
      if (s) return s;
    } catch (e) { log(`slug lookup ${brand}/${p}: ${e.message}`); }
  }
  return spec.slug || null;
}

// sub-trim (pack) slugs and labels from the lease-deals landing page
async function subTrims(brand, slug) {
  const r = await get(`${QUOTES}/lease-deals?${new URLSearchParams({ brand_slug: brand, model_review_slug: slug, type: 'PCH' })}`);
  const map = new Map();
  const re = /sub-trim-select-sub-trim-slug-value='([^']*)'\s+data-lease-deals--sub-trim-select-trim-slug-value='([^']*)'>\s*<span[^>]*>([\s\S]*?)<\/span>/g;
  for (const mm of r.text.matchAll(re)) {
    const [, sub, , label] = mm;
    if (sub && !map.has(sub)) map.set(sub, clean(label));
  }
  return map;
}

async function engineInfo(dealId) {
  const r = await get(`${QUOTES}/deals/${dealId}`);
  const kv = {};
  for (const mm of r.text.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const k = clean(mm[1]).toLowerCase();
    if (!(k in kv)) kv[k] = clean(mm[2]);
  }
  const t = clean(r.text.replace(/<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/g, ' '));
  const hp = parseInt((kv['engine power'] || kv.power || (t.match(/Engine power\s+(\d+\s*(bhp|hp|ps))/i) || [])[1] || '').replace(/[^\d]/g, ''), 10) || null;
  const size = ((kv['engine size'] || (/litre/i.test(kv.engine || '') ? kv.engine : '') || (t.match(/Engine size\s+([\d.]+)\s*litres?/i) || [])[1] || '').match(/[\d.]+/) || [])[0];
  if (!hp && !size && !kv.fuel) throw new Error('no spec table');
  return {
    powerHp: hp,
    engineSize: size ? (+size).toFixed(1) : null,
    fuelText: kv.fuel || null,
    transmission: kv.transmission || kv.gearbox || null,
  };
}

function mapFuel(engine, fuelText) {
  const e = String(engine || '');
  const f = String(fuelText || '').toLowerCase();
  if (/electric/.test(f) && !/hybrid/.test(f)) return 'bev';
  if (/\d(\.\d)?\s?kwh|e-hybrid|tfsi e\b|\bphev\b|plug-?in|\bT[68]\b|\b[0-9]{2,3}e\b/i.test(e) || /plug-?in/.test(f)) return 'phev';
  if (/\bMHT\b|\bMHEV\b|mild/i.test(e) || /mild/.test(f)) return 'mhev';
  if (/hybrid/.test(f)) return /diesel/.test(f) ? 'mhev' : 'hybrid';
  if (/diesel/.test(f) || /\bTDI\b|\b\d{2,3}d\b/i.test(e)) return 'diesel';
  if (/petrol/.test(f) || /\bTFSI\b|\b\d{2,3}i\b/i.test(e)) return 'petrol';
  return null;
}

function mapDrive(engine) {
  if (/xdrive|quattro|\bawd\b|4matic|4motion|all.wheel/i.test(engine)) return 'awd';
  if (/sdrive/i.test(engine)) return 'rwd';
  return null;
}

export async function scrape(ctx) {
  const { models, log } = ctx;
  const mileage = ctx.mileage ?? 10000;
  const terms = ctx.terms ?? [24, 36, 48];
  const upfronts = [...new Set(ctx.initialMonths ?? [1, 3])];
  const fetchedAt = new Date().toISOString();
  const deals = [];

  for (const m of models) {
    try {
      const brand = BRAND[slugify(m.make)] || slugify(m.make).split('-')[0];
      const slug = await resolveSlug(m, brand, log);
      if (!slug) { log(`${m.id}: no carwow model slug`); continue; }
      let subs = new Map();
      try { subs = await subTrims(brand, slug); } catch (e) { log(`${m.id}: sub-trims failed: ${e.message}`); }
      log(`${m.id}: slug=${slug}, packs=${[...subs.values()].join('/') || '-'}`);

      const combos = terms.flatMap(term => upfronts.map(up => ({ term, up })));
      const results = await pool(combos, CONCURRENCY, async ({ term, up }) => {
        const byId = new Map();
        try {
          for (const [state, flag] of STATES) {
            const { cards } = await fetchAll(brand, slug, { term, up, mileage, state });
            for (const c of cards) if (!byId.has(c.id)) byId.set(c.id, { ...c, stock: flag, packs: [] });
          }
          if (byId.size) {
            for (const [sub, label] of subs) {
              try {
                const { cards } = await fetchAll(brand, slug, { term, up, mileage, state: 'UNREGISTERED,PREREGISTERED,UNBUILT', subTrim: sub });
                for (const c of cards) byId.get(c.id)?.packs.push(label);
              } catch (e) { log(`${m.id} ${term}/${up} pack ${sub}: ${e.message}`); }
            }
          }
        } catch (e) { log(`${m.id} ${term}m/${up}up failed: ${e.message}`); }
        return { term, up, cards: [...byId.values()] };
      });

      // engine details: one deal page per distinct engine name
      const engines = new Map();
      for (const r of results) for (const c of r.cards) {
        if (!c.engine) continue;
        const ids = engines.get(c.engine) || [];
        if (ids.length < 3) ids.push(c.id);
        engines.set(c.engine, ids);
      }
      const info = new Map();
      await pool([...engines], CONCURRENCY, async ([eng, ids]) => {
        for (const id of ids) {
          try { info.set(eng, await engineInfo(id)); return; } catch (e) { log(`${m.id} engine ${eng} (${id}): ${e.message}`); }
        }
      });

      let n = 0;
      for (const { term, up, cards } of results) {
        for (const c of cards) {
          const ei = info.get(c.engine) || {};
          const packs = [...new Set(c.packs)];
          const initialInc = c.initial ?? null;
          deals.push({
            source: meta.id,
            modelId: m.id,
            url: `${QUOTES}/deals/${c.id}`,
            make: m.make,
            model: m.model,
            derivative: [c.engine, c.trim, packs.join(' + ')].filter(Boolean).join(' '),
            trim: c.trim,
            fuel: mapFuel(c.engine, ei.fuelText),
            engine: ei.engineSize || null,
            powerHp: ei.powerHp ?? null,
            transmission: /auto|tronic|dct|dsg|geartronic/i.test(`${ei.transmission || ''} ${c.engine}`) ? 'auto' : (/manual/i.test(ei.transmission || '') ? 'manual' : null),
            drive: mapDrive(c.engine),
            termMonths: term,
            initialMonths: up,
            annualMileage: mileage,
            monthlyIncVat: c.monthly,
            // carwow's "Initial payment" includes the dealer's fees; we split them out
            initialPaymentIncVat: initialInc != null ? +(initialInc - (c.fees || 0)).toFixed(2) : +(c.monthly * up).toFixed(2),
            totalInitialIncFees: initialInc,
            fees: c.fees ?? null,
            totalCost: c.total,
            stock: c.stock,
            delivery: null,
            options: packs,
            dealer: c.dealer,
            dealerType: c.dealerType,
            dealScore: c.dealScore,
            dealId: c.id,
            fetchedAt,
          });
          n++;
        }
      }
      log(`${m.id}: ${n} deals (${results.map(r => `${r.term}/${r.up}:${r.cards.length}`).join(' ')})`);
    } catch (e) {
      log(`${m.id} failed: ${e.message}`);
    }
  }
  return deals;
}
