import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GeoPrefix } from './geoprefix.js';
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalFetch = globalThis.fetch;
const point = { coords: { latitude: 40.71281, longitude: -74.00601, accuracy: 15 }, timestamp: 1700000000000 };
function browser(run) { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: { getCurrentPosition: run } } }); }
function response(body, status = 200) { return { ok: status < 400, status, json: async () => body }; }
afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
  globalThis.fetch = originalFetch;
});
test('browser success stays local without contribution permission', async () => {
  browser(success => success(point));
  globalThis.fetch = () => assert.fail('No network request is permitted');
  const result = await new GeoPrefix({ appToken: 'public-token' }).getLocation();
  assert.equal(result.source, 'browser');
  assert.equal(result.provider, 'unknown');
  assert.equal(result.latitude, point.coords.latitude);
  assert.equal(result.contribution.status, 'disabled');
});
test('explicit permission submits coarse coordinates with scoped token', async () => {
  browser(success => success(point));
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.test/api/observations');
    assert.equal(options.headers.Authorization, 'Bearer public-token');
    const body = JSON.parse(options.body);
    assert.equal(body.latitude, 40.7); assert.equal(body.longitude, -74);
    assert.equal(body.accuracy_m, 8015); assert.equal(body.consent, true);
    assert.equal(body.reported_accuracy_m, 15); assert.equal(body.source, 'browser');
    assert.equal(body.installation_id, undefined);
    return response({ id: 'observation-1', status: 'quarantined' });
  };
  const result = await new GeoPrefix({ endpoint: 'https://example.test/', appToken: 'public-token', contributionConsent: true }).getLocation();
  assert.equal(calls, 1);
  assert.equal(result.reported_accuracy_m, 15);
  assert.equal(result.contribution.receipt.status, 'quarantined');
});
test('failed contribution preserves usable browser position', async () => {
  browser(success => success(point)); globalThis.fetch = async () => response({ detail: 'quota exceeded' }, 429);
  const result = await new GeoPrefix({ appToken: 'public-token', contributionConsent: true }).getLocation();
  assert.equal(result.source, 'browser'); assert.equal(result.contribution.status, 'failed');
  assert.match(result.contribution.message, /quota/);
});
test('denial falls back to current public IP and never uploads', async () => {
  browser((_, failure) => failure({ code: 1 }));
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/lookup'); assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer token');
    return response({ location: { country_code: 'US', accuracy_radius_km: 100 } });
  };
  const result = await new GeoPrefix({ contributionConsent: true, appToken: 'token' }).getLocation();
  assert.equal(result.source, 'ip'); assert.equal(result.fallback_reason, 'permission_denied');
  assert.equal(result.contribution.status, 'not_applicable');
  assert.equal(result.lookup.location.accuracy_radius_km, 100);
});
test('a browser that never replies hits deadline and falls back', async () => {
  browser(() => {}); globalThis.fetch = async () => response({ country_code: 'US' });
  const result = await new GeoPrefix({ timeout: 10 }).getLocation();
  assert.equal(result.fallback_reason, 'timeout');
});
test('missing browser API falls back and disabled fallback rejects', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  globalThis.fetch = async () => response({ country_code: 'US' });
  assert.equal((await new GeoPrefix().getLocation()).fallback_reason, 'unavailable');
  await assert.rejects(new GeoPrefix({ fallback: false }).getLocation(), /unavailable/);
});
test('direct contribution cannot bypass consent or coordinate validation', () => {
  globalThis.fetch = () => assert.fail('Invalid observation must never be sent');
  const client = new GeoPrefix({ appToken: 'token' });
  assert.throws(() => client.contribute({ ...point.coords, accuracy_m: 15, consent: false }), /consent/);
  assert.throws(() => client.contribute({ latitude: 200, longitude: 0, accuracy_m: 15, consent: true }), /latitude/);
});
test('fallback service failure is reported, not fabricated as a position', async () => {
  browser((_, failure) => failure({ code: 2 }));
  globalThis.fetch = async () => response({ detail: 'dataset unavailable' }, 503);
  await assert.rejects(new GeoPrefix().getLocation(), /dataset unavailable/);
});
test('website demo uses our SDK to retain consented history without an app token', async () => {
  browser(success => success(point));
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/demo/observations');
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.retention, 'history'); assert.equal(body.consent, true);
    assert.equal(body.latitude, 40.7); assert.equal(body.longitude, -74);
    return response({ id: 'saved', status: 'accepted', contribution_receipt: 'receipt' });
  };
  const result = await new GeoPrefix({ websiteDemo: true, contributionConsent: true, retention: 'history' }).getLocation();
  assert.equal(result.contribution.receipt.id, 'saved');
});
test('website demo denial submits no point and falls back through the SDK', async () => {
  browser((_, failure) => failure({ code: 1 }));
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/lookup'); assert.equal(options.method, 'GET');
    return response({ status: 'unknown' });
  };
  const result = await new GeoPrefix({ websiteDemo: true, contributionConsent: true, retention: 'history' }).getLocation();
  assert.equal(result.source, 'ip'); assert.equal(result.contribution.status, 'not_applicable');
});
test('legacy retention stays default and receipts authorize withdrawal', async () => {
  const client = new GeoPrefix();
  assert.equal(client.retention, '30_days');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/observations/point-id');
    assert.equal(options.method, 'DELETE');
    assert.equal(options.headers['X-Contribution-Receipt'], 'private-receipt');
    assert.equal(options.headers.Authorization, undefined);
    return response({ status: 'deleted' });
  };
  assert.equal((await client.withdraw({id:'point-id',contribution_receipt:'private-receipt'})).status,'deleted');
});
test('website demo cannot target another origin', () => {
  assert.throws(() => new GeoPrefix({endpoint:'https://other.example',websiteDemo:true}), /same origin/);
});
