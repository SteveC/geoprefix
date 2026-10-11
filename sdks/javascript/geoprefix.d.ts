export type JsonObject = Record<string, unknown>;
export interface GeoPrefixOptions {
  endpoint?: string; appToken?: string; contributionConsent?: boolean; fallback?: boolean; timeout?: number;
}
export interface Observation {
  latitude: number; longitude: number; accuracy_m: number; captured_at?: string;
  consent: boolean; installation_id?: string;
  source?: string; provider?: string; reported_accuracy_m?: number;
}
export interface Contribution {
  status: 'disabled' | 'missing_app_token' | 'submitted' | 'failed' | 'not_applicable';
  receipt?: JsonObject; message?: string;
}
export type LocationResult = {
  source: 'browser'; provider: 'unknown'; latitude: number; longitude: number;
  accuracy_m: number; reported_accuracy_m: number; captured_at: string; contribution: Contribution;
} | {
  source: 'ip'; provider: 'geoprefix'; fallback_reason: 'permission_denied' | 'unavailable' | 'timeout';
  lookup: JsonObject; contribution: Contribution;
};
export class GeoPrefix {
  constructor(options?: GeoPrefixOptions);
  lookup(ip?: string): Promise<JsonObject>;
  reverse(options: { latitude: number; longitude: number; radius_km?: number }): Promise<JsonObject>;
  contribute(observation: Observation): Promise<JsonObject>;
  getLocation(): Promise<LocationResult>;
  locate(): Promise<LocationResult>;
}
export default GeoPrefix;
export function locate(options?: GeoPrefixOptions): Promise<LocationResult>;
