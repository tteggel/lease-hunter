// Gateway2Lease — drives the public site in your own visible browser (local only; it refuses cloud traffic).
// URL shapes (search-engine results, Nov 2026): /cars/bmw/3-series-touring/42753/330e-2.0-m-sport-auto,
//   /cars/mercedes/c-class-estate/31205/c300e-2.0-326ps-amg-line-premium-plus-auto. Used-car leases live under
//   /car-leasing/used/ and are ignored. Some pages say "Please request a quote" instead of a price; those are skipped.
// UNVERIFIED against the live site. Run with DISCOVER=1 to dump pages for tuning.
import { driveSite } from '../lib/sitedriver.mjs';
import { looksLikeDerivative, LOCAL_ONLY_NOTE } from '../lib/sitecommon.mjs';

export const meta = { id: 'gateway2lease', name: 'Gateway2Lease', url: 'https://www.gateway2lease.com', method: 'browser (local)', localOnly: true, homeIpRecommended: true, note: LOCAL_ONLY_NOTE };

const site = {
  id: meta.id, name: meta.name, base: 'https://www.gateway2lease.com',
  listing: {
    'bmw-3-touring': ['/cars/bmw/3-series-touring'],
    'bmw-x3': ['/cars/bmw/x3', '/cars/bmw/x3-estate'],
    'merc-c-estate': ['/cars/mercedes/c-class-estate', '/cars/mercedes-benz/c-class-estate'],
    'volvo-xc60': ['/cars/volvo/xc60', '/cars/volvo/xc60-estate'],
    'audi-a5-avant': ['/cars/audi/a5-avant', '/cars/audi/a5-estate'],
    'audi-s5-avant': ['/cars/audi/s5-avant', '/cars/audi/a5-avant'],
    'audi-rs5-avant': ['/cars/audi/rs5-avant', '/cars/audi/rs-5-avant'],
  },
  derivFilter: { 'audi-a5-avant': /^(?!.*\b(s5|rs ?5)\b)/i, 'audi-s5-avant': /\bs5\b/i },
  makePath: { BMW: '/cars/bmw', 'Mercedes-Benz': '/cars/mercedes', Volvo: '/cars/volvo', Audi: '/cars/audi' },
  nextPage: (url, n) => `${url}?page=${n}`,
  isDerivative: (href, listingUrl) => looksLikeDerivative(href, listingUrl, 2) && /\/\d+\/[^/]+$/.test(href.split('?')[0]),
};
export const scrape = ctx => driveSite(site, ctx);
