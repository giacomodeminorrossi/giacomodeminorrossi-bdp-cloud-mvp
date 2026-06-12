import crypto from 'node:crypto';
import { newBdpContext, closeQuietly } from '../browser/playwright.js';
import { saveStoredSession } from './session-store.js';

const BDP_HOME = 'https://bdp.giustizia.it/';
const BDP_SEARCH = 'https://bdp.giustizia.it/search/standard?target=provvedimento';
const flows = new Map();
const FLOW_TTL_MS = Number(process.env.CIE_FLOW_TTL_MS || 15 * 60 * 1000);

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
  await page.waitForLoadState('domcontentloaded').catch(() => {});
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
  const image = await page.screenshot({ type: 'png', fullPage: false });
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

async function assertAuthenticatedAndSave(flow) {
  await flow.page.goto(BDP_SEARCH, { waitUntil: 'domcontentloaded' });
  await flow.page.waitForTimeout(1500);
  const url = flow.page.url();
  if (!url.includes('bdp.giustizia.it') || looksLikeLoginUrl(url)) {
    return {
      ok: false,
      authenticated: false,
      message: 'The browser is not authenticated on BDP yet. Complete the CIE flow, then click Finish again.',
      screenshot: await screenshotPayload(flow.page)
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
  await cleanupExpired();
  for (const [id, flow] of flows.entries()) {
    if (flow.userId === userId) {
      flows.delete(id);
      await closeQuietly(flow.context, flow.browser);
    }
  }
  const id = crypto.randomUUID();
  const { browser, context, page } = await newBdpContext();
  const flow = { id, userId, browser, context, page, createdAt: now() };
  flows.set(id, flow);
  await page.goto(BDP_HOME, { waitUntil: 'domcontentloaded' });
  await tryAdvanceToCie(page);
  return {
    ok: true,
    flowId: id,
    message: 'Login browser started in the cloud. Use the screen image below; scan the CIE QR code with your phone if it appears.',
    screenshot: await screenshotPayload(page)
  };
}

export async function getCieScreenshot(userId, flowId) {
  const flow = getFlow(userId, flowId);
  return { ok: true, screenshot: await screenshotPayload(flow.page) };
}

export async function clickCiePage(userId, flowId, { x, y }) {
  const flow = getFlow(userId, flowId);
  await flow.page.mouse.click(x, y);
  await flow.page.waitForTimeout(800);
  return { ok: true, screenshot: await screenshotPayload(flow.page) };
}

export async function typeCieText(userId, flowId, text) {
  const flow = getFlow(userId, flowId);
  await flow.page.keyboard.type(text);
  await flow.page.waitForTimeout(500);
  return { ok: true, screenshot: await screenshotPayload(flow.page) };
}

export async function pressCieKey(userId, flowId, key) {
  const flow = getFlow(userId, flowId);
  await flow.page.keyboard.press(key);
  await flow.page.waitForTimeout(500);
  return { ok: true, screenshot: await screenshotPayload(flow.page) };
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
