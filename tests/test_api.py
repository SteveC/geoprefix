import importlib
import ipaddress
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    monkeypatch.setenv('TRUST_PROXY_CIDRS', '127.0.0.1/32')
    import server.app
    m = importlib.reload(server.app)
    return m, TestClient(m.app, client=('127.0.0.1', 4321), headers={'x-forwarded-for':'173.245.48.5','cf-connecting-ip':'8.8.8.1'})


def headers(ip='8.8.8.1', token=None):
    h={'cf-connecting-ip':ip}
    if token:
        h['Authorization']='Bearer '+token
    return h


def payload(**kwargs):
    result=dict(latitude=40.712812,longitude=-74.006012,accuracy_m=10,consent=True)
    result.update(kwargs)
    return result


def test_empty_launch_and_public_exports(api):
    m,c=api
    assert c.get('/health').json()['status']=='ok'
    assert c.get('/api/stats').json()['published_networks']==0
    assert c.get('/api/accuracy').json()['median_error_km'] is None
    assert c.get('/api/lookup?ip=8.8.8.8').json()['status']=='unknown'
    export=c.get('/api/dataset.json').json()
    assert export['networks']==[] and export['license']=='CC0-1.0'
    assert len(c.get('/api/dataset.csv').text.strip().splitlines())==1
    assert len(export['columns'])==45
    assert c.get('/api/reverse?latitude=40&longitude=-74').json()['matches']==[]


def test_auth_consent_coarsening_and_withdrawal(api):
    m,c=api
    assert c.post('/api/observations',json=payload(),headers=headers()).status_code==401
    registration=c.post('/api/apps',json={'name':'Test app','origins':['https://example.com']},headers=headers()).json()
    token=registration['app_token']
    assert c.post('/api/observations',json=payload(consent=False),headers=headers(token=token)).status_code==422
    h=headers(token=token)
    h['origin']='https://evil.example'
    assert c.post('/api/observations',json=payload(),headers=h).status_code==403
    result=c.post('/api/observations',json=payload(),headers=headers(token=token))
    assert result.status_code==202
    with m.db() as db:
        row=dict(db.execute('SELECT * FROM observations').fetchone())
        assert row['latitude']==40.7 and row['longitude']==-74.0
        assert row['accuracy_m']>=8000
        assert row['network']=='8.8.8.0/24'
        assert '8.8.8.1' not in str(row)
    body=result.json()
    assert c.delete('/api/observations/'+body['id']).status_code==404
    assert c.delete('/api/observations/'+body['id'],headers={'x-contribution-receipt':body['contribution_receipt']}).status_code==200
    assert c.get('/api/stats').json()['observations']==0


def test_validation_quarantine_and_capture_history(api):
    m,c=api
    for ip in ('garbage','127.0.0.1','10.1.1.1','192.168.1.1','::1'):
        assert c.get('/api/lookup',params={'ip':ip}).status_code==422
    assert c.post('/api/demo/observations',json=payload(latitude=99),headers=headers()).status_code==422
    r=c.post('/api/demo/observations',json=payload(network_type='vpn'),headers=headers()).json()
    assert r['status']=='quarantined'
    capture=datetime.now(timezone.utc).isoformat()
    a=c.post('/api/demo/observations',json=payload(captured_at=capture),headers=headers('8.8.8.2')).json()
    b=c.post('/api/demo/observations',json=payload(captured_at=capture),headers=headers('8.8.8.2')).json()
    assert a['status']=='accepted' and b['status']=='duplicate'
    assert c.get('/api/stats').json()['observations']==2
    assert c.get('/api/stats').json()['quarantined_observations']==1
    assert r['id'] and r['contribution_receipt']
    assert c.post('/api/demo/observations',json=payload(),headers={'cf-connecting-ip':'8.8.8.3','origin':'https://evil.example'}).status_code==403


def seed(m,holdout=0,prefix='8.8.8.0/24',spread=False):
    with m.db() as db:
        for i in range(5):
            date=(datetime.now(timezone.utc)-timedelta(days=i%2)).isoformat()
            db.execute('INSERT INTO observations(id,app_id,network,observer_hash,latitude,longitude,accuracy_m,captured_at,created_at,receipt_hash,holdout,network_type,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',(str(i),'test',prefix,m.digest(str(i)),39.7 if not spread or i<3 else 1,-104.9,8000,date,date,m.digest('receipt'+str(i)),holdout,'unknown','browser'))


def test_consensus_reverse_export_and_conflict(api):
    m,c=api
    seed(m)
    answer=c.get('/api/lookup?ip=8.8.8.99').json()
    assert answer['status']=='found' and answer['network']=='8.8.8.0/24'
    assert answer['country_code']=='US'
    assert answer['asn'] is None and answer['city'] is None
    assert answer['accuracy_radius_km']>=8
    assert answer['first_seen']==(datetime.now(timezone.utc)-timedelta(days=1)).date().isoformat()
    assert answer['last_seen']==datetime.now(timezone.utc).date().isoformat()
    assert c.get('/api/reverse?latitude=39.7&longitude=-104.9&radius_km=10').json()['total']==1
    published=c.get('/api/dataset.json').json()['networks']
    assert 'observer_hash' not in str(published) and 'test' not in str(published)
    assert c.get('/api/reverse?latitude=0&longitude=0&radius_km=10').json()['total']==0
    with m.db() as db:
        db.execute('UPDATE observations SET latitude=0 WHERE id="4"')
    dispersed=c.get('/api/lookup?ip=8.8.8.99').json()
    assert dispersed['status']=='found'
    assert dispersed['distribution_status']=='dispersed'
    assert dispersed['accuracy_radius_km']>1000
    assert dispersed['observed_p90_distance_km']>1000
    assert dispersed['location_count']==2
    assert dispersed['country_code'] is None


def test_holdouts_never_train(api):
    m,c=api
    seed(m,holdout=1)
    assert c.get('/api/stats').json()['observations']==5
    assert c.get('/api/stats').json()['published_networks']==0


def test_untrusted_header_and_monthly_quota(api):
    m,c=api
    m.TRUSTED=[]
    assert c.get('/api/me',headers=headers()).json()['ip']=='127.0.0.1'
    m.TRUSTED=[ipaddress.ip_network('127.0.0.1/32')]
    registration=c.post('/api/apps',json={'name':'quota'},headers=headers()).json()
    with m.db() as db:
        db.execute('UPDATE apps SET monthly_quota=1')
    h=headers(token=registration['app_token'])
    assert c.get('/api/lookup?ip=8.8.8.8',headers=h).status_code==200
    assert c.get('/api/lookup?ip=8.8.8.8',headers=h).status_code==429


def test_expiration_removes_old_private_samples(api):
    m,c=api
    seed(m)
    old=(datetime.now(timezone.utc)-timedelta(days=31)).isoformat()
    with m.db() as db:
        db.execute('UPDATE observations SET created_at=?',(old,))
    assert c.get('/api/stats').json()['observations']==0


def test_proxy_chain_cannot_be_forged_from_origin(api):
    m,c=api
    assert c.get('/api/me',headers={'x-forwarded-for':'1.1.1.1, 9.9.9.9','cf-connecting-ip':'8.8.8.8'}).json()['ip']=='9.9.9.9'
    assert c.get('/api/me',headers={'x-forwarded-for':'junk, 173.245.48.5','cf-connecting-ip':'2606:4700::1111'}).json()['ip']=='2606:4700::1111'
    assert c.get('/api/me',headers={'x-forwarded-for':'bad'}).status_code==400
    assert c.get('/api/me',headers={'x-forwarded-for':''}).status_code==400
    assert c.get('/api/me',headers={'cf-connecting-ip':'bad'}).status_code==400


def test_https_demo_origin_behind_proxy(api):
    m,c=api
    result=c.post('/api/demo/observations',json=payload(),headers={**headers(),'origin':'https://testserver'})
    assert result.status_code==202


def test_chunked_body_limit(api):
    m,c=api
    def chunks():
        yield b'{"name":"'
        yield b'x'*17000
        yield b'"}'
    assert c.post('/api/apps',content=chunks(),headers={'content-type':'application/json'}).status_code==413


def test_observation_day_uses_utc(api):
    m,c=api
    captured=datetime.now(timezone(timedelta(hours=14)))
    result=c.post('/api/demo/observations',json=payload(captured_at=captured.isoformat()),headers=headers())
    assert result.status_code==202
    with m.db() as db:
        stored=db.execute('SELECT captured_at FROM observations').fetchone()['captured_at']
    assert stored==captured.astimezone(timezone.utc).isoformat()


def test_repeated_address_keeps_each_capture_and_stable_holdout(api):
    m,c=api
    captured=datetime.now(timezone.utc)
    registration=c.post('/api/apps',json={'name':'History app'},headers=headers()).json()
    auth=headers(token=registration['app_token'])
    points=[]
    for i in range(3):
        r=c.post('/api/observations',json=payload(latitude=39.7+i,retention='history',captured_at=(captured-timedelta(seconds=i)).isoformat()),headers=auth)
        assert r.status_code==202
        points.append(r.json())
    assert len({r['id'] for r in points})==3
    assert len({r['holdout'] for r in points})==1
    with m.db() as db:
        rows=db.execute('SELECT * FROM observations').fetchall()
    assert len(rows)==3 and {r['retention'] for r in rows}=={'history'}
    assert len({r['latitude'] for r in rows})==3


def test_history_survives_legacy_expiration_and_can_be_withdrawn(api):
    m,c=api
    r=c.post('/api/demo/observations',json=payload(retention='history',provider='unknown',reported_accuracy_m=12),headers=headers()).json()
    c.post('/api/demo/observations',json=payload(),headers=headers('8.8.8.2'))
    old=(datetime.now(timezone.utc)-timedelta(days=365)).isoformat()
    with m.db() as db:
        db.execute('UPDATE observations SET created_at=?',(old,))
    stats=c.get('/api/stats').json()
    assert stats['observations']==1 and stats['history_observations']==1
    with m.db() as db:
        point=db.execute('SELECT * FROM observations').fetchone()
        assert point['reported_accuracy_m']==12 and point['provider']=='unknown'
    assert c.delete('/api/observations/'+r['id'],headers={'x-contribution-receipt':r['contribution_receipt']}).status_code==200
    assert c.get('/api/stats').json()['observations']==0


def test_repeat_visits_do_not_move_center_or_shrink_spread(api):
    m,c=api
    seed(m)
    with m.db() as db:
        db.execute('UPDATE observations SET latitude=10 WHERE id="4"')
    before=c.get('/api/lookup?ip=8.8.8.99').json()
    with m.db() as db:
        for i in range(50):
            db.execute('INSERT INTO observations(id,app_id,network,observer_hash,latitude,longitude,accuracy_m,captured_at,created_at,receipt_hash,holdout,network_type,source) SELECT ?,app_id,network,observer_hash,latitude,longitude,accuracy_m,?,created_at,receipt_hash,holdout,network_type,source FROM observations WHERE id="4"',(f'repeat{i}',(datetime.now(timezone.utc)-timedelta(seconds=i)).isoformat()))
    after=c.get('/api/lookup?ip=8.8.8.99').json()
    assert after['sample_count']==before['sample_count']+50
    assert after['latitude']==before['latitude'] and after['longitude']==before['longitude']
    assert after['observed_p90_distance_km']==before['observed_p90_distance_km']
    assert after['accuracy_radius_km']==before['accuracy_radius_km']


def test_antimeridian_network_has_local_spread(api):
    m,c=api
    seed(m)
    with m.db() as db:
        db.execute('UPDATE observations SET latitude=0,longitude=179.9')
        db.execute('UPDATE observations SET longitude=-179.9 WHERE id="4"')
    row=c.get('/api/lookup?ip=8.8.8.99').json()
    assert abs(row['longitude'])>179
    assert row['accuracy_radius_km']<50
    assert row['location_count']==2


def test_upgrade_preserves_old_observations(tmp_path,monkeypatch):
    import sqlite3
    conn=sqlite3.connect(tmp_path/'geoprefix.sqlite3')
    conn.execute('CREATE TABLE observations(id TEXT PRIMARY KEY,app_id TEXT,network TEXT,observer_hash TEXT,latitude REAL,longitude REAL,accuracy_m REAL,captured_at TEXT,created_at TEXT,receipt_hash TEXT,holdout INTEGER,network_type TEXT,source TEXT,UNIQUE(network,observer_hash,captured_at))')
    stamp=datetime.now(timezone.utc).isoformat()
    conn.execute('INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',('legacy','app','8.8.8.0/24','hash',40,-74,8000,stamp,stamp,'receipt',0,'unknown','browser'))
    conn.commit();conn.close()
    monkeypatch.setenv('DATA_DIR',str(tmp_path))
    import server.app
    m=importlib.reload(server.app)
    with m.db() as db:
        old=db.execute('SELECT * FROM observations WHERE id="legacy"').fetchone()
        assert old['latitude']==40 and old['retention']=='30_days' and old['quarantined']==0


def test_prediction_error_balances_repeat_captures_per_address_day(api):
    m,c=api
    seed(m,holdout=1)
    stamp=datetime.now(timezone.utc).isoformat()
    with m.db() as db:
        # Four captures from one address/day, plus one from a second address.
        for i in range(4):
            captured=datetime.now(timezone.utc).replace(hour=0,minute=0,second=0,microsecond=i).isoformat()
            db.execute('UPDATE observations SET observer_hash="repeat",captured_at=? WHERE id=?',(captured,str(i)))
        db.execute('UPDATE observations SET captured_at=? WHERE id="4"',(stamp,))
        for i in range(5):
            db.execute('INSERT INTO evaluations VALUES (?,?,?,?,?,?)',(f'e{i}',str(i),'8.8.8.0/24',10 if i<4 else 100,stamp,'fixed'))
    report=c.get('/api/accuracy').json()
    assert report['evaluated_observations']==5
    assert report['sample_count']==2 and report['median_error_km']==55
    assert report['by_network_type']==[{'network_type':'fixed','sample_count':2}]
