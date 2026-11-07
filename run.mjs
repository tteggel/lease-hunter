#!/usr/bin/env node
// Usage: node run.mjs [sourceId ...] [--models=bmw-x3,volvo-xc60] [--force]
//   local-only sources (selectcarleasing, nationwide, leasingcom) run only with HEADED=1
//   DISCOVER=1 saves page HTML / JSON / screenshots to data/discovery/ for tuning; ALL_DERIVATIVES=1 prices every trim
//   HEADED=1 PROFILE_DIR=.profile node run.mjs   (recommended on a laptop)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/pw.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const wanted = args.filter(a => !a.startsWith('--'));

const settings = JSON.parse(await fs.readFile(path.join(root, 'config/settings.json'), 'utf8').catch(() => '{}'));
let models = JSON.parse(await fs.readFile(path.join(root, 'config/models.json'), 'utf8'));
const specs = JSON.parse(await fs.readFile(path.join(root, 'config/cars.json'), 'utf8').catch(() => '[]'));
if (flags.models) models = models.filter(m => flags.models.split(',').includes(m.id));

const files = (await fs.readdir(path.join(root, 'scrapers'))).filter(f => f.endsWith('.mjs'));
const ids = wanted.length ? wanted : files.map(f => f.replace('.mjs', '')).filter(id => !(settings.disabledSources || []).includes(id));

const { context, close } = await launch();
const summary = [];
for (const id of ids) {
  const mod = await import(path.join(root, 'scrapers', id + '.mjs'));
  const log = (...a) => console.log(`[${id}]`, ...a);
  if (mod.meta.localOnly && !process.env.HEADED && !flags.force) {
    log('skipped: local-only source, run on your laptop with HEADED=1 (see README)');
    summary.push({ id, skipped: 'local only' }); continue;
  }
  const t0 = Date.now();
  try {
    const deals = await mod.scrape({
      models, specs, context, log,
      mileage: settings.annualMileage ?? 10000,
      initialMonths: settings.initialMonths ?? [1, 3],
      terms: settings.terms ?? [24, 36, 48],
    });
    await fs.writeFile(path.join(root, 'data/raw', id + '.json'), JSON.stringify({ source: mod.meta, fetchedAt: new Date().toISOString(), deals }, null, 1));
    summary.push({ id, deals: deals.length, secs: Math.round((Date.now() - t0) / 1000) });
    log(`OK ${deals.length} deals in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    summary.push({ id, error: String(e.message || e) });
    log('FAILED', e);
  }
}
await close();
console.table(summary);
