// SPDX-License-Identifier: Apache-2.0
import '../lib/geoprefix.dart';

Future<void> main() async {
  final client = GeoPrefixClient(
    endpoint: Uri.parse('https://geoprefix-preview.goodspider.net'),
    // An app token is optional for a public lookup, required to contribute.
  );
  try {
    final estimate = await client.lookup(ip: '8.8.8.8');
    print('Estimate status: ${estimate['status']}');
    // Respect status "unknown", accuracy_radius_km and evidence timestamps.
  } on GeoPrefixException catch (error) {
    print('Request failed: ${error.kind.name}');
  } finally {
    client.close();
  }
}
