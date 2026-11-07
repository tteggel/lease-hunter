// Select Car Leasing — drives the public site in your own visible browser (local only).
// URL shapes (from search-engine results, Nov 2026): /car-leasing/bmw/3-series/touring/330e-223-kwh-m-sport-5dr-step-auto?term=36
// Select charges an admin fee shown on the deal page ("Plus admin fee"); readDisplayedDeal picks it up when stated.
// UNVERIFIED against the live site from the build machine (it refuses datacenter traffic). Run with DISCOVER=1 to dump pages for tuning.
import { driveSite } from '../lib/sitedriver.mjs';
import { looksLikeDerivative, LOCAL_ONLY_NOTE } from '../lib/sitecommon.mjs';

export const meta = { id: 'selectcarleasing', name: 'Select Car Leasing', url: 'https://www.selectcarleasing.co.uk', method: 'browser (local)', localOnly: true, homeIpRecommended: true, note: LOCAL_ONLY_NOTE };

const site = {
  id: meta.id, name: meta.name, base: 'https://www.selectcarleasing.co.uk',
  listing: {
    'bmw-3-touring': ['/car-leasing/bmw/3-series/touring', '/car-leasing/bmw/3-series/estate'],
    'bmw-x3': ['/car-leasing/bmw/x3'],
    'merc-c-estate': ['/car-leasing/mercedes-benz/c-class/estate', '/car-leasing/mercedes/c-class/estate'],
    'volvo-xc60': ['/car-leasing/volvo/xc60'],
    'audi-a5-avant': ['/car-leasing/audi/a5/avant', '/car-leasing/audi/a5/estate'],
    'audi-s5-avant': ['/car-leasing/audi/s5/avant', '/car-leasing/audi/s5/estate'],
    'audi-rs5-avant': ['/car-leasing/audi/rs5/avant', '/car-leasing/audi/rs-5/avant', '/car-leasing/audi/rs5/estate'],
  },
  makePath: { BMW: '/car-leasing/bmw', 'Mercedes-Benz': '/car-leasing/mercedes-benz', Volvo: '/car-leasing/volvo', Audi: '/car-leasing/audi' },
  nextPage: (url, n) => `${url}?page=${n}`,
  isDerivative: (href, listingUrl) => looksLikeDerivative(href, listingUrl, 2),
};
export const scrape = ctx => driveSite(site, ctx);
