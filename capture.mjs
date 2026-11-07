#!/usr/bin/env node
// Assisted capture for sites that don't permit automated scraping (e.g. Leasing.com, Select, NVC).
// YOU browse normally in a visible Chrome window; press Enter here to record the deal on the current page.
//   node capture.mjs https://leasing.com/
// Captured deals are appended to config/manual-deals.json and picked up by `npm run build`.
import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { launch } from './lib/pw.mjs';

const models = JSON.parse(await fs.readFile('config/models.json', 'utf8'));
const file = 'config/manual-deals.json';
const saved = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]'));
process.env.HEADED = '1';
process.env.PROFILE_DIR ||= '.profile';
const { context, close } = await launch({ headed: true });
const page = context.pages()[0] || await context.newPage();
await page.goto(process.argv[2] || 'https://leasing.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
const rl = readline.createInterface({ input: stdin, output: stdout });

const guess = async () => page.evaluate(() => {
  const text = document.body.innerText;
  const money = [...text.matchAll(/£\s?([\d,]+(?:\.\d{2})?)\s*(?:inc\.? ?VAT)?\s*(?:p\/?m|per month|\/mo|a month|monthly)/gi)].map(m => +m[1].replace(/,/g, ''));
  const h1 = document.querySelector('h1')?.innerText || document.title;
  const h2 = document.querySelector('h2')?.innerText || '';
  const pick = re => (text.match(re) || [])[1];
  return {
    title: `${h1} ${h2}`.replace(/\s+/g, ' ').trim(),
    monthly: money[0] || null,
    term: +pick(/(\d{2})\s*months?\s*(?:contract|term|agreement)/i) || null,
    upfront: +pick(/(\d{1,2})\s*(?:months?|x)\s*(?:initial|upfront|in advance)/i) || null,
    mileage: +String(pick(/([\d,]{4,6})\s*(?:miles|mi)\s*(?:per|a|\/)\s*(?:year|annum|yr)/i) || '').replace(/,/g, '') || null,
    fee: +String(pick(/(?:admin|processing|arrangement|documentation)\s*fee[^£]{0,20}£\s?([\d,]+)/i) || '').replace(/,/g, '') || null,
  };
});

console.log('\nBrowse to a deal page with your preferred term / mileage / upfront selected.\nPress Enter to capture it, or type q then Enter to quit.\n');
while (true) {
  const cmd = (await rl.question('> ')).trim();
  if (cmd === 'q') break;
  const g = await guess();
  const host = new URL(page.url()).hostname.replace(/^www\./, '');
  const ask = async (q, d) => { const a = (await rl.question(`${q} [${d ?? ''}]: `)).trim(); return a === '' ? d : a; };
  console.log(`\n${g.title}\n${page.url()}`);
  const modelGuess = models.find(m => m.aliases.some(a => g.title.toLowerCase().includes(a.toLowerCase())))?.id;
  const deal = {
    source: 'manual', dealer: await ask('Broker', host),
    modelId: await ask(`Model id (${models.map(m => m.id).join(', ')})`, modelGuess),
    derivative: await ask('Derivative', g.title),
    monthlyIncVat: +(await ask('Monthly £ inc VAT', g.monthly)),
    termMonths: +(await ask('Term months', g.term ?? 36)),
    initialMonths: +(await ask('Months upfront', g.upfront ?? 3)),
    annualMileage: +(await ask('Annual mileage', g.mileage ?? 10000)),
    fees: +(await ask('Admin fee £ (0 if none)', g.fee ?? 0)),
    stock: await ask('factory / stock / prereg', 'factory'),
    url: page.url(), fetchedAt: new Date().toISOString(),
  };
  const m = models.find(x => x.id === deal.modelId); if (m) Object.assign(deal, { make: m.make, model: m.model });
  saved.push(deal);
  await fs.writeFile(file, JSON.stringify(saved, null, 1));
  console.log(`Saved (${saved.length} manual deals). Run \`npm run build\` to refresh the dashboard.\n`);
}
rl.close(); await close();
