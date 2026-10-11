// SPDX-License-Identifier: Apache-2.0
/** A browser location is an observation, not verified GPS ground truth. */
export class GeoPrefix {
  constructor({ endpoint = '', appToken, contributionConsent = false, fallback = true, timeout = 8000 } = {}) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.appToken = appToken;
    this.contributionConsent = contributionConsent === true;
    this.fallback = fallback;
    this.timeout = timeout;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError('timeout must be positive');
  }

  async request(path, { method = 'GET', body, token = Boolean(this.appToken) } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const headers = { Accept: 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${this.appToken}`;
      const response = await fetch(`${this.endpoint}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal, credentials: 'omit',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || data.detail || `GeoPrefix HTTP ${response.status}`);
      return data;
    } finally { clearTimeout(timer); }
  }

  lookup(ip) {
    return this.request(`/api/lookup${ip ? `?ip=${encodeURIComponent(ip)}` : ''}`);
  }

  reverse({ latitude, longitude, radius_km = 25 }) {
    validateCoordinates(latitude, longitude);
    if (!Number.isFinite(radius_km) || radius_km <= 0) throw new TypeError('radius_km must be positive');
    const query = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), radius_km: String(radius_km) });
    return this.request(`/api/reverse?${query}`);
  }

  /** Host must disclose third-party contribution and obtain permission first. */
  contribute({ latitude, longitude, accuracy_m, captured_at = new Date().toISOString(), consent, installation_id,
    source = 'browser', provider = 'unknown', reported_accuracy_m = accuracy_m }) {
    if (consent !== true) throw new Error('Explicit contribution consent is required');
    if (!this.appToken) throw new Error('A public, scoped application token is required');
    validateCoordinates(latitude, longitude);
    if (!Number.isFinite(accuracy_m) || accuracy_m < 0) throw new TypeError('accuracy_m must be non-negative');
    if (!Number.isFinite(Date.parse(captured_at))) throw new TypeError('captured_at must be an ISO timestamp');
    const body = {
      latitude: roundCoordinate(latitude), longitude: roundCoordinate(longitude),
      accuracy_m: accuracy_m + 8000, reported_accuracy_m, source, provider, captured_at, consent: true,
    };
    if (installation_id) body.installation_id = installation_id;
    return this.request('/api/observations', { method: 'POST', body, token: true });
  }

  async getLocation() {
    let position;
    try {
      position = await this.browserPosition();
      validateCoordinates(position.coords.latitude, position.coords.longitude);
      if (!Number.isFinite(position.coords.accuracy) || position.coords.accuracy < 0) throw new Error('Invalid browser accuracy');
    } catch (error) {
      if (!this.fallback) throw error;
      const lookup = await this.lookup();
      return { source: 'ip', provider: 'geoprefix', fallback_reason: fallbackReason(error), lookup,
        contribution: { status: 'not_applicable' } };
    }
    const result = {
      source: 'browser', provider: 'unknown', latitude: position.coords.latitude,
      longitude: position.coords.longitude, accuracy_m: position.coords.accuracy,
      reported_accuracy_m: position.coords.accuracy,
      captured_at: new Date(position.timestamp || Date.now()).toISOString(),
      contribution: { status: this.contributionConsent ? 'missing_app_token' : 'disabled' },
    };
    if (this.contributionConsent && this.appToken) {
      try {
        const receipt = await this.contribute({ ...result, consent: true });
        result.contribution = { status: 'submitted', receipt };
      } catch (error) {
        result.contribution = { status: 'failed', message: error.message };
      }
    }
    return result;
  }

  locate() { return this.getLocation(); }

  browserPosition() {
    return new Promise((resolve, reject) => {
      const geolocation = globalThis.navigator?.geolocation;
      if (!geolocation) return reject(Object.assign(new Error('Browser location unavailable'), { code: 2 }));
      // A separate deadline also handles a browser that never calls either callback.
      const timer = setTimeout(() => reject(Object.assign(new Error('Browser location timed out'), { code: 3 })), this.timeout);
      const finish = callback => value => { clearTimeout(timer); callback(value); };
      try {
        geolocation.getCurrentPosition(finish(resolve), finish(reject), {
          enableHighAccuracy: true, maximumAge: 0, timeout: this.timeout,
        });
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  }
}

function validateCoordinates(latitude, longitude) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new TypeError('Valid latitude and longitude are required');
  }
}
function roundCoordinate(value) { return Number((Math.round(value / 0.1) * 0.1).toFixed(1)); }
function fallbackReason(error) {
  return ({ 1: 'permission_denied', 2: 'unavailable', 3: 'timeout' })[error.code] || 'unavailable';
}
export default GeoPrefix;
export function locate(options) { return new GeoPrefix(options).getLocation(); }
