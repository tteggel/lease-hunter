#!/usr/bin/env node
// Merge data/raw/*.json (+ config/manual-deals.json) -> dashboard/data.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './lib/normalize.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = async (p, d) => JSON.parse(await fs.readFile(path.join(root, p), 'utf8').catch(() => d));
const settings = await read('config/settings.json', '{}');
const models = await read('config/models.json', '[]');
const specs = await read('config/cars.json', '[]');
const mileage = settings.annualMileage ?? 10000, ups = settings.initialMonths ?? [1, 3], terms = settings.terms ?? [24, 36, 48];

const sources = [], deals = [];
const rawFiles = (await fs.readdir(path.join(root, 'data/raw'))).filter(f => f.endsWith('.json'));
const manual = await read('config/manual-deals.json', '[]');
const batches = [];
for (const f of rawFiles) batches.push(await read('data/raw/' + f, '{}'));
if (manual.length) batches.push({ source: { id: 'manual', name: 'Manual quotes', method: 'manual' }, fetchedAt: new Date().toISOString(), deals: manual });

for (const b of batches) {
  const meta = b.source || {};
  let kept = 0, seen = new Set();
  for (const raw of b.deals || []) {
    const mdl = models.find(m => m.id === raw.modelId);
    const prefixes = mdl ? [...mdl.aliases.map(a => `${mdl.make} ${a}`), `${mdl.make.split('-')[0]} ${mdl.model}`, ...mdl.aliases] : [];
    const d = normalize({ ...raw, fetchedAt: raw.fetchedAt || b.fetchedAt }, { ...meta, aliasPrefixes: prefixes });
    if (!d || !models.find(m => m.id === d.modelId)) continue;
    if (d.mileage !== mileage || !ups.includes(d.upfront) || !terms.includes(d.term)) continue;
    const key = [d.source, d.dealer, d.derivative, d.term, d.upfront, d.monthly, d.stock].join('|');
    if (seen.has(key)) continue; seen.add(key);
    deals.push(d); kept++;
  }
  sources.push({ id: meta.id, name: meta.name, url: meta.url, method: meta.method, homeIpRecommended: !!meta.homeIpRecommended, fetchedAt: b.fetchedAt, rawCount: (b.deals || []).length, kept });
}
const out = { generatedAt: new Date().toISOString(), settings: { mileage, upfront: ups, terms }, models, specs, sources, deals };
await fs.writeFile(path.join(root, 'dashboard/data.json'), JSON.stringify(out));
console.table(sources.map(s => ({ source: s.id, raw: s.rawCount, kept: s.kept, fetched: s.fetchedAt })));
console.log(`${deals.length} deals -> dashboard/data.json`);
