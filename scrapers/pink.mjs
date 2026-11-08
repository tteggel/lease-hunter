// Pink Car Leasing — drives the public site in your own visible browser (local only; it refuses cloud traffic).
// URL shapes (search-engine results, Nov 2026): /car-leasing/audi/a5/avant/2-0-tfsi-150-sport-5dr-s-tronic,
//   S5 is filed under /audi/a5/avant/s5-..., RS5 under /audi/rs5/avant/. Admin fee (e.g. £199) is shown on deal pages.
// UNVERIFIED against the live site. Run with DISCOVER=1 to dump pages for tuning.
import { driveSite } from '../lib/sitedriver.mjs';
import { looksLikeDerivative, LOCAL_ONLY_NOTE } from '../lib/sitecommon.mjs';

export const meta = { id: 'pink', name: 'Pink Car Leasing', url: 'https://www.pinkcarleasing.co.uk', method: 'browser (local)', localOnly: true, homeIpRecommended: true, note: LOCAL_ONLY_NOTE };

const site = {
  id: meta.id, name: meta.name, base: 'https://www.pinkcarleasing.co.uk',
  listing: {
    'bmw-3-touring': ['/car-leasing/bmw/3-series/touring', '/car-leasing/bmw/3-series/estate'],
    'bmw-x3': ['/car-leasing/bmw/x3/estate', '/car-leasing/bmw/x3/suv', '/car-leasing/bmw/x3'],
    'merc-c-estate': ['/car-leasing/mercedes-benz/c-class/estate'],
    'volvo-xc60': ['/car-leasing/volvo/xc60/estate', '/car-leasing/volvo/xc60/suv', '/car-leasing/volvo/xc60'],
    'audi-a5-avant': ['/car-leasing/audi/a5/avant'],
    'audi-s5-avant': ['/car-leasing/audi/a5/avant', '/car-leasing/audi/s5/avant'],
    'audi-rs5-avant': ['/car-leasing/audi/rs5/avant', '/car-leasing/audi/rs-5/avant'],
  },
  derivFilter: { 'audi-a5-avant': /^(?!.*\b(s5|rs ?5)\b)/i, 'audi-s5-avant': /\bs5\b/i },
  makePath: { BMW: '/car-leasing/bmw', 'Mercedes-Benz': '/car-leasing/mercedes-benz', Volvo: '/car-leasing/volvo', Audi: '/car-leasing/audi' },
  nextPage: (url, n) => `${url}?page=${n}`,
  isDerivative: (href, listingUrl) => looksLikeDerivative(href, listingUrl, 1),
};
export const scrape = ctx => driveSite(site, ctx);
