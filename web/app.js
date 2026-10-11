const $ = (selector) => document.querySelector(selector);
const numberFormat = new Intl.NumberFormat('en-US');
const distanceFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const tabNames = ['lookup', 'explore', 'dataset', 'accuracy', 'developers'];
let activeAppToken = '';
let contributionReceipt = null;
let toastTimer;

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined && value !== null) node.textContent = String(value);
  return node;
}
function hasNumber(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function count(value) { return hasNumber(value) ? numberFormat.format(Number(value)) : '—'; }
function distance(value) { return hasNumber(value) ? `${distanceFormat.format(Number(value))} km` : 'Not measured'; }
function formatDate(value) {
  if (!value) return 'Not yet recorded';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Not yet recorded' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
}
function countryName(code) {
  if (!code) return '';
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(String(code).toUpperCase()) || code; } catch { return code; }
}
function placeName(row) {
  return [row.city, row.region, row.country_name || countryName(row.country_code)].filter(Boolean).join(', ') || 'Location not labeled';
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
function setStatus(node, message, kind = '') { node.textContent = message; node.className = `form-status ${kind}`.trim(); }
function setBusy(button, busy, label) { button.disabled = busy; if (busy) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy'); if (label) button.firstChild.textContent = label; }
async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    let data;
    try { data = await response.json(); } catch { throw new Error('The atlas returned an unreadable response. Please try again.'); }
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : typeof data.message === 'string' ? data.message : null;
      throw new Error(detail || (response.status === 429 ? 'Too many requests. Please wait a little before trying again.' : `The request could not be completed (${response.status}).`));
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The atlas is taking longer than expected. Please try again.');
    if (error instanceof TypeError) throw new Error('The atlas could not be reached. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function openTab(name, focus = false, updateHash = true) {
  const selected = tabNames.includes(name) ? name : 'lookup';
  for (const tabName of tabNames) {
    const tab = $(`#tab-${tabName}`);
    const active = tabName === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(`#panel-${tabName}`).hidden = !active;
    if (active && focus) tab.focus();
  }
  if (updateHash && location.hash !== `#${selected}`) history.replaceState(null, '', `#${selected}`);
}
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => openTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    const index = tabNames.indexOf(tab.dataset.tab);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabNames.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabNames.length) % tabNames.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabNames.length - 1;
    if (next !== undefined) { event.preventDefault(); openTab(tabNames[next], true); }
  });
}
for (const link of document.querySelectorAll('[data-open-tab], .brand, .footer-brand')) {
  link.addEventListener('click', () => openTab(link.dataset.openTab || 'lookup'));
}
window.addEventListener('hashchange', () => openTab(location.hash.slice(1), false, false));
openTab(location.hash.slice(1), false, false);
$('#current-year').textContent = new Date().getFullYear();

function showEmpty(target, title, message) {
  const wrapper = element('div', 'large-empty');
  wrapper.append(element('h3', '', title), element('p', '', message));
  target.replaceChildren(wrapper);
}
function clearMap() {
  $('#map-location').hidden = true;
  $('#map-coordinate').textContent = 'NO LOCATION SELECTED';
  $('#map-legend').textContent = 'Approximate network locations';
  $('#world-map').setAttribute('aria-label', 'Illustrative world map. No location selected.');
}
function plotLocation(row) {
  if (!hasNumber(row.latitude) || !hasNumber(row.longitude)) { clearMap(); return; }
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  const x = (longitude + 180) / 360 * 1000;
  const y = (90 - latitude) / 180 * 500;
  // The display ring is illustrative; the numeric result is the authoritative radius.
  const approximateRing = hasNumber(row.accuracy_radius_km) ? Math.max(12, Math.min(150, Number(row.accuracy_radius_km) / 40075 * 1000)) : 20;
  for (const id of ['map-radius', 'map-marker-halo', 'map-marker']) {
    $(`#${id}`).setAttribute('cx', x);
    $(`#${id}`).setAttribute('cy', y);
  }
  $('#map-radius').setAttribute('r', approximateRing);
  $('#map-location').hidden = false;
  // Use absolute magnitude with a cardinal direction for unambiguous coordinates.
  $('#map-coordinate').textContent = `${Math.abs(latitude).toFixed(3)}° ${latitude >= 0 ? 'N' : 'S'}  /  ${Math.abs(longitude).toFixed(3)}° ${longitude >= 0 ? 'E' : 'W'}`;
  $('#map-legend').textContent = hasNumber(row.accuracy_radius_km) ? `Radius: ${distance(row.accuracy_radius_km)} · ring illustrative` : 'Uncertainty radius unavailable';
  $('#world-map').setAttribute('aria-label', `Illustrative world map showing a network estimate near ${latitude.toFixed(3)}, ${longitude.toFixed(3)}. ${hasNumber(row.accuracy_radius_km) ? `Accuracy radius ${distance(row.accuracy_radius_km)}. The displayed ring is illustrative.` : 'Accuracy radius is unavailable.'}`);
}
function renderLookup(data) {
  const target = $('#lookup-result');
  if (data.status !== 'found' || !hasNumber(data.latitude) || !hasNumber(data.longitude)) {
    const wrapper = element('div', 'empty-result');
    const text = element('div');
    text.append(element('h3', '', 'No public estimate for this IP yet.'), element('p', '', data.message || 'There isn’t enough community evidence to publish a location. The atlas is starting small; we won’t fill the gap with a guess.'));
    wrapper.append(text); target.replaceChildren(wrapper); clearMap(); return;
  }
  const heading = element('div', 'result-heading');
  const title = element('div'); title.append(element('h3', '', placeName(data)), element('code', '', data.network || data.ip));
  heading.append(title, element('span', 'confidence-pill', `${data.confidence || 'Unrated'} confidence`));
  const values = element('dl', 'result-values');
  for (const [label, value] of [
    ['Coordinates', `${Number(data.latitude).toFixed(3)}, ${Number(data.longitude).toFixed(3)}`],
    ['Accuracy radius', hasNumber(data.accuracy_radius_km) ? distance(data.accuracy_radius_km) : 'Unknown'],
    ['Observations', count(data.sample_count)],
    ['Latest evidence (UTC)', formatDate(data.last_seen)],
  ]) { const item = element('div'); item.append(element('dt', '', label), element('dd', '', value)); values.append(item); }
  target.replaceChildren(heading, values, element('p', 'result-footnote', 'The coordinates represent a network estimate within the stated radius. They do not identify a person, household, or street address.'));
  plotLocation(data);
}
async function lookupIP(ip) {
  const button = $('#lookup-button');
  setBusy(button, true, 'Looking up ');
  $('#lookup-result').setAttribute('aria-busy', 'true');
  try { const data = await request(`/api/lookup?ip=${encodeURIComponent(ip.trim())}`); renderLookup(data); return data; }
  catch (error) { $('#lookup-result').replaceChildren(element('p', 'error-message', error.message)); clearMap(); throw error; }
  finally { setBusy(button, false, 'Look up '); $('#lookup-result').removeAttribute('aria-busy'); }
}
$('#lookup-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await lookupIP($('#ip-input').value); } catch {} });
async function lookupMyIP() {
  const button = $('#my-ip-button'); button.disabled = true;
  try {
    const data = await request('/api/me');
    if (!data.ip) throw new Error('Your public IP could not be determined. You can enter an IP manually.');
    $('#ip-input').value = data.ip;
    return await lookupIP(data.ip);
  } finally { button.disabled = false; }
}
$('#my-ip-button').addEventListener('click', async () => {
  try { await lookupMyIP(); } catch (error) { $('#lookup-result').replaceChildren(element('p', 'error-message', error.message)); }
});

function networkTable(rows, includeDistance = false) {
  const wrapper = element('div', 'table-wrap');
  const table = element('table');
  const thead = element('thead'); const header = element('tr');
  for (const label of ['Network', 'Location', includeDistance ? 'Distance' : 'Evidence', 'Last seen (UTC)']) header.append(element('th', '', label));
  thead.append(header); table.append(thead);
  const tbody = element('tbody');
  for (const row of rows) {
    const tr = element('tr');
    const network = element('td');
    const networkButton = element('button', 'network-button', row.network || row.prefix || 'Unknown prefix');
    networkButton.type = 'button';
    networkButton.addEventListener('click', async () => {
      const ip = String(row.network || row.prefix || '').split('/')[0];
      if (!ip) return;
      openTab('lookup'); $('#ip-input').value = ip;
      $('#ip-input').focus();
      try { await lookupIP(ip); } catch {}
    });
    network.append(networkButton);
    const place = element('td', '', placeName(row));
    place.append(element('span', 'cell-detail', hasNumber(row.accuracy_radius_km) ? `${distance(row.accuracy_radius_km)} radius` : 'Radius unavailable'));
    const evidence = element('td', '', includeDistance ? (hasNumber(row.distance_km) ? distance(row.distance_km) : 'Unknown') : `${count(row.sample_count)} observations`);
    if (!includeDistance) evidence.append(element('span', 'cell-detail', `${row.confidence || 'Unrated'} confidence`));
    tr.append(network, place, evidence, element('td', '', formatDate(row.last_seen)));
    tbody.append(tr);
  }
  table.append(tbody); wrapper.append(table); return wrapper;
}
$('#reverse-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#reverse-button'); setBusy(button, true, 'Searching ');
  const params = new URLSearchParams({ latitude: $('#latitude').value, longitude: $('#longitude').value, radius_km: $('#radius').value });
  $('#reverse-results').setAttribute('aria-busy', 'true');
  try {
    const data = await request(`/api/reverse?${params}`);
    const rows = Array.isArray(data.matches) ? data.matches : [];
    $('#reverse-count').textContent = `${count(data.total ?? rows.length)} matches`;
    if (rows.length) $('#reverse-results').replaceChildren(networkTable(rows, true));
    else showEmpty($('#reverse-results'), 'This part of the map is still open.', 'No published network estimates match this area yet. A missing result means missing evidence, not an empty internet.');
  } catch (error) { $('#reverse-count').textContent = 'Search unavailable'; $('#reverse-results').replaceChildren(element('p', 'error-message', error.message)); }
  finally { setBusy(button, false, 'Find networks '); $('#reverse-results').removeAttribute('aria-busy'); }
});

async function refreshStats() {
  try {
    const data = await request('/api/stats');
    for (const node of document.querySelectorAll('[data-stat]')) node.textContent = count(data[node.dataset.stat]);
    const evaluated = Number(data.independent_evaluations || 0) > 0;
    $('#overview-error').textContent = evaluated ? distance(data.median_error_km) : 'Not measured';
    $('#overview-error-description').textContent = evaluated ? 'Median error on held-out observations' : 'Waiting for held-out observations';
    $('#dataset-updated').textContent = data.updated_at ? `Latest evidence: ${formatDate(data.updated_at)} · UTC` : 'Fresh atlas · No published observations yet';
    const currentMRR = hasNumber(data.mrr_usd) ? Number(data.mrr_usd) : null;
    const targetMRR = hasNumber(data.target_mrr_usd) ? Number(data.target_mrr_usd) : 1000;
    $('#mrr-label').textContent = currentMRR === null ? `Not reported / $${count(targetMRR)}` : `$${count(currentMRR)} / $${count(targetMRR)}`;
    const percentage = currentMRR === null || targetMRR <= 0 ? 0 : Math.max(0, Math.min(100, currentMRR / targetMRR * 100));
    $('#mrr-progress').setAttribute('aria-valuemax', String(targetMRR));
    $('#mrr-progress').setAttribute('aria-valuenow', String(currentMRR === null ? 0 : Math.min(targetMRR, Math.max(0, currentMRR))));
    $('#mrr-progress').setAttribute('aria-valuetext', currentMRR === null ? 'Revenue not reported' : `$${count(currentMRR)} of a $${count(targetMRR)} monthly goal`);
    $('#mrr-progress span').style.width = `${percentage}%`;
    $('#connection-status').className = 'connection-status connected';
    $('#connection-status span:last-child').textContent = 'Atlas connected';
  } catch {
    $('#connection-status').className = 'connection-status offline';
    $('#connection-status span:last-child').textContent = 'Atlas unavailable';
    $('#dataset-updated').textContent = 'Snapshot status unavailable. Please try again later.';
    $('#overview-error').textContent = 'Unavailable';
    $('#overview-error-description').textContent = 'Could not load evaluation status';
  }
}
async function refreshNetworks() {
  try {
    const data = await request('/api/networks?limit=8');
    const rows = Array.isArray(data.networks) ? data.networks : [];
    $('#dataset-count').textContent = `${count(data.total ?? rows.length)} public networks`;
    if (rows.length) $('#dataset-table').replaceChildren(networkTable(rows));
    else showEmpty($('#dataset-table'), 'The first chapter is still being written.', 'There are no public network summaries yet. Consented contributions will begin building this dataset; the download still includes its schema.');
  } catch (error) { $('#dataset-count').textContent = 'Unavailable'; $('#dataset-table').replaceChildren(element('p', 'error-message', error.message)); }
}
async function refreshAccuracy() {
  try {
    const data = await request('/api/accuracy');
    const samples = hasNumber(data.sample_count) ? Number(data.sample_count) : 0;
    $('#accuracy-median').textContent = samples > 0 ? distance(data.median_error_km) : 'Not measured';
    $('#accuracy-p90').textContent = samples > 0 ? distance(data.p90_error_km) : 'Not measured';
    const independent = $('#panel-accuracy [data-stat="independent_evaluations"]'); independent.textContent = count(samples);
    $('#accuracy-methodology').textContent = typeof data.methodology === 'string' ? data.methodology : 'Community evaluations use withheld observations. Browser coordinates are not verified ground truth, and this is not an independent audit.';
    $('#accuracy-status').textContent = samples > 0 ? `${count(samples)} held-out samples` : 'No held-out samples yet';
    if (!samples) {
      showEmpty($('#accuracy-report'), 'No accuracy claim without a test.', 'There are no held-out evaluations yet. Training observations do not count as proof of accuracy. Results will appear here when withheld evidence is available.');
    } else {
      const report = element('div');
      if (hasNumber(data.within_25km_percent)) {
        const metric = element('div', 'evaluation-value');
        metric.append(element('strong', '', `${distanceFormat.format(Number(data.within_25km_percent))}%`), element('span', '', 'of held-out estimates were within 25 km.'));
        report.append(metric);
      }
      if (Array.isArray(data.by_network_type) && data.by_network_type.length) {
        const grid = element('div', 'table-wrap'); const table = element('table'); const head = element('thead'); const tr = element('tr');
        for (const title of ['Network type', 'Samples', 'Median error', 'P90 error']) tr.append(element('th', '', title));
        head.append(tr); table.append(head); const body = element('tbody');
        for (const row of data.by_network_type) { const line = element('tr'); for (const value of [row.network_type || row.type || 'Unknown', count(row.sample_count), distance(row.median_error_km), distance(row.p90_error_km)]) line.append(element('td', '', value)); body.append(line); }
        table.append(body); grid.append(table); report.append(grid);
      }
      $('#accuracy-report').replaceChildren(report);
    }
  } catch (error) { $('#accuracy-status').textContent = 'Unavailable'; $('#accuracy-median').textContent = 'Unavailable'; $('#accuracy-p90').textContent = 'Unavailable'; $('#accuracy-report').replaceChildren(element('p', 'error-message', error.message)); }
}

const consent = $('#contribution-consent');
const contributionButton = $('#contribute-button');
consent.addEventListener('change', () => { contributionButton.disabled = !consent.checked; });
contributionButton.addEventListener('click', async () => {
  if (!consent.checked) return;
  const status = $('#contribution-status');
  if (!navigator.geolocation) { setStatus(status, 'Browser location is unavailable. No contribution was sent. Trying an approximate IP lookup…'); await contributionFallback(); return; }
  contributionButton.disabled = true;
  contributionButton.setAttribute('aria-busy', 'true');
  setStatus(status, 'Waiting for your browser’s location permission…');
  try {
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 12000, maximumAge: 0 }));
    if (!consent.checked) { setStatus(status, 'Contribution canceled. No location was sent.'); return; }
    setStatus(status, 'Rounding your location and sending your contribution…');
    const roundToGrid = (value) => Math.round(value * 10) / 10;
    const payload = {
      latitude: roundToGrid(position.coords.latitude),
      longitude: roundToGrid(position.coords.longitude),
      accuracy_m: Math.ceil(position.coords.accuracy + 8000),
      captured_at: new Date(position.timestamp || Date.now()).toISOString(),
      consent: true,
    };
    const response = await request('/api/demo/observations', { method: 'POST', body: JSON.stringify(payload) });
    if (response.status === 'duplicate') {
      setStatus(status, response.message || 'An observation from this public address has already been recorded today.', 'success');
    } else if (response.status === 'quarantined') {
      setStatus(status, response.reason || 'This connection cannot safely contribute a location estimate.');
    } else {
      setStatus(status, response.message || 'Contribution received. Thank you for helping build the open atlas. Only your coarse location was sent.', 'success');
      if (response.id && response.contribution_receipt) {
        contributionReceipt = { id: response.id, contribution_receipt: response.contribution_receipt };
        $('#contribution-receipt').hidden = false;
      }
    }
    await Promise.allSettled([refreshStats(), refreshNetworks(), refreshAccuracy()]);
  } catch (error) {
    if (typeof error.code === 'number' && [1, 2, 3].includes(error.code)) {
      setStatus(status, 'Browser location was declined or unavailable. No location was contributed. Trying an approximate IP lookup…');
      await contributionFallback();
    } else setStatus(status, error.message || 'Your contribution could not be completed. Please try again.', 'error');
  } finally { contributionButton.disabled = !consent.checked; contributionButton.removeAttribute('aria-busy'); }
});
async function contributionFallback() {
  try { await lookupMyIP(); setStatus($('#contribution-status'), 'An IP lookup is shown above. No GPS contribution was sent.'); }
  catch { setStatus($('#contribution-status'), 'Location was not contributed. An IP estimate could not be loaded; you can try the lookup manually.', 'error'); }
}

function updateSnippet() {
  const origin = location.origin;
  $('#sdk-code').textContent = `import { locate } from "${origin}/sdk/geoprefix.js";\n\n// Call after showing your contribution notice\n// and receiving the visitor's agreement.\nconst location = await locate({\n  endpoint: "${origin}",\n  appToken: "${activeAppToken || 'YOUR_APP_TOKEN'}",\n  contributionConsent: true,\n  fallback: true,\n  timeout: 8000\n});\n\nconsole.log(location.source);`;
}
updateSnippet();
async function copyText(value, button) {
  try { await navigator.clipboard.writeText(value); toast('Copied to clipboard'); }
  catch { toast('Clipboard unavailable. Select the text and copy it manually.'); if (button.id === 'copy-token') { $('#app-token').focus(); $('#app-token').select(); } }
}
$('#copy-code').addEventListener('click', () => copyText($('#sdk-code').textContent, $('#copy-code')));
$('#copy-token').addEventListener('click', () => copyText($('#app-token').value, $('#copy-token')));
$('#copy-receipt').addEventListener('click', () => { if (contributionReceipt) copyText(JSON.stringify(contributionReceipt, null, 2), $('#copy-receipt')); });
$('#withdraw-contribution').addEventListener('click', async () => {
  if (!contributionReceipt) return;
  const button = $('#withdraw-contribution'); button.disabled = true;
  try {
    await request(`/api/observations/${encodeURIComponent(contributionReceipt.id)}`, { method: 'DELETE', headers: { 'X-Contribution-Receipt': contributionReceipt.contribution_receipt } });
    contributionReceipt = null; $('#contribution-receipt').hidden = true;
    setStatus($('#contribution-status'), 'Observation withdrawn. Future exports will be recomputed. Already downloaded public data cannot be recalled.', 'success');
    await Promise.allSettled([refreshStats(), refreshNetworks(), refreshAccuracy()]);
  } catch (error) { setStatus($('#contribution-status'), error.message, 'error'); }
  finally { button.disabled = false; }
});
$('#app-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('#app-status'); const button = $('#register-button');
  let origins;
  try {
    origins = [...new Set($('#app-origins').value.split(/[\s,]+/).filter(Boolean).map((value) => {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use complete site origins, such as https://example.com, without a page path.');
      return url.origin;
    }))];
    if (!origins.length) throw new Error('Add at least one site origin that you control.');
  } catch (error) { setStatus(status, error.message.startsWith('Use complete') ? error.message : 'Enter valid site origins, such as https://example.com, without a page path.', 'error'); return; }
  setBusy(button, true, 'Creating token '); setStatus(status, 'Registering your application…');
  try {
    const data = await request('/api/apps', { method: 'POST', body: JSON.stringify({ name: $('#app-name').value.trim(), origins }) });
    if (!data.app_token) throw new Error('No app token was returned. Please try again.');
    activeAppToken = data.app_token; $('#app-token').value = data.app_token; $('#app-token-result').hidden = false;
    setStatus(status, `Application registered. ${count(data.monthly_quota ?? 100000)} requests per month; restricted to your listed origins.`, 'success');
    updateSnippet();
  } catch (error) { setStatus(status, error.message, 'error'); }
  finally { setBusy(button, false, 'Create app token '); }
});

await Promise.allSettled([refreshStats(), refreshNetworks(), refreshAccuracy()]);
