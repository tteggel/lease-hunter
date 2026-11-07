// Resolve Playwright whether installed locally (laptop: `npm i`) or globally (cloud box).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

export async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const globalRoot = execSync('npm root -g').toString().trim();
  const req = createRequire(path.join(globalRoot, 'noop.js'));
  return req('playwright');
}

/**
 * Launch a browser. On a laptop use headed + real Chrome channel for best bot-check survival:
 *   HEADED=1 CHANNEL=chrome node run.mjs
 * A persistent profile (PROFILE_DIR) keeps cookie-consent choices between runs.
 */
export async function launch({ headed = !!process.env.HEADED, channel = process.env.CHANNEL } = {}) {
  const { chromium } = await loadPlaywright();
  const opts = { headless: !headed };
  if (channel) opts.channel = channel;
  if (process.env.PROFILE_DIR) {
    const ctx = await chromium.launchPersistentContext(process.env.PROFILE_DIR, { ...opts, locale: 'en-GB', viewport: { width: 1400, height: 900 } });
    return { browser: null, context: ctx, close: () => ctx.close() };
  }
  const browser = await chromium.launch(opts);
  const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1400, height: 900 } });
  return { browser, context, close: () => browser.close() };
}
