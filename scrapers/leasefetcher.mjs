// LeaseFetcher (www.leasefetcher.co.uk) — broker-comparison site (Laravel + jQuery, behind Cloudflare CDN, no bot wall).
//
// Method (server-rendered HTML fragments the site's own jQuery requests):
//   1. Range pages are discovered from the sitemap https://www.leasefetcher.co.uk/deals.xml
//      e.g. /bmw/3-series/touring-deals, /bmw/x3/estate-deals, /mercedes-benz/c-class/estate-deals, /volvo/xc60/estate-deals
//   2. Trim list:  GET {rangeUrl}?initial_rental[]=3&term=36&mileage[]=10000&orderby=rental.asc&in_stock=0
//        with X-Requested-With: XMLHttpRequest  ->  {"html": "<trim cards…>"}   (personal pricing is the session default)
//   3. Per-trim broker offers: GET {data-trim-details url}?{same query}&code={trim code}  (XHR) -> HTML of broker offers
//
// NOTE (Nov 2026): every range page on the site currently returns "0 trims available / No Results Found" for both
// personal and business finance types, so this scraper returns no deals. The card/offer parsers below are generic
// (DOM heuristics run in a Playwright page via setContent) because no populated markup was available to study.

export const meta = { id: 'leasefetcher', name: 'LeaseFetcher', url: 'https://www.leasefetcher.co.uk', method: 'api', homeIpRecommended: false };

const SITE = 'https://www.leasefetcher.co.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const XHR = { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', Referer: SITE + '/' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Which sitemap range paths belong to each configured model.
const RANGES = {
  'bmw-3-touring':  [/^\/bmw\/3-series\/touring-deals$/],
  'bmw-x3':         [/^\/bmw\/x3\/[a-z0-9-]*-deals$/],
  'merc-c-estate':  [/^\/mercedes-benz\/c-class\/estate-deals$/, /^\/mercedes-benz\/c-class\/[a-z-]*estate[a-z-]*-deals$/],
  'volvo-xc60':     [/^\/volvo\/xc60\/[a-z0-9-]*-deals$/],
  // New (2024/25) A5 Avant replaced the A4 Avant; LF may still file it under /audi/a4/avant-deals.
  'audi-a5-avant':  [/^\/audi\/a5\/avant-deals$/, /^\/audi\/a4\/avant-deals$/],
  'audi-s5-avant':  [/^\/audi\/s5\/[a-z0-9-]*avant-deals$/, /^\/audi\/a5\/avant-deals$/, /^\/audi\/a4\/avant-deals$/],
  'audi-rs5-avant': [/^\/audi\/rs-?5\/[a-z0-9-]*avant-deals$/],
  // Polestar 4 SUV (Sept 2026): CAP-style sites file it as "4 Estate" (the original car is "4 Coupe"), so take
  // /polestar/4/estate-deals (in the sitemap, 0 trims as of Nov 2026) or a /suv-deals page; never a coupe page.
  'polestar-4':     [/^\/polestar\/4\/(estate|suv)-deals$/],
  // not listed as of Nov 2026 (/volvo/ex60/* 404, not in the sitemap)
  'volvo-ex60':     [/^\/volvo\/ex60\/[a-z0-9-]*-deals$/],
};
// derivative filters for ranges shared between configured models
const DERIV_FILTER = {
  'audi-a5-avant': d => !/\b(S5|S4|RS ?[45])\b/i.test(d),
  'audi-s5-avant': d => /\bS5\b/i.test(d),
};

async function get(url, ctx, { json = false, headers = XHR } = {}) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (r.status === 403 || r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (!json) return t;
      try { return JSON.parse(t); } catch { return { html: t }; }
    } catch (e) {
      if (i === 3 && ctx?.context) {
        try {
          const r = await ctx.context.request.get(url, { headers, timeout: 30000 });
          const t = await r.text();
          if (!json) return t;
          try { return JSON.parse(t); } catch { return { html: t }; }
        } catch {}
      }
      if (i === 3) throw e;
      await sleep(1500 * i);
    }
  }
}

const money = s => { const m = String(s || '').match(/£\s?([\d,]+(?:\.\d{1,2})?)/); return m ? +m[1].replace(/,/g, '') : null; };

// ---- DOM parsers (run inside a Playwright page) ----
function parseCardsInPage() {
  const txt = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const cards = [...document.querySelectorAll('[data-trim-card]')];
  return cards.map(c => {
    const h = c.querySelector('h1,h2,h3,h4,h5,[class*="title"],[class*="name"]');
    const tgl = c.querySelector('[data-toggle-trim-details]');
    const a = [...c.querySelectorAll('a[href]')].map(x => x.href).find(x => /leasefetcher\.co\.uk\/.+/.test(x) && !/#$/.test(x));
    return {
      name: txt(h), text: txt(c),
      code: tgl?.getAttribute('data-toggle-trim-details') || c.getAttribute('data-trim-card') || null,
      detailsUrl: tgl?.getAttribute('data-trim-details') || null,
      href: a || null,
    };
  });
}
function parseOffersInPage() {
  const txt = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const sel = '[data-deal],[class*="deal"],[class*="offer"],[class*="quote"],[class*="broker"],tr,li';
  let rows = [...document.querySelectorAll(sel)].filter(el => /£\s?\d/.test(txt(el)));
  // keep the innermost rows that still carry a price (drop wrappers that contain other candidate rows)
  rows = rows.filter(el => !rows.some(o => o !== el && el.contains(o)));
  return rows.map(el => {
    const img = el.querySelector('img[alt]');
    const named = el.querySelector('[class*="broker"],[class*="dealer"],[class*="provider"],[class*="company"],[class*="supplier"]');
    const a = [...el.querySelectorAll('a[href]')].map(x => x.href).find(x => !/#$/.test(x) && !x.startsWith('javascript')) || null;
    return { dealer: (img && img.getAttribute('alt')) || txt(named) || null, text: txt(el), href: a };
  });
}

function parseOfferText(t) {
  const monthly = (() => {
    const m = t.match(/£\s?([\d,]+\.\d{2})\s*(?:p\/?m|per month|\/mo|a month|monthly)/i) || t.match(/(?:monthly|per month)[^£]{0,40}£\s?([\d,]+\.\d{2})/i);
    return m ? +m[1].replace(/,/g, '') : money(t);
  })();
  const initial = (() => { const m = t.match(/initial[^£]{0,60}£\s?([\d,]+(?:\.\d{2})?)/i); return m ? +m[1].replace(/,/g, '') : null; })();
  const fee = (() => {
    const m = t.match(/(?:admin|arrangement|processing|documentation|doc|broker)\s*fee[^£]{0,40}£\s?([\d,]+(?:\.\d{2})?)/i);
    if (m) return +m[1].replace(/,/g, '');
    if (/no (?:admin|arrangement|processing) fee|(?:admin|arrangement) fee[:\s]*(?:free|£0|none)/i.test(t)) return 0;
    return null;
  })();
  const stock = /\bin stock\b/i.test(t) ? 'stock' : /factory order/i.test(t) ? 'factory' : /pre-?reg/i.test(t) ? 'prereg' : null;
  const dm = t.match(/(\d+\s*(?:-|–|to)\s*\d+\s*(?:weeks?|days?|months?)|\d+\s*(?:weeks?|days?|months?)\s*delivery)/i);
  return { monthly, initial, fee, stock, delivery: dm ? dm[1] : null };
}

function specFromName(d) {
  const s = d.toLowerCase();
  const fuel = /phev|kwh|plug-in|tfsi e\b|\d+ ?e\b|\bt[68]\b|recharge|hybrid/.test(s) ? (/mild|\bmht\b|\bb[3-6]\b/.test(s) ? 'mhev' : 'phev')
    : /\btdi\b|\d+d\b|diesel|\bb4d\b/.test(s) ? 'diesel' : /\bmht\b|mhev|\bb[3-6]p?\b/.test(s) ? 'mhev' : /tfsi|\d+i\b|petrol|\bxdrive20\b/.test(s) ? 'petrol' : null;
  const hp = (d.match(/\b(\d{3})\s?(?:ps|hp|bhp)?\b/) || [])[1];
  return {
    fuel,
    engine: (d.match(/\b(\d\.\d)\b/) || [])[1] || null,
    powerHp: hp ? +hp : null,
    transmission: /manual/i.test(d) ? 'manual' : /auto|tronic|steptronic|geartronic|tiptronic|dct|dsg/i.test(d) ? 'auto' : null,
    drive: /xdrive|quattro|qtro|awd|4matic|4x4/i.test(d) ? 'awd' : null,
  };
}

export async function scrape(ctx) {
  const { models, log } = ctx;
  const mileage = ctx.mileage || 10000;
  const terms = (ctx.terms || [24, 36, 48]);
  const initials = [...new Set([...(ctx.initialMonths || [1, 3]), 6])];
  const deals = [];

  // 1. discover range pages
  let paths = [];
  try {
    const xml = await get(SITE + '/deals.xml', ctx, { headers: { 'User-Agent': UA } });
    paths = [...(xml || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);
    log(`sitemap: ${paths.length} range pages`);
  } catch (e) { log('sitemap failed', e.message); }
  // the sitemap is incomplete (e.g. /bmw/x3/estate-deals exists but is not listed) — always add known/likely paths
  paths = [...new Set([...paths, '/bmw/3-series/touring-deals', '/bmw/x3/estate-deals', '/mercedes-benz/c-class/estate-deals',
    '/volvo/xc60/estate-deals', '/audi/a4/avant-deals', '/audi/a5/avant-deals', '/audi/s5/avant-deals', '/audi/rs5/rs-5-avant-deals'])];

  let page = null;
  const evalHtml = async (html, fn) => {
    if (!html || !ctx.context) return [];
    if (!page) page = await ctx.context.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return page.evaluate(fn);
  };

  try {
    for (const m of models) {
      try {
        const pats = RANGES[m.id] || [];
        let ranges = paths.filter(p => pats.some(re => re.test(p)));
        if (!ranges.length) { log(`${m.id}: no range page on LeaseFetcher`); continue; }
        const n0 = deals.length;
        for (const rp of ranges) {
          const rangeUrl = SITE + rp;
          // cheap probe: unfiltered list — skip the 9 filtered requests if the range has no trims at all
          const probe = await get(rangeUrl + '?in_stock=0', ctx, { json: true });
          await sleep(400);
          const probeHtml = probe?.html || '';
          if (!probeHtml || /no-results/.test(probeHtml) && !/data-trim-card/.test(probeHtml)) { log(`${m.id}: ${rp} -> 0 trims available`); continue; }

          for (const term of terms) for (const im of initials) {
            const q = `initial_rental%5B%5D=${im}&term=${term}&mileage%5B%5D=${mileage}&orderby=rental.asc&in_stock=0`;
            const listUrl = `${rangeUrl}?${q}`;
            let cards = [];
            try {
              const j = await get(listUrl, ctx, { json: true });
              cards = await evalHtml(j?.html, parseCardsInPage);
            } catch (e) { log(`${m.id} ${rp} ${term}/${im}: list failed ${e.message}`); }
            await sleep(400);
            for (const c of cards) {
              const derivative = c.name || c.text.slice(0, 80);
              if (DERIV_FILTER[m.id] && !DERIV_FILTER[m.id](derivative)) continue;
              const spec = specFromName(derivative);
              let offers = [];
              if (c.detailsUrl && c.code) {
                try {
                  const sep = c.detailsUrl.includes('?') ? '&' : '?';
                  const dres = await get(`${c.detailsUrl}${sep}${q}&code=${encodeURIComponent(c.code)}`, ctx, { json: true });
                  offers = await evalHtml(dres?.html, parseOffersInPage);
                } catch (e) { log(`${m.id} details ${c.code}: ${e.message}`); }
                await sleep(400);
              }
              if (!offers.length) offers = [{ dealer: null, text: c.text, href: c.href }];
              for (const o of offers) {
                const p = parseOfferText(o.text);
                if (!p.monthly) continue;
                deals.push({
                  source: meta.id, modelId: m.id,
                  url: o.href || c.href || listUrl.replace(/&orderby=[^&]+/, ''),
                  make: m.make, model: m.model,
                  derivative, trim: null, ...spec,
                  termMonths: term, initialMonths: im, annualMileage: mileage,
                  monthlyIncVat: p.monthly,
                  initialPaymentIncVat: p.initial,
                  fees: p.fee,
                  dealer: o.dealer,
                  stock: p.stock, delivery: p.delivery, options: [],
                  rangePath: rp,
                  fetchedAt: new Date().toISOString(),
                });
              }
            }
          }
        }
        log(`${m.id}: ${deals.length - n0} deals`);
      } catch (e) { log(`${m.id}: FAILED ${e.message}`); }
    }
  } finally {
    if (page) await page.close().catch(() => {});
  }
  return deals;
}
