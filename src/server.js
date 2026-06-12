import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { loginHandler, requireAppAuth, logoutHandler, meHandler } from './security/app-auth.js';
import { startCieFlow, getCieScreenshot, clickCiePage, typeCieText, pressCieKey, finishCieFlow, cancelCieFlow } from './auth/flows.js';
import { hasStoredSession, deleteStoredSession } from './auth/session-store.js';
import { checkBdpSession, searchBdp, readBdpDocument } from './bdp/client.js';

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

app.use((err, _req, res, _next) => {
  const status = err.statusCode || err.status || 500;
  const message = status >= 500 ? 'Internal server error' : err.message;
  if (status >= 500) console.error(err);
  res.status(status).json({ ok: false, error: message });
});

app.listen(port, () => {
  console.error(`[bdp-cloud-mvp] listening on port ${port}`);
});
