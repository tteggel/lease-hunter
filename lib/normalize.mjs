// Normalise RawDeals from any source into one consistent shape + derived fields.
const FUEL_RULES = [
  ['phev', /\b(C ?\d{3} ?de|\d{3}de)\b/i],   // Mercedes diesel plug-in (C300de)
  ['phev', /\b(\d{3}e|\d{2}e|xDrive\d{2}e|T6|T8|TFSI ?e|e-hybrid|plug-?in|PHEV|Recharge|C\s?\d{3}\s?e|\d{3}e)\b|(?:\b\d{2}e\b)/i],
  ['bev', /\b(i\d|EV|electric|e-tron|EQ[ABCES])\b/i],
  ['diesel', /\b(\d{3}d|\d{2}d|TDI|CDI|diesel|xDrive\d{2}d|B4 ?D|D4|D5)\b/i],
];
export function inferFuel(text, given) {
  if (given) {
    const g = String(given).toLowerCase();
    if (/plug|phev/.test(g)) return 'phev';
    if (/electric|bev/.test(g)) return 'bev';
    if (/diesel/.test(g)) return 'diesel';
    if (/mild|mhev/.test(g)) return 'mhev';
    if (/hybrid/.test(g)) return 'phev';
    if (/petrol/.test(g)) return 'petrol';
  }
  for (const [fuel, re] of FUEL_RULES) if (re.test(text)) return fuel;
  return 'petrol';
}
export function inferPower(text, given) {
  if (given) return Number(given);
  const m = text.match(/(\d{3})\s?(?:PS|hp|bhp)\b/i) || text.match(/\b(?:TFSI|TDI|TFSI e)\s?(\d{3})\b/i) || text.match(/\[(\d{3})\]/);
  return m ? Number(m[1]) : null;
}
const r2 = n => Math.round(n * 100) / 100;

export function normalize(raw, sourceMeta) {
  let derivative = String(raw.derivative || '').replace(/\s+/g, ' ').trim();
  // strip a leading "BMW 3 Series Touring" / "Volvo XC60" so names compare across sources
  for (const pre of [`${raw.make} ${raw.model}`, raw.model, raw.make, ...(sourceMeta.aliasPrefixes || [])]) {
    if (pre && derivative.toLowerCase().startsWith(pre.toLowerCase() + ' ')) derivative = derivative.slice(pre.length + 1);
  }
  const text = `${derivative} ${raw.trim || ''} ${raw.engine || ''}`;
  const term = Number(raw.termMonths), up = Number(raw.initialMonths), monthly = Number(raw.monthlyIncVat);
  if (!term || !up || !monthly) return null;
  const initial = raw.initialPaymentIncVat ? Number(raw.initialPaymentIncVat) : r2(monthly * up);
  const fees = raw.fees == null ? null : Number(raw.fees);
  // Standard UK profile: initial rental (N x monthly) then (term-1) monthly payments.
  const total = r2(initial + monthly * (term - 1) + (fees || 0));
  return {
    source: raw.source || sourceMeta.id,
    sourceName: sourceMeta.name || raw.source,
    dealer: raw.dealer || null,
    modelId: raw.modelId,
    make: raw.make, model: raw.model,
    derivative, trim: raw.trim || null,
    fuel: inferFuel(text, raw.fuel === 'hybrid' ? null : raw.fuel),
    powerHp: inferPower(text, raw.powerHp),
    transmission: raw.transmission || null, drive: raw.drive || (/xDrive|quattro|4MATIC|AWD|4x4/i.test(text) ? 'awd' : null),
    term, upfront: up, mileage: Number(raw.annualMileage),
    monthly: r2(monthly), initial: r2(initial), fees, feesKnown: fees != null,
    total, effective: r2(total / term),
    stock: raw.stock || null, delivery: raw.delivery || null,
    options: raw.options || [], url: raw.url, fetchedAt: raw.fetchedAt,
  };
}
