"""GeoPrefix API client. SPDX-License-Identifier: Apache-2.0."""
import json
import math
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class GeoPrefix:
    def __init__(self, endpoint, app_token=None, timeout=8):
        self.endpoint = endpoint.rstrip("/")
        self.app_token = app_token
        self.timeout = timeout

    def _request(self, path, body=None):
        headers = {"Accept": "application/json", "User-Agent": "GeoPrefix/0.1 Python SDK"}
        if self.app_token:
            headers["Authorization"] = f"Bearer {self.app_token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.endpoint + path, headers=headers,
                          data=json.dumps(body).encode() if body is not None else None)
        with urlopen(request, timeout=self.timeout) as response:
            return json.load(response)

    def lookup(self, ip=None):
        """Omitting ip locates this Python process's public egress, not an end user."""
        return self._request("/api/lookup" + ("?" + urlencode({"ip": ip}) if ip else ""))

    def reverse(self, latitude, longitude, radius_km=25):
        _coordinates(latitude, longitude)
        if not math.isfinite(radius_km) or radius_km <= 0:
            raise ValueError("radius_km must be positive")
        return self._request("/api/reverse?" + urlencode(dict(
            latitude=latitude, longitude=longitude, radius_km=radius_km)))

    def contribute(self, latitude, longitude, accuracy_m, *, consent=False,
                   captured_at=None, source="native", provider="unknown", retention="30_days"):
        """Upload only host-authorized observations; never uploads precise coordinates."""
        if consent is not True:
            raise ValueError("Explicit contribution consent is required")
        if not self.app_token:
            raise ValueError("A scoped application token is required")
        if retention not in ("30_days", "history"):
            raise ValueError("retention must be 30_days or history")
        _coordinates(latitude, longitude)
        if not math.isfinite(accuracy_m) or accuracy_m < 0:
            raise ValueError("accuracy_m must be non-negative")
        # Match the public grid, with a conservative allowance for rounding error.
        return self._request("/api/observations", dict(
            latitude=round(latitude, 1), longitude=round(longitude, 1),
            accuracy_m=accuracy_m + 8000, reported_accuracy_m=accuracy_m,
            captured_at=captured_at or datetime.now(timezone.utc).isoformat(),
            source=source, provider=provider, consent=True, retention=retention))


def _coordinates(latitude, longitude):
    if not (math.isfinite(latitude) and -90 <= latitude <= 90 and
            math.isfinite(longitude) and -180 <= longitude <= 180):
        raise ValueError("Valid latitude and longitude are required")
