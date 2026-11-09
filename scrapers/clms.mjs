// Car Leasing Made Simple (www.carleasingmadesimple.com) — server-rendered HTML, no browser needed.
//
//   GET /car-leasing/{make}/{range}/            (range = "3-series-touring", "x3-estate", "a5-avant", ...)
//        -> one <tr class="tr-vehicle"> per derivative: name, fuel, gearbox, data-personal-rate ("from"),
//           data-personal-rate > 0 when personal rates exist (0 = "Prices coming soon"/POA), stock tags
//   GET /car-leasing/{make}/{range}/{id}/?c=1   (personal view of the derivative)
//        -> #derivative-contract-table: EVERY rate the site has, one <tr> per
//           rental type (data-rentaltype 1 = Personal) x profile (1+/3+/6+/9+/12+) x term x mileage (data-mileage in
//           thousands) x maintenance. Personal cells are shown inc VAT (data-rate is ex VAT, data-vatrate 1.2).
// So one GET per derivative yields all terms / upfronts at 10k miles. Site states "No admin, document, or set-up fees".

export const meta = { id: 'clms', name: 'Car Leasing Made Simple', url: 'https://www.carleasingmadesimple.com', method: 'api', homeIpRecommended: false };

const SITE = 'https://www.carleasingmadesimple.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const DELAY_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RULES = {
  'bmw-3-touring':  { make: 'bmw', ranges: /^3-series-(diesel-)?touring(-special-edition)?$/ },
  'bmw-x3':         { make: 'bmw', ranges: /^x3-(diesel-)?estate(-special-edition)?$/ },
  'merc-c-estate':  { make: 'mercedes-benz', ranges: /^c-class-(amg-|diesel-)?estate(-special-edition)?$/ },
  'volvo-xc60':     { make: 'volvo', ranges: /^xc60-(diesel-)?estate(-special-edition)?$/ },
  'audi-a5-avant':  { make: 'audi', ranges: /^a5-(diesel-)?avant(-special-edition)?$/, deriv: d => !/^S5\b/i.test(d) },
  'audi-s5-avant':  { make: 'audi', ranges: /^(a5|s5)-(diesel-)?avant(-special-edition)?$/, deriv: d => /^S5\b/i.test(d) },
  'audi-rs5-avant': { make: 'audi', ranges: /^rs-?5-avant$/ },
  // Polestar 4 SUV (Sept 2026, MRP from £54,750) is the "4 ESTATE" range; the original car is "4-coupe"/"4-coupe_2" (excluded)
  'polestar-4':     { make: 'polestar', ranges: /^4-estate(-special-edition)?$/ },
  'volvo-ex60':     { make: 'volvo', ranges: /^ex60-estate(-special-edition)?$/ },
};

const decode = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&pound;/g, '£').replace(/&amp;/g, '&')
  .replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&dagger;/g, '').replace(/\s+/g, ' ').trim();
const money = s => { const n = parseFloat(String(s).replace(/[£,\s*]/g, '')); return Number.isFinite(n) ? n : null; };
const attr = (s, name) => (s.match(new RegExp(`data-${name}="([^"]*)"`)) || [])[1];

async function getHtml(url, ctx, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(45000) });
      if (r.status === 404) return null;
      if (r.status === 403 || r.status === 429) throw new Error(`HTTP ${r.status} (blocked/rate-limited)`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // pages are mostly UTF-8 but contain stray cp1252 bytes; decode leniently
      const buf = Buffer.from(await r.arrayBuffer());
      await sleep(DELAY_MS);
      return new TextDecoder('utf-8', { fatal: false }).decode(buf);
    } catch (e) { last = e; if (/403/.test(e.message)) break; await sleep(1500 * i); }
  }
  if (ctx?.context) { try { const r = await ctx.context.request.get(url, { timeout: 45000 }); if (r.ok()) return await r.text(); } catch {} }
  throw last;
}

async function pool(items, n, fn) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i], i); }
  }));
}

function parseRange(html, make, range) {
  const out = [];
  for (const m of html.matchAll(/<tr class="tr-vehicle"([\s\S]*?)>([\s\S]*?)<\/tr>/g)) {
    const [, attrs, inner] = m;
    const path = attr(attrs, 'personal-path') || attr(attrs, 'business-path');
    if (!path || !path.startsWith(`/car-leasing/${make}/${range}/`)) continue;
    const name = decode((inner.match(/<a [^>]*title="Lease the[^"]*">([\s\S]*?)<\/a>/) || [])[1]);
    const cell = l => decode((inner.match(new RegExp(`data-label="${l}"[^>]*>([\\s\\S]*?)</td>`)) || [])[1]);
    const tags = [...inner.matchAll(/name-tags-stock personal-tag">[\s\S]*?title="([^"]*)">([^<]+)</g)].map(x => ({ label: x[2].trim(), title: x[1] }));
    out.push({
      path: path.replace(/\?c=\d$/, '?c=1'), name,
      mrp: money(cell('MRP')), fuel: cell('Fuel Type'), gearbox: cell('Gearbox'),
      personal: attr(attrs, 'personal-contract') === '1' && money(attr(attrs, 'personal-rate')) > 0, fromRate: money(attr(attrs, 'personal-rate')),
      drivetrain: attr(attrs, 'drivetrain'), tags,
    });
  }
  return out;
}

function parseMatrix(html) {
  const rows = [];
  const table = (html.match(/<table id="derivative-contract-table"[\s\S]*?<\/table>/) || [])[0] || '';
  for (const m of table.matchAll(/<tr ([^>]*data-rentaltype[^>]*)>([\s\S]*?)<\/tr>/g)) {
    const [, a, inner] = m;
    const tds = [...inner.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => decode(x[1]));
    rows.push({
      personal: attr(a, 'rentaltype') === '1',
      term: +attr(a, 'term'), mileage: +attr(a, 'mileage') * 1000, profile: +attr(a, 'profile'),
      maintained: attr(a, 'maintenance') === '1',
      // displayed (inc VAT for personal) base-rate cells: initial, monthly
      initial: money(tds[6]), monthly: money(tds[7]),
      exVat: +attr(a, 'rate'), vat: +attr(a, 'vatrate'),
      promo: attr(a, 'ispromotion') === '1', stock: attr(a, 'isstock') === '1' || attr(a, 'ispromotionstock') === '1',
    });
  }
  return rows;
}

function mapFuel(f, name) {
  const s = String(f || '').toLowerCase();
  if (/plug/.test(s)) return 'phev';
  if (/electric/.test(s) && !/hybrid/.test(s)) return 'bev';
  if (/hybrid/.test(s)) return /\bMHT\b|mild|MHEV/i.test(name) ? 'mhev' : 'hybrid';
  if (/diesel/.test(s)) return /\bMHT\b|mild|MHEV/i.test(name) ? 'mhev' : 'diesel';
  if (/petrol/.test(s)) return /\bMHT\b|mild|MHEV/i.test(name) ? 'mhev' : 'petrol';
  return null;
}
const driveOf = (n, dt) => /xdrive|quattro|qtro|4matic|\bAWD\b|dual motor/i.test(n) || dt === '3' ? 'awd' : /sdrive/i.test(n) ? 'rwd' : null;
const TRIMS = ['M Sport Pro', 'M Sport', 'xLine', 'Sport', 'AMG Line Premium Plus', 'AMG Line Premium', 'AMG Line', 'Urban Edition',
  'Plus Pro', 'Plus', 'Ultra', 'Core', 'Ultimate', 'Dark', 'Black Edition', 'Edition 1', 'Launch Edition', 'Vorsprung', 'Carbon Black',
  'Competition', 'Performance', 'S line', 'Technik', 'Sport', 'R-Design', 'Inscription', 'Momentum'];
const guessTrim = n => TRIMS.filter(t => new RegExp(`(^|\\s)${t.replace(/ /g, '\\s+')}(\\s|$)`, 'i').test(n)).sort((a, b) => b.length - a.length)[0] || null;

export async function scrape(ctx) {
  const { models, log } = ctx;
  const mileage = ctx.mileage ?? 10000;
  const terms = ctx.terms ?? [24, 36, 48];
  const initials = new Set([...(ctx.initialMonths ?? [1, 3]), 6]);   // 6 is free (same page); pipeline filters
  const fetchedAt = new Date().toISOString();
  const deals = [];
  const makePages = new Map();
  const t0 = Date.now();

  for (const m of models) {
    const rule = RULES[m.id];
    if (!rule) { log(`${m.id}: no mapping`); continue; }
    try {
      if (!makePages.has(rule.make)) makePages.set(rule.make, await getHtml(`${SITE}/car-leasing/${rule.make}/`, ctx) || '');
      const ranges = [...new Set([...makePages.get(rule.make).matchAll(new RegExp(`href="/car-leasing/${rule.make}/([a-z0-9_-]+)/"`, 'g'))].map(x => x[1]))]
        .filter(r => rule.ranges.test(r));
      if (!ranges.length) { log(`${m.id}: no matching range on site`); continue; }

      const derivs = [];
      for (const range of ranges) {
        const html = await getHtml(`${SITE}/car-leasing/${rule.make}/${range}/`, ctx);
        if (!html) continue;
        for (const d of parseRange(html, rule.make, range)) if (!rule.deriv || rule.deriv(d.name)) derivs.push({ ...d, range });
      }
      const priced = derivs.filter(d => d.personal);
      log(`${m.id}: ${ranges.join(',')} -> ${derivs.length} derivatives, ${priced.length} with personal prices${priced.length < derivs.length ? ` (${derivs.length - priced.length} POA / "prices coming soon")` : ''}`);

      const n0 = deals.length;
      await pool(priced, 2, async d => {
        if (Date.now() - t0 > 9 * 60 * 1000) return;
        try {
          const html = await getHtml(SITE + d.path, ctx);
          if (!html) return;
          const rows = parseMatrix(html).filter(r => r.personal && !r.maintained && r.mileage === mileage && terms.includes(r.term) && initials.has(r.profile) && r.monthly);
          const hdr = decode((html.match(/<div id="derivative-fixed-vehicle">[\s\S]*?<span>([\s\S]*?)<\/span>/) || [])[1]) || d.name;
          const p11d = money((html.match(/data-originalp11d="([\d.]+)"/) || [])[1]);
          const noFees = /No (admin, document, or set-up|document or set-up) fees/i.test(html);
          const stockTag = d.tags.find(t => /in.?stock/i.test(t.label));
          const dueTag = d.tags.find(t => /^due/i.test(t.label));
          // keep one row per (term, profile): promotional rate if present, else standard
          const best = new Map();
          for (const r of rows) {
            const k = `${r.term}|${r.profile}`;
            if (!best.has(k) || r.monthly < best.get(k).monthly) best.set(k, r);
          }
          for (const r of best.values()) {
            deals.push({
              source: meta.id, modelId: m.id,
              url: SITE + d.path,
              make: m.make, model: m.model,
              derivative: hdr, trim: guessTrim(hdr),
              fuel: mapFuel(d.fuel, hdr),
              engine: (hdr.match(/\b(\d\.\d)\b/) || [])[1] || null,
              powerHp: null,
              transmission: /auto/i.test(d.gearbox) ? 'auto' : /manual/i.test(d.gearbox) ? 'manual' : null,
              drive: driveOf(hdr, d.drivetrain),
              termMonths: r.term, initialMonths: r.profile, annualMileage: mileage,
              monthlyIncVat: r.monthly,
              initialPaymentIncVat: r.initial,
              fees: noFees ? 0 : null,
              stock: stockTag || r.stock ? 'stock' : 'factory',
              delivery: stockTag ? stockTag.title : dueTag ? dueTag.title : null,
              options: [...hdr.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]),
              p11d: p11d || d.mrp || null,
              promo: r.promo,
              fetchedAt,
            });
          }
        } catch (e) { log(`${m.id} ${d.path}: ${e.message}`); }
      });
      log(`${m.id}: ${deals.length - n0} deals`);
    } catch (e) {
      log(`${m.id}: FAILED ${e.message}`);
    }
  }
  return deals;
}
