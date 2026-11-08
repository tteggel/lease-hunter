// Carparison Leasing — drives the public site in your own visible browser (local only; it refuses cloud traffic).
// URL shapes (search-engine results, Nov 2026): /personal-leasing/cars/bmw/3-series/touring
// UNVERIFIED against the live site. Run with DISCOVER=1 to dump pages for tuning.
import { driveSite } from '../lib/sitedriver.mjs';
import { looksLikeDerivative, LOCAL_ONLY_NOTE } from '../lib/sitecommon.mjs';

export const meta = { id: 'carparison', name: 'Carparison Leasing', url: 'https://www.carparisonleasing.co.uk', method: 'browser (local)', localOnly: true, homeIpRecommended: true, note: LOCAL_ONLY_NOTE };

const P = '/personal-leasing/cars';
const site = {
  id: meta.id, name: meta.name, base: 'https://www.carparisonleasing.co.uk',
  listing: {
    'bmw-3-touring': [`${P}/bmw/3-series/touring`],
    'bmw-x3': [`${P}/bmw/x3`],
    'merc-c-estate': [`${P}/mercedes-benz/c-class/estate`, `${P}/mercedes/c-class/estate`],
    'volvo-xc60': [`${P}/volvo/xc60`],
    'audi-a5-avant': [`${P}/audi/a5/avant`],
    'audi-s5-avant': [`${P}/audi/s5/avant`, `${P}/audi/a5/avant`],
    'audi-rs5-avant': [`${P}/audi/rs5/avant`, `${P}/audi/rs-5/avant`],
  },
  derivFilter: { 'audi-a5-avant': /^(?!.*\b(s5|rs ?5)\b)/i, 'audi-s5-avant': /\bs5\b/i },
  makePath: { BMW: `${P}/bmw`, 'Mercedes-Benz': `${P}/mercedes-benz`, Volvo: `${P}/volvo`, Audi: `${P}/audi` },
  nextPage: (url, n) => `${url}?page=${n}`,
  isDerivative: (href, listingUrl) => looksLikeDerivative(href, listingUrl, 2),
};
export const scrape = ctx => driveSite(site, ctx);
