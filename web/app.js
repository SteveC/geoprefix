import { GeoPrefix } from '/sdk/geoprefix.js?v=0.2.0';

const $ = id => document.getElementById(id);
const client = new GeoPrefix({ websiteDemo: true, contributionConsent: true, retention: 'history', timeout: 12000 });
const receiptsKey = 'geoprefix-observation-receipts-v2';
const dialog = $('location-request');
let receipts = [];
let busy = false;
try {
  const saved = JSON.parse(localStorage.getItem(receiptsKey) || '[]');
  if (Array.isArray(saved)) receipts = saved.filter(r => typeof r.id === 'string' && typeof r.contribution_receipt === 'string');
} catch { /* Storage can be unavailable; this page still works. */ }

function status(message, kind = '') {
  $('location-status').textContent = message;
  $('location-status').className = `status ${kind}`;
}
function km(value) { return typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString(undefined, {maximumFractionDigits: 1})} km` : 'Not measured'; }
function coords(lat, lon) { return `${Number(lat).toFixed(1)}, ${Number(lon).toFixed(1)}`; }
function haversine(a, b, x, y) {
  const rad = Math.PI / 180;
  const h = Math.sin((x-a)*rad/2)**2 + Math.cos(a*rad)*Math.cos(x*rad)*Math.sin((y-b)*rad/2)**2;
  return 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function renderEstimate(estimate) {
  if (estimate.status !== 'found') {
    $('ip-location').textContent = 'No estimate yet';
    $('ip-radius').textContent = 'Not enough observations';
    $('network-detail').textContent = 'A block needs five distinct public addresses across two days before we publish an estimate.';
    return;
  }
  $('my-network').textContent = estimate.network;
  $('ip-location').textContent = coords(estimate.latitude, estimate.longitude);
  $('ip-radius').textContent = km(estimate.accuracy_radius_km);
  $('network-detail').textContent = `${estimate.sample_count.toLocaleString()} observations · ${estimate.distinct_observers} public addresses · ${estimate.location_count ?? 'Unknown'} rounded location cells. Observed P90 distance: ${km(estimate.observed_p90_distance_km)}.${estimate.distribution_status === 'dispersed' ? ' This block is dispersed; a single location is unreliable.' : ''}`;
}
async function refreshTotals() {
  try {
    const stats = await client.request('/api/stats');
    $('dataset-stats').textContent = `${stats.observations.toLocaleString()} observations in history · ${stats.published_networks.toLocaleString()} published network blocks`;
  } catch { $('dataset-stats').textContent = 'Database totals unavailable.'; }
}
const initialEstimate = client.lookup().then(data => { renderEstimate(data); return data; }).catch(error => {
  $('ip-location').textContent = 'Service unavailable';
  $('ip-radius').textContent = '—';
  $('network-detail').textContent = error.message;
  return null;
});
client.request('/api/me').then(data => {
  $('my-ip').textContent = data.ip;
  // The API is authoritative for IPv6 normalization and the actual prefix.
  if (data.network) $('my-network').textContent = data.network;
  else $('my-network').textContent = 'No published block yet';
}).catch(() => { $('my-ip').textContent = 'Unavailable'; $('my-network').textContent = 'Unavailable'; });

function persistReceipts() {
  try { localStorage.setItem(receiptsKey, JSON.stringify(receipts)); }
  catch { $('receipt-status').textContent = 'Browser storage is unavailable. Save deletion receipts before leaving this page.'; }
}
function renderReceipts() {
  const rows = $('history-rows'); rows.replaceChildren();
  $('history-empty').hidden = receipts.length > 0;
  $('history-table-wrap').hidden = receipts.length === 0;
  $('download-receipts').hidden = receipts.length === 0;
  for (const receipt of [...receipts].reverse()) {
    const row = document.createElement('tr');
    const captured = document.createElement('td'); captured.textContent = typeof receipt.captured_at === 'string' ? receipt.captured_at.slice(0,19).replace('T',' ') : 'Unknown';
    const point = document.createElement('td'); point.textContent = typeof receipt.latitude === 'number' && typeof receipt.longitude === 'number' ? coords(receipt.latitude, receipt.longitude) : 'Unknown';
    const result = document.createElement('td'); result.textContent = receipt.status || 'accepted';
    const actions = document.createElement('td');
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Withdraw';
    remove.setAttribute('aria-label', `Withdraw contribution from ${captured.textContent}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await client.withdraw(receipt);
        receipts = receipts.filter(r => r.id !== receipt.id); persistReceipts(); renderReceipts();
        $('receipt-status').textContent = 'Observation removed. Future downloads will be recomputed; earlier downloaded CC0 data cannot be recalled.';
        await refreshTotals();
      } catch (error) { $('receipt-status').textContent = error.message; remove.disabled = false; }
    });
    actions.append(remove); row.append(captured, point, result, actions); rows.append(row);
  }
}
$('download-receipts').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipts, null, 2)], {type:'application/json'}));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'geoprefix-deletion-receipts.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function shareLocation() {
  if (busy) return;
  busy = true; $('share-location').disabled = true;
  status('Waiting for your browser’s location permission…');
  try {
    // Start synchronously from the agreement click to preserve the browser gesture.
    const locationPromise = client.getLocation();
    const [before, result] = await Promise.all([initialEstimate, locationPromise]);
    if (result.source === 'ip') {
      renderEstimate(result.lookup);
      $('browser-location').textContent = 'Declined or unavailable';
      $('comparison-distance').textContent = 'No browser location to compare';
      status('Showing the IP fallback. No location observation was sent.');
      return;
    }
    $('browser-location').textContent = `${coords(result.latitude, result.longitude)} (rounded for display)`;
    if (before?.status === 'found') {
      $('comparison-distance').textContent = km(haversine(result.latitude, result.longitude, before.latitude, before.longitude));
    } else $('comparison-distance').textContent = 'No preexisting IP estimate';
    const contribution = result.contribution;
    if (contribution.status === 'failed') {
      status(`Browser location found, but the observation was not saved: ${contribution.message}`, 'error');
      return;
    }
    const receipt = contribution.receipt;
    if (receipt?.id && receipt?.contribution_receipt) {
      receipts.push({id:receipt.id,contribution_receipt:receipt.contribution_receipt,captured_at:result.captured_at,latitude:Number((Math.round(result.latitude*10)/10).toFixed(1)),longitude:Number((Math.round(result.longitude*10)/10).toFixed(1)),status:receipt.status});
      persistReceipts(); renderReceipts();
    }
    status(receipt?.message || 'No new observation was saved.', receipt?.status === 'accepted' ? 'success' : '');
    await refreshTotals();
  } catch (error) { status(error.message || 'Location could not be obtained.', 'error'); }
  finally { busy = false; $('share-location').disabled = false; }
}
function askLocation() { dialog.returnValue = ''; dialog.showModal(); }
$('share-location').addEventListener('click', askLocation);
dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'share') shareLocation();
  else status('Using your public IP only. No browser location was requested or contributed.');
});
renderReceipts(); refreshTotals(); askLocation();
