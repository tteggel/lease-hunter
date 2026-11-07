// Browser automation helpers for sites you drive locally in a visible window.
// Designed to behave like a person clicking: one tab, one page at a time, pauses between actions.
// If a site shows a verification page or CAPTCHA, we stop and wait for YOU to complete it in the window.
// Nothing here hides automation, spoofs fingerprints or solves challenges.
import fs from 'node:fs/promises';
import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const jitter = (a = 1200, b = 2600) => sleep(a + Math.random() * (b - a));

const CHALLENGE_TITLE = /just a moment|attention required|access denied|verify you are human|are you a robot|security check|pardon our interruption/i;
const CHALLENGE_FRAME = /challenges\.cloudflare\.com|hcaptcha\.com|recaptcha|captcha-delivery|perimeterx|px-cdn|datadome|arkoselabs/i;

export async function isChallenge(page) {
  const title = await page.title().catch(() => '');
  if (CHALLENGE_TITLE.test(title)) return true;
  if (page.frames().some(f => CHALLENGE_FRAME.test(f.url()))) {
    // An invisible reCAPTCHA badge on a normal page is not a challenge; require the page to look blocked too.
    const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
    return txt.length < 600 || /verify|human|captcha|robot/i.test(txt);
  }
  return false;
}

/** Wait (up to 5 min) for the person at the keyboard to clear a verification page. */
export async function waitForHuman(page, log) {
  if (!(await isChallenge(page))) return true;
  log('\x07⚠  The site is showing a verification check. Please complete it in the browser window; I will carry on when it clears.');
  const t0 = Date.now();
  while (Date.now() - t0 < 5 * 60_000) {
    await sleep(2000);
    if (!(await isChallenge(page))) { log('Thanks, continuing.'); await sleep(1500); return true; }
  }
  log('Verification was not completed; skipping this page.');
  return false;
}

export async function acceptCookies(page) {
  const re = /^(accept( all)?( cookies)?|allow all( cookies)?|i accept|agree( and close)?|got it|ok)$/i;
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    const btn = frame.getByRole('button', { name: re }).first();
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) { await btn.click().catch(() => {}); await sleep(600); return true; }
  }
  return false;
}

/** Records JSON responses while a page is open, for the generic JSON deal walker and for discovery dumps. */
export function recordJson(page) {
  const rec = [];
  const onResp = async resp => {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!/json/.test(ct) || resp.request().method() === 'OPTIONS') return;
      const u = resp.url(); if (/google|facebook|hotjar|clarity|analytics|doubleclick|tiktok|bing|trustpilot|segment|sentry|optimizely/i.test(u)) return;
      const body = await resp.text(); if (body.length > 3_000_000) return;
      rec.push({ url: u, status: resp.status(), json: JSON.parse(body) });
    } catch {}
  };
  page.on('response', onResp);
  return { rec, stop: () => page.off('response', onResp), clear: () => rec.splice(0) };
}

export async function visit(page, url, log) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(e => { log('goto failed', url, e.message); return null; });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
  if (!(await waitForHuman(page, log))) return null;
  await acceptCookies(page);
  await jitter(800, 1600);
  return resp;
}

export async function links(page, hrefRe) {
  const all = await page.$$eval('a[href]', as => as.map(a => ({ href: a.href.split('#')[0], text: (a.innerText || a.title || '').replace(/\s+/g, ' ').trim() })));
  const out = new Map();
  for (const l of all) if (hrefRe.test(l.href) && !out.has(l.href.split('?')[0])) out.set(l.href.split('?')[0], l);
  return [...out.values()];
}

/**
 * Find term / mileage / upfront controls by the *set of values* they offer, whatever the site calls them:
 *   term: {24,36,48} (or 2/3/4 years)   upfront: {1,3,6,9,12}   mileage: {5000,8000,10000,...}
 * Handles <select>, groups of buttons/radios/pills, and range sliders. If none are visible, opens a
 * "Customise / Edit / Change" panel first. Returns what was set, per dimension.
 */
const OPENER = /^(customi[sz]e|personali[sz]e|edit|change|adjust|amend|configure)\b.{0,24}\b(deal|quote|lease|contract|finance|payments?|options)$|^(customi[sz]e|personali[sz]e|edit|configure)$/i;

function scanControls(want) {
  const num = s => { s = String(s).replace(/,/g, ''); const m = s.match(/(\d+(?:\.\d+)?)\s*(k)?/i); if (!m) return null; let n = +m[1] * (m[2] ? 1000 : 1); if (/year|yr/i.test(s) && n <= 6) n *= 12; return Math.round(n); };
  const classify = vals => {
    const v = new Set(vals.filter(x => x != null));
    if ([...v].filter(x => x >= 3000 && x <= 60000).length >= 2) return 'mileage';
    if (v.has(24) && v.has(36) && [...v].every(x => x >= 6 && x <= 60)) return 'term';
    if ((v.has(1) || v.has(3)) && (v.has(6) || v.has(9) || v.has(12)) && [...v].every(x => x >= 1 && x <= 12)) return 'upfront';
    return null;
  };
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const done = {};
  let tag = Date.now() % 100000;
  for (const sel of document.querySelectorAll('select')) {
    if (!visible(sel) && !sel.closest('label')) continue;
    const opts = [...sel.options].map(o => ({ o, n: num(o.textContent) }));
    const kind = classify(opts.map(x => x.n)); if (!kind || done[kind] || want[kind] == null) continue;
    const hit = opts.find(x => x.n === want[kind]);
    if (!hit) { done[kind] = { ok: false, why: 'value not offered', offered: opts.map(x => x.n) }; continue; }
    sel.setAttribute('data-lh', 's' + (++tag));
    done[kind] = { ok: true, how: 'select', sel: `[data-lh="s${tag}"]`, value: hit.o.value };
  }
  for (const r of document.querySelectorAll('input[type="range"], [role="slider"]')) {
    if (!visible(r)) continue;
    const min = +(r.min ?? r.getAttribute('aria-valuemin')), max = +(r.max ?? r.getAttribute('aria-valuemax')), step = +(r.step || 1);
    const kind = max >= 10000 ? 'mileage' : (min >= 12 && max <= 60 && max >= 36) ? 'term' : (min >= 1 && max <= 12) ? 'upfront' : null;
    if (!kind || done[kind] || want[kind] == null) continue;
    r.setAttribute('data-lh', 'r' + (++tag));
    done[kind] = { ok: true, how: 'range', sel: `[data-lh="r${tag}"]`, min, max, step, value: want[kind], aria: r.getAttribute('role') === 'slider' };
  }
  // first line of the control's text, e.g. "2 Years" from "2 Years\n+£60.04/pm"
  const head = el => ((el.innerText || '').split('\n').map(x => x.trim()).find(Boolean) || '');
  const cands = [...document.querySelectorAll('button, [role="radio"], [role="tab"], [role="option"], label, li, a')]
    .filter(el => visible(el) && (el.innerText || '').length < 80 && /^\s*[\d,.]+\s*(k|months?|mths?|mos?|years?|yrs?|miles|x|\+)?\s*$/i.test(head(el)));
  const groups = new Map();
  for (const el of cands) { const p = el.parentElement?.closest('div, ul, fieldset, section') || el.parentElement; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(el); }
  for (const [, els] of groups) {
    if (els.length < 2) continue;
    const kind = classify(els.map(e => num(head(e)))); if (!kind || done[kind] || want[kind] == null) continue;
    const hit = els.find(e => num(head(e)) === want[kind]);
    if (!hit) { done[kind] = { ok: false, why: 'value not offered', offered: els.map(e => num(head(e))) }; continue; }
    hit.setAttribute('data-lh', 'b' + (++tag));
    done[kind] = { ok: true, how: 'click', sel: `[data-lh="b${tag}"]` };
  }
  return done;
}

export async function setProfile(page, want, log) {
  let res = await page.evaluate(scanControls, want);
  const missing = () => ['mileage', 'term', 'upfront'].filter(k => want[k] != null && !res[k]);
  if (missing().length) {
    const opener = page.getByRole('button', { name: OPENER }).first();
    if (await opener.isVisible({ timeout: 500 }).catch(() => false)) {
      await opener.click().catch(() => {}); await sleep(900);
      res = { ...(await page.evaluate(scanControls, want)), ...res };
    }
  }
  // Make sure we're looking at personal (inc VAT) pricing where the site offers a choice.
  const personal = page.getByRole('button', { name: /^personal( lease| contract hire| leasing)?( inc\.? vat)?$/i }).first();
  if (await personal.isVisible({ timeout: 300 }).catch(() => false)) await personal.click().catch(() => {});
  for (const [kind, r] of Object.entries(res)) {
    if (!r.ok) continue;
    try {
      if (r.how === 'select') await page.selectOption(r.sel, r.value);
      else if (r.how === 'click') await page.click(r.sel);
      else if (r.how === 'range') {
        // Move the slider with the keyboard, as a person would.
        const el = page.locator(r.sel); await el.focus();
        const read = async () => Number(r.aria ? await el.getAttribute('aria-valuenow') : await el.inputValue());
        const steps = Math.round((r.value - await read()) / r.step);
        for (let i = 0; i < Math.abs(steps); i++) await page.keyboard.press(steps > 0 ? 'ArrowRight' : 'ArrowLeft');
        if (await read() !== r.value) r.ok = false;
      }
      await jitter(700, 1400);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    } catch (e) { r.ok = false; r.why = e.message.split('\n')[0]; }
  }
  return res;
}

/** Read the deal currently displayed: the most prominent "£x per month" figure, plus initial payment, fees, stock. */
export async function readDisplayedDeal(page) {
  return page.evaluate(() => {
    const money = s => { const m = String(s).match(/£\s?([\d,]+(?:\.\d{1,2})?)/); return m ? +m[1].replace(/,/g, '') : null; };
    const els = [...document.querySelectorAll('body *')].filter(el => {
      if (!el.childNodes.length || el.children.length > 3) return false;
      const t = el.textContent || ''; if (!/£\s?\d/.test(t) || t.length > 40) return false;
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    });
    let best = null;
    for (const el of els) {
      const v = money(el.textContent); if (!v || v < 80 || v > 5000) continue;
      let ctx = el, txt = ''; for (let i = 0; i < 4 && ctx; i++, ctx = ctx.parentElement) { txt = ctx.innerText || ''; if (txt.length > 300) break; if (/per month|p\/?m\b|\/mo|a month|monthly/i.test(txt)) break; }
      if (!/per month|p\/?m\b|\/mo|a month|monthly/i.test(txt) || /initial|total|upfront|deposit|was\b/i.test(el.textContent)) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      const top = el.getBoundingClientRect().top + scrollY;
      if (!best || fs > best.fs + 0.5 || (Math.abs(fs - best.fs) <= 0.5 && top < best.top)) best = { v, fs, top };
    }
    const text = document.body.innerText;
    const grab = re => { const m = text.match(re); return m ? +m[1].replace(/,/g, '') : null; };
    const h1 = document.querySelector('h1')?.innerText?.replace(/\s+/g, ' ').trim() || document.title;
    return {
      title: h1,
      subtitle: document.querySelector('h1 + *, h2')?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 160) || '',
      monthly: best?.v ?? null,
      initial: grab(/initial (?:payment|rental)[^£]{0,60}£\s?([\d,]+(?:\.\d{1,2})?)/i),
      fee: grab(/(?:admin(?:istration)?|processing|arrangement|documentation|broker|set[- ]?up) fee[^£]{0,40}£\s?([\d,]+(?:\.\d{1,2})?)/i),
      noFee: /no (?:admin|arrangement|processing) fees?/i.test(text),
      stock: /\b(in stock|fast lease|quick delivery|ready for delivery|available now)\b/i.test(text) ? 'stock' : /pre[- ]?reg/i.test(text) ? 'prereg' : 'factory',
      delivery: (text.match(/(?:estimated |expected )?delivery[:\s]+([^\n]{3,40})/i) || [])[1] || null,
      shows10k: /10,?000\s*(miles|mi)/i.test(text),
      // what the page says the current profile is (used to confirm our clicks took effect)
      shownTerm: (() => { const m = text.match(/(?:contract length|term|lease length|duration)[^\n\d]{0,20}(\d{1,2})\s*(months?|years?)/i) || text.match(/\b(\d{1,2})\s*(months?|years?)\s*(?:personal\s+)?(?:lease|contract)/i); return m ? +m[1] * (/year/i.test(m[2]) ? 12 : 1) : null; })(),
      shownMileage: (() => { const m = text.match(/(?:annual mileage|mileage)[^\n\d]{0,20}([\d,]{4,6})/i) || text.match(/([\d,]{4,6})\s*miles\s*(?:per|a|\/)\s*(?:annum|year|yr)/i); return m ? +m[1].replace(/,/g, '') : null; })(),
      shownUpfront: (() => { const m = text.match(/\b(\d{1,2})\s*\+\s*\d{2}\b/) || text.match(/initial (?:payment|rental)[^\n\d£]{0,20}\(?(\d{1,2})\s*(?:months?|x)/i) || text.match(/(\d{1,2})\s*months?\s*(?:initial|upfront|in advance)/i); return m ? +m[1] : null; })(),
    };
  });
}

/**
 * Generic walker over recorded JSON: finds objects that look like price quotes
 * (a monthly figure + a term, optionally mileage / initial months / name / broker).
 */
export function quotesFromJson(rec) {
  const out = [];
  const pick = (o, re, test) => { for (const k of Object.keys(o)) if (re.test(k) && test(o[k])) return o[k]; return undefined; };
  const isNum = v => typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v));
  const walk = (o, depth, parentName) => {
    if (!o || typeof o !== 'object' || depth > 12) return;
    if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1, parentName)); return; }
    const name = pick(o, /^(derivative|derivativeName|variant|title|name|description|vehicleName)$/i, v => typeof v === 'string' && v.length > 4) || parentName;
    const monthly = pick(o, /^(monthly|monthlyPrice|monthlyRental|monthlyPayment|monthlyCost|rental|price|pricePerMonth|monthly_rental|monthlyIncVat|personalMonthly)$/i, v => isNum(v) && +v > 80 && +v < 5000);
    const term = pick(o, /^(term|termMonths|duration|contractLength|months|contract_length|period)$/i, v => isNum(v) && [18, 24, 36, 48, 60].includes(+v));
    if (monthly != null && term != null) {
      out.push({
        name, monthly: +monthly, term: +term,
        mileage: +pick(o, /mile/i, v => isNum(v) && +v >= 3000 && +v <= 60000) || null,
        upfront: +pick(o, /^(initial|initialMonths|initialPayment(Months)?|upfront|profile|advance|initialRentalMonths|initial_months|deposit(Months)?)$/i, v => isNum(v) && +v >= 1 && +v <= 12) || null,
        initial: +pick(o, /initial.*(price|amount|value|payment|rental)|upfront.*(amount|price)/i, v => isNum(v) && +v > 80) || null,
        fee: +pick(o, /(admin|arrangement|processing|broker|doc).*fee|^fee$/i, v => isNum(v) && +v >= 0 && +v < 2000) ?? null,
        dealer: pick(o, /^(broker|brokerName|dealer|dealerName|supplier|supplierName|provider|leaseCompany|funder)$/i, v => typeof v === 'string'),
        personal: pick(o, /personal|isBusiness|business|vat/i, v => typeof v === 'boolean'),
      });
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, depth + 1, name);
  };
  for (const r of rec) walk(r.json, 0, null);
  return out;
}

/** DISCOVER=1: save page HTML, JSON responses and a screenshot so the parsers can be tuned to the live site. */
export async function discover(page, site, label, rec) {
  if (!process.env.DISCOVER) return;
  const dir = path.join('data/discovery', site); await fs.mkdir(dir, { recursive: true });
  const slug = label.replace(/[^a-z0-9]+/gi, '-').slice(0, 80);
  await fs.writeFile(path.join(dir, slug + '.html'), await page.content()).catch(() => {});
  await fs.writeFile(path.join(dir, slug + '.json'), JSON.stringify({ url: page.url(), responses: rec?.rec?.map(r => ({ url: r.url, status: r.status, json: r.json })) || [] }, null, 1)).catch(() => {});
  await page.screenshot({ path: path.join(dir, slug + '.png'), fullPage: true }).catch(() => {});
}

/** Slug text for matching derivative URLs against shortlist regexes, e.g. "330e-223-kwh-m-sport-5dr" -> "330e 223 kwh m sport 5dr". */
export const slugText = href => decodeURIComponent(href.split('?')[0].split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' ');

/** Which candidate derivative links to visit: all, or only those that could match a shortlist spec. */
export function shortlistFilter(specs, modelId) {
  const mine = specs.filter(s => s.modelId === modelId);
  return text => {
    if (process.env.ALL_DERIVATIVES) return true;
    if (!mine.length) return true;
    // slugs lose punctuation: loosen regexes (spaces optional, word boundaries kept)
    return mine.some(s => (s.match || []).every(p => { try { return new RegExp(p.replace(/\\b/g, ''), 'i').test(text) || new RegExp(p.replace(/ \?|\s/g, ''), 'i').test(text.replace(/\s/g, '')); } catch { return false; } }));
  };
}
