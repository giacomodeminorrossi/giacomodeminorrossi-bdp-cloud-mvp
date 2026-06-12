import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { loginHandler, requireAppAuth, logoutHandler, meHandler } from './security/app-auth.js';
import { startCieFlow, getCieScreenshot, navigateCiePage, clickCiePage, typeCieText, pressCieKey, finishCieFlow, cancelCieFlow } from './auth/flows.js';
import { hasStoredSession, deleteStoredSession } from './auth/session-store.js';
import { checkBdpSession, searchBdp, readBdpDocument } from './bdp/client.js';
import { newBdpContext, closeQuietly } from './browser/playwright.js';
import { diagnoseUrl } from './debug/network.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "img-src": ["'self'", 'data:'],
      "script-src": ["'self'"],
      "connect-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"]
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.post('/api/login', asyncHandler(loginHandler));
app.post('/api/logout', asyncHandler(logoutHandler));
app.get('/api/me', asyncHandler(requireAppAuth), asyncHandler(meHandler));

app.get('/api/debug/browser', asyncHandler(requireAppAuth), asyncHandler(async (_req, res) => {
  let browser;
  let context;
  try {
    const opened = await newBdpContext();
    browser = opened.browser;
    context = opened.context;
    const page = opened.page;
    await page.goto('data:text/html,<html><body><h1>Playwright OK</h1></body></html>', { waitUntil: 'domcontentloaded' });
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    res.json({
      ok: true,
      message: 'Cloud Chromium launched and captured a screenshot successfully.',
      screenshotBytes: screenshot.length
    });
  } finally {
    await closeQuietly(context, browser);
  }
}));

app.get('/api/debug/network', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const target = typeof req.query.url === 'string' && req.query.url ? req.query.url : 'https://bdp.giustizia.it/';
  const result = await diagnoseUrl(target);
  res.json(result);
}));

app.get('/api/debug/bdp', asyncHandler(requireAppAuth), asyncHandler(async (_req, res) => {
  const result = await diagnoseUrl('https://bdp.giustizia.it/');
  res.json(result);
}));


app.get('/api/debug/bdp-network', asyncHandler(requireAppAuth), asyncHandler(async (_req, res) => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('https://bdp.giustizia.it/', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 BDP Cloud MVP network diagnostic'
      }
    });
    const text = await response.text();
    res.json({
      ok: true,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      elapsedMs: Date.now() - startedAt,
      bodySample: text.slice(0, 300)
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message,
      name: error.name,
      elapsedMs: Date.now() - startedAt,
      message: 'The Render service could not fetch the BDP homepage from its cloud network.'
    });
  } finally {
    clearTimeout(timer);
  }
}));


app.get('/api/session', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  res.json({ hasStoredSession: await hasStoredSession(req.user.sub) });
}));

app.delete('/api/session', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  await deleteStoredSession(req.user.sub);
  res.json({ ok: true });
}));

app.post('/api/cie/start', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const result = await startCieFlow(req.user.sub);
  res.json(result);
}));

app.get('/api/cie/:flowId/screenshot', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const result = await getCieScreenshot(req.user.sub, req.params.flowId);
  res.json(result);
}));


app.post('/api/cie/:flowId/navigate', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const body = z.object({ url: z.string().url() }).parse(req.body);
  const result = await navigateCiePage(req.user.sub, req.params.flowId, body.url);
  res.json(result);
}));

app.post('/api/cie/:flowId/click', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const body = z.object({ x: z.number(), y: z.number() }).parse(req.body);
  const result = await clickCiePage(req.user.sub, req.params.flowId, body);
  res.json(result);
}));

app.post('/api/cie/:flowId/type', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const body = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
  const result = await typeCieText(req.user.sub, req.params.flowId, body.text);
  res.json(result);
}));

app.post('/api/cie/:flowId/key', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const body = z.object({ key: z.string().min(1).max(40) }).parse(req.body);
  const result = await pressCieKey(req.user.sub, req.params.flowId, body.key);
  res.json(result);
}));

app.post('/api/cie/:flowId/finish', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const result = await finishCieFlow(req.user.sub, req.params.flowId);
  res.json(result);
}));

app.delete('/api/cie/:flowId', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  await cancelCieFlow(req.user.sub, req.params.flowId);
  res.json({ ok: true });
}));

app.post('/api/bdp/session/check', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const result = await checkBdpSession(req.user.sub);
  res.json(result);
}));

app.post('/api/bdp/search', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const input = z.object({
    query: z.string().min(1).max(500),
    court: z.string().max(200).optional().default(''),
    district: z.string().max(200).optional().default(''),
    type: z.string().max(100).optional().default(''),
    dateFrom: z.string().max(30).optional().default(''),
    dateTo: z.string().max(30).optional().default(''),
    maxResults: z.number().int().min(1).max(30).optional().default(10)
  }).parse(req.body);
  const result = await searchBdp(req.user.sub, input);
  res.json(result);
}));

app.post('/api/bdp/read', asyncHandler(requireAppAuth), asyncHandler(async (req, res) => {
  const input = z.object({
    url: z.string().url(),
    maxCharacters: z.number().int().min(1000).max(100000).optional().default(40000)
  }).parse(req.body);
  const result = await readBdpDocument(req.user.sub, input);
  res.json(result);
}));

app.use((err, req, res, _next) => {
  const status = err.statusCode || err.status || 500;
  const requestId = Math.random().toString(36).slice(2, 10);
  if (status >= 500) {
    console.error(`[${requestId}] ${req.method} ${req.originalUrl}`);
    console.error(err);
  }
  const showDetails = process.env.SHOW_ERROR_DETAILS === 'true' || process.env.NODE_ENV !== 'production';
  const message = status >= 500 && !showDetails ? 'Internal server error' : err.message;
  res.status(status).json({
    ok: false,
    error: message,
    requestId,
    details: showDetails ? {
      name: err.name,
      stack: err.stack?.split('\n').slice(0, 8).join('\n')
    } : undefined
  });
});

app.listen(port, () => {
  console.error(`[bdp-cloud-mvp] listening on port ${port}`);
});
