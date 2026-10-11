# GeoPrefix for Dart and Flutter

A dependency-free `dart:io` API client for Flutter mobile/desktop and Dart VM applications. Apache-2.0 licensed. This package does not request device permission, acquire coordinates, or run a background watcher. Flutter web uses the [JavaScript SDK](../javascript/).

Install from this repository; the package is not published to pub.dev:

```yaml
dependencies:
  geoprefix:
    git:
      url: https://github.com/SteveC/geoprefix.git
      path: sdks/dart
```

```dart
import 'package:geoprefix/geoprefix.dart';

final client = GeoPrefixClient(
  endpoint: Uri.parse('https://geoprefix-preview.goodspider.net'),
  appToken: 'YOUR_SCOPED_APP_TOKEN',
);
try {
  final estimate = await client.lookup(ip: '8.8.8.8');
  final nearby = await client.reverse(
    latitude: 40.7128,
    longitude: -74.0060,
    radiusKm: 100,
  );
  // Estimates may have status "unknown". Preserve the stated accuracy radius.
} on GeoPrefixException catch (error) {
  // Handle error.kind and optional error.statusCode without logging coordinates.
} finally {
  client.close();
}
```

After your app has explained the contribution and received explicit agreement, pass a fresh position from your existing platform location provider:

```dart
final receipt = await client.contribute(
  latitude: position.latitude,
  longitude: position.longitude,
  accuracyM: position.accuracy,
  capturedAt: position.timestamp,
  consent: informedContributionConsent,
  source: GeoPrefixObservationSource.native,
  provider: 'unknown',
  networkType: GeoPrefixNetworkType.unknown,
);
```

`contribute` rejects `consent: false` or a missing app token before sending anything. It rounds coordinates to 0.1° and adds 8 km to reported uncertainty before transmission; precise coordinates are not uploaded. Native permission is separate from consent to contribute. The API observes the connection's public IP; callers cannot upload a location for an arbitrary target IP.

Preserve an accepted response's `id` and `contribution_receipt`. To withdraw its private observation:

```dart
await client.withdraw(
  observationId: receipt['id'] as String,
  contributionReceipt: receipt['contribution_receipt'] as String,
);
```

Duplicate and quarantined responses may have no deletion receipt. Already downloaded CC0 aggregates cannot be recalled. There are no automatic retries, including after a timeout: the server may already have accepted a request.

`lookup()` without an IP locates the calling device's public egress. In a backend process it locates the backend instead. A lookup can be unknown, and a VPN exit does not locate its user. Use HTTPS for remote endpoints. App tokens are scoped application credentials, not administrative credentials; a native binary cannot keep an embedded token secret.

See [Flutter integration](../../docs/flutter.md) for a `geolocator` example with permission handling, IP fallback, and automatic coarse contribution after agreement.

Run the SDK checks without third-party test dependencies:

```sh
dart pub get --offline
dart analyze
dart run test/geoprefix_test.dart
```
