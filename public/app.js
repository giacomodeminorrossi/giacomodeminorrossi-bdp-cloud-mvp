const state = {
  user: null,
  flowId: null,
  browserRefreshTimer: null
};

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  $(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function show(id, visible = true) {
  $(id).classList.toggle('hidden', !visible);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function init() {
  try {
    const me = await api('/api/me');
    state.user = me.user;
    show('loginPanel', false);
    show('appPanel', true);
    show('logoutButton', true);
    await refreshStoredSessionStatus();
  } catch {
    show('loginPanel', true);
    show('appPanel', false);
    show('logoutButton', false);
  }
}

async function login() {
  await api('/api/login', {
    method: 'POST',
    body: {
      userId: $('userIdInput').value || 'default',
      password: $('passwordInput').value
    }
  });
  $('passwordInput').value = '';
  await init();
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.reload();
}

async function refreshStoredSessionStatus() {
  const local = await api('/api/session');
  setText('sessionStatus', local);
}

async function checkBdpSession() {
  setText('sessionStatus', 'Checking BDP session...');
  const result = await api('/api/bdp/session/check', { method: 'POST' });
  setText('sessionStatus', result);
}

function renderScreenshot(payload) {
  if (!payload?.screenshot) return;
  const { screenshot } = payload;
  const status = screenshot.screenshotError ? `Screenshot error: ${screenshot.screenshotError}` : '';
  if (screenshot.textPreview) setText('sessionStatus', { screenshotTextPreview: screenshot.textPreview, url: screenshot.url, screenshotError: screenshot.screenshotError });
  $('browserUrl').textContent = [screenshot.url || '', status].filter(Boolean).join(' | ');
  if (screenshot.imageBase64) {
    const mimeType = screenshot.mimeType || 'image/png';
    $('browserImage').src = `data:${mimeType};base64,${screenshot.imageBase64}`;
  }
  $('browserImage').dataset.width = String(screenshot.width || 1280);
  $('browserImage').dataset.height = String(screenshot.height || 900);
  show('cloudBrowserPanel', true);
}

async function debugJson(path) {
  setText('debugOutput', `Running ${path} ...`);
  const result = await api(path);
  setText('debugOutput', result);
}

async function startCie() {
  setText('sessionStatus', 'Starting cloud browser...');
  const result = await api('/api/cie/start', { method: 'POST' });
  state.flowId = result.flowId;
  setText('sessionStatus', result);
  renderScreenshot(result);
  show('finishCieButton', true);
  startAutoRefresh();
}

function startAutoRefresh() {
  clearInterval(state.browserRefreshTimer);
  state.browserRefreshTimer = setInterval(() => {
    if (state.flowId) refreshBrowser().catch(() => {});
  }, 2500);
}

async function refreshBrowser() {
  if (!state.flowId) return;
  const result = await api(`/api/cie/${state.flowId}/screenshot`);
  renderScreenshot(result);
}

async function navigateBrowser(url) {
  if (!state.flowId) return;
  setText('sessionStatus', `Navigating cloud browser to ${url} ...`);
  const result = await api(`/api/cie/${state.flowId}/navigate`, { method: 'POST', body: { url } });
  setText('sessionStatus', result);
  renderScreenshot(result);
}

async function clickBrowser(event) {
  if (!state.flowId) return;
  const img = $('browserImage');
  const rect = img.getBoundingClientRect();
  const naturalWidth = Number(img.dataset.width || img.naturalWidth || 1280);
  const naturalHeight = Number(img.dataset.height || img.naturalHeight || 900);
  const x = Math.round((event.clientX - rect.left) * naturalWidth / rect.width);
  const y = Math.round((event.clientY - rect.top) * naturalHeight / rect.height);
  const result = await api(`/api/cie/${state.flowId}/click`, { method: 'POST', body: { x, y } });
  renderScreenshot(result);
}

async function pressEnter() {
  if (!state.flowId) return;
  const result = await api(`/api/cie/${state.flowId}/key`, { method: 'POST', body: { key: 'Enter' } });
  renderScreenshot(result);
}

async function finishCie() {
  if (!state.flowId) return;
  setText('sessionStatus', 'Checking authenticated BDP page and saving encrypted session...');
  const result = await api(`/api/cie/${state.flowId}/finish`, { method: 'POST' });
  setText('sessionStatus', result);
  if (result.authenticated) {
    clearInterval(state.browserRefreshTimer);
    state.flowId = null;
    show('cloudBrowserPanel', false);
    show('finishCieButton', false);
  } else {
    renderScreenshot(result);
  }
}

async function cancelFlow() {
  if (!state.flowId) return;
  await api(`/api/cie/${state.flowId}`, { method: 'DELETE' });
  clearInterval(state.browserRefreshTimer);
  state.flowId = null;
  show('cloudBrowserPanel', false);
  show('finishCieButton', false);
}

async function deleteSession() {
  await api('/api/session', { method: 'DELETE' });
  await refreshStoredSessionStatus();
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function appendPre(parent, value) {
  const pre = document.createElement('pre');
  pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  parent.appendChild(pre);
}

function renderResults(data) {
  const root = $('results');
  clearChildren(root);
  appendPre(root, { count: data.count, url: data.url, filled: data.filled, warning: data.warning });
  for (const item of data.results || []) {
    const box = document.createElement('div');
    box.className = 'resultItem';
    const title = document.createElement('h3');
    title.textContent = `${item.rank}. ${item.title || 'Untitled result'}`;
    const url = document.createElement('p');
    url.className = 'muted';
    url.textContent = item.url || 'No URL detected';
    const snippet = document.createElement('p');
    snippet.className = 'snippet';
    snippet.textContent = item.snippet || '';
    const button = document.createElement('button');
    button.textContent = 'Read this document';
    button.disabled = !item.url;
    button.addEventListener('click', () => readDocument(item.url));
    box.append(title, url, snippet, button);
    root.appendChild(box);
  }
}

async function search() {
  $('searchButton').disabled = true;
  try {
    const result = await api('/api/bdp/search', {
      method: 'POST',
      body: {
        query: $('queryInput').value,
        district: $('districtInput').value,
        type: $('typeInput').value,
        dateFrom: $('dateFromInput').value,
        dateTo: $('dateToInput').value,
        maxResults: Number($('maxResultsInput').value || 10)
      }
    });
    renderResults(result);
  } finally {
    $('searchButton').disabled = false;
  }
}

async function readDocument(url) {
  const root = $('documentOutput');
  clearChildren(root);
  appendPre(root, `Reading ${url} ...`);
  const result = await api('/api/bdp/read', { method: 'POST', body: { url, maxCharacters: 40000 } });
  clearChildren(root);
  const h = document.createElement('h3');
  h.textContent = result.title || 'Document';
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = result.url;
  const pre = document.createElement('pre');
  pre.textContent = result.text || '';
  root.append(h, p, pre);
}

function bindEvents() {
  $('debugBrowserButton').addEventListener('click', () => debugJson('/api/debug/browser').catch((err) => setText('debugOutput', err.message)));
  $('debugExampleButton').addEventListener('click', () => debugJson('/api/debug/network?url=https%3A%2F%2Fexample.com%2F').catch((err) => setText('debugOutput', err.message)));
  $('debugBdpButton').addEventListener('click', () => debugJson('/api/debug/bdp').catch((err) => setText('debugOutput', err.message)));
  $('debugCieButton').addEventListener('click', () => debugJson('/api/debug/network?url=https%3A%2F%2Fidserver.servizicie.interno.gov.it%2F').catch((err) => setText('debugOutput', err.message)));
  $('loginButton').addEventListener('click', () => login().catch((err) => alert(err.message)));
  $('logoutButton').addEventListener('click', () => logout().catch((err) => alert(err.message)));
  $('checkSessionButton').addEventListener('click', () => checkBdpSession().catch((err) => setText('sessionStatus', err.message)));
  $('startCieButton').addEventListener('click', () => startCie().catch((err) => setText('sessionStatus', err.message)));
  $('finishCieButton').addEventListener('click', () => finishCie().catch((err) => setText('sessionStatus', err.message)));
  $('deleteSessionButton').addEventListener('click', () => deleteSession().catch((err) => setText('sessionStatus', err.message)));
  $('refreshBrowserButton').addEventListener('click', () => refreshBrowser().catch((err) => setText('sessionStatus', err.message)));
  $('openBdpHomeButton').addEventListener('click', () => navigateBrowser('https://bdp.giustizia.it/').catch((err) => setText('sessionStatus', err.message)));
  $('openBdpSearchButton').addEventListener('click', () => navigateBrowser('https://bdp.giustizia.it/search/standard?target=provvedimento').catch((err) => setText('sessionStatus', err.message)));
  $('enterKeyButton').addEventListener('click', () => pressEnter().catch((err) => setText('sessionStatus', err.message)));
  $('cancelFlowButton').addEventListener('click', () => cancelFlow().catch((err) => setText('sessionStatus', err.message)));
  $('browserImage').addEventListener('click', (event) => clickBrowser(event).catch((err) => setText('sessionStatus', err.message)));
  $('searchButton').addEventListener('click', () => search().catch((err) => alert(err.message)));
}

bindEvents();
init();
