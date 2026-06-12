import { loadStoredSession } from '../auth/session-store.js';
import { newBdpContext, closeQuietly } from '../browser/playwright.js';

const BDP_HOST = 'bdp.giustizia.it';
const BDP_SEARCH = 'https://bdp.giustizia.it/search/standard?target=provvedimento';

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isLoginUrl(url) {
  return /login|idserver|servizicie|auth03|pst\.giustizia/i.test(url || '');
}

function ensureBdpUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname !== BDP_HOST) {
    const err = new Error('Only bdp.giustizia.it URLs can be opened by this service.');
    err.statusCode = 400;
    throw err;
  }
  return url.toString();
}

async function withAuthenticatedPage(userId, work) {
  const storageState = await loadStoredSession(userId);
  if (!storageState) {
    const err = new Error('No encrypted BDP session exists for this app user. Run CIE login first.');
    err.statusCode = 409;
    throw err;
  }
  const { browser, context, page } = await newBdpContext(storageState);
  try {
    return await work(page, context);
  } finally {
    await closeQuietly(context, browser);
  }
}

async function verifyNotRedirectedToLogin(page) {
  const url = page.url();
  if (!url.includes(BDP_HOST) || isLoginUrl(url)) {
    const err = new Error('Stored BDP session appears to be expired. Run CIE login again.');
    err.statusCode = 401;
    throw err;
  }
}

async function fillFirst(page, selectors, value) {
  if (!value) return false;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.fill(value, { timeout: 2000 });
        return true;
      }
    } catch {
      // try next selector
    }
  }
  return false;
}

async function selectOptionLike(page, selectSelectors, wantedText) {
  if (!wantedText) return false;
  const needle = wantedText.toLowerCase();
  for (const selector of selectSelectors) {
    const select = page.locator(selector).first();
    try {
      if (!(await select.count())) continue;
      const options = await select.locator('option').evaluateAll((nodes) => nodes.map((node) => ({
        value: node.getAttribute('value') || '',
        label: node.textContent || ''
      })));
      const match = options.find((option) => option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle));
      if (match) {
        await select.selectOption(match.value);
        return true;
      }
    } catch {
      // try next selector
    }
  }
  return false;
}

async function clickSearch(page) {
  const candidates = [
    page.getByRole('button', { name: /cerca|search|avvia/i }),
    page.getByRole('link', { name: /cerca|search|avvia/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
    page.locator('text=/Cerca|Search|Avvia/i')
  ];
  for (const locator of candidates) {
    try {
      if (await locator.first().count()) {
        await locator.first().click({ timeout: 3000 });
        return true;
      }
    } catch {
      // try next candidate
    }
  }
  await page.keyboard.press('Enter');
  return true;
}

async function extractResults(page, maxResults) {
  const results = await page.evaluate((limit) => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const looksLegal = (text, href) => {
      const blob = `${text} ${href}`.toLowerCase();
      return blob.includes('provvedimento') || blob.includes('sentenza') || blob.includes('ordinanza') || blob.includes('decreto') || blob.includes('tribunale') || blob.includes('corte');
    };
    const out = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const href = anchor.href;
      const closest = anchor.closest('article, li, .card, .result, .risultato, tr, div') || anchor;
      const text = clean(closest.innerText || anchor.textContent);
      if (!href || !text || text.length < 20 || !looksLegal(text, href)) continue;
      const key = `${href}|${text.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        title: clean(anchor.textContent || text.slice(0, 160)),
        url: href,
        snippet: text.slice(0, 1200)
      });
      if (out.length >= limit) break;
    }
    if (out.length === 0) {
      const blocks = Array.from(document.querySelectorAll('article, li, .card, .result, .risultato, tr'));
      for (const block of blocks) {
        const text = clean(block.innerText);
        if (text.length < 40 || !looksLegal(text, '')) continue;
        const link = block.querySelector('a[href]');
        const href = link ? link.href : '';
        const key = `${href}|${text.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          title: clean(link?.textContent || text.slice(0, 160)),
          url: href,
          snippet: text.slice(0, 1200)
        });
        if (out.length >= limit) break;
      }
    }
    return out;
  }, maxResults);
  return results.map((item, index) => ({ rank: index + 1, ...item }));
}

export async function checkBdpSession(userId) {
  return withAuthenticatedPage(userId, async (page) => {
    await page.goto(BDP_SEARCH, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const authenticated = page.url().includes(BDP_HOST) && !isLoginUrl(page.url());
    return {
      ok: true,
      authenticated,
      url: page.url(),
      message: authenticated ? 'Stored BDP session is active.' : 'Stored BDP session is expired or not accepted.'
    };
  });
}

export async function searchBdp(userId, input) {
  return withAuthenticatedPage(userId, async (page) => {
    await page.goto(BDP_SEARCH, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await verifyNotRedirectedToLogin(page);

    const filled = {
      query: await fillFirst(page, [
        '#testo',
        'textarea[name*="testo" i]',
        'input[name*="testo" i]',
        'input[type="search"]',
        'textarea',
        'input[type="text"]'
      ], input.query),
      dateFrom: await fillFirst(page, [
        'input[name*="from" i]',
        'input[name*="inizio" i]',
        'input[name*="dataDa" i]',
        'input[placeholder*="da" i]'
      ], input.dateFrom),
      dateTo: await fillFirst(page, [
        'input[name*="to" i]',
        'input[name*="fine" i]',
        'input[name*="dataA" i]',
        'input[placeholder*="a" i]'
      ], input.dateTo),
      district: await selectOptionLike(page, ['select[name*="distretto" i]', '#distretto', 'select'], input.district),
      type: await selectOptionLike(page, ['select[name*="tipo" i]', '#tipo', 'select'], input.type),
      court: await fillFirst(page, ['input[name*="ufficio" i]', 'input[name*="tribunale" i]', 'input[placeholder*="ufficio" i]'], input.court)
    };

    await clickSearch(page);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2500);
    const results = await extractResults(page, input.maxResults);
    return {
      ok: true,
      url: page.url(),
      filled,
      count: results.length,
      results,
      warning: results.length === 0 ? 'No result cards were detected. BDP DOM selectors may need adjustment in src/bdp/client.js.' : ''
    };
  });
}

export async function readBdpDocument(userId, input) {
  const url = ensureBdpUrl(input.url);
  return withAuthenticatedPage(userId, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await verifyNotRedirectedToLogin(page);
    const data = await page.evaluate((maxCharacters) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const title = clean(document.querySelector('h1, h2, title')?.textContent || document.title);
      const main = document.querySelector('main') || document.body;
      const text = clean(main?.innerText || document.body.innerText || '');
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map((a) => ({
        text: clean(a.textContent),
        href: a.href
      })).filter((a) => a.text && a.href);
      return {
        title,
        text: text.slice(0, maxCharacters),
        characters: text.length,
        links
      };
    }, input.maxCharacters);
    return {
      ok: true,
      url: page.url(),
      ...data,
      truncated: data.characters > input.maxCharacters
    };
  });
}
