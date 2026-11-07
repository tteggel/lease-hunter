// Leasing.com (aggregator; Contract Hire and Leasing now redirects here) — drives the public site in your own visible browser (local only).
// URL shapes (from search-engine results, Nov 2026): /car-leasing/bmw/3-series/touring/  (personal; /business/ prefix = business), pages: /page2/
// Each derivative lists offers from several brokers with their own fees. The page reader takes the headline offer; the JSON walker
// picks up every broker's quote if the page loads them as JSON.
// UNVERIFIED against the live site from the build machine. Run with DISCOVER=1 to dump pages for tuning.
import { driveSite } from '../lib/sitedriver.mjs';
import { looksLikeDerivative, LOCAL_ONLY_NOTE } from '../lib/sitecommon.mjs';

export const meta = { id: 'leasingcom', name: 'Leasing.com', url: 'https://leasing.com', method: 'browser (local)', localOnly: true, homeIpRecommended: true, note: LOCAL_ONLY_NOTE };

const site = {
  id: meta.id, name: meta.name, base: 'https://leasing.com',
  listing: {
    'bmw-3-touring': ['/car-leasing/bmw/3-series/touring/'],
    'bmw-x3': ['/car-leasing/bmw/x3/'],
    'merc-c-estate': ['/car-leasing/mercedes-benz/c-class/estate/'],
    'volvo-xc60': ['/car-leasing/volvo/xc60/'],
    'audi-a5-avant': ['/car-leasing/audi/a5/avant/'],
    'audi-s5-avant': ['/car-leasing/audi/s5/avant/', '/car-leasing/audi/s5/'],
    'audi-rs5-avant': ['/car-leasing/audi/rs5/avant/', '/car-leasing/audi/rs5/'],
  },
  makePath: { BMW: '/car-leasing/bmw/', 'Mercedes-Benz': '/car-leasing/mercedes-benz/', Volvo: '/car-leasing/volvo/', Audi: '/car-leasing/audi/' },
  nextPage: (url, n) => url.replace(/\/?$/, '/') + `page${n}/`,
  isDerivative: (href, listingUrl) => !/\/business\//.test(href) && looksLikeDerivative(href, listingUrl, 2),
};
export const scrape = ctx => driveSite(site, ctx);
