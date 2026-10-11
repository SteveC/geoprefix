// SPDX-License-Identifier: Apache-2.0
package net.goodspider.geoprefix

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.round

/** Host obtains location permission. This client never requests permission or tracks users. */
class GeoPrefixClient(endpoint: String, private val appToken: String? = null) {
    private val endpoint = endpoint.trimEnd('/')

    suspend fun lookup(ip: String? = null): JSONObject = request(
        "/api/lookup" + if (ip.isNullOrBlank()) "" else "?ip=" + URLEncoder.encode(ip, "UTF-8"))

    suspend fun reverse(latitude: Double, longitude: Double, radiusKm: Double = 25.0): JSONObject {
        validate(latitude, longitude)
        require(radiusKm.isFinite() && radiusKm > 0) { "radiusKm must be positive" }
        return request("/api/reverse?latitude=$latitude&longitude=$longitude&radius_km=$radiusKm")
    }

    /** Contribution requires separate explicit permission, beyond native location access. */
    suspend fun contribute(latitude: Double, longitude: Double, accuracyMeters: Double,
                           consent: Boolean, capturedAt: Date = Date(), provider: String = "unknown", retention: String = "30_days"): JSONObject {
        require(consent) { "Explicit contribution consent is required" }
        require(!appToken.isNullOrBlank()) { "A scoped application token is required" }
        require(retention in listOf("30_days", "history")) { "retention must be 30_days or history" }
        validate(latitude, longitude)
        require(accuracyMeters.isFinite() && accuracyMeters >= 0) { "accuracyMeters must be non-negative" }
        val timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(capturedAt)
        return request("/api/observations", JSONObject()
            .put("latitude", round(latitude * 10) / 10)
            .put("longitude", round(longitude * 10) / 10)
            .put("accuracy_m", accuracyMeters + 8000)
            .put("reported_accuracy_m", accuracyMeters)
            .put("captured_at", timestamp).put("source", "native")
            .put("provider", provider).put("consent", true).put("retention", retention))
    }

    private fun validate(latitude: Double, longitude: Double) {
        require(latitude.isFinite() && longitude.isFinite() && latitude in -90.0..90.0 && longitude in -180.0..180.0) {
            "Valid latitude and longitude are required"
        }
    }
    private suspend fun request(path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val connection = URL(endpoint + path).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 8000; connection.readTimeout = 8000
            connection.setRequestProperty("Accept", "application/json")
            if (!appToken.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $appToken")
            if (body != null) {
                connection.requestMethod = "POST"; connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val text = (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            check(code in 200..299) { "GeoPrefix HTTP $code: $text" }
            JSONObject(text)
        } finally { connection.disconnect() }
    }
}
