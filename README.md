# GeoPrefix

An open-source, empty-by-default network location atlas. Latest supported network estimates are public domain (CC0); the server, website and SDKs use Apache 2.0. No commercial IP geolocation data is imported.

Public alpha: https://geoprefix-preview.goodspider.net

## Run

Use Python 3.10+ and install requirements.txt, then run `uvicorn server.app:app --host 0.0.0.0 --port 8000 --no-access-log --no-proxy-headers`. Or run `docker compose up --build -d`. Open http://localhost:8000 and /docs. Persist DATA_DIR (default ./data, Docker /data). Back up the entire directory including its private hashing key. One API process is intended for the initial SQLite deployment.

## What works

- IPv4/IPv6 lookup, coordinate/radius search, JSON/CSV CC0 exports with 45 explicit columns.
- Public app-token registration, origin controls, per-minute and monthly limits, disclosed coarse contribution and deletion receipts.
- Observer-balanced history requiring five distinct public addresses across two days. Sparse ranges return unknown; dispersed blocks remain published with their wider uncertainty radius and spread metrics.
- New addresses use a stable 20% holdout split across repeat visits. Accuracy reports separate prediction error from descriptive location spread, and reduce repeat-visit bias by grouping evaluations per address/day. Legacy launch samples retain their original split.
- JavaScript browser location with automatic contribution after disclosed agreement and IP fallback on denial/unavailability; native and server client packages under sdks/.
- Country/continent enrichment for compact estimates from public-domain Natural Earth boundaries. Border geometry is coarse. Unsupported city, timezone, ASN and risk fields remain null, not guessed.

The homepage uses the shipped JavaScript SDK, asks for contribution agreement on arrival, then requests browser location. Decline/unavailability falls back through the same SDK. Lookup, reverse search, app registration and other tools are at `/tools.html`. Individual observation history stays private; public downloads contain network summaries. The homepage keeps deletion receipts in local browser storage.

## Honest launch state

There are no real observations initially, so downloads contain only headers and accuracy is not yet measured. Coordinate-to-IP search returns known network ranges, not all devices or a single definitive IP. Mobile NAT, VPNs, anycast and forged coordinates remain hard problems. Never market these estimates as exact personal locations. Holdout data is still community-supplied and is not an independent audit.

High-volume managed hosting is the planned revenue model; software and complete current data remain free. The launch goal is $1,000 MRR. Paid-plan interest capture exists, but checkout is not active until a payment provider is connected. This repository does not modify or release any of the owner's mobile apps. The [Flutter guide](docs/flutter.md) covers integration into the owner's apps; SDKs are available for JavaScript/TypeScript, Swift/iOS, Kotlin/Android, Dart/Flutter and Python.

## Deploy with Coolify

Create a public Git application using the Dockerfile, internal port 8000 and health path /health. Mount a persistent volume at /data. Use a temporary HTTPS domain initially. Set TRUST_PROXY_CIDRS to the actual immediate reverse-proxy address(es) only after inspecting the deployment topology. Do not trust arbitrary forwarding headers or set 0.0.0.0/0. Traefik must append its real external peer to X-Forwarded-For; the app accepts CF-Connecting-IP only when that external peer is Cloudflare. Direct-origin visitor headers cannot impersonate Cloudflare. The app disables Uvicorn proxy-header rewriting deliberately, so the source socket is available for validation. Revalidate proxy addresses after infrastructure changes. History contributions remain until withdrawn. Every distinct capture is retained, including repeated visits and quarantined connection types. The API defaults to the legacy `retention: "30_days"`; new host apps must disclose continuing retention and explicitly send `retention: "history"`. Cleanup still honors the original 30-day agreement for legacy records, with up to an hour of scheduling delay. Database migrations preserve existing records and their retention policy.

## Tests

Install pytest/httpx and run `python -m pytest tests`. JavaScript SDK tests are documented in sdks/javascript. Dart checks are documented in sdks/dart. CI checks the service and JavaScript/Dart clients, builds the Swift package, and assembles the Android library on every push. Native permission flows still require testing in the host apps on physical devices. Use an isolated DATA_DIR for tests; no synthetic measurements should enter the production atlas.

## Data provenance

Own opt-in observations: CC0 aggregate release. Natural Earth boundaries: public domain, https://www.naturalearthdata.com/about/terms-of-use/. Its geometry is used for country labels only. No MaxMind, DB-IP, IPinfo or other licensed IP database is included.
