import dns from 'node:dns/promises';
import https from 'node:https';
import { newBdpContext, closeQuietly } from '../browser/playwright.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.DEBUG_NETWORK_TIMEOUT_MS || 20000);
const ALLOWED_DEBUG_HOSTS = new Set([
  'bdp.giustizia.it',
  'pst.giustizia.it',
  'idserver.servizicie.interno.gov.it',
  'servizicie.interno.gov.it',
  'example.com'
]);

function sanitizeDebugUrl(rawUrl) {
  const url = new URL(rawUrl || 'https://bdp.giustizia.it/');
  if (url.protocol !== 'https:' || !ALLOWED_DEBUG_HOSTS.has(url.hostname)) {
    const err = new Error('Debug URL blocked. Allowed hosts: BDP, PST Giustizia, official CIE hosts, and example.com.');
    err.statusCode = 400;
    throw err;
  }
  return url;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function dnsLookup(hostname, timeoutMs) {
  const started = Date.now();
  try {
    const addresses = await withTimeout(dns.lookup(hostname, { all: true }), timeoutMs, 'DNS lookup');
    return { ok: true, ms: Date.now() - started, addresses };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error.message, name: error.name, code: error.code };
  }
}

async function nodeHttpsRequest(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 BDP-Cloud-MVP network diagnostic',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
      }
    }, (res) => {
      let bytes = 0;
      let sample = Buffer.alloc(0);
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (sample.length < 512) sample = Buffer.concat([sample, chunk]).subarray(0, 512);
        if (bytes > 4096) req.destroy();
      });
      res.on('end', () => resolve({
        ok: true,
        ms: Date.now() - started,
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        headers: {
          server: res.headers.server,
          location: res.headers.location,
          contentType: res.headers['content-type'],
          contentLength: res.headers['content-length']
        },
        bytesRead: bytes,
        bodySample: sample.toString('utf8').replace(/\s+/g, ' ').slice(0, 300)
      }));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`HTTPS request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (error) => resolve({
      ok: false,
      ms: Date.now() - started,
      error: error.message,
      name: error.name,
      code: error.code
    }));
    req.end();
  });
}

async function browserGoto(url, timeoutMs) {
  const started = Date.now();
  let browser;
  let context;
  const requestFailures = [];
  const responses = [];
  try {
    const opened = await newBdpContext();
    browser = opened.browser;
    context = opened.context;
    const page = opened.page;
    page.on('requestfailed', (request) => {
      if (requestFailures.length < 10) {
        requestFailures.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText || '' });
      }
    });
    page.on('response', (response) => {
      if (responses.length < 10) responses.push({ url: response.url(), status: response.status(), statusText: response.statusText() });
    });
    const response = await page.goto(url.toString(), { waitUntil: 'commit', timeout: timeoutMs });
    await page.waitForTimeout(1200).catch(() => {});
    const title = await page.title().catch(() => '');
    const bodyPreview = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    return {
      ok: true,
      ms: Date.now() - started,
      finalUrl: page.url(),
      status: response?.status?.() ?? null,
      statusText: response?.statusText?.() ?? '',
      title,
      bodyPreview: String(bodyPreview || '').replace(/\s+/g, ' ').slice(0, 500),
      requestFailures,
      responses
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: error.message,
      name: error.name,
      code: error.code,
      requestFailures,
      responses
    };
  } finally {
    await closeQuietly(context, browser);
  }
}

function interpretDiagnostics(dnsResult, nodeResult, browserResult) {
  if (!dnsResult.ok) return 'DNS lookup failed from the cloud service. This is a cloud/network resolution problem before BDP or CIE authentication.';
  if (!nodeResult.ok && !browserResult.ok) return 'Both Node HTTPS and Chromium failed from the cloud service. This points to egress/network reachability, hosting region, or destination-side blocking of this cloud provider/IP range.';
  if (nodeResult.ok && !browserResult.ok) return 'The server can reach the site over HTTPS, but Chromium cannot. This points to browser/headless/WAF behavior or Chromium-specific networking.';
  if (!nodeResult.ok && browserResult.ok) return 'Chromium can reach the site even though Node HTTPS failed. Continue with the CIE flow and treat Node diagnostics as secondary.';
  return 'Both Node HTTPS and Chromium reached the target. If the app still fails, the next issue is likely page selectors or the CIE interaction flow.';
}

export async function diagnoseUrl(rawUrl) {
  const url = sanitizeDebugUrl(rawUrl);
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  const dns = await dnsLookup(url.hostname, Math.min(timeoutMs, 10000));
  const nodeHttps = await nodeHttpsRequest(url, timeoutMs);
  const browserChromium = await browserGoto(url, timeoutMs);
  return {
    ok: true,
    startedAt,
    url: url.toString(),
    host: url.hostname,
    timeoutMs,
    interpretation: interpretDiagnostics(dns, nodeHttps, browserChromium),
    dns,
    nodeHttps,
    browserChromium
  };
}
