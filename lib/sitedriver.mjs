// Generic "drive the site like a person" routine shared by the local-only broker modules.
// model listing page -> derivative pages -> set 10k miles / term / upfront -> read the price shown.
import { visit, links, setProfile, readDisplayedDeal, recordJson, quotesFromJson, discover, slugText, shortlistFilter, jitter } from './assist.mjs';

/**
 * site = {
 *   id, name, base: 'https://www.example.co.uk',
 *   listing: { [modelId]: ['/car-leasing/bmw/3-series/touring', ...] },   // candidate listing paths, first that works wins
 *   makePath: { BMW: '/car-leasing/bmw', ... },                         // fallback: find the model link on the make page
 *   nextPage: (url, n) => string | null,                                // pagination URL builder
 *   isDerivative: (href, listingUrl) => boolean,
 *   withParams?: (href, {term, mileage, upfront}) => string,             // if the site honours URL params
 *   maxPages?: 4,
 *   derivFilter?: { [modelId]: RegExp },                                 // keep only matching derivative links for that model
 * }
 */
export async function driveSite(site, ctx) {
  const { models, context, log, mileage, initialMonths, terms, specs = [] } = ctx;
  const page = context.pages()[0] || await context.newPage();
  const deals = [];
  const at = new Date().toISOString();

  for (const m of models) {
    try {
      // 1. find the listing page(s)
      let derivs = [];
      for (const p of site.listing[m.id] || []) {
        const url = site.base + p;
        const resp = await visit(page, url, log);
        if (!resp || resp.status() >= 400 || /not found|404/i.test(await page.title())) continue;
        for (let n = 1; n <= (site.maxPages || 4); n++) {
          if (n > 1) { const nu = site.nextPage?.(url, n); if (!nu) break; const r = await visit(page, nu, log); if (!r || r.status() >= 400) break; }
          const found = (await links(page, /./)).filter(l => site.isDerivative(l.href, url));
          const before = derivs.length;
          for (const l of found) if (!derivs.some(d => d.href === l.href)) derivs.push(l);
          if (derivs.length === before) break; // no new results on this page
        }
        if (derivs.length) break;
      }
      if (!derivs.length && site.makePath?.[m.make]) {
        // fallback: locate the model on the make page
        await visit(page, site.base + site.makePath[m.make], log);
        const aliasRe = new RegExp(m.aliases.map(a => a.replace(/[-\s]+/g, '[-\\s]?')).join('|'), 'i');
        const cand = (await links(page, /./)).filter(l => l.href.startsWith(site.base + site.makePath[m.make]) && (aliasRe.test(l.text) || aliasRe.test(slugText(l.href))));
        if (cand[0]) { await visit(page, cand[0].href, log); derivs = (await links(page, /./)).filter(l => site.isDerivative(l.href, cand[0].href)); }
      }
      // Some sites file one model under another's pages (e.g. S5 under /a5/avant): narrow by slug/text per model.
      if (site.derivFilter?.[m.id]) derivs = derivs.filter(d => site.derivFilter[m.id].test(`${slugText(d.href)} ${d.text}`));
      const keep = shortlistFilter(specs, m.id);
      const todo = derivs.filter(d => keep(`${slugText(d.href)} ${d.text}`));
      log(`${m.id}: ${derivs.length} derivatives listed, ${todo.length} to price${process.env.ALL_DERIVATIVES ? '' : ' (shortlist only; ALL_DERIVATIVES=1 for every trim)'}`);

      // 2. price each derivative
      for (const d of todo) {
        const rec = recordJson(page);
        try {
          const first = site.withParams ? site.withParams(d.href, { term: terms[0], mileage, upfront: initialMonths[0] }) : d.href;
          if (!(await visit(page, first, log))) continue;
          await discover(page, site.id, `${m.id}-${slugText(d.href)}`, rec);
          const base = await readDisplayedDeal(page); // fees/stock text can be hidden once an edit panel opens
          const got = new Map(); // "term|upfront" -> deal
          for (const upfront of initialMonths) for (const term of terms) {
            if (site.withParams) { await visit(page, site.withParams(d.href, { term, mileage, upfront }), log); }
            const set = await setProfile(page, { mileage, term, upfront }, log);
            const shown = await readDisplayedDeal(page);
            // Trust what the page displays over what we clicked; fall back to the click result if the page doesn't say.
            const okMileage = shown.shownMileage != null ? shown.shownMileage === mileage : (set.mileage?.ok || shown.shows10k);
            const okTerm = shown.shownTerm != null ? shown.shownTerm === term : set.term?.ok;
            const okUp = shown.shownUpfront != null ? shown.shownUpfront === upfront : set.upfront?.ok;
            if (set.upfront && !set.upfront.ok && set.upfront.why === 'value not offered') continue; // e.g. no 1-month option
            if (shown.monthly && okMileage && okTerm && okUp) {
              got.set(`${term}|${upfront}`, {
                source: site.id, modelId: m.id, make: m.make, model: m.model, url: page.url(),
                derivative: [shown.title, shown.subtitle].join(' ').trim() || slugText(d.href),
                termMonths: term, initialMonths: upfront, annualMileage: mileage,
                monthlyIncVat: shown.monthly, initialPaymentIncVat: shown.initial,
                fees: shown.fee ?? base.fee ?? (shown.noFee || base.noFee ? 0 : null), stock: base.stock === 'factory' ? shown.stock : base.stock, delivery: shown.delivery || base.delivery,
                via: 'page', fetchedAt: at,
              });
            } else {
              log(`  ${slugText(d.href)} ${upfront}+${term - 1}: could not confirm (${JSON.stringify({ monthly: shown.monthly, mileage: set.mileage?.ok ?? shown.shows10k, term: set.term?.ok, upfront: set.upfront?.ok ?? 'control not found', shown: [shown.shownMileage, shown.shownTerm, shown.shownUpfront] })})`);
            }
          }
          // 3. JSON the page loaded may hold the whole price matrix (and, on aggregators, every broker)
          for (const q of quotesFromJson(rec.rec)) {
            if (q.mileage !== mileage || !terms.includes(q.term) || !initialMonths.includes(q.upfront) || q.personal === false) continue;
            deals.push({ source: site.id, modelId: m.id, make: m.make, model: m.model, url: d.href,
              derivative: q.name || [...got.values()][0]?.derivative || slugText(d.href), dealer: q.dealer || null,
              termMonths: q.term, initialMonths: q.upfront, annualMileage: q.mileage, monthlyIncVat: q.monthly,
              initialPaymentIncVat: q.initial, fees: q.fee, via: 'json', fetchedAt: at });
          }
          deals.push(...got.values());
          log(`  ${slugText(d.href)}: ${got.size} profiles priced`);
        } catch (e) { log('  derivative failed', d.href, e.message); }
        finally { rec.stop(); }
        await jitter(1500, 3500);
      }
    } catch (e) { log(`${m.id} failed:`, e.message); }
  }
  return deals;
}
