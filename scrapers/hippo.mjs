// Hippo Leasing (www.hippoleasing.co.uk) — uses the JSON price endpoint the site's own derivative page calls.
//
//   GET  /car-leasing/{make}/{range}/                 -> links /car-leasing/{make}/{range}/{model}/{derivSlug}/[used/]
//        (model = "3-series-touring", "x3-estate", "a5-avant" ...; "/used/" = used-car leases, skipped)
//   GET  /car-leasing/.../{derivSlug}/                -> Laravel session cookie + hidden quote-form inputs (_token, car_id, stock ...)
//   POST /api/car/price/{car_id}   multipart form (same fields the page's JS sends: _token, car_id, term, mileage,
//        profile, type=personal ...) with the session cookie + X-CSRF-TOKEN
//        -> { term, mileage, type:'Personal', vat:'including VAT', fee:'330.00' (admin fee inc VAT),
//             payment_profiles: { '1': {monthly_rental, initial_payment}, '3': {...}, ... '12' },
//             get_derivative: { name, fuel_type, transmission, in_stock, stock_delivery, list_price, ... } }
// One POST per term returns every upfront (1..12 months) for that term/mileage.

export const meta = { id: 'hippo', name: 'Hippo Leasing', url: 'https://www.hippoleasing.co.uk', method: 'api', homeIpRecommended: false };

const SITE = 'https://www.hippoleasing.co.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const DELAY_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RULES = {
  'bmw-3-touring':  { make: 'bmw', ranges: ['3-series'], models: /^3-series-(diesel-)?touring/ },
  'bmw-x3':         { make: 'bmw', ranges: ['x3'], models: /^x3-(diesel-)?estate/ },
  'merc-c-estate':  { make: 'mercedes-benz', ranges: ['c-class'], models: /^c-class-(diesel-|amg-|hybrid-)?estate/ },
  'volvo-xc60':     { make: 'volvo', ranges: ['xc60'], models: /^xc60-(diesel-)?estate/ },
  'audi-a5-avant':  { make: 'audi', ranges: ['a5'], models: /^a5-(diesel-)?avant/, deriv: s => !/^s5-/.test(s) },
  'audi-s5-avant':  { make: 'audi', ranges: ['a5', 's5'], models: /^(a5|s5)-(diesel-)?avant/, deriv: s => /^s5-/.test(s) },
  'audi-rs5-avant': { make: 'audi', ranges: ['a5', 'rs5', 'rs-5'], models: /^(a5|rs-?5)-avant/, deriv: s => /^rs-?5-/.test(s) },
  // range "4" has model "4-estate" (the new 2026 4 SUV) and "4-coupe" (original car, excluded)
  'polestar-4':     { make: 'polestar', ranges: ['4'], models: /^4-estate/ },
  'volvo-ex60':     { make: 'volvo', ranges: ['ex60'], models: /^ex60-estate/ },
};

// tiny cookie jar (the price endpoint needs the Laravel session that issued the CSRF token)
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function keepCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
}

async function req(url, opts = {}, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9', Cookie: cookieHeader(), ...(opts.headers || {}) }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
      keepCookies(r);
      if (r.status === 404) return null;
      if (r.status === 403 || r.status === 429) throw new Error(`HTTP ${r.status} (blocked/rate-limited)`);
      if (r.status === 419) throw new Error('HTTP 419 (CSRF/session expired)');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = await r.text();
      await sleep(DELAY_MS);
      return body;
    } catch (e) { last = e; if (/403/.test(e.message)) break; await sleep(1500 * i); }
  }
  throw last;
}

async function pool(items, n, fn) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i], i); }
  }));
}

const hiddenInputs = html => {
  const out = {};
  const form = (html.match(/<form id="quote-form"[\s\S]*?<\/form>/) || [])[0] || html;
  for (const m of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = (m[0].match(/name="([^"]+)"/) || [])[1];
    const value = (m[0].match(/value="([^"]*)"/) || [])[1] ?? '';
    if (name && !(name in out)) out[name] = value.replace(/&amp;/g, '&');
  }
  return out;
};

function mapFuel(f, name) {
  const s = String(f || '').toLowerCase();
  if (/plug|phev/.test(s) || /\d{3}e\b|\bxdrive\s?\d{2}e\b|\d{2}e\b|TFSI e\b|\bT[68]\b|PHEV|kwh/i.test(name)) return /electric$/.test(s) ? 'bev' : 'phev';
  if (/electric/.test(s) && !/hybrid/.test(s)) return 'bev';
  if (/\bMHT\b|mild|MHEV|\bB[3-6]P?\b/i.test(name) && !/diesel/.test(s)) return 'mhev';
  if (/diesel/.test(s)) return 'diesel';
  if (/hybrid/.test(s)) return 'hybrid';
  if (/petrol/.test(s)) return 'petrol';
  return null;
}
const driveOf = n => /xdrive|quattro|qtro|4matic|\bAWD\b/i.test(n) ? 'awd' : /sdrive/i.test(n) ? 'rwd' : null;
const TRIMS = ['M Sport Pro', 'M Sport', 'xLine', 'SE Pro', 'Sport', 'AMG Line Premium Plus', 'AMG Line Premium', 'AMG Line',
  'Plus Pro', 'Plus Black Edition', 'Plus Dark', 'Plus', 'Ultra', 'Core', 'Ultimate', 'Dark', 'Black Edition', 'Edition 1', 'Launch Edition',
  'Vorsprung', 'Carbon Black', 'Competition', 'Performance', 'S line', 'Technik', 'R-Design', 'R DESIGN Pro', 'R DESIGN', 'Inscription', 'Momentum'];
const guessTrim = n => TRIMS.filter(t => new RegExp(`(^|\\s)${t.replace(/ /g, '\\s+')}(\\s|$)`, 'i').test(n)).sort((a, b) => b.length - a.length)[0] || null;

export async function scrape(ctx) {
  const { models, log } = ctx;
  const mileage = ctx.mileage ?? 10000;
  const terms = ctx.terms ?? [24, 36, 48];
  const initials = [...new Set([...(ctx.initialMonths ?? [1, 3]), 6])];
  const fetchedAt = new Date().toISOString();
  const deals = [];
  const rangeHtml = new Map();
  const t0 = Date.now();

  for (const m of models) {
    const rule = RULES[m.id];
    if (!rule) { log(`${m.id}: no mapping`); continue; }
    try {
      // 1. derivative links (new cars only)
      const links = new Map();
      let usedSkipped = 0;
      for (const range of rule.ranges) {
        const key = `${rule.make}/${range}`;
        if (!rangeHtml.has(key)) rangeHtml.set(key, await req(`${SITE}/car-leasing/${key}/`).catch(() => null) || '');
        const re = new RegExp(`href="(?:${SITE.replace(/\./g, '\\.')})?/car-leasing/${rule.make}/${range}/([a-z0-9-]+)/([a-z0-9-]+)/(used/)?`, 'g');
        for (const x of rangeHtml.get(key).matchAll(re)) {
          const [, model, slug, used] = x;
          if (!rule.models.test(model) || (rule.deriv && !rule.deriv(slug))) continue;
          if (used) { usedSkipped++; continue; }
          links.set(`/car-leasing/${rule.make}/${range}/${model}/${slug}/`, { model, slug });
        }
      }
      if (!links.size) { log(`${m.id}: no new-car derivatives listed${usedSkipped ? ` (${usedSkipped} used-car links skipped)` : ''}`); continue; }
      log(`${m.id}: ${links.size} derivatives (${usedSkipped} used-car links skipped)`);

      // 2. each derivative: load page (session + form), then one price POST per term
      const n0 = deals.length;
      await pool([...links.keys()], 2, async path => {
        if (Date.now() - t0 > 9 * 60 * 1000) return;
        try {
          const html = await req(`${SITE}${path}?term=36&mileage=${mileage}&profile=3`, { headers: { Accept: 'text/html' } });
          if (!html) return;
          const form = hiddenInputs(html);
          if (!form.car_id || !form._token) { log(`${path}: no quote form`); return; }
          for (const term of terms) {
            const fd = new FormData();
            const fields = { ...form, enquiry_type: form.enquiry_type || 'Quote Request', maintenance: 'no', options_total: '0',
              term: String(term), mileage: String(mileage), profile: '3', initial_profile: '3', type: 'personal', deal_type: 'Personal' };
            for (const [k, v] of Object.entries(fields)) fd.append(k, v ?? '');
            const body = await req(`${SITE}/api/car/price/${form.car_id}`, {
              method: 'POST', body: fd,
              headers: { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-TOKEN': form._token, Origin: SITE, Referer: SITE + path },
            }).catch(e => { log(`${path} ${term}m: ${e.message}`); return null; });
            let j; try { j = JSON.parse(body); } catch { continue; }
            if (!j || +j.term !== term || +j.mileage !== mileage || !/personal/i.test(j.type || '') || !/including/i.test(j.vat || '')) continue;
            const d = j.get_derivative || {};
            const name = d.name || form.vehicle_name || path.split('/').slice(-2, -1)[0];
            const inStock = d.in_stock === '1' || j.stock_price === '1' || form.stock === 'yes';
            for (const im of initials) {
              const p = j.payment_profiles?.[String(im)];
              if (!p?.monthly_rental) continue;
              deals.push({
                source: meta.id, modelId: m.id,
                url: `${SITE}${path}?term=${term}&mileage=${mileage}&profile=${im}`,
                make: m.make, model: m.model,
                derivative: name, trim: guessTrim(name),
                fuel: mapFuel(d.fuel_type, name),
                engine: (name.match(/\b(\d\.\d)\b/) || [])[1] || null,
                powerHp: +(d.bhp || d.power_bhp || 0) || null,
                transmission: /auto|tronic|dct|geartronic/i.test(`${d.transmission || ''} ${name}`) ? 'auto' : /manual/i.test(d.transmission || '') ? 'manual' : null,
                drive: driveOf(name),
                termMonths: term, initialMonths: im, annualMileage: mileage,
                monthlyIncVat: Math.round(p.monthly_rental * 100) / 100,
                initialPaymentIncVat: Math.round(p.initial_payment * 100) / 100,
                fees: p.fee != null ? +p.fee : j.fee != null ? +j.fee : null,
                feeLabel: 'admin fee (inc VAT)',
                stock: inStock ? 'stock' : 'factory',
                delivery: d.stock_delivery || (d.quick_delivery === '1' ? 'quick delivery' : null),
                options: [],
                p11d: +(d.list_price || 0) || null,
                funder: j.funder || null,
                fetchedAt,
              });
            }
          }
        } catch (e) { log(`${m.id} ${path}: ${e.message}`); }
      });
      log(`${m.id}: ${deals.length - n0} deals`);
    } catch (e) {
      log(`${m.id}: FAILED ${e.message}`);
    }
  }
  return deals;
}
