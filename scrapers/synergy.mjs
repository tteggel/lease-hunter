// Synergy Car Leasing — drives the public site in your own visible browser (local only; it refuses cloud traffic).
// URL shapes (search-engine results, Nov 2026): /bmw/3-series/touring/ , /bmw/3-series/?page=3
// UNVERIFIED against the live site. Run with DISCOVER=1 to dump pages for tuning.
import { driveSite } from '../lib/sitedriver.mjs';
import { looksLikeDerivative, LOCAL_ONLY_NOTE } from '../lib/sitecommon.mjs';

export const meta = { id: 'synergy', name: 'Synergy Car Leasing', url: 'https://www.synergycarleasing.co.uk', method: 'browser (local)', localOnly: true, homeIpRecommended: true, note: LOCAL_ONLY_NOTE };

const site = {
  id: meta.id, name: meta.name, base: 'https://www.synergycarleasing.co.uk',
  listing: {
    'bmw-3-touring': ['/bmw/3-series/touring/'],
    'bmw-x3': ['/bmw/x3/'],
    'merc-c-estate': ['/mercedes-benz/c-class/estate/', '/mercedes/c-class/estate/'],
    'volvo-xc60': ['/volvo/xc60/'],
    'audi-a5-avant': ['/audi/a5/avant/'],
    'audi-s5-avant': ['/audi/s5/avant/', '/audi/a5/avant/'],
    'audi-rs5-avant': ['/audi/rs5/avant/', '/audi/rs-5/avant/'],
  },
  derivFilter: { 'audi-a5-avant': /^(?!.*\b(s5|rs ?5)\b)/i, 'audi-s5-avant': /\bs5\b/i },
  makePath: { BMW: '/bmw/', 'Mercedes-Benz': '/mercedes-benz/', Volvo: '/volvo/', Audi: '/audi/' },
  nextPage: (url, n) => `${url}?page=${n}`,
  isDerivative: (href, listingUrl) => looksLikeDerivative(href, listingUrl, 2),
};
export const scrape = ctx => driveSite(site, ctx);
