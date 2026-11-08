// Motorlet (motorlet.co.uk) — Jacit MotorFinance platform, server-rendered HTML; see lib/jacit.mjs.
// Personal prices inc VAT; one-off "Broker fee" shown on each derivative page.
import { scrapeJacit } from '../lib/jacit.mjs';

export const meta = { id: 'motorlet', name: 'Motorlet', url: 'https://www.motorlet.co.uk', method: 'api', homeIpRecommended: false };

export const scrape = ctx => scrapeJacit(ctx, { id: meta.id, origin: 'https://www.motorlet.co.uk', typeParam: true });
