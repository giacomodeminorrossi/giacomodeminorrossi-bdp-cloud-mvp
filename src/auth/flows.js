import crypto from 'node:crypto';
import { newBdpContext, closeQuietly } from '../browser/playwright.js';
import { saveStoredSession } from './session-store.js';

const BDP_HOME = 'https://bdp.giustizia.it/';
const BDP_SEARCH = 'https://bdp.giustizia.it/search/standard?target=provvedimento';
const flows = new Map();
const FLOW_TTL_MS = Number(process.env.CIE_FLOW_TTL_MS || 15 * 60 * 1000);
const BDP_GOTO_TIMEOUT_MS = Number(process.env.BDP_GOTO_TIMEOUT_MS || 20000);
const BDP_GOTO_WAIT_UNTIL = process.env.BDP_GOTO_WAIT_UNTIL || 'commit';

function now() {
  return Date.now();
}

function isExpired(flow) {
  return now() - flow.createdAt > FLOW_TTL_MS;
}

async function cleanupExpired() {
  for (const [id, flow] of flows.entries()) {
    if (isExpired(flow)) {
      flows.delete(id);
      await closeQuietly(flow.context, flow.browser);
    }
  }
}

function getFlow(userId, flowId) {
  const flow = flows.get(flowId);
  if (!flow || flow.userId !== userId) {
    const err = new Error('CIE flow not found. Start a new login flow.');
    err.statusCode = 404;
    throw err;
  }
  if (isExpired(flow)) {
    flows.delete(flowId);
    closeQuietly(flow.context, flow.browser);
    const err = new Error('CIE flow expired. Start a new login flow.');
    err.statusCode = 410;
    throw err;
  }
  return flow;
}

async function tryClick(locator) {
  try {
    await locator.first().click({ timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function tryAdvanceToCie(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  const loginClicked = await tryClick(page.getByRole('button', { name: /accedi|login|entra/i }))
    || await tryClick(page.getByRole('link', { name: /accedi|login|entra/i }))
    || await tryClick(page.locator('text=/Accedi|Login|Entra/i'));
  if (loginClicked) await page.waitForTimeout(1500);

  const cieClicked = await tryClick(page.getByRole('button', { name: /cie|carta/i }))
    || await tryClick(page.getByRole('link', { name: /cie|carta/i }))
    || await tryClick(page.locator('text=/CIE|Carta d/i'));
  if (cieClicked) await page.waitForTimeout(2500);
}

async function screenshotPayload(page) {
  console.error(`[cie:screenshot] capturing ${page.url()}`);
  const image = await page.screenshot({ type: 'png', fullPage: false, timeout: 15000 });
  const viewport = page.viewportSize() || { width: 1280, height: 900 };
  return {
    url: page.url(),
    imageBase64: image.toString('base64'),
    width: viewport.width,
    height: viewport.height,
    capturedAt: new Date().toISOString()
  };
}

function looksLikeLoginUrl(url) {
  return /login|idserver|servizicie|auth03|pst\.giustizia/i.test(url);
}

async function safeStopLoading(page) {
  try {
    await page.evaluate(() => window.stop());
  } catch {
    // The page may not have a document yet. Ignore.
  }
}

async function safeGoto(page, url, label, options = {}) {
  const timeout = Number(options.timeout || BDP_GOTO_TIMEOUT_MS);
  const waitUntil = options.waitUntil || BDP_GOTO_WAIT_UNTIL;
  try {
    console.error(`[cie:goto] ${label}: ${url}; waitUntil=${waitUntil}; timeout=${timeout}`);
    await page.goto(url, { waitUntil, timeout });
    console.error(`[cie:goto] ${label} arrived at ${page.url()}`);
    return { ok: true, url: page.url() };
  } catch (error) {
    console.error(`[cie:goto] ${label} warning`, error);
    await safeStopLoading(page);
    await page.waitForTimeout(750).catch(() => {});
    return {
      ok: false,
      error: error.message,
      name: error.name,
      url: typeof page?.url === 'function' ? page.url() : ''
    };
  }
}

async function safeTryAdvanceToCie(page) {
  try {
    await tryAdvanceToCie(page);
    console.error(`[cie:auto] after auto-advance url=${page.url()}`);
    return { ok: true };
  } catch (error) {
    console.error('[cie:auto] auto-advance to CIE failed', error);
    return { ok: false, error: error.message, name: error.name };
  }
}

async function safeScreenshotPayload(page) {
  try {
    return await screenshotPayload(page);
  } catch (error) {
    console.error('[cie:screenshot] failed', error);
    return {
      url: typeof page?.url === 'function' ? page.url() : '',
      imageBase64: '',
      width: 1280,
      height: 900,
      screenshotError: error.message,
      capturedAt: new Date().toISOString()
    };
  }
}

function assertAllowedNavigationUrl(rawUrl) {
  const url = new URL(rawUrl);
  const allowedHosts = new Set([
    'bdp.giustizia.it',
    'pst.giustizia.it',
    'idserver.servizicie.interno.gov.it',
    'servizicie.interno.gov.it'
  ]);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    const err = new Error('Navigation blocked. Only BDP, PST Giustizia, and official CIE login hosts are allowed.');
    err.statusCode = 400;
    throw err;
  }
  return url.toString();
}

async function assertAuthenticatedAndSave(flow) {
  const navigation = await safeGoto(flow.page, BDP_SEARCH, 'BDP search', { timeout: 30000, waitUntil: 'commit' });
  if (!navigation.ok) {
    return {
      ok: false,
      authenticated: false,
      message: `Could not navigate to BDP search: ${navigation.error}`,
      screenshot: await safeScreenshotPayload(flow.page)
    };
  }
  await flow.page.waitForTimeout(1500);
  const url = flow.page.url();
  if (!url.includes('bdp.giustizia.it') || looksLikeLoginUrl(url)) {
    return {
      ok: false,
      authenticated: false,
      message: 'The browser is not authenticated on BDP yet. Complete the CIE flow, then click Finish again.',
      screenshot: await safeScreenshotPayload(flow.page)
    };
  }
  const storageState = await flow.context.storageState();
  const saved = await saveStoredSession(flow.userId, storageState);
  flows.delete(flow.id);
  await closeQuietly(flow.context, flow.browser);
  return {
    ok: true,
    authenticated: true,
    savedAt: saved.savedAt,
    message: 'CIE session saved in encrypted cloud storage for this app user.'
  };
}

export async function startCieFlow(userId) {
  console.error(`[cie:start] requested for user ${userId}`);
  await cleanupExpired();
  for (const [id, flow] of flows.entries()) {
    if (flow.userId === userId) {
      flows.delete(id);
      await closeQuietly(flow.context, flow.browser);
    }
  }

  const id = crypto.randomUUID();
  let browser;
  let context;
  let page;
  try {
    console.error('[cie:start] launching Chromium');
    ({ browser, context, page } = await newBdpContext());
    console.error('[cie:start] Chromium launched');
  } catch (error) {
    console.error('[cie:start] failed to launch Playwright/Chromium', error);
    const err = new Error(`Cloud browser could not start: ${error.message}`);
    err.statusCode = 503;
    throw err;
  }

  const flow = { id, userId, browser, context, page, createdAt: now() };
  flows.set(id, flow);

  const warnings = [];
  const navigation = await safeGoto(page, BDP_HOME, 'BDP home', { timeout: BDP_GOTO_TIMEOUT_MS, waitUntil: BDP_GOTO_WAIT_UNTIL });
  if (!navigation.ok) warnings.push(`BDP navigation warning: ${navigation.error}`);

  if (navigation.ok) {
    const advance = await safeTryAdvanceToCie(page);
    if (!advance.ok) warnings.push(`Auto-click warning: ${advance.error}`);
  } else {
    warnings.push('Automatic login click was skipped because the BDP homepage did not finish its first response. Try Refresh screenshot or Open BDP home.');
  }

  return {
    ok: true,
    flowId: id,
    warnings,
    message: warnings.length
      ? 'Cloud browser started, but BDP/CIE navigation had warnings. Use Refresh screenshot or Open BDP home, then click manually.'
      : 'Login browser started in the cloud. Use the screen image below; scan the CIE QR code with your phone if it appears.',
    screenshot: await safeScreenshotPayload(page)
  };
}

export async function getCieScreenshot(userId, flowId) {
  const flow = getFlow(userId, flowId);
  return { ok: true, screenshot: await safeScreenshotPayload(flow.page) };
}

export async function navigateCiePage(userId, flowId, rawUrl) {
  const flow = getFlow(userId, flowId);
  const url = assertAllowedNavigationUrl(rawUrl);
  const navigation = await safeGoto(flow.page, url, 'manual navigation', { timeout: 30000, waitUntil: 'commit' });
  return {
    ok: true,
    navigation,
    screenshot: await safeScreenshotPayload(flow.page)
  };
}

export async function clickCiePage(userId, flowId, { x, y }) {
  const flow = getFlow(userId, flowId);
  await flow.page.mouse.click(x, y);
  await flow.page.waitForTimeout(800);
  return { ok: true, screenshot: await safeScreenshotPayload(flow.page) };
}

export async function typeCieText(userId, flowId, text) {
  const flow = getFlow(userId, flowId);
  await flow.page.keyboard.type(text);
  await flow.page.waitForTimeout(500);
  return { ok: true, screenshot: await safeScreenshotPayload(flow.page) };
}

export async function pressCieKey(userId, flowId, key) {
  const flow = getFlow(userId, flowId);
  await flow.page.keyboard.press(key);
  await flow.page.waitForTimeout(500);
  return { ok: true, screenshot: await safeScreenshotPayload(flow.page) };
}

export async function finishCieFlow(userId, flowId) {
  const flow = getFlow(userId, flowId);
  return assertAuthenticatedAndSave(flow);
}

export async function cancelCieFlow(userId, flowId) {
  const flow = getFlow(userId, flowId);
  flows.delete(flowId);
  await closeQuietly(flow.context, flow.browser);
}
