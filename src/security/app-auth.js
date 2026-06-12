import crypto from 'node:crypto';

const COOKIE_NAME = 'bdp_cloud_token';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return null;
    const key = decodeURIComponent(part.slice(0, index).trim());
    const value = decodeURIComponent(part.slice(index + 1).trim());
    return [key, value];
  }).filter(Boolean));
}

function cookieSecret() {
  const secret = process.env.COOKIE_SECRET || process.env.SESSION_ENCRYPTION_KEY || 'dev-cookie-secret-change-me';
  return Buffer.from(secret);
}

function configuredPassword() {
  return process.env.APP_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'change-me-now');
}

function sanitizeUserId(value) {
  const raw = String(value || 'default').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9._@-]/g, '_').slice(0, 120);
  return cleaned || 'default';
}

function sign(payload) {
  return crypto.createHmac('sha256', cookieSecret()).update(payload).digest('base64url');
}

function createToken(userId) {
  const payload = Buffer.from(JSON.stringify({
    sub: sanitizeUserId(userId),
    exp: Date.now() + ONE_DAY_MS
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!data.exp || Date.now() > data.exp) return null;
  return { sub: sanitizeUserId(data.sub), exp: data.exp };
}

function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export async function loginHandler(req, res) {
  const password = String(req.body?.password || '');
  const userId = sanitizeUserId(req.body?.userId || 'default');
  const expected = configuredPassword();
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'APP_PASSWORD is required in production.' });
  }
  const passwordBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(expected);
  const ok = passwordBuf.length === expectedBuf.length && crypto.timingSafeEqual(passwordBuf, expectedBuf);
  if (!ok) return res.status(401).json({ ok: false, error: 'Invalid password.' });
  const token = createToken(userId);
  setAuthCookie(res, token);
  res.json({ ok: true, user: { sub: userId } });
}

export async function logoutHandler(_req, res) {
  clearAuthCookie(res);
  res.json({ ok: true });
}

export async function requireAppAuth(req, res, next) {
  const cookies = parseCookies(req);
  const user = verifyToken(cookies[COOKIE_NAME]);
  if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
  req.user = user;
  next();
}

export async function meHandler(req, res) {
  res.json({ ok: true, user: req.user });
}
