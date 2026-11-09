// Shared scraper for brokers on the "Jacit MotorFinance" Laravel/Livewire platform
// (VIPGateway, Motorlet). Prices are server-rendered; the listing and derivative pages honour
// the same query string the site's own filters write:  ?type=personal&term=36&mileage=10000&initial=3
//
//   GET /car-leasing/{make}/{range}                         -> links to /car-leasing/{make}/{range}/{body}/{slug}
//   GET /car-leasing/{make}/{range}/{body}?type=personal&term=T&mileage=M&initial=I&page=N
//        -> 12 derivatives per page, each row = name, fuel, gearbox, personal monthly price (inc VAT);
//           each row's href carries the term/mileage/initial the price is for (checked against the request)
//   GET /car-leasing/{make}/{range}/{body}/{slug}?type=personal&term=..   (once per derivative)
//        -> arrangement / broker fee, BHP, list price / P11D, factory-order vs stock, delivery text
// No browser needed (plain fetch returns HTTP 200 with the full HTML).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DELAY_MS = 250;

// Which range / body pages belong to each configured model, and how to strip the name prefix.
export const JACIT_RULES = {
  'bmw-3-touring':  { make: 'bmw', ranges: ['3-series'], body: /^(estate|touring)$/, prefix: /^BMW\s+3 Series\s+(Touring|Estate)\s+/i },
  'bmw-x3':         { make: 'bmw', ranges: ['x3'], body: /^(suv|estate)$/, prefix: /^BMW\s+X3\s+(SUV\s+|Estate\s+)?/i },
  'merc-c-estate':  { make: 'mercedes-benz', ranges: ['c-class'], body: /^estate$/, prefix: /^Mercedes-Benz\s+C[ -]Class\s+Estate\s+/i },
  'volvo-xc60':     { make: 'volvo', ranges: ['xc60'], body: /^(suv|estate)$/, prefix: /^Volvo\s+XC60\s+(SUV\s+|Estate\s+)?/i },
  'audi-a5-avant':  { make: 'audi', ranges: ['a5'], body: /^(avant|estate)$/, prefix: /^Audi\s+A5\s+(Avant|Estate)\s+/i, deriv: d => !/^S5\b/i.test(d) },
  'audi-s5-avant':  { make: 'audi', ranges: ['a5', 's5'], body: /^(avant|estate)$/, prefix: /^Audi\s+[AS]5\s+(Avant|Estate)\s+/i, deriv: d => /^S5\b/i.test(d) },
  'audi-rs5-avant': { make: 'audi', ranges: ['rs5', 'rs-5'], body: /^(avant|estate)$/, prefix: /^Audi\s+RS\s?5\s+(Avant|Estate)\s+/i },
  // Polestar 4 SUV (Sept 2026) only: /polestar/4/suv; the original car is the /polestar/4/coupe body (VIPGateway) and is excluded
  // Motorlet also lists the Coupe under the "4 SUV" name and slug (same text, lower price), hence verifyTwins
  'polestar-4':     { make: 'polestar', ranges: ['4'], body: /^suv$/, prefix: /^Polestar\s+4\s+(SUV\s+)?/i, verifyTwins: true },
  'volvo-ex60':     { make: 'volvo', ranges: ['ex60'], body: /^(suv|estate)$/, prefix: /^Volvo\s+EX60\s+(SUV\s+|Estate\s+)?/i },
};

const decode = s => String(s || '')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&pound;/g, '£').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const money = s => { const n = parseFloat(String(s).replace(/[£,\s]/g, '')); return Number.isFinite(n) ? n : null; };

async function getHtml(url, ctx, tries = 3) {
  return (await getPage(url, ctx, tries))?.html ?? null;
}

async function getPage(url, ctx, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
      if (r.status === 404) return null;
      if (r.status === 403 || r.status === 429) throw new Error(`HTTP ${r.status} (blocked/rate-limited)`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text();
      await sleep(DELAY_MS);
      return { html, url: r.url || url };
    } catch (e) {
      last = e;
      if (/HTTP 403/.test(e.message)) break;
      await sleep(1500 * i);
    }
  }
  if (ctx?.context) {   // network-level failure: retry once via the browser's request context (proxy-aware)
    try { const r = await ctx.context.request.get(url, { timeout: 45000 }); if (r.ok()) return { html: await r.text(), url: r.url() }; } catch {}
  }
  throw last;
}

async function pool(items, n, fn) {
  const out = []; let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Body sub-pages ("estate", "suv", "avant") linked from a range page. */
async function bodiesOf(origin, make, range, ctx) {
  const html = await getHtml(`${origin}/car-leasing/${make}/${range}`, ctx);
  if (!html) return [];
  const re = new RegExp(`href="(?:${origin.replace(/[.]/g, '\\.')})?/car-leasing/${make}/${range}/([a-z0-9-]+)(?:[/"?])`, 'g');
  return [...new Set([...html.matchAll(re)].map(m => m[1]))];
}

/** Parse one listing page into rows. Handles both the VIPGateway and Motorlet row templates. */
function parseListing(html, origin, make, range, body) {
  const rows = [];
  const hrefRe = new RegExp(`<a\\s[^>]*?href="((?:${origin.replace(/[.]/g, '\\.')})?/car-leasing/${make}/${range}/${body}/([a-z0-9-]+)(\\?[^"]*)?)"([^>]*)>([\\s\\S]*?)</a>`, 'g');
  for (const m of html.matchAll(hrefRe)) {
    const [, href, slug, qs = '', attrs, inner] = m;
    const text = decode(inner);
    const params = new URLSearchParams((qs || '').replace(/^\?/, '').replace(/&amp;/g, '&'));
    // monthly personal price: VIP rows say "Personal From (inc VAT) £x" (cards: "Personal Lease 36 months, ... £x inc VAT");
    // Motorlet rows say "£x inc VAT".
    let price = null, initial = null, shownTerm = null;
    let pm = text.match(/Personal (?:From )?\(inc VAT\)\s*£([\d,]+\.\d\d)/) || text.match(/Personal Lease (\d+) months, [\d,]+ miles £([\d,]+\.\d\d) inc VAT/);
    if (pm) { price = money(pm[pm.length - 1]); if (pm.length === 3) shownTerm = +pm[1]; }
    else if (!/Business (Lease|From)/.test(text)) {
      pm = text.match(/£([\d,]+\.\d\d) initial payment £([\d,]+\.\d\d) inc VAT/);   // Motorlet card
      if (pm) { initial = money(pm[1]); price = money(pm[2]); }
      else { pm = text.match(/£([\d,]+\.\d\d) inc VAT/); if (pm) price = money(pm[1]); }
    }
    const ir = text.match(/Personal Lease[^£]*£[\d,.]+ inc VAT Initial rental: £([\d,]+\.\d\d)/);
    if (ir) initial = money(ir[1]);
    const tm = text.match(/\b(\d{2}) months?\b/); if (!shownTerm && tm) shownTerm = +tm[1];
    // name = first <p> in the row
    const name = decode((inner.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
    const ps = [...inner.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(x => decode(x[1]));
    const fuel = ps.find(p => /^(Diesel|Petrol|Electric|Hybrid|.*Plugin.*|.*Hybrid.*)$/i.test(p)) || null;
    const gearbox = ps.find(p => /^(Automatic|Manual)$/i.test(p)) || null;
    const key = (attrs.match(/wire:key="([^"]+)"/) || [])[1] || null;
    rows.push({ href: href.startsWith('http') ? href : origin + href, slug, params, name, fuel, gearbox, price, initial, shownTerm, key,
      stockBadge: /\bIn Stock\b/i.test(text), card: /Initial rental|initial payment/.test(text) });
  }
  return rows;
}

/** Facts from a derivative page that the listing lacks. */
function parseDerivative(html) {
  const t = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' '));
  const fee = t.match(/(?:Arrangement|Broker|Admin|Processing) [Ff]ee:?\s*£([\d,]+(?:\.\d\d)?)(?: inc VAT)?/);
  const noFee = /No (admin|arrangement|broker) fees?/i.test(t);
  const bhp = t.match(/Engine Power - BHP:?\s*(\d{2,4})/) || t.match(/\b(\d{3}) ?(?:bhp|BHP)\b/);
  const ps = t.match(/Engine Power - PS:?\s*(\d{2,4})/);
  const p11d = t.match(/P11[dD]:?\s*£([\d,]+(?:\.\d\d)?)/);
  const list = t.match(/List Price:?\s*£([\d,]+(?:\.\d\d)?)/);
  const factory = /Factory order/i.test(t);
  const lead = t.match(/(?:Lead time|Estimated delivery|Delivery time)[: ]+([^.]{3,40}?(?:weeks?|months?|days?))/i);
  const delivery = t.match(/Delivery:\s*(Free[^:]{0,40}?(?:\)|mainland))/);
  const title = (html.match(/<title>([^<]+)/) || [])[1];
  const mon = t.match(/Monthly Rental:\s*£([\d,]+\.\d\d)/);
  return {
    fees: fee ? money(fee[1]) : noFee ? 0 : null,
    feeLabel: fee ? fee[0].replace(/:?\s*£.*/, '').trim() : null,
    powerHp: bhp ? +bhp[1] : ps && +ps[1] > 50 ? Math.round(+ps[1] * 0.986) : null,
    p11d: p11d ? money(p11d[1]) : list ? money(list[1]) : null,
    factoryOrder: factory,
    delivery: [lead?.[1], delivery?.[1]].filter(Boolean).join('; ') || null,
    title: title ? decode(title) : null,
    monthly: mon ? money(mon[1]) : null,
  };
}

function mapFuel(f, name) {
  const s = `${f || ''}`.toLowerCase();
  if (/plugin|plug-in/.test(s)) return 'phev';
  if (/electric/.test(s) && !/hybrid/.test(s)) return 'bev';
  if (/hybrid/.test(s)) return 'mhev';
  if (/diesel/.test(s)) return 'diesel';
  if (/petrol/.test(s)) return /\bMHT\b|MHEV|mild/i.test(name) ? 'mhev' : 'petrol';
  if (/\d{3}e\b|\d{2}e\b|TFSI e\b|\bT[68]\b|PHEV|plug-in/i.test(name)) return 'phev';
  if (/\d{3}d\b|\bTDI\b|\bB\dD\b|diesel/i.test(name)) return 'diesel';
  // "Special Offer" rows leave the fuel cell blank; EV names carry motor kW + battery kWh ("200kW 100kWh Rear Motor")
  if (/\b\d{2,3}kW\s+\d{2,3}(\.\d)?kWh\b/i.test(name)) return 'bev';
  return null;
}
const driveOf = n => /xdrive|quattro|qtro|4matic|\bAWD\b|dual motor/i.test(n) ? 'awd' : /sdrive/i.test(n) ? 'rwd' : null;
const TRIMS = ['AMG Line Premium Plus', 'AMG Line Premium', 'AMG Line', 'Urban Edition', 'Premier Edition', 'Avantgarde', 'Exclusive', 'Sport',
  'M Sport Pro', 'M Sport', 'xLine', 'SE Pro', 'Plus Pro', 'Plus', 'Ultra', 'Core', 'Ultimate', 'Black Edition', 'Dark',
  'Edition 1', 'Launch Edition', 'Vorsprung', 'Black Edition', 'Carbon Black', 'Competition', 'Performance', 'S line', 'Technik', 'Sport'];
function guessTrim(name) {
  const hits = TRIMS.filter(t => new RegExp(`(^|\\s)${t.replace(/ /g, '\\s+')}(\\s|$)`, 'i').test(name));
  return hits.sort((a, b) => b.length - a.length)[0] || null;
}

/**
 * @param ctx  scraper ctx
 * @param site { id, origin, typeParam: true if the site wants &type=personal in URLs }
 */
export async function scrapeJacit(ctx, site) {
  const { models, log } = ctx;
  const mileage = ctx.mileage ?? 10000;
  const terms = ctx.terms ?? [24, 36, 48];
  const initials = ctx.initialMonths ?? [1, 3];
  const fetchedAt = new Date().toISOString();
  const deals = [];
  const t0 = Date.now();
  const budgetMs = 9 * 60 * 1000;

  for (const m of models) {
    const rule = JACIT_RULES[m.id];
    if (!rule) { log(`${m.id}: no mapping`); continue; }
    try {
      // 1. find the body pages for this model
      const pages = [];
      for (const range of rule.ranges) {
        const bodies = (await bodiesOf(site.origin, rule.make, range, ctx)).filter(b => rule.body.test(b));
        for (const b of bodies) pages.push({ range, body: b });
      }
      if (!pages.length) { log(`${m.id}: no matching range/body pages`); continue; }

      // 2. each (term, initial) config: walk the paginated listing
      const byVehicle = new Map();   // slug|rowKey -> { row, range, body, prices: Map('term|initial' -> monthly) }
      for (const { range, body } of pages) {
        // a range with a single body (e.g. Motorlet x3/suv) redirects to the range page and drops the
        // query string, so list from wherever the body URL lands
        const bodyUrl = `${site.origin}/car-leasing/${rule.make}/${range}/${body}`;
        const landed = await getPage(bodyUrl, ctx).catch(() => null);
        const listBase = landed?.url ? landed.url.split('?')[0].replace(/\/$/, '') : bodyUrl;
        for (const term of terms) for (const im of initials) {
          if (Date.now() - t0 > budgetMs) { log('time budget reached, stopping'); break; }
          const qs = `type=personal&term=${term}&mileage=${mileage}&initial=${im}`;
          const seen = new Set();
          for (let page = 1; page <= 15; page++) {
            const url = `${listBase}?${qs}${page > 1 ? `&page=${page}` : ''}`;
            const html = await getHtml(url, ctx);
            if (!html) break;
            const rows = parseListing(html, site.origin, rule.make, range, body).filter(r => r.price && r.name);
            let fresh = 0;
            for (const r of rows) {
              // row href must carry the config we asked for, otherwise the site substituted another one
              const p = r.params;
              if (p.get('term') && +p.get('term') !== term) continue;
              if (p.get('mileage') && +p.get('mileage') !== mileage) continue;
              if (p.get('initial') && +p.get('initial') !== im) continue;
              if (p.get('type') && p.get('type') !== 'personal') continue;
              if (r.shownTerm && r.shownTerm !== term) continue;
              // featured "cards" at the top repeat (cheapest) table rows; the table is the complete list
              if (r.card) continue;
              // same slug can appear twice (e.g. two model years); wire:key changes per config, so key on slug + fuel cell
              const id = `${r.slug}|${(r.fuel || '').toLowerCase()}`;
              if (seen.has(id)) {
                // verifyTwins: keep every price listed under this slug for this config; resolved in step 2b
                if (rule.verifyTwins && byVehicle.has(id)) {
                  const v = byVehicle.get(id), k = `${term}|${im}`;
                  v.alts ??= new Map();
                  v.alts.set(k, [...(v.alts.get(k) || [v.prices.get(k)]), r.price]);
                }
                continue;
              }
              seen.add(id); fresh++;
              if (!byVehicle.has(id)) byVehicle.set(id, { row: r, range, body, listBase, prices: new Map() });
              const v = byVehicle.get(id);
              v.prices.set(`${term}|${im}`, r.price);
              if (r.stockBadge) v.row.stockBadge = true;
              if (!v.row.fuel && r.fuel) v.row.fuel = r.fuel;
              if (!v.row.gearbox && r.gearbox) v.row.gearbox = r.gearbox;
            }
            if (!fresh || rows.length < 6) break;   // 12 per page; a short or repeated page is the last
          }
        }
      }

      // 2b. verifyTwins (opt-in per rule): the listing can show the same slug + name more than once with different
      // prices (Motorlet files Polestar 4 Coupe rows under the "4 SUV" name/slug); keep only the price the
      // derivative page itself shows for that config, drop the config if none matches.
      if (rule.verifyTwins) {
        let twins = 0;
        for (const v of byVehicle.values()) for (const [k, cands] of v.alts || []) {
          twins++;
          const [term, im] = k.split('|');
          const url = `${site.origin}/car-leasing/${rule.make}/${v.range}/${v.body}/${v.row.slug}?type=personal&term=${term}&mileage=${mileage}&initial=${im}`;
          let shown = null;
          try { const h = await getHtml(url, ctx); shown = h ? parseDerivative(h).monthly : null; } catch (e) { log(`${m.id} ${v.row.slug} ${k}: ${e.message}`); }
          if (shown != null && cands.includes(shown)) v.prices.set(k, shown);
          else { v.prices.delete(k); log(`${m.id} ${v.row.slug} ${k}: listing prices ${cands.join('/')} not confirmed by derivative page (${shown}) - dropped`); }
        }
        for (const [id, v] of byVehicle) if (!v.prices.size) byVehicle.delete(id);
        if (twins) log(`${m.id}: ${twins} slug/config pairs listed more than once, resolved against the derivative page`);
      }

      // 3. filter derivatives for this model (A5 vs S5) and enrich from one derivative page each
      const vehicles = [...byVehicle.values()].map(v => ({ ...v, derivative: v.row.name.replace(rule.prefix, '').trim() }))
        .filter(v => !rule.deriv || rule.deriv(v.derivative));
      const slugs = [...new Set(vehicles.map(v => v.row.slug))];
      const facts = new Map();
      await pool(slugs, 2, async slug => {
        if (Date.now() - t0 > budgetMs) return;
        const v = vehicles.find(x => x.row.slug === slug);
        const [cfg] = [...v.prices.keys()];
        const [term, im] = cfg.split('|');
        const url = `${site.origin}/car-leasing/${rule.make}/${v.range}/${v.body}/${slug}?type=personal&term=${term}&mileage=${mileage}&initial=${im}`;
        try { const h = await getHtml(url, ctx); if (h) facts.set(slug, { ...parseDerivative(h), cfg }); }
        catch (e) { log(`${m.id} ${slug}: derivative page failed ${e.message}`); }
      });

      let n0 = deals.length;
      for (const v of vehicles) {
        const f = facts.get(v.row.slug) || {};
        const name = v.derivative;
        // Two listing rows can share one slug (e.g. two model years); the derivative URL shows only one of
        // them. For the other, link the listing page that shows its price instead.
        const twin = vehicles.filter(x => x.row.slug === v.row.slug).length > 1;
        const onPage = !twin || !f.monthly || v.prices.get(f.cfg) === f.monthly;
        for (const [cfg, price] of v.prices) {
          const [term, im] = cfg.split('|').map(Number);
          const qs = `${site.typeParam ? 'type=personal&' : ''}term=${term}&mileage=${mileage}&initial=${im}`;
          deals.push({
            source: site.id, modelId: m.id,
            url: onPage ? `${site.origin}/car-leasing/${rule.make}/${v.range}/${v.body}/${v.row.slug}?${qs}`
              : `${v.listBase}?type=personal&term=${term}&mileage=${mileage}&initial=${im}`,
            ...(onPage ? {} : { note: 'second listing row sharing this derivative URL (other model year?); price shown on the listing page' }),
            make: m.make, model: m.model,
            derivative: name, siteName: v.row.name,
            trim: guessTrim(name),
            fuel: mapFuel(v.row.fuel, name),
            engine: (name.match(/\b(\d\.\d)\b/) || [])[1] || null,
            powerHp: f.powerHp ?? null,
            transmission: v.row.gearbox ? v.row.gearbox.toLowerCase().replace('automatic', 'auto') : (/auto|tronic|steptronic|geartronic|dct|dsg/i.test(name) ? 'auto' : null),
            drive: driveOf(name),
            termMonths: term, initialMonths: im, annualMileage: mileage,
            monthlyIncVat: price,
            initialPaymentIncVat: Math.round(price * im * 100) / 100,   // site: initial rental = N x monthly (fee separate)
            fees: f.fees ?? null,
            feeLabel: f.feeLabel ? `${f.feeLabel} (inc VAT, one-off)` : null,
            stock: v.row.stockBadge ? 'stock' : 'factory',
            delivery: f.delivery || (f.factoryOrder ? 'factory order - lead time on enquiry' : null),
            options: [...name.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]).filter(x => !/^\d+$/.test(x)),
            p11d: f.p11d ?? null,
            fetchedAt,
          });
        }
      }
      log(`${m.id}: ${pages.map(p => p.range + '/' + p.body).join(',')} -> ${vehicles.length} derivatives, ${deals.length - n0} deals`);
    } catch (e) {
      log(`${m.id}: FAILED ${e.message}`);
    }
  }
  return deals;
}
