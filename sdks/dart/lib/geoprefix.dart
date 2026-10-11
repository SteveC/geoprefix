// SPDX-License-Identifier: Apache-2.0
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// An API object. Unknown fields remain available for forward compatibility.
typedef GeoPrefixJson = Map<String, Object?>;

/// Errors are typed and do not include app tokens or raw response bodies.
enum GeoPrefixErrorKind { validation, http, network, timeout, response, closed }

class GeoPrefixException implements Exception {
  const GeoPrefixException(this.kind, this.message, {this.statusCode});

  final GeoPrefixErrorKind kind;
  final String message;
  final int? statusCode;

  @override
  String toString() => 'GeoPrefixException(${kind.name}'
      '${statusCode == null ? '' : ', HTTP $statusCode'}): $message';
}

enum GeoPrefixObservationSource { browser, gps, native }

enum GeoPrefixNetworkType {
  unknown,
  fixed,
  mobile,
  hosting,
  vpn,
  relay,
  satellite,
}

/// Dart VM / Flutter mobile and desktop API client.
///
/// This client never requests device permission or starts a location watcher.
/// The host app must disclose the contribution and obtain explicit agreement
/// before calling [contribute]. Platform permission alone is not that agreement.
/// Flutter web should use GeoPrefix's browser JavaScript SDK instead.
class GeoPrefixClient {
  GeoPrefixClient({
    required Uri endpoint,
    String? appToken,
    this.timeout = const Duration(seconds: 8),
    HttpClient? httpClient,
  })  : endpoint = _validateEndpoint(endpoint),
        _appToken = _validateToken(appToken),
        _httpClient = httpClient ?? HttpClient(),
        _ownsHttpClient = httpClient == null {
    if (timeout <= Duration.zero) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'timeout must be positive.',
      );
    }
  }

  final Uri endpoint;
  final Duration timeout;
  final String? _appToken;
  final HttpClient _httpClient;
  final bool _ownsHttpClient;
  bool _closed = false;

  /// Finds an IP's supported estimate. An unknown estimate has status "unknown".
  ///
  /// If [ip] is omitted, the server locates this client's public egress address.
  /// Call from the user's device; a server call would locate the server instead.
  Future<GeoPrefixJson> lookup({String? ip}) {
    if (ip != null && InternetAddress.tryParse(ip) == null) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'ip must be an IPv4 or IPv6 address without a prefix or zone identifier.',
      );
    }
    if (ip != null && ip.contains('%')) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'Scoped IPv6 addresses cannot be looked up.',
      );
    }
    return _request(
      'GET',
      '/api/lookup',
      query: ip == null ? null : {'ip': ip},
    );
  }

  /// Finds known network estimates whose uncertainty areas overlap a place.
  /// This is not an inventory of people, devices or all IPs in that location.
  Future<GeoPrefixJson> reverse({
    required double latitude,
    required double longitude,
    double radiusKm = 25,
  }) {
    _validateCoordinates(latitude, longitude);
    if (!radiusKm.isFinite || radiusKm <= 0 || radiusKm > 1000) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'radiusKm must be greater than zero and at most 1000.',
      );
    }
    return _request(
      'GET',
      '/api/reverse',
      query: {
        'latitude': '$latitude',
        'longitude': '$longitude',
        'radius_km': '$radiusKm',
      },
    );
  }

  /// Submits coarse evidence after the host's explicit contribution agreement.
  ///
  /// Coordinates are rounded to 0.1 degree before they leave this client.
  /// The reported radius is increased by 8000 meters to account conservatively
  /// for rounding. [accuracyM] is submitted as provider-reported uncertainty.
  /// Never label an unverified platform position as verified GPS ground truth.
  /// Preserve the returned contribution_receipt to withdraw the observation.
  Future<GeoPrefixJson> contribute({
    required double latitude,
    required double longitude,
    required double accuracyM,
    required bool consent,
    String retention = '30_days',
    DateTime? capturedAt,
    GeoPrefixObservationSource source = GeoPrefixObservationSource.native,
    String provider = 'unknown',
    GeoPrefixNetworkType networkType = GeoPrefixNetworkType.unknown,
  }) {
    if (!consent) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'Explicit host-obtained contribution consent is required.',
      );
    }
    if (_appToken == null) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'A scoped application token is required for contributions.',
      );
    }
    if (!['30_days', 'history'].contains(retention)) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'retention must be 30_days or history.',
      );
    }
    _validateCoordinates(latitude, longitude);
    if (!accuracyM.isFinite || accuracyM < 0 || accuracyM > 92000) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'accuracyM must be between 0 and 92000; the rounding allowance adds 8000.',
      );
    }
    if (provider.length > 40) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'provider must be at most 40 characters.',
      );
    }
    final now = DateTime.now().toUtc();
    final captured = (capturedAt ?? now).toUtc();
    if (now.difference(captured) > const Duration(days: 1) ||
        captured.difference(now) > const Duration(minutes: 5)) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'capturedAt must be from the past 24 hours, allowing 5 minutes of clock skew.',
      );
    }
    return _request(
      'POST',
      '/api/observations',
      body: {
        'latitude': _roundCoordinate(latitude),
        'longitude': _roundCoordinate(longitude),
        'accuracy_m': accuracyM + 8000,
        'reported_accuracy_m': accuracyM,
        'captured_at': captured.toIso8601String(),
        'consent': true,
        'retention': retention,
        'source': source.name,
        'provider': provider,
        'network_type': networkType.name,
      },
    );
  }

  /// Withdraws a private observation with its deletion receipt.
  /// Already downloaded public-domain aggregates cannot be recalled.
  Future<GeoPrefixJson> withdraw({
    required String observationId,
    required String contributionReceipt,
  }) {
    if (observationId.isEmpty || contributionReceipt.isEmpty) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'Both observationId and contributionReceipt are required.',
      );
    }
    return _request(
      'DELETE',
      '/api/observations/${Uri.encodeComponent(observationId)}',
      useToken: false,
      headers: {'X-Contribution-Receipt': contributionReceipt},
    );
  }

  /// Releases the owned HTTP client. A caller-supplied client stays open.
  /// No methods may be called on this GeoPrefix client after closing.
  void close({bool force = false}) {
    _closed = true;
    if (_ownsHttpClient) _httpClient.close(force: force);
  }

  Future<GeoPrefixJson> _request(
    String method,
    String path, {
    Map<String, String>? query,
    GeoPrefixJson? body,
    Map<String, String>? headers,
    bool useToken = true,
  }) async {
    if (_closed) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.closed,
        'This client is closed.',
      );
    }
    final uri = endpoint.replace(
      path: '${endpoint.path.replaceAll(RegExp(r'/+$'), '')}$path',
      queryParameters: query,
    );
    HttpClientRequest? pending;
    var timedOut = false;
    try {
      return await (() async {
        final request = await _httpClient.openUrl(method, uri);
        pending = request;
        if (timedOut || _closed) {
          request.abort();
          throw const GeoPrefixException(
            GeoPrefixErrorKind.closed,
            'The request was canceled before it could be sent.',
          );
        }
        // A redirect must not silently move the app token to another endpoint.
        request.followRedirects = false;
        request.headers.set(HttpHeaders.acceptHeader, 'application/json');
        if (useToken && _appToken != null) {
          request.headers.set(
            HttpHeaders.authorizationHeader,
            'Bearer $_appToken',
          );
        }
        headers?.forEach(request.headers.set);
        if (body != null) {
          request.headers.contentType = ContentType.json;
          request.write(jsonEncode(body));
        }
        final response = await request.close();
        final text = await utf8.decoder.bind(response).join();
        GeoPrefixJson? data;
        try {
          final decoded = jsonDecode(text);
          if (decoded is Map<String, dynamic>) data = decoded;
        } on FormatException {
          // A failed HTTP response may have an HTML body from a proxy.
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          final detail = data?['detail'];
          throw GeoPrefixException(
            GeoPrefixErrorKind.http,
            detail is String ? detail : 'The GeoPrefix request was rejected.',
            statusCode: response.statusCode,
          );
        }
        if (data == null) {
          throw const GeoPrefixException(
            GeoPrefixErrorKind.response,
            'GeoPrefix returned an invalid JSON object.',
          );
        }
        return data;
      })()
          .timeout(
        timeout,
        onTimeout: () {
          timedOut = true;
          pending?.abort();
          throw const GeoPrefixException(
            GeoPrefixErrorKind.timeout,
            'GeoPrefix timed out. A submitted observation may already have been accepted; do not retry automatically.',
          );
        },
      );
    } on GeoPrefixException {
      rethrow;
    } on SocketException {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.network,
        'GeoPrefix could not be reached.',
      );
    } on HttpException {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.network,
        'The GeoPrefix connection ended unexpectedly.',
      );
    } on IOException {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.network,
        'The GeoPrefix connection could not be completed.',
      );
    } on StateError {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.closed,
        'The HTTP client is no longer available.',
      );
    } on FormatException {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.response,
        'GeoPrefix returned an invalid text response.',
      );
    }
  }

  static Uri _validateEndpoint(Uri endpoint) {
    if (!['http', 'https'].contains(endpoint.scheme) ||
        endpoint.host.isEmpty ||
        endpoint.userInfo.isNotEmpty ||
        endpoint.hasQuery ||
        endpoint.hasFragment) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'endpoint must be an http(s) base URL without credentials, query or fragment.',
      );
    }
    return endpoint;
  }

  static String? _validateToken(String? token) {
    if (token != null &&
        (token.trim().isEmpty || token.contains(RegExp(r'[\r\n]')))) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'appToken must be a non-empty single-line token.',
      );
    }
    return token?.trim();
  }

  static void _validateCoordinates(double latitude, double longitude) {
    if (!latitude.isFinite ||
        latitude < -90 ||
        latitude > 90 ||
        !longitude.isFinite ||
        longitude < -180 ||
        longitude > 180) {
      throw const GeoPrefixException(
        GeoPrefixErrorKind.validation,
        'Latitude must be within [-90, 90] and longitude within [-180, 180].',
      );
    }
  }

  static double _roundCoordinate(double value) =>
      double.parse(((value * 10).round() / 10).toStringAsFixed(1));
}
