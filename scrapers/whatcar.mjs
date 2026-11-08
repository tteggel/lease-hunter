// What Car? new-car leasing deals (www.whatcar.com/new-car-leasing-deals/{make}/{model}/{body}) — server-rendered Drupal
// view ("make_model_deals"), parsed from HTML with plain HTTP. All prices come from What Car?'s partner Autotrader
// ("In partnership with Autotrader"): one indicative personal-lease example per derivative, at whatever profile Autotrader
// quotes (typically 5–6k miles, 48–60 months, 12 months upfront) — the page has no mileage/term/upfront selectors, so
// rows are recorded with the profile they actually show (the pipeline filters on mileage/term/upfront).
// Card fields: title, Engine, Trim, fuel/gearbox/doors, "£x per month", "£A total upfront (£B initial rental plus £C
// processing fee) | N miles | M months", info table "Deposit months", and a "View deal" link to autotrader.co.uk.
// Derivatives without a lease quote show "Call Now" only and are skipped (logged).
// Note: from the cloud box, CloudFront/AWS WAF answers 403 "Request blocked" to both headless Chromium and Node's fetch,
// so homeIpRecommended. This module only makes plain HTTP GETs of the public page and stops at the first 403/challenge
// (it does not try to get around the block).

export const meta = { id: 'whatcar', name: 'What Car? Leasing', url: 'https://www.whatcar.com/new-car-leasing-deals', method: 'html', homeIpRecommended: true };

const SITE = 'https://www.whatcar.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Leasing page paths per configured model (first that returns cards wins; all are tried so body variants merge).
const PATHS = {
  'bmw-3-touring':  ['bmw/3-series/estate'],
  'bmw-x3':         ['bmw/x3/suv'],
  'merc-c-estate':  ['mercedes-benz/c-class/estate'],
  'volvo-xc60':     ['volvo/xc60/suv'],
  'audi-a5-avant':  ['audi/a5-avant/estate'],
  'audi-s5-avant':  ['audi/s5-avant/estate'],
  'audi-rs5-avant': ['audi/rs5-avant/estate'],
};
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const text = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const money = s => s == null ? null : Number(String(s).replace(/[£,\s]/g, '')) || null;

class Blocked extends Error {}

async function getPage(url) {
  for (let i = 1; i <= 2; i++) {
    let r;
    try { r = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (i === 2) throw e; await sleep(2000); continue; }
    const html = await r.text();
    if (r.status === 404) return null;
    if (r.status === 403 || r.status === 405 || r.status === 202 || r.status === 429 || /<title>[^<]*(request could not be satisfied|Human Verification|Access Denied)/i.test(html))
      throw new Blocked(`HTTP ${r.status} (verification/block page)`);
    if (r.ok) return html;
    if (i === 2) throw new Error('HTTP ' + r.status);
    await sleep(2000);
  }
}

function fuelOf(fuelLabel, title) {
  const f = (fuelLabel || '').toLowerCase();
  if (/plug-in/.test(f)) return 'phev';
  if (/electric/.test(f) && !/hybrid/.test(f)) return 'bev';
  if (/diesel/.test(f)) return /hybrid/.test(f) || /\bMHT\b|MHEV|mild/i.test(title) ? 'mhev' : 'diesel';
  if (/hybrid/.test(f)) return /\bMHT\b|MHEV|mild|\bB[3-6]\b|C\d{3}h|\bT\d mhev/i.test(title) ? 'mhev' : 'hybrid';
  if (/petrol/.test(f)) return /\bMHT\b|MHEV|mild/i.test(title) ? 'mhev' : 'petrol';
  return null;
}

function parseCards(html) {
  const out = [];
  for (const [, c] of html.matchAll(/<article class="mmd-card leasingCard">([\s\S]*?)<\/article>/g)) {
    const title = text((c.match(/mmd-card-title">([\s\S]*?)<\/div>/) || [])[1] || '');
    const engine = text((c.match(/<strong>Engine:<\/strong>([\s\S]*?)<\/div>/) || [])[1] || '') || null;
    const trim = text((c.match(/<strong>Trim:<\/strong>([\s\S]*?)<\/div>/) || [])[1] || '') || null;
    const specs = [...((c.match(/<ul class="mmd-card-specs">([\s\S]*?)<\/ul>/) || [])[1] || '').matchAll(/<li>([\s\S]*?)<\/li>/g)].map(x => text(x[1]));
    const pers = (c.match(/leasingCard__personalLeasePrice([\s\S]*?)(?=leasingCard__businessLeasePrice|<span class="leasingCard__divider">)/) || [])[1];
    const link = c.match(/<a\s[^>]*data-bi="autotrader-click"[^>]*>/);
    const attr = n => link ? decode((link[0].match(new RegExp(`\\b${n}="([^"]*)"`)) || [])[1] || '') || null : null;
    const card = { title, engine, trim, specs, dealUrl: attr('href'), atDerivative: attr('derivative'), generation: attr('generation') };
    if (pers) {
      const cell = label => { const m = pers.match(new RegExp(`<td>\\s*${label}\\s*</td>\\s*<td>([^<]*)</td>`, 'i')); return m ? text(m[1]) : null; };
      const pay = text((pers.match(/leasingCard__payments">([\s\S]*?)<\/p>/) || [])[1] || '');
      card.monthly = money((pers.match(/leasingCard__LeaseMainPrice">([^<]*)</) || [])[1]) || money(cell('Monthly payment'));
      card.initial = money((pay.match(/£([\d,.]+) initial rental/) || [])[1]) || money(cell('Initial payment'));
      const fee = pay.match(/£([\d,.]+) (?:processing|admin|arrangement|documentation) fee/i);
      card.fees = fee ? money(fee[1]) : (/no (?:admin|processing|arrangement) fee/i.test(pay) ? 0 : null);
      card.mileage = money((pay.match(/([\d,]+) miles/) || [])[1]) || money(cell('Expected annual mileage'));
      card.term = money((pay.match(/(\d+) months/) || [])[1]) || money(cell('Term months'));
      card.upfrontMonths = money(cell('Deposit months')) || (card.initial && card.monthly ? Math.round(card.initial / card.monthly) : null);
    }
    out.push(card);
  }
  return out;
}

export async function scrape(ctx) {
  const { models, log } = ctx;
  const deals = [];
  for (const m of models) {
    try {
      const paths = PATHS[m.id] || [`${slug(m.make)}/${slug(m.model)}/estate`];
      const seen = new Set();
      let listed = 0, unpriced = 0;
      for (const p of paths) {
        const url = `${SITE}/new-car-leasing-deals/${p}`;
        const html = await getPage(url);
        await sleep(1200);
        if (!html) { log(`${m.id}: ${p} -> 404`); continue; }
        const cards = parseCards(html);
        listed += cards.length;
        for (const c of cards) {
          if (seen.has(c.title)) continue; seen.add(c.title);
          if (!c.monthly || !c.term) { unpriced++; continue; }
          const [fuelLabel, gearbox] = c.specs;
          deals.push({
            source: meta.id, modelId: m.id,
            url: c.trim ? `${url}?trim=${encodeURIComponent(c.trim)}` : url,
            dealUrl: c.dealUrl,
            dealer: 'Autotrader',
            make: m.make, model: m.model,
            derivative: c.title, trim: c.trim,
            fuel: fuelOf(fuelLabel, c.title),
            engine: c.engine ? (Number(c.engine.replace(/L$/i, '')) || 0).toFixed(1) : null,
            powerHp: null,
            transmission: /auto/i.test(gearbox || '') ? 'auto' : /manual/i.test(gearbox || '') ? 'manual' : null,
            drive: /xdrive|quattro|awd|4matic|all-wheel/i.test(c.title) ? 'awd' : null,
            termMonths: c.term, initialMonths: c.upfrontMonths, annualMileage: c.mileage,
            monthlyIncVat: c.monthly,
            initialPaymentIncVat: c.initial,
            fees: c.fees,
            stock: null, delivery: null,
            options: [],
            generation: c.generation,
            indicative: true,
            fetchedAt: new Date().toISOString(),
          });
        }
      }
      const mine = deals.filter(d => d.modelId === m.id);
      const profiles = [...new Set(mine.map(d => `${d.annualMileage}mi/${d.termMonths}m/${d.initialMonths}up`))];
      log(`${m.id}: ${listed} derivatives listed, ${mine.length} with a personal-lease quote${unpriced ? `, ${unpriced} without (Call Now only)` : ''}${profiles.length ? ' — profiles ' + profiles.join(', ') : ''}`);
    } catch (e) {
      if (e instanceof Blocked) { log(`STOP: ${e.message} on ${m.id} — not retrying What Car?`); break; }
      log(`${m.id}: FAILED ${e.message}`);
    }
  }
  return deals;
}
