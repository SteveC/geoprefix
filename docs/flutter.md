# Flutter integration

GeoPrefix includes an Apache-2.0 Dart SDK at `sdks/dart`. It uses only Dart's `HttpClient`; no runtime dependencies or platform permission plugin are bundled. It supports Flutter on iOS, Android and desktop, plus Dart VM applications. Flutter web should use the JavaScript browser SDK rather than this `dart:io` client.

## Install

The SDK is available from Git and has not been published to pub.dev:

```yaml
dependencies:
  geoprefix:
    git:
      url: https://github.com/SteveC/geoprefix.git
      path: sdks/dart
```

Use your existing location provider. For an app using `geolocator`, add it in the host Flutter project:

```sh
flutter pub add geolocator
```

Follow the maintained [geolocator platform setup](https://pub.dev/packages/geolocator), including foreground location declarations for each target platform. GeoPrefix does not require background location. The example below uses the current `LocationSettings`, `checkPermission`, `requestPermission`, and `getCurrentPosition` APIs documented by the [plugin maintainers](https://github.com/Baseflow/flutter-geolocator/blob/main/geolocator/lib/geolocator.dart).

## Explain the contribution before requesting permission

The host app owns the disclosure and consent flow. A native location permission prompt does not explain third-party data contribution and is not sufficient by itself. Use a notice appropriate to the app and its audience before calling the helper. For example:

> Use your location for this feature and help improve GeoPrefix's public network map. If location succeeds, the app will automatically send GeoPrefix a rounded location and reported uncertainty. GeoPrefix observes your connection's public IP, keeps each rounded observation in private history until you withdraw it, and may publish network summaries under CC0. If location access is declined or unavailable, the app will request an approximate IP-based estimate instead. Precise coordinates are not contributed.

Only pass `informedContributionConsent: true` after the user agrees to that disclosed behavior. If they decline this notice, keep the contribution disabled and use the app's normal alternative. Include access to the service's [contribution notice](https://geoprefix-preview.goodspider.net/privacy) in the host app.

## Permission, automatic contribution, and fallback

This helper belongs in the Flutter host app. The core Dart SDK has no `geolocator` dependency. Call it from a deliberate user action after agreement, rather than on every screen build or app launch.

```dart
import 'package:geolocator/geolocator.dart';
import 'package:geoprefix/geoprefix.dart';

class AppLocation {
  const AppLocation({
    this.devicePosition,
    this.ipEstimate,
    this.contribution,
    this.contributionError,
  });

  final Position? devicePosition;
  final GeoPrefixJson? ipEstimate;
  final GeoPrefixJson? contribution;
  final GeoPrefixException? contributionError;
}

Future<Position?> readForegroundPosition() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) return null;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission != LocationPermission.whileInUse &&
        permission != LocationPermission.always) {
      return null;
    }
    return await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.medium,
        timeLimit: Duration(seconds: 8),
      ),
    );
  } on Exception {
    // Denial, a disabled provider, or timeout can use the disclosed IP fallback.
    return null;
  }
}

Future<AppLocation> locateAndContribute(
  GeoPrefixClient client, {
  required bool informedContributionConsent,
}) async {
  if (!informedContributionConsent) {
    throw ArgumentError('Obtain the disclosed contribution agreement first.');
  }
  final position = await readForegroundPosition();
  if (position == null) {
    // This is the device's public egress address; no GPS data is submitted.
    return AppLocation(ipEstimate: await client.lookup());
  }
  try {
    // Automatic after agreement and successful location. The SDK rounds before
    // transmission, so the precise device position stays inside the host app.
    final contribution = await client.contribute(
      latitude: position.latitude,
      longitude: position.longitude,
      accuracyM: position.accuracy,
      capturedAt: position.timestamp,
      consent: true,
      retention: 'history',
      source: GeoPrefixObservationSource.native,
      provider: 'unknown',
      networkType: GeoPrefixNetworkType.unknown,
    );
    return AppLocation(
      devicePosition: position,
      contribution: contribution,
    );
  } on GeoPrefixException catch (error) {
    // Contribution failure should not discard a successful device position.
    // Show or record the failure status without logging coordinates or tokens.
    return AppLocation(
      devicePosition: position,
      contributionError: error,
    );
  }
}

final client = GeoPrefixClient(
  endpoint: Uri.parse('https://geoprefix-preview.goodspider.net'),
  appToken: 'YOUR_SCOPED_APP_TOKEN',
  timeout: const Duration(seconds: 8),
);

// In the callback for the host's agreed location action:
// final result = await locateAndContribute(
//   client,
//   informedContributionConsent: agreementWasAccepted,
// );
// Release the client in the owning service's dispose/close lifecycle:
// client.close();
```

The native provider may derive a position from GPS, Wi-Fi, cellular information or an IP source. The example does not claim verified GPS ground truth. `networkType` can identify known mobile or fixed connections; known VPN, relay, hosting or satellite connections are quarantined by the service. The SDK cannot reliably detect all such connections automatically.

## Data, error handling, and withdrawal

Coordinates are rounded to a 0.1° grid before upload, roughly 11 km north/south. The SDK adds an 8 km rounding allowance to the uncertainty radius and keeps provider-reported accuracy separate. A token and `consent: true` are required. The example explicitly selects `retention: 'history'` after disclosing continuing retention; the SDK default remains `30_days` for compatibility with existing notices. Values outside latitude/longitude ranges, nonfinite numbers, an inflated accuracy above the API limit, and stale timestamps are rejected before transmission.

`GeoPrefixException.kind` distinguishes validation, HTTP, network, timeout, response-format and closed-client failures. HTTP failures expose `statusCode`. Methods do not retry automatically. If a request times out, the server may already have received it.

A successful location can produce `accepted`, `duplicate`, or `quarantined` contribution status. Only accepted responses include a new deletion receipt. Preserve `id` and `contribution_receipt` in the host's user-controlled receipt storage so the user can withdraw that private observation:

```dart
await client.withdraw(
  observationId: acceptedContribution['id'] as String,
  contributionReceipt:
      acceptedContribution['contribution_receipt'] as String,
);
```

A withdrawal recomputes future exports; public-domain releases downloaded previously cannot be recalled. Native apps should use scoped app tokens, never administrative credentials. Embedded native tokens are extractable and do not authenticate the truth of a reported position. Use HTTPS for the remote service, and respect every estimate's `status`, evidence timestamp, and `accuracy_radius_km`.

## Verification

The core client has dependency-free loopback HTTP tests covering bearer headers, lookup/reverse queries, consent rejection before transmission, coordinate coarsening, uncertainty, validation, deletion receipts, typed HTTP/format errors, timeout, and redirect refusal. Run `dart analyze` and `dart run test/geoprefix_test.dart` from `sdks/dart`. The integration example still requires testing in the host app on physical devices; platform permission and location behavior are not proven by core transport tests.
