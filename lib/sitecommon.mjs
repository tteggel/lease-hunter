// Shared helpers for local-only site configs.
export const segsAfter = (href, listingUrl) => {
  const a = href.split('?')[0].replace(/\/$/, ''), b = listingUrl.split('?')[0].replace(/\/$/, '');
  if (!a.startsWith(b + '/')) return null;
  return a.slice(b.length + 1).split('/').filter(Boolean);
};
/** A derivative link sits 1-2 path segments under the listing and looks like a spec slug ("330e-m-sport-5dr-step-auto"). */
export const looksLikeDerivative = (href, listingUrl, maxDepth = 2) => {
  const s = segsAfter(href, listingUrl);
  if (!s || s.length < 1 || s.length > maxDepth) return false;
  const last = s[s.length - 1];
  return last.length > 8 && /\d|auto|manual|\bdr\b/i.test(last) && !/^page\d+$|^(reviews?|faq|news|guides?|compare|offers|deals)$/i.test(last);
};
export const LOCAL_ONLY_NOTE = 'Runs on your laptop in a visible browser (HEADED=1). If the site asks you to verify, complete it in the window and the run continues.';
