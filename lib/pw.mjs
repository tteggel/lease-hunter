// Resolve Playwright whether installed locally (laptop: `npm i`) or globally (cloud box).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const globalRoot = execSync('npm root -g').toString().trim();
  const req = createRequire(path.join(globalRoot, 'noop.js'));
  return req('playwright');
}

/**
 * Find a Chromium inside PLAYWRIGHT_BROWSERS_PATH (e.g. the Nix dev shell's playwright-driver.browsers)
 * regardless of revision, so a small npm-vs-nixpkgs Playwright version mismatch still launches.
 */
function nixChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse();
  const rel = ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-x64/Chromium.app/Contents/MacOS/Chromium'];
  for (const d of dirs) for (const r of rel) { const p = path.join(root, d, r); if (fs.existsSync(p)) return p; }
  return null;
}

/**
 * Launch a browser. On a laptop, use a visible window:
 *   HEADED=1 node run.mjs                  (Playwright's / the Nix shell's Chromium)
 *   HEADED=1 CHANNEL=chrome node run.mjs   (your installed Google Chrome)
 *   HEADED=1 CHROME_PATH=/path/to/chrome   (any specific binary)
 * A persistent profile (PROFILE_DIR) keeps cookie-consent choices between runs.
 */
export async function launch({ headed = !!process.env.HEADED, channel = process.env.CHANNEL } = {}) {
  const { chromium } = await loadPlaywright();
  const opts = { headless: !headed };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;   // any Chrome/Chromium binary
  else if (channel) opts.channel = channel;                                      // e.g. 'chrome' = installed Google Chrome
  else if (!fs.existsSync(chromium.executablePath()) && nixChromium()) opts.executablePath = nixChromium();
  const start = async o => {
    if (process.env.PROFILE_DIR) {
      const ctx = await chromium.launchPersistentContext(process.env.PROFILE_DIR, { ...o, locale: 'en-GB', viewport: { width: 1400, height: 900 } });
      return { browser: null, context: ctx, close: () => ctx.close() };
    }
    const browser = await chromium.launch(o);
    const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1400, height: 900 } });
    return { browser, context, close: () => browser.close() };
  };
  try {
    return await start(opts);
  } catch (e) {
    // A requested browser that isn't installed (e.g. CHANNEL=chrome on NixOS) shouldn't stop the run.
    if (!/is not found at|Executable doesn't exist|Failed to launch/i.test(e.message) || (!opts.channel && !opts.executablePath)) throw e;
    const { channel, executablePath, ...rest } = opts;
    const fb = fs.existsSync(chromium.executablePath()) ? null : nixChromium();
    console.warn(`[browser] ${opts.channel ? `CHANNEL=${opts.channel}` : `CHROME_PATH=${opts.executablePath}`} could not be launched; using Chromium at ${fb || chromium.executablePath()} instead.`);
    return start(fb ? { ...rest, executablePath: fb } : rest);
  }
}
