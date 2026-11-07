// Nationwide Vehicle Contracts — drives the public site in your own visible browser (local only).
// URL shapes (from search-engine results, Nov 2026): /car-leasing/bmw/3-series/touring  ->  /car-leasing/bmw/3-series/touring/320d-mht-se-step-auto
// Listing pages paginate with ?page=N. NVC charges a processing fee on personal deals; picked up when the page states it.
// UNVERIFIED against the live site from the build machine. Run with DISCOVER=1 to dump pages for tuning.
import { driveSite } from '../lib/sitedriver.mjs';
import { looksLikeDerivative, LOCAL_ONLY_NOTE } from '../lib/sitecommon.mjs';

export const meta = { id: 'nationwide', name: 'Nationwide Vehicle Contracts', url: 'https://www.nationwidevehiclecontracts.co.uk', method: 'browser (local)', localOnly: true, homeIpRecommended: true, note: LOCAL_ONLY_NOTE };

const site = {
  id: meta.id, name: meta.name, base: 'https://www.nationwidevehiclecontracts.co.uk',
  listing: {
    'bmw-3-touring': ['/car-leasing/bmw/3-series/touring'],
    'bmw-x3': ['/car-leasing/bmw/x3', '/car-leasing/bmw/x3/estate'],
    'merc-c-estate': ['/car-leasing/mercedes-benz/c-class/estate', '/car-leasing/mercedes/c-class/estate'],
    'volvo-xc60': ['/car-leasing/volvo/xc60', '/car-leasing/volvo/xc60/estate'],
    'audi-a5-avant': ['/car-leasing/audi/a5/avant', '/car-leasing/audi/a5/estate'],
    'audi-s5-avant': ['/car-leasing/audi/s5/avant', '/car-leasing/audi/a5/s5-avant'],
    'audi-rs5-avant': ['/car-leasing/audi/rs5/avant', '/car-leasing/audi/rs-5/avant', '/car-leasing/audi/a5/rs5-avant'],
  },
  makePath: { BMW: '/car-leasing/bmw', 'Mercedes-Benz': '/car-leasing/mercedes-benz', Volvo: '/car-leasing/volvo', Audi: '/car-leasing/audi' },
  nextPage: (url, n) => `${url}?page=${n}`,
  isDerivative: (href, listingUrl) => looksLikeDerivative(href, listingUrl, 1),
};
export const scrape = ctx => driveSite(site, ctx);
