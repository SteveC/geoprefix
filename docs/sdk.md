# GeoPrefix SDKs

GeoPrefix provides a browser ESM module with TypeScript declarations, a Swift package, an Android Kotlin client and a dependency-free Python client. These are initial clients for the same open API, not published package-registry releases. Software is Apache-2.0; GeoPrefix's own published aggregate data is CC0. Imported data retains its source license and attribution.

## Browser and TypeScript

The server exposes `sdks/javascript/geoprefix.js` at `/sdk/geoprefix.js`. Import it from your deployment's HTTPS origin, or use the local module and its adjacent TypeScript declarations. Cross-origin browser requests require the service to allow your application's origin.

```html
<p>
  We use browser location to customize this page. If you decline or it is
  unavailable, GeoPrefix estimates an approximate location from your IP.
</p>
<label>
  <input id="contribute" type="checkbox">
  Also help improve the open GeoPrefix database: send our public IP alongside
  location rounded to a 0.1° grid, reported accuracy and observation time.
  This is optional and may be commercially reused as coarse network estimates.
</label>
<button id="locate">Find my location</button>
<pre id="result"></pre>
<script type="module">
  import { locate } from '/sdk/geoprefix.js';

  document.querySelector('#locate').onclick = async () => {
    try {
      const result = await locate({
        endpoint: 'https://YOUR-DEPLOYMENT',
        appToken: 'YOUR_PUBLIC_SCOPED_APP_TOKEN',
        contributionConsent: document.querySelector('#contribute').checked,
        fallback: true,
        timeout: 8000,
      });
      document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      document.querySelector('#result').textContent = error.message;
    }
  };
</script>
```

The example checkbox is one way for a host to record the separate contribution choice. A host that has already obtained and recorded this explicit permission can configure `contributionConsent: true`; successful browser observations then contribute automatically. The SDK itself shows no additional popup. Browser permission alone does not establish permission to send an observation to our shared database. Keep the disclosure visible and accurate, including retention and deletion information from the deployed privacy policy.

The browser result has `source: "browser"`, the original coordinates for the host's immediate task, `accuracy_m`, `reported_accuracy_m`, `captured_at`, and `provider: "unknown"`. Browser APIs may use GPS, Wi-Fi or IP-based positioning; a successful response is not verified GPS ground truth. No coordinates leave the SDK when contribution is disabled. If enabled, uploads are rounded to a 0.1° grid, and the submitted `accuracy_m` adds an 8,000-metre conservative rounding allowance. `reported_accuracy_m` retains the browser's original reported accuracy. Coarsening reduces precision; it does not by itself prove anonymity.

On permission denial, timeout or unavailability, the result has `source: "ip"`, a `fallback_reason`, and the unmodified API response under `lookup`. Preserve that response's uncertainty and dataset age in your UI. A fallback lookup does not submit a training observation. Setting `fallback: false` rejects instead. The fallback uses the service-observed public IP, which can be a VPN, relay, corporate gateway or mobile carrier egress.

Contribution results are separate from the useful position: `disabled`, `missing_app_token`, `submitted`, or `failed`. A failed submission still returns the successful browser position. `submitted` means the service returned a receipt; inspect `contribution.receipt.status` to distinguish quarantined from accepted. The SDK generates no persistent device identifier, cookie or installation ID. It does not poll or track movement.

For direct API use:

```js
import { GeoPrefix } from '/sdk/geoprefix.js';
const client = new GeoPrefix({ endpoint: 'https://YOUR-DEPLOYMENT' });
const currentNetwork = await client.lookup();
const address = await client.lookup('8.8.8.8');
const knownPrefixes = await client.reverse({
  latitude: 40.7, longitude: -74.0, radius_km: 25,
});
```

Reverse lookup returns known prefix estimates around a region. It does not enumerate devices or establish that every address in a prefix is physically there. IP lookups and reverse queries send their requested inputs to the configured service.

## Swift / iOS

Add the local package at `sdks/swift` in Xcode. The package supports iOS 15+ and macOS 12+. The app obtains Core Location permission and coordinates; the client does not request location access. Native location permission and permission to contribute are separate decisions.

```swift
import GeoPrefix

let client = GeoPrefixClient(
    endpoint: URL(string: "https://YOUR-DEPLOYMENT")!,
    appToken: "YOUR_PUBLIC_SCOPED_APP_TOKEN"
)
let network = try await client.lookup()
let knownPrefixes = try await client.reverse(latitude: 40.7, longitude: -74.0)

// Only after the app has obtained and recorded contribution permission:
let receipt = try await client.contribute(
    latitude: location.coordinate.latitude,
    longitude: location.coordinate.longitude,
    accuracyMeters: location.horizontalAccuracy,
    consent: userExplicitlyConsented,
    capturedAt: location.timestamp
)
```

Responses are `[String: JSONValue]`, preserving API fields without forcing a premature schema. Contribution rounds coordinates before transmission and labels the source `native`, provider `unknown` unless the host supplies a known provider. Negative native accuracy is rejected. Catch submission failures separately from your app's usable native position.

## Android / Kotlin

Use `sdks/android` as an Android library module or copy its client into an app already using Kotlin coroutines. It needs the Android `INTERNET` permission and `kotlinx-coroutines-android`; requests run on `Dispatchers.IO`. Build configuration targets Android API 35, minimum API 23. The host app owns runtime location permission, acquisition and fallback UX.

```kotlin
import net.goodspider.geoprefix.GeoPrefixClient

val client = GeoPrefixClient("https://YOUR-DEPLOYMENT", "YOUR_PUBLIC_SCOPED_APP_TOKEN")
// In an existing lifecycle-aware coroutine:
val network = client.lookup()
val prefixes = client.reverse(40.7, -74.0, 25.0)
// userExplicitlyConsented must record permission for database contribution.
val receipt = client.contribute(
    latitude = location.latitude,
    longitude = location.longitude,
    accuracyMeters = location.accuracy.toDouble(),
    consent = userExplicitlyConsented,
    capturedAt = java.util.Date(location.time)
)
```

Use `location.hasAccuracy()` before submitting and reject mock/suspect fixes according to your application's policy. Android responses are `JSONObject`. Submission failures throw; preserve the native position independently. No installation ID is generated or persisted.

## Python

Install the local client with `python -m pip install ./sdks/python`, or add that directory to your module search path. Python 3.10+; standard library only.

```python
from geoprefix import GeoPrefix

client = GeoPrefix("https://YOUR-DEPLOYMENT", app_token="YOUR_PUBLIC_SCOPED_APP_TOKEN")
result = client.lookup("8.8.8.8")
prefixes = client.reverse(40.7, -74.0, radius_km=25)
```

Omitting `ip` from a server-side Python lookup locates the server's public egress. It does not infer a visitor's address. The contribution method accepts coordinates obtained and authorized by the host; do not proxy a visitor's coordinates through a server and accidentally pair them with that server's IP. Responses are dictionaries. Network/HTTP failures use standard `urllib` exceptions.

## Tokens, privacy and scope

Create an application using the website or `POST /api/apps`. Use its limited-scope `app_token` as the SDK token. Browser and mobile tokens are public and must be quota-limited by the service. Never embed an administrator key or other server secret. None of these clients takes an administrator key.

Contribution requests use `POST /api/observations` with a bearer application token and `consent: true`. Accepted responses include the observation ID, validation status and `contribution_receipt`. Quarantined or duplicate responses may omit a receipt. Keep an accepted contribution's receipt private: it authorizes withdrawal using `DELETE /api/observations/{id}` and the `X-Contribution-Receipt` header. Uploaded observations remain subject to quarantine, network classification and independent corroboration. Browser/IP-derived circular observations, VPN exits, relays, mobile addressing and anycast require special handling by the data pipeline. Receiving a receipt does not imply that the estimate has been added to a public release.

The native and Python clients provide lookup, reverse lookup and explicit contribution. Automatic native permission prompts, native browser-first orchestration, package-registry publishing and additional languages are later work. Raw personal contribution records must not become public downloads; the public data product consists of validated coarse network aggregates.

## Verification

- Browser: `cd sdks/javascript && npm test` checks permission denial, deadlines, unavailable location, consent, coordinate rounding, upload failures and lookup failures.
- Swift: `cd sdks/swift && swift build` compiles the package.
- Python: the initial contribution serialization, coarse rounding and no-identifier behavior have been smoke-checked.
- Android: source and Gradle module supplied; compilation requires a local Gradle/Android SDK installation and has not been verified in this workspace.
