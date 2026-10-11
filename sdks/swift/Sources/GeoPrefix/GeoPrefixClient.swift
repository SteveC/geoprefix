// SPDX-License-Identifier: Apache-2.0
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum JSONValue: Codable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Double.self) { self = .number(value) }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .string(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .bool(let value): try c.encode(value)
        case .null: try c.encodeNil()
        }
    }
}

public enum GeoPrefixError: Error { case invalidInput, consentRequired, tokenRequired, http(Int) }

public struct GeoPrefixClient: Sendable {
    public let endpoint: URL
    public let appToken: String?
    public init(endpoint: URL, appToken: String? = nil) {
        self.endpoint = endpoint; self.appToken = appToken
    }
    /// Without ip, this locates the calling device's public network egress.
    public func lookup(ip: String? = nil) async throws -> [String: JSONValue] {
        try await request("/api/lookup", query: ip.map { [URLQueryItem(name: "ip", value: $0)] } ?? [])
    }
    public func reverse(latitude: Double, longitude: Double, radiusKm: Double = 25) async throws -> [String: JSONValue] {
        try validate(latitude, longitude)
        guard radiusKm.isFinite && radiusKm > 0 else { throw GeoPrefixError.invalidInput }
        return try await request("/api/reverse", query: [
            URLQueryItem(name: "latitude", value: String(latitude)),
            URLQueryItem(name: "longitude", value: String(longitude)),
            URLQueryItem(name: "radius_km", value: String(radiusKm))])
    }
    /// Host obtains native permission AND separate permission for contribution.
    public func contribute(latitude: Double, longitude: Double, accuracyMeters: Double,
                           consent: Bool, capturedAt: Date = Date(), provider: String = "unknown") async throws -> [String: JSONValue] {
        guard consent else { throw GeoPrefixError.consentRequired }
        guard appToken != nil else { throw GeoPrefixError.tokenRequired }
        try validate(latitude, longitude)
        guard accuracyMeters.isFinite && accuracyMeters >= 0 else { throw GeoPrefixError.invalidInput }
        return try await request("/api/observations", body: [
            "latitude": .number((latitude * 10).rounded() / 10),
            "longitude": .number((longitude * 10).rounded() / 10),
            "accuracy_m": .number(accuracyMeters + 8000),
            "reported_accuracy_m": .number(accuracyMeters),
            "captured_at": .string(ISO8601DateFormatter().string(from: capturedAt)),
            "source": .string("native"), "provider": .string(provider), "consent": .bool(true)])
    }
    private func validate(_ latitude: Double, _ longitude: Double) throws {
        guard latitude.isFinite && longitude.isFinite && (-90...90).contains(latitude) && (-180...180).contains(longitude)
        else { throw GeoPrefixError.invalidInput }
    }
    private func request(_ path: String, query: [URLQueryItem] = [], body: [String: JSONValue]? = nil) async throws -> [String: JSONValue] {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { throw GeoPrefixError.invalidInput }
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = (components.path.isEmpty ? "" : "/" + components.path) + path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw GeoPrefixError.invalidInput }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let appToken { req.setValue("Bearer \(appToken)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpMethod = "POST"; req.httpBody = try JSONEncoder().encode(body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw GeoPrefixError.http(0) }
        guard (200..<300).contains(http.statusCode) else { throw GeoPrefixError.http(http.statusCode) }
        return try JSONDecoder().decode([String: JSONValue].self, from: data)
    }
}
