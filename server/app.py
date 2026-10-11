"""GeoPrefix: an empty-by-default, community-built public domain network atlas."""
import csv
import asyncio
import hashlib
import hmac
import io
import ipaddress
import json
import logging
import math
import os
import secrets
import sqlite3
import statistics
from contextlib import contextmanager, asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.getenv('DATA_DIR', str(ROOT / 'data')))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / 'geoprefix.sqlite3'
secret_file = DATA / '.hash-key'
if not secret_file.exists():
    fd = os.open(secret_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(secrets.token_hex(32))
HASH_KEY = secret_file.read_bytes()
MIN_SAMPLES = max(5, int(os.getenv('MIN_SAMPLES', '5')))
VERSION = '0.1.0'
CF_RANGES = ('173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20','197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13','104.24.0.0/14','172.64.0.0/13','131.0.72.0/22','2400:cb00::/32','2606:4700::/32','2803:f800::/32','2405:b500::/32','2405:8100::/32','2a06:98c0::/29','2c0f:f248::/32')
TRUSTED = [ipaddress.ip_network(n) for n in os.getenv('TRUST_PROXY_CIDRS', ','.join(CF_RANGES)).split(',') if n]
CF_NETWORKS = [ipaddress.ip_network(n) for n in CF_RANGES]
COLUMNS = ['network','ip_version','latitude','longitude','accuracy_radius_km','country_code','country_name','continent','region','region_code','city','postal_code','timezone','asn','as_name','as_domain','isp','organization','network_type','is_anycast','is_mobile','is_hosting','is_vpn','is_proxy','is_tor','sample_count','distinct_observers','first_seen','last_seen','updated_at','confidence','source','method','license','grid_degrees','median_error_km','p90_error_km','evaluation_count','registered_country','routing_prefix']

def now():
    return datetime.now(timezone.utc).isoformat()

def digest(value):
    return hmac.new(HASH_KEY, str(value).encode(), hashlib.sha256).hexdigest()

@contextmanager
def db():
    conn = sqlite3.connect(DB, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

with db() as c:
    c.executescript('''
    CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE,origins TEXT,created_at TEXT,monthly_quota INTEGER DEFAULT 100000);
    CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY,app_id TEXT,network TEXT,observer_hash TEXT,latitude REAL,longitude REAL,accuracy_m REAL,captured_at TEXT,created_at TEXT,receipt_hash TEXT,holdout INTEGER,network_type TEXT,source TEXT,UNIQUE(network,observer_hash,captured_at));
    CREATE INDEX IF NOT EXISTS observations_network ON observations(network);
    CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY,observation_id TEXT UNIQUE,network TEXT,error_km REAL,created_at TEXT,network_type TEXT);
    CREATE TABLE IF NOT EXISTS counters(bucket TEXT PRIMARY KEY,n INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS interests(id TEXT PRIMARY KEY,organization TEXT,contact TEXT,plan TEXT,created_at TEXT);
    ''')

@asynccontextmanager
async def lifespan(application):
    def purge():
        with db() as c:
            cleanup(c)
    async def purge_loop():
        while True:
            try:
                await asyncio.to_thread(purge)
            except sqlite3.Error:
                logging.warning('Retention purge will retry after a database error')
                await asyncio.sleep(60)
            else:
                await asyncio.sleep(3600)
    task = asyncio.create_task(purge_loop())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

app = FastAPI(title='GeoPrefix', version=VERSION, lifespan=lifespan, description='Public domain IP geography built from disclosed, coarse contributions. Empty until observations support a result.')

class RequestBodyLimit:
    def __init__(self, app):
        self.app=app

    async def __call__(self, scope, receive, send):
        if scope['type']!='http' or scope['method'] not in ('POST','PUT','PATCH'):
            return await self.app(scope,receive,send)
        body=bytearray()
        while True:
            message=await receive()
            if message['type']=='http.disconnect':
                return
            body.extend(message.get('body',b''))
            if len(body)>16384:
                return await JSONResponse({'detail':'Request body too large'},status_code=413)(scope,receive,send)
            if not message.get('more_body',False):
                break
        delivered=False
        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered=True
                return {'type':'http.request','body':bytes(body),'more_body':False}
            return await receive()
        await self.app(scope,bounded_receive,send)

app.add_middleware(RequestBodyLimit)

@app.middleware('http')
async def headers(request: Request, call_next):
    try:
        size = int(request.headers.get('content-length', '0') or 0)
    except ValueError:
        return JSONResponse({'detail':'Invalid Content-Length'}, status_code=400)
    if size > 16384:
        return JSONResponse({'detail':'Request body too large'}, status_code=413)
    if request.method == 'OPTIONS':
        res = Response(status_code=204)
    else:
        res = await call_next(request)
    res.headers['Access-Control-Allow-Origin'] = '*'
    res.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
    res.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-Contribution-Receipt'
    res.headers['X-Content-Type-Options'] = 'nosniff'
    res.headers['Referrer-Policy'] = 'no-referrer'
    res.headers['Permissions-Policy'] = 'geolocation=(self)'
    res.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    if request.url.path in ('/docs', '/redoc'):
        res.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; img-src 'self' data: https://fastapi.tiangolo.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
    if request.url.path.startswith('/api/'):
        res.headers['Cache-Control'] = 'no-store'
    return res

def client_ip(request):
    peer = ipaddress.ip_address(request.client.host)
    if not any(peer in n for n in TRUSTED if n.version == peer.version):
        return peer
    # Traefik appends its actual external peer as the final XFF element.
    # Never let a direct-origin visitor impersonate Cloudflare with a header.
    external = peer
    if not any(peer in n for n in CF_NETWORKS if n.version == peer.version):
        try:
            external = ipaddress.ip_address(request.headers.get('x-forwarded-for','').split(',')[-1].strip())
        except ValueError:
            raise HTTPException(400, 'Trusted proxy must append its external peer')
    if any(external in n for n in CF_NETWORKS if n.version == external.version):
        try:
            return ipaddress.ip_address(request.headers.get('cf-connecting-ip',''))
        except ValueError:
            raise HTTPException(400, 'Cloudflare must supply a valid visitor address')
    return external

def public_ip(value):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        raise HTTPException(422, 'Enter a valid IPv4 or IPv6 address')
    if not ip.is_global:
        raise HTTPException(422, 'Only public IP addresses can be mapped')
    return ip

def limit(c, bucket, maximum):
    row = c.execute('INSERT INTO counters VALUES (?,1) ON CONFLICT(bucket) DO UPDATE SET n=n+1 WHERE counters.n < ? RETURNING n', (bucket,maximum)).fetchone()
    if not row:
        raise HTTPException(429, 'Quota reached. Self-hosting and public downloads are unlimited.')

def rate(request, action, maximum=60):
    bucket = action + ':' + digest(client_ip(request)) + ':' + now()[:16]
    with db() as c:
        limit(c, bucket, maximum)

def authorize(request, authorization):
    token = (authorization or '').removeprefix('Bearer ')
    with db() as c:
        row = c.execute('SELECT * FROM apps WHERE token_hash=?', (digest(token),)).fetchone()
        if not row:
            raise HTTPException(401, 'A valid app token is required. Create one at /api/apps.')
        origins = json.loads(row['origins'])
        origin = request.headers.get('origin')
        if origin and origins and origin not in origins:
            raise HTTPException(403, 'Origin is not registered for this app')
        limit(c, 'month:' + row['id'] + ':' + now()[:7], row['monthly_quota'])
        return dict(row)

def distance(a, b, x, y):
    lat1, lat2 = math.radians(a), math.radians(x)
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(y-b)/2)**2
    return 6371.0088 * 2 * math.asin(min(1, math.sqrt(h)))

def ring_contains(ring, lon, lat):
    inside = False
    j = len(ring)-1
    for i in range(len(ring)):
        x,y = ring[i][:2]
        px,py = ring[j][:2]
        if (y > lat) != (py > lat) and lon < (px-x)*(lat-y)/(py-y)+x:
            inside = not inside
        j = i
    return inside

country_path = ROOT / 'assets' / 'countries.geojson'
COUNTRIES = json.loads(country_path.read_text())['features'] if country_path.exists() else []

def country_at(lat, lon):
    for feature in COUNTRIES:
        g = feature['geometry']
        polygons = [g['coordinates']] if g['type']=='Polygon' else g['coordinates']
        for poly in polygons:
            if ring_contains(poly[0], lon, lat) and not any(ring_contains(h,lon,lat) for h in poly[1:]):
                p=feature['properties']
                code=p.get('ISO_A2_EH') or p.get('ISO_A2')
                return {'country_code': None if code=='-99' else code,'country_name':p.get('ADMIN') or p.get('NAME'),'continent':p.get('CONTINENT')}
    return {}

def cleanup(c):
    cutoff=(datetime.now(timezone.utc)-timedelta(days=30)).isoformat()
    c.execute('DELETE FROM evaluations WHERE observation_id IN (SELECT id FROM observations WHERE created_at < ?)', (cutoff,))
    c.execute('DELETE FROM observations WHERE created_at < ?', (cutoff,))
    # Keep monthly counters and only the recent minute buckets.
    c.execute("DELETE FROM counters WHERE bucket NOT LIKE 'month:%' AND substr(bucket,-16) < ?", ((datetime.now(timezone.utc)-timedelta(hours=2)).isoformat()[:16],))

def networks(c):
    cleanup(c)
    rows=c.execute('SELECT * FROM observations WHERE holdout=0 ORDER BY created_at').fetchall()
    groups={}
    for r in rows:
        groups.setdefault(r['network'], []).append(r)
    output=[]
    for prefix, samples in groups.items():
        observers={r['observer_hash'] for r in samples}
        days={r['captured_at'][:10] for r in samples}
        if len(observers)<MIN_SAMPLES or len(days)<2:
            continue
        lat=round(statistics.median(r['latitude'] for r in samples),1)
        # Circular mean avoids longitude wraparound and scales linearly with evidence.
        x=sum(math.cos(math.radians(r['longitude'])) for r in samples)
        y=sum(math.sin(math.radians(r['longitude'])) for r in samples)
        lon=round(math.degrees(math.atan2(y,x)),1)
        radii=[distance(lat,lon,r['latitude'],r['longitude'])+r['accuracy_m']/1000 for r in samples]
        spread=max(radii)
        if spread>100:
            continue # conflicting/shared/mobile exits need a distribution model before publication
        result={k:None for k in COLUMNS}
        result.update(network=prefix,ip_version=ipaddress.ip_network(prefix).version,latitude=lat,longitude=lon,accuracy_radius_km=round(max(8,spread),2),sample_count=len(samples),distinct_observers=len(observers),first_seen=min(days),last_seen=max(days),updated_at=samples[-1]['created_at'][:10],confidence='medium' if len(observers)>=20 else 'low',source='community',method='coarse-prefix-consensus',license='CC0-1.0',grid_degrees=0.1)
        result.update(country_at(lat,lon))
        errors=[x['error_km'] for x in c.execute('SELECT error_km FROM evaluations WHERE network=?',(prefix,))]
        result['evaluation_count']=len(errors)
        if errors:
            result['median_error_km']=round(statistics.median(errors),2)
            result['p90_error_km']=round(sorted(errors)[math.ceil(len(errors)*.9)-1],2)
        output.append(result)
    return sorted(output,key=lambda x:x['network'])

def lookup(c, ip):
    matches=[n for n in networks(c) if ip.version==n['ip_version'] and ip in ipaddress.ip_network(n['network'])]
    if matches:
        return dict(max(matches,key=lambda n:ipaddress.ip_network(n['network']).prefixlen),status='found',ip=str(ip))
    return {'status':'unknown','ip':str(ip),'network':None,'latitude':None,'longitude':None,'message':'No supported community estimate yet. Contribute observations to help build this area.'}

class AppRegistration(BaseModel):
    name: str = Field(min_length=2,max_length=80)
    origins: list[str] = Field(default_factory=list,max_length=20)

@app.post('/api/apps', status_code=201)
def register(body:AppRegistration, request:Request):
    rate(request,'register',3)
    from urllib.parse import urlsplit
    for origin in body.origins:
        parsed=urlsplit(origin)
        if parsed.scheme not in ('http','https') or not parsed.netloc or parsed.path not in ('','/') or parsed.query or parsed.fragment:
            raise HTTPException(422,'Origins must be complete http(s) origins without a path')
    token='gp_'+secrets.token_urlsafe(30)
    ident=secrets.token_hex(12)
    with db() as c:
        c.execute('INSERT INTO apps(id,name,token_hash,origins,created_at) VALUES (?,?,?,?,?)',(ident,body.name,digest(token),json.dumps([x.rstrip('/') for x in body.origins]),now()))
    return {'app_id':ident,'app_token':token,'monthly_quota':100000,'note':'Store this token now. It is scoped to contribution and free API usage; never embed an administrative credential.'}

class Observation(BaseModel):
    latitude: float = Field(ge=-90,le=90,allow_inf_nan=False)
    longitude: float = Field(ge=-180,le=180,allow_inf_nan=False)
    accuracy_m: float = Field(ge=0,le=100000,allow_inf_nan=False)
    captured_at: Optional[datetime] = None
    consent: bool
    source: str = Field(default='browser',pattern='^(browser|gps|native)$')
    provider: Optional[str] = Field(default=None,max_length=40)
    reported_accuracy_m: Optional[float] = Field(default=None,ge=0,le=100000,allow_inf_nan=False)
    network_type: str = Field(default='unknown',pattern='^(unknown|fixed|mobile|hosting|vpn|relay|satellite)$')

def ingest(body, request, app_id):
    if not body.consent:
        raise HTTPException(422,'Informed contribution consent is required before uploading location')
    ip=public_ip(str(client_ip(request)))
    captured=body.captured_at or datetime.now(timezone.utc)
    if captured.tzinfo is None:
        raise HTTPException(422,'captured_at must include a timezone')
    captured=captured.astimezone(timezone.utc)
    delta=datetime.now(timezone.utc)-captured
    if delta.total_seconds() < -300 or delta.total_seconds()>86400:
        raise HTTPException(422,'Use a fresh observation from the past 24 hours')
    if body.network_type in ('vpn','relay','hosting','satellite'):
        return {'status':'quarantined','reason':'This connection type cannot safely associate user location with its exit address','id':None}
    prefix=str(ipaddress.ip_network(str(ip)+('/24' if ip.version==4 else '/48'),strict=False))
    observer=digest(str(ip))
    ident=secrets.token_hex(16)
    receipt=secrets.token_urlsafe(32)
    lat=round(body.latitude,1)
    lon=round(body.longitude,1)
    radius=max(8000,body.accuracy_m)
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        previous=c.execute('SELECT id FROM observations WHERE network=? AND observer_hash=? AND substr(captured_at,1,10)=?',(prefix,observer,captured.isoformat()[:10])).fetchone()
        if previous:
            return {'status':'duplicate','id':previous['id'],'message':'One observation per public address per day is sufficient'}
        # Holdouts are never used to construct public network estimates.
        holdout=int(int(digest(ident)[:8],16)%5==0)
        estimate=lookup(c,ip) if holdout else None
        c.execute('INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',(ident,app_id,prefix,observer,lat,lon,radius,captured.isoformat(),now(),digest(receipt),holdout,body.network_type,body.source))
        if estimate and estimate['status']=='found':
            error=distance(lat,lon,estimate['latitude'],estimate['longitude'])
            c.execute('INSERT INTO evaluations VALUES (?,?,?,?,?,?)',(secrets.token_hex(12),ident,prefix,error,now(),body.network_type))
    return {'id':ident,'status':'accepted','contribution_receipt':receipt,'holdout':bool(holdout),'stored_precision_degrees':0.1,'license':'CC0-1.0','message':'Coarse observation received. Publication requires at least five distinct address observations across two days.'}

@app.post('/api/observations',status_code=202)
def contribute(body:Observation,request:Request,authorization:Optional[str]=Header(default=None)):
    rate(request,'contribute',20)
    account=authorize(request,authorization)
    return ingest(body,request,account['id'])

@app.post('/api/demo/observations',status_code=202)
def demo(body:Observation,request:Request):
    rate(request,'demo',3)
    origin=request.headers.get('origin')
    parsed_origin=urlsplit(origin or '')
    if origin and (parsed_origin.scheme not in ('http','https') or parsed_origin.netloc != request.headers.get('host') or parsed_origin.path not in ('','/')):
        raise HTTPException(403,'Use an app token for cross-origin contributions')
    return ingest(body,request,'website-demo')

@app.delete('/api/observations/{ident}')
def withdraw(ident:str,x_contribution_receipt:str=Header(default='')):
    with db() as c:
        row=c.execute('SELECT receipt_hash FROM observations WHERE id=?',(ident,)).fetchone()
        if not row or not secrets.compare_digest(row['receipt_hash'],digest(x_contribution_receipt)):
            raise HTTPException(404,'Contribution or receipt not found')
        c.execute('DELETE FROM evaluations WHERE observation_id=?',(ident,))
        c.execute('DELETE FROM observations WHERE id=?',(ident,))
    return {'status':'deleted','note':'Future releases recompute the aggregate. Already downloaded CC0 releases cannot be recalled.'}

@app.get('/api/me')
def me(request:Request):
    return {'ip':str(client_ip(request))}

@app.get('/api/lookup')
def find(request:Request,ip:Optional[str]=None,authorization:Optional[str]=Header(default=None)):
    rate(request,'lookup',60)
    if authorization:
        authorize(request,authorization)
    target=public_ip(ip or str(client_ip(request)))
    with db() as c:
        return lookup(c,target)

@app.get('/api/reverse')
def reverse(request:Request,latitude:float=Query(ge=-90,le=90),longitude:float=Query(ge=-180,le=180),radius_km:float=Query(default=50,gt=0,le=1000),limit_count:int=Query(default=100,ge=1,le=500),authorization:Optional[str]=Header(default=None)):
    rate(request,'reverse',30)
    if authorization:
        authorize(request,authorization)
    if not math.isfinite(latitude) or not math.isfinite(longitude) or not math.isfinite(radius_km):
        raise HTTPException(422,'Coordinates must be finite numbers')
    with db() as c:
        results=[]
        for n in networks(c):
            d=distance(latitude,longitude,n['latitude'],n['longitude'])
            if d<=radius_km+n['accuracy_radius_km']:
                results.append(dict(n,distance_km=round(d,2)))
    results.sort(key=lambda n:n['distance_km'])
    return {'matches':results[:limit_count],'total':len(results),'latitude':latitude,'longitude':longitude,'radius_km':radius_km,'meaning':'Known network estimates whose uncertainty areas overlap this search. This is not a complete inventory of devices or IPs at a coordinate.'}

@app.get('/api/networks')
def list_networks(request:Request,limit:int=Query(default=100,ge=1,le=1000)):
    rate(request,'networks',30)
    with db() as c:
        items=networks(c)
    return {'networks':items[:limit],'total':len(items)}

@app.get('/api/dataset.json')
def download_json(request:Request):
    rate(request,'download',30)
    with db() as c:
        items=networks(c)
    return JSONResponse({'license':'CC0-1.0','generated_at':now(),'columns':COLUMNS,'networks':items},headers={'Content-Disposition':'attachment; filename="geoprefix-latest.json"'})

@app.get('/api/dataset.csv')
def download_csv(request:Request):
    rate(request,'download',30)
    stream=io.StringIO()
    writer=csv.DictWriter(stream,fieldnames=COLUMNS)
    writer.writeheader()
    with db() as c:
        writer.writerows(networks(c))
    return Response(stream.getvalue(),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="geoprefix-latest.csv"'})

@app.get('/api/accuracy')
def accuracy(request:Request=None):
    if request is not None:
        rate(request,'accuracy',60)
    with db() as c:
        cleanup(c)
        rows=c.execute('SELECT error_km,network_type FROM evaluations').fetchall()
    errors=sorted(r['error_km'] for r in rows)
    return {'sample_count':len(errors),'median_error_km':round(statistics.median(errors),2) if errors else None,'p90_error_km':round(errors[math.ceil(len(errors)*.9)-1],2) if errors else None,'within_25km_percent':round(100*sum(e<=25 for e in errors)/len(errors),1) if errors else None,'by_network_type':[{'network_type':kind,'sample_count':sum(r['network_type']==kind for r in rows)} for kind in sorted({r['network_type'] for r in rows})],'methodology':'Random 20% holdout observations are never included in map construction. Errors compare coarse contributed coordinates with the existing prefix estimate. Browser location sources are unverified; figures include rounding uncertainty and sampling bias. These are community evaluations, not an independent audit. Samples expire after 30 days.'}

@app.get('/api/stats')
def stats(request:Request):
    rate(request,'stats',60)
    with db() as c:
        items=networks(c)
        total=c.execute('SELECT count(*) FROM observations').fetchone()[0]
    a=accuracy()
    return {'observations':total,'published_networks':len(items),'independent_evaluations':a['sample_count'],'median_error_km':a['median_error_km'],'p90_error_km':a['p90_error_km'],'countries':len({n['country_code'] for n in items if n['country_code']}),'ipv4_networks':sum(n['ip_version']==4 for n in items),'ipv6_networks':sum(n['ip_version']==6 for n in items),'updated_at':max((n['updated_at'] for n in items),default=None),'mrr_usd':0,'target_mrr_usd':1000,'billing_status':'not_connected','version':VERSION,'minimum_observers':MIN_SAMPLES,'dataset_license':'CC0-1.0'}

class Interest(BaseModel):
    organization:str=Field(min_length=1,max_length=100)
    contact:str=Field(min_length=3,max_length=200)
    plan:str=Field(default='managed',pattern='^(managed|dedicated|support)$')

@app.post('/api/plans/interest',status_code=201)
def interest(body:Interest,request:Request):
    rate(request,'interest',3)
    with db() as c:
        c.execute('INSERT INTO interests VALUES (?,?,?,?,?)',(secrets.token_hex(12),body.organization,body.contact,body.plan,now()))
    return {'status':'recorded','message':'Interest recorded. Paid plans are not active yet; no payment has been taken.'}

@app.get('/health')
def health():
    with db() as c:
        c.execute('SELECT 1')
    return {'status':'ok','version':VERSION}

@app.get('/sdk/geoprefix.js')
def javascript_sdk():
    return FileResponse(ROOT/'sdks/javascript/geoprefix.js',media_type='text/javascript')

@app.get('/privacy')
def privacy():
    return FileResponse(ROOT/'docs/privacy.txt',media_type='text/plain')

@app.get('/data-license')
def data_license():
    return FileResponse(ROOT/'DATA-LICENSE',media_type='text/plain')

if (ROOT/'web').exists():
    app.mount('/',StaticFiles(directory=ROOT/'web',html=True),name='website')
