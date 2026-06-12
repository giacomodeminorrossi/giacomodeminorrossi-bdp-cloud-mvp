import { chromium } from 'playwright';

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

export async function launchBdpBrowser() {
  return chromium.launch({
    headless: true,
    timeout: Number(process.env.PLAYWRIGHT_LAUNCH_TIMEOUT_MS || 60000),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-zygote'
    ]
  });
}

export async function newBdpContext(storageState = null) {
  const browser = await launchBdpBrowser();
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    storageState: storageState || undefined
  });
  context.setDefaultTimeout(Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 30000));
  context.setDefaultNavigationTimeout(Number(process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || 45000));
  const page = await context.newPage();
  return { browser, context, page };
}

export async function closeQuietly(...items) {
  for (const item of items) {
    try {
      if (item && typeof item.close === 'function') await item.close();
    } catch {
      // ignore shutdown errors
    }
  }
}
