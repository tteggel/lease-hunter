// VIPGateway (vipgateway.co.uk) — Jacit MotorFinance platform, server-rendered HTML; see lib/jacit.mjs.
// Personal prices inc VAT; one-off "Arrangement Fee" (inc VAT) shown on each derivative page.
import { scrapeJacit } from '../lib/jacit.mjs';

export const meta = { id: 'vipgateway', name: 'VIPGateway', url: 'https://vipgateway.co.uk', method: 'api', homeIpRecommended: false };

export const scrape = ctx => scrapeJacit(ctx, { id: meta.id, origin: 'https://vipgateway.co.uk', typeParam: true });
