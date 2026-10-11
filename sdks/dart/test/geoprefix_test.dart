// SPDX-License-Identifier: Apache-2.0
// Dependency-free transport tests: dart run test/geoprefix_test.dart
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../lib/geoprefix.dart';

void check(bool condition, String message) {
  if (!condition) throw StateError(message);
}

Future<void> expectError(
  FutureOr<Object?> Function() action,
  GeoPrefixErrorKind kind, {
  int? statusCode,
}) async {
  try {
    await action();
  } on GeoPrefixException catch (error) {
    check(error.kind == kind, 'Expected $kind, received ${error.kind}');
    if (statusCode != null)
      check(error.statusCode == statusCode, 'HTTP status');
    check(
      !error.toString().contains('gp_test_scoped'),
      'Token must not be logged',
    );
    return;
  }
  throw StateError('Expected GeoPrefixException($kind)');
}

Future<void> main() async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final received = <Map<String, Object?>>[];
  var mode = 'ok';
  var redirectRequests = 0;
  final subscription = server.listen((request) async {
    try {
      final text = await utf8.decoder.bind(request).join();
      received.add({
        'method': request.method,
        'uri': request.uri,
        'token': request.headers.value(HttpHeaders.authorizationHeader),
        'receipt': request.headers.value('X-Contribution-Receipt'),
        'body': text.isEmpty ? null : jsonDecode(text),
      });
      request.response.headers.contentType = ContentType.json;
      if (request.uri.path == '/redirect-target') redirectRequests++;
      if (mode == 'http') {
        request.response.statusCode = 429;
        request.response.write(jsonEncode({'detail': 'Quota reached.'}));
      } else if (mode == 'invalid') {
        request.response.write('<html>not json</html>');
      } else if (mode == 'array') {
        request.response.write('[]');
      } else if (mode == 'redirect') {
        request.response.statusCode = 302;
        request.response.headers.set(
          HttpHeaders.locationHeader,
          '/redirect-target',
        );
        request.response.write('{}');
      } else if (mode == 'slow') {
        await Future<void>.delayed(const Duration(milliseconds: 120));
        request.response.write('{}');
      } else {
        request.response.write(
          jsonEncode({'status': 'unknown', 'matches': <Object?>[]}),
        );
      }
      await request.response.close();
    } on HttpException {
      // The client intentionally aborts the timeout test.
    } on SocketException {
      // The client intentionally aborts the timeout test.
    }
  });
  final endpoint = Uri.parse('http://127.0.0.1:${server.port}');
  final client = GeoPrefixClient(
    endpoint: endpoint,
    appToken: 'gp_test_scoped',
  );
  try {
    final result = await client.lookup(ip: '2001:4860:4860::8888');
    check(result['status'] == 'unknown', 'Unknown is a valid response');
    var row = received.last;
    check(
      (row['uri'] as Uri).queryParameters['ip'] == '2001:4860:4860::8888',
      'IPv6 query must survive URI encoding',
    );
    check(row['token'] == 'Bearer gp_test_scoped', 'Bearer app token');
    await client.lookup();
    check(
      (received.last['uri'] as Uri).queryParameters.isEmpty,
      'Self-egress lookup omits ip',
    );

    await client.reverse(latitude: 40.7128, longitude: -74.0060, radiusKm: 100);
    check(
      (received.last['uri'] as Uri).queryParameters['radius_km'] == '100.0',
      'Reverse radius',
    );

    final captured = DateTime.now();
    await client.contribute(
      latitude: 40.74429,
      longitude: -73.96871,
      accuracyM: 12,
      consent: true,
      retention: 'history',
      capturedAt: captured,
      networkType: GeoPrefixNetworkType.mobile,
    );
    row = received.last;
    final body = row['body'] as Map<String, dynamic>;
    check(row['method'] == 'POST', 'Contribution uses POST');
    check(
      body['latitude'] == 40.7 && body['longitude'] == -74.0,
      'Precise coordinates must never leave the client',
    );
    check(body['accuracy_m'] == 8012.0, 'Conservative rounding uncertainty');
    check(body['retention'] == 'history', 'Disclosed history retention');
    check(
      body['reported_accuracy_m'] == 12.0,
      'Original provider uncertainty remains distinct',
    );
    check(
      body['consent'] == true && body['network_type'] == 'mobile',
      'Consent and network type',
    );
    check(
      DateTime.parse(body['captured_at'] as String).isUtc,
      'Timestamp must be UTC',
    );

    final beforeValidation = received.length;
    await expectError(
      () => client.contribute(
        latitude: 1,
        longitude: 2,
        accuracyM: 1,
        consent: false,
      ),
      GeoPrefixErrorKind.validation,
    );
    await expectError(
      () => client.contribute(
        latitude: double.nan,
        longitude: 2,
        accuracyM: 1,
        consent: true,
      ),
      GeoPrefixErrorKind.validation,
    );
    await expectError(
      () => client.contribute(
        latitude: 1,
        longitude: 2,
        accuracyM: 99999,
        consent: true,
      ),
      GeoPrefixErrorKind.validation,
    );
    await expectError(
      () => client.contribute(
        latitude: 1,
        longitude: 2,
        accuracyM: 1,
        consent: true,
        capturedAt: DateTime.now().subtract(const Duration(days: 2)),
      ),
      GeoPrefixErrorKind.validation,
    );
    await expectError(
      () => client.reverse(latitude: 91, longitude: 0),
      GeoPrefixErrorKind.validation,
    );
    await expectError(
      () => client.reverse(latitude: 0, longitude: 0, radiusKm: 1001),
      GeoPrefixErrorKind.validation,
    );
    await expectError(
      () => client.lookup(ip: 'not-an-ip'),
      GeoPrefixErrorKind.validation,
    );
    check(
      received.length == beforeValidation,
      'Invalid or non-consented data must not be sent',
    );
    final noToken = GeoPrefixClient(endpoint: endpoint);
    await expectError(
      () => noToken.contribute(
        latitude: 1,
        longitude: 2,
        accuracyM: 1,
        consent: true,
      ),
      GeoPrefixErrorKind.validation,
    );
    noToken.close();

    await client.withdraw(
      observationId: 'observation-123',
      contributionReceipt: 'receipt-123',
    );
    row = received.last;
    check(row['method'] == 'DELETE', 'Withdrawal uses DELETE');
    await client.withdraw(
        observationId: 'observation/123', contributionReceipt: 'receipt-123');
    check((received.last['uri'] as Uri).pathSegments.last == 'observation/123',
        'Opaque IDs must be encoded as one path segment');
    check(
      row['receipt'] == 'receipt-123' && row['token'] == null,
      'Withdrawal uses only its receipt',
    );

    mode = 'http';
    await expectError(
      () => client.lookup(ip: '8.8.8.8'),
      GeoPrefixErrorKind.http,
      statusCode: 429,
    );
    mode = 'invalid';
    await expectError(
      () => client.lookup(ip: '8.8.8.8'),
      GeoPrefixErrorKind.response,
    );
    mode = 'array';
    await expectError(
      () => client.lookup(ip: '8.8.8.8'),
      GeoPrefixErrorKind.response,
    );
    mode = 'redirect';
    await expectError(
      () => client.lookup(ip: '8.8.8.8'),
      GeoPrefixErrorKind.http,
      statusCode: 302,
    );
    check(redirectRequests == 0, 'Redirect must not forward the app token');
    mode = 'slow';
    final short = GeoPrefixClient(
      endpoint: endpoint,
      timeout: const Duration(milliseconds: 25),
    );
    await expectError(
      () => short.lookup(ip: '8.8.8.8'),
      GeoPrefixErrorKind.timeout,
    );
    short.close(force: true);
    mode = 'ok';

    client.close();
    await expectError(
      () => client.lookup(ip: '8.8.8.8'),
      GeoPrefixErrorKind.closed,
    );
    await expectError(
      () => GeoPrefixClient(endpoint: Uri.parse('ftp://example.com')),
      GeoPrefixErrorKind.validation,
    );
    await expectError(
      () => GeoPrefixClient(endpoint: endpoint, appToken: 'bad\r\ntoken'),
      GeoPrefixErrorKind.validation,
    );
    await expectError(
      () => GeoPrefixClient(endpoint: endpoint, timeout: Duration.zero),
      GeoPrefixErrorKind.validation,
    );
    stdout.writeln(
      'PASS: Dart transport, consent, precision, validation, HTTP errors, timeout, redirects and withdrawal.',
    );
  } finally {
    client.close(force: true);
    await subscription.cancel();
    await server.close(force: true);
  }
}
