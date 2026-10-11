# GeoPrefix

An open-source, empty-by-default network location atlas. Latest supported network estimates are public domain (CC0); the server, website and SDKs use Apache 2.0. No commercial IP geolocation data is imported.

Public alpha: https://geoprefix-preview.goodspider.net

## Run

Use Python 3.10+ and install requirements.txt, then run `uvicorn server.app:app --host 0.0.0.0 --port 8000 --no-access-log --no-proxy-headers`. Or run `docker compose up --build -d`. Open http://localhost:8000 and /docs. Persist DATA_DIR (default ./data, Docker /data). Back up the entire directory including its private hashing key. One API process is intended for the initial SQLite deployment.

## What works

- IPv4/IPv6 lookup, coordinate/radius search, JSON/CSV CC0 exports with 40 explicit columns.
- Public app-token registration, origin controls, per-minute and monthly limits, disclosed coarse contribution and deletion receipts.
- Prefix consensus requiring five distinct address observations across two days. Unsupported, conflicting and sparse ranges return unknown.
- 20% randomized holdouts never train the map; accuracy reports show sample sizes and limitations.
- JavaScript browser location with automatic contribution after disclosed agreement and IP fallback on denial/unavailability; native and server client packages under sdks/.
- Country/continent enrichment from public-domain Natural Earth boundaries. Border geometry is coarse. Unsupported city, timezone, ASN and risk fields remain null, not guessed.

## Honest launch state

There are no real observations initially, so downloads contain only headers and accuracy is not yet measured. Coordinate-to-IP search returns known network ranges, not all devices or a single definitive IP. Mobile NAT, VPNs, anycast and forged coordinates remain hard problems. Never market these estimates as exact personal locations. Holdout data is still community-supplied and is not an independent audit.

High-volume managed hosting is the planned revenue model; software and complete current data remain free. The launch goal is $1,000 MRR. Paid-plan interest capture exists, but checkout is not active until a payment provider is connected. This repository does not modify or release any of the owner's mobile apps. The [Flutter guide](docs/flutter.md) covers integration into the owner's apps; SDKs are available for JavaScript/TypeScript, Swift/iOS, Kotlin/Android, Dart/Flutter and Python.

## Deploy with Coolify

Create a public Git application using the Dockerfile, internal port 8000 and health path /health. Mount a persistent volume at /data. Use a temporary HTTPS domain initially. Set TRUST_PROXY_CIDRS to the actual immediate reverse-proxy address(es) only after inspecting the deployment topology. Do not trust arbitrary forwarding headers or set 0.0.0.0/0. Traefik must append its real external peer to X-Forwarded-For; the app accepts CF-Connecting-IP only when that external peer is Cloudflare. Direct-origin visitor headers cannot impersonate Cloudflare. The app disables Uvicorn proxy-header rewriting deliberately, so the source socket is available for validation. Revalidate proxy addresses after infrastructure changes. Retention cleanup runs hourly and on aggregate reads; samples age out after 30 days, with up to an hour of scheduling delay.

## Tests

Install pytest/httpx and run `python -m pytest tests`. JavaScript SDK tests are documented in sdks/javascript. Dart checks are documented in sdks/dart. CI checks the service and JavaScript/Dart clients, builds the Swift package, and assembles the Android library on every push. Native permission flows still require testing in the host apps on physical devices. Use an isolated DATA_DIR for tests; no synthetic measurements should enter the production atlas.

## Data provenance

Own opt-in observations: CC0 aggregate release. Natural Earth boundaries: public domain, https://www.naturalearthdata.com/about/terms-of-use/. Its geometry is used for country labels only. No MaxMind, DB-IP, IPinfo or other licensed IP database is included.
