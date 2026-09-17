#!/usr/bin/env python3
import json, math, os, sys, urllib.request
from collections import defaultdict
from pathlib import Path

import numpy as np
from shapely.geometry import Polygon
from shapely.ops import triangulate

ROOT = Path(__file__).resolve().parent
POLICY_PATH = ROOT / 'policy.json'
OUT_PATH = ROOT / 'generated' / 'mesh.json'
DATA_URL = 'https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json'
MAINLAND_BOX = (120.0, 122.12, 21.72, 25.58)
OFFSHORE_TOWNS = {'綠島鄉', '兰嶼鄉', '蘭嶼鄉', '琉球鄉'}
NANTOU = '南投縣'
NANTOU_ADJ = {'台中市', '彰化縣', '雲林縣', '嘉義縣', '高雄市', '花蓮縣'}


def clean_tai(s):
    return str(s or '').replace('臺', '台').strip()


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'taiwan-planet-mesh-solver/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def decode_topology(topology):
    transform = topology.get('transform')
    scale = transform['scale'] if transform else [1.0, 1.0]
    translate = transform['translate'] if transform else [0.0, 0.0]
    decoded = []
    for arc in topology['arcs']:
        qx = qy = 0
        pts = []
        for pair in arc:
            if transform:
                qx += pair[0]; qy += pair[1]
                x = qx * scale[0] + translate[0]
                y = qy * scale[1] + translate[1]
                pts.append((qx, qy, float(x), float(y)))
            else:
                x, y = pair
                pts.append((None, None, float(x), float(y)))
        decoded.append(pts)
    return decoded


def arc_points(decoded, ref):
    if ref >= 0:
        return decoded[ref]
    return list(reversed(decoded[-ref - 1]))


def ring_points(decoded, refs):
    out = []
    for j, ref in enumerate(refs):
        pts = arc_points(decoded, ref)
        if j:
            pts = pts[1:]
        out.extend(pts)
    if len(out) > 1 and out[0][2:] == out[-1][2:]:
        out = out[:-1]
    return out


def geom_polygons(geom):
    if geom['type'] == 'Polygon':
        return [geom['arcs']]
    if geom['type'] == 'MultiPolygon':
        return geom['arcs']
    return []


def ring_centroid_lonlat(r):
    if not r: return (999, 999)
    return (sum(p[2] for p in r)/len(r), sum(p[3] for p in r)/len(r))


def is_mainland_ring(r):
    lon, lat = ring_centroid_lonlat(r)
    minlon, maxlon, minlat, maxlat = MAINLAND_BOX
    return minlon <= lon <= maxlon and minlat <= lat <= maxlat


def source_polar(center_lon, center_lat, lon, lat):
    lon1 = math.radians(center_lon); lat1 = math.radians(center_lat)
    lon2 = math.radians(lon); lat2 = math.radians(lat)
    dl = lon2-lon1
    c = max(-1.0, min(1.0, math.sin(lat1)*math.sin(lat2)+math.cos(lat1)*math.cos(lat2)*math.cos(dl)))
    angle = math.acos(c)
    bearing = math.atan2(math.sin(dl)*math.cos(lat2), math.cos(lat1)*math.sin(lat2)-math.sin(lat1)*math.cos(lat2)*math.cos(dl))
    rho = 2*math.tan(angle/2)
    return np.array([rho*math.sin(bearing), rho*math.cos(bearing)], dtype=float)


def plane_to_unit(p):
    x, y = float(p[0]), float(p[1])
    rho = math.hypot(x, y)
    if rho < 1e-15:
        return np.array([0.,0.,1.])
    col = 2*math.atan(rho/2)
    s = math.sin(col)
    return np.array([s*x/rho, s*y/rho, math.cos(col)], dtype=float)


def lonlat_to_unit(lon, lat):
    lon=math.radians(lon); lat=math.radians(lat); c=math.cos(lat)
    return np.array([c*math.cos(lon), c*math.sin(lon), math.sin(lat)], dtype=float)


def tri_sphere_area(a,b,c):
    num = abs(np.dot(a, np.cross(b,c)))
    den = 1 + np.dot(a,b)+np.dot(b,c)+np.dot(c,a)
    return 2*math.atan2(num, max(1e-15, den))


def tri_signed2(p, a,b,c):
    pa,pb,pc=p[a],p[b],p[c]
    return (pb[0]-pa[0])*(pc[1]-pa[1])-(pb[1]-pa[1])*(pc[0]-pa[0])


def normalize_weights(items, weights, amount, caps, target):
    remaining = amount
    active = list(items)
    for _ in range(16):
        if remaining <= 1e-15 or not active: break
        tw = sum(max(0.0, weights[i]) for i in active)
        if tw <= 0: break
        distributed = 0.0; nxt=[]
        for i in active:
            cap = caps[i] - target[i]
            if cap <= 1e-15: continue
            proposed = remaining * max(0.0, weights[i]) / tw
            gain = min(cap, proposed)
            target[i] += gain; distributed += gain
            if cap-gain > 1e-15: nxt.append(i)
        if distributed <= 1e-15: break
        remaining -= distributed; active = nxt
    return remaining


def main():
    policy = json.loads(POLICY_PATH.read_text())
    print('fetching', DATA_URL, flush=True)
    topo = fetch_json(DATA_URL)
    decoded = decode_topology(topo)
    obj = topo['objects'].get('towns') or next(iter(topo['objects'].values()))

    raw_towns=[]; all_lonlat=[]
    for geom in obj['geometries']:
        props=geom.get('properties',{})
        county=clean_tai(props.get('COUNTYNAME') or props.get('countyname'))
        town=clean_tai(props.get('TOWNNAME') or props.get('townname'))
        if town in OFFSHORE_TOWNS: continue
        kept=[]
        for poly_refs in geom_polygons(geom):
            rings=[ring_points(decoded, refs) for refs in poly_refs]
            if rings and is_mainland_ring(rings[0]):
                kept.append(rings)
                all_lonlat.extend((p[2],p[3]) for ring in rings for p in ring)
        if kept:
            raw_towns.append({'county':county,'town':town,'polygons':kept})
    if not raw_towns: raise RuntimeError('no mainland towns')

    lons=[x for x,_ in all_lonlat]; lats=[y for _,y in all_lonlat]
    center_lon=(min(lons)+max(lons))/2; center_lat=(min(lats)+max(lats))/2
    target_rho=2*math.tan(math.radians(policy['target_max_colat_deg'])/2)
    raw_rhos=[np.linalg.norm(source_polar(center_lon,center_lat,lon,lat)) for lon,lat in all_lonlat]
    conformal_scale=target_rho/max(raw_rhos)

    key_to_vid={}; lonlat=[]; p0=[]
    def get_vid(point):
        key=(round(point[2],10), round(point[3],10))
        if key not in key_to_vid:
            key_to_vid[key]=len(lonlat)
            lonlat.append((point[2],point[3]))
            p0.append(source_polar(center_lon,center_lat,point[2],point[3])*conformal_scale)
        return key_to_vid[key]

    towns=[]; edge_owners=defaultdict(set); adjacency=defaultdict(set)
    for ti,rt in enumerate(raw_towns):
        polys=[]; vids_all=set()
        for rings in rt['polygons']:
            vrings=[]
            for ring in rings:
                vids=[get_vid(p) for p in ring]
                if len(vids)>=3:
                    vrings.append(vids); vids_all.update(vids)
                    for a,b in zip(vids, vids[1:]+vids[:1]):
                        e=(a,b) if a<b else (b,a)
                        edge_owners[e].add(ti); adjacency[a].add(b); adjacency[b].add(a)
            if vrings: polys.append(vrings)
        towns.append({'county':rt['county'],'town':rt['town'],'polygons':polys,'vids':sorted(vids_all)})

    p0=np.asarray(p0,float); p=p0.copy(); lonlat=np.asarray(lonlat,float)
    nvert=len(p)

    # Triangulate once in the initial 115° stereographic plane. Connectivity remains fixed.
    triangles=[]; town_tris=[[] for _ in towns]
    for ti,t in enumerate(towns):
        for rings in t['polygons']:
            outer=[tuple(p0[v]) for v in rings[0]]
            holes=[[tuple(p0[v]) for v in r] for r in rings[1:]]
            poly=Polygon(outer, holes)
            if not poly.is_valid:
                poly=poly.buffer(0)
            coord_map={ (round(p0[v,0],10),round(p0[v,1],10)):v for r in rings for v in r }
            for tr in triangulate(poly):
                if tr.area <= 1e-18: continue
                inter=tr.intersection(poly)
                if inter.area/tr.area < 0.999999: continue
                coords=list(tr.exterior.coords)[:3]
                ids=[]
                ok=True
                for x,y in coords:
                    k=(round(x,10),round(y,10)); v=coord_map.get(k)
                    if v is None:
                        candidates=[vv for r in rings for vv in r]
                        v=min(candidates,key=lambda vv:(p0[vv,0]-x)**2+(p0[vv,1]-y)**2)
                        if (p0[v,0]-x)**2+(p0[v,1]-y)**2 > 1e-14: ok=False; break
                    ids.append(v)
                if not ok or len(set(ids))<3: continue
                a,b,c=ids
                if tri_signed2(p0,a,b,c)<0: b,c=c,b
                idx=len(triangles); triangles.append((a,b,c,ti)); town_tris[ti].append(idx)
    if not triangles: raise RuntimeError('triangulation failed')
    print('towns',len(towns),'vertices',nvert,'triangles',len(triangles), flush=True)

    geo_units=[lonlat_to_unit(*ll) for ll in lonlat]
    source_area=np.zeros(len(towns))
    for a,b,c,ti in triangles:
        source_area[ti]+=tri_sphere_area(geo_units[a],geo_units[b],geo_units[c])

    total_len=np.zeros(len(towns)); coast_len=np.zeros(len(towns)); coast_vertices=set()
    for (a,b),owners in edge_owners.items():
        L=np.linalg.norm(p0[a]-p0[b])
        for ti in owners: total_len[ti]+=L
        if len(owners)==1:
            ti=next(iter(owners)); coast_len[ti]+=L; coast_vertices.update((a,b))
    coast_exp=np.divide(coast_len,total_len,out=np.zeros_like(coast_len),where=total_len>0)

    cent=np.array([p0[t['vids']].mean(axis=0) if t['vids'] else np.zeros(2) for t in towns])
    radial=np.linalg.norm(cent,axis=1); radial/=max(radial.max(),1e-12)

    factors=np.ones(len(towns))
    for i,t in enumerate(towns):
        if t['county']==NANTOU: factors[i]=policy['nantou_factor']
        elif t['county'] in NANTOU_ADJ: factors[i]=policy['nantou_adjacent_factor']
    target=source_area*factors
    pool=float(source_area.sum()-target.sum())

    core=set(policy['taipei_core_no_gain']); taipei_n=set(policy['taipei_north']); newtaipei_n=set(policy['new_taipei_north'])
    south=set(policy['south_prime']); bonus=policy['north_bonus']; capf=float(policy['receiver_cap_factor'])
    tier={'north':[],'south':[],'second':[],'general':[]}; weight=np.zeros(len(towns)); caps=source_area*capf
    for i,t in enumerate(towns):
        if t['county']=='台北市' and t['town'] in core: continue
        if factors[i] < 1: continue
        is_north=(t['county']=='基隆市' or (t['county']=='台北市' and t['town'] in taipei_n) or (t['county']=='新北市' and t['town'] in newtaipei_n))
        is_south=(t['county']=='屏東縣' and t['town'] in south)
        coastal=coast_exp[i]>0.001
        if is_north: k='north'
        elif is_south: k='south'
        elif coastal and radial[i]>=0.64: k='second'
        elif coastal: k='general'
        else: continue
        tier[k].append(i)
        manual=float(bonus.get(t['county'], bonus.get(t['town'],1.0))) if k=='north' else 1.0
        if k=='north':
            weight[i]=manual*math.sqrt(max(source_area[i],1e-15))*(0.45+coast_exp[i])*(0.5+radial[i]**3)
        else:
            weight[i]=math.sqrt(max(source_area[i],1e-15))*(0.15+coast_exp[i])*(0.5+radial[i]**3)
    leftover=0.0
    for k,share in policy['receiver_shares'].items():
        leftover += normalize_weights(tier[k],weight,pool*float(share),caps,target)
    allrecv=[i for g in tier.values() for i in g]
    if leftover>1e-15:
        leftover=normalize_weights(allrecv,weight,leftover,caps,target)
    if leftover>source_area.sum()*1e-8:
        print('warning: unallocated target pool',leftover, flush=True)
    target_share=target/target.sum()

    north=int(np.argmax(lonlat[:,1])); southv=int(np.argmin(lonlat[:,1])); east=int(np.argmax(lonlat[:,0])); west=int(np.argmin(lonlat[:,0]))
    anchors={north,southv,east,west}
    maxrho=target_rho

    neigh=[np.array(sorted(adjacency.get(v,())),dtype=int) for v in range(nvert)]
    coast_mask=np.zeros(nvert,dtype=bool); coast_mask[list(coast_vertices)]=True
    init_tri_area=np.array([abs(tri_signed2(p0,*tr[:3])) for tr in triangles])

    cfg=policy['solver']; alpha=float(cfg['area_alpha']); max_step=float(cfg['max_local_scale_step']); smooth=float(cfg['smooth_strength']); coast_mult=float(cfg['coast_smooth_multiplier']); anchor_strength=float(cfg['anchor_strength']); min_ratio=float(cfg['min_triangle_area_ratio']); iterations=int(cfg['iterations']); report_every=int(cfg['report_every'])

    def current_areas(pos):
        units=[plane_to_unit(q) for q in pos]
        ar=np.zeros(len(towns))
        for a,b,c,ti in triangles: ar[ti]+=tri_sphere_area(units[a],units[b],units[c])
        return ar

    def area_error(pos):
        ar=current_areas(pos); sh=ar/ar.sum(); e=np.log(np.maximum(sh,1e-15)/np.maximum(target_share,1e-15))
        return ar,e,float(np.mean(np.abs(e))),float(np.max(np.abs(e)))

    ar,err,meanerr,maxerr=area_error(p)
    print(f'initial mean|log ratio|={meanerr:.4f} max={maxerr:.4f}',flush=True)
    owner_count=np.zeros(nvert)
    town_vid_arrays=[]
    for t in towns:
        arr=np.asarray(t['vids'],dtype=int); town_vid_arrays.append(arr); owner_count[arr]+=1
    owner_count=np.maximum(owner_count,1)

    for it in range(iterations):
        ar,err,meanerr,maxerr=area_error(p)
        delta=np.zeros_like(p)
        order=np.argsort(-np.abs(err))
        for ti in order:
            vids=town_vid_arrays[ti]
            if len(vids)<3: continue
            c=p[vids].mean(axis=0)
            log_scale=max(-max_step,min(max_step,-alpha*err[ti]/2.0))
            scale=math.exp(log_scale)
            proposal=c+(p[vids]-c)*scale
            delta[vids]+=proposal-p[vids]
        delta/=owner_count[:,None]

        disp=p-p0; lap=np.zeros_like(p)
        for v,ns in enumerate(neigh):
            if len(ns): lap[v]=disp[ns].mean(axis=0)-disp[v]
        delta += smooth*lap*(np.where(coast_mask,coast_mult,1.0)[:,None])
        delta += anchor_strength*(p0-p)
        for v in anchors: delta[v]=0

        step=1.0; accepted=False; base=meanerr
        for _ in range(12):
            cand=p+step*delta
            rr=np.linalg.norm(cand,axis=1); over=rr>maxrho
            cand[over]*=(maxrho/rr[over])[:,None]
            for v in anchors: cand[v]=p0[v]
            ok=True
            for j,(a,b,c,ti) in enumerate(triangles):
                sa=tri_signed2(cand,a,b,c)
                if sa <= 0 or abs(sa) < init_tri_area[j]*min_ratio:
                    ok=False; break
            if ok:
                _,_,canderr,_=area_error(cand)
                if canderr <= base*1.002:
                    p=cand; accepted=True; break
            step*=0.5
        if not accepted:
            print('stalled at',it,'mean',meanerr,flush=True); break
        if it%report_every==0 or it==iterations-1:
            _,e,mxmean,mx=area_error(p)
            print(f'iter {it:03d} step={step:.3f} mean={mxmean:.4f} max={mx:.4f}',flush=True)

    actual,err,meanerr,maxerr=area_error(p); actual_share=actual/actual.sum(); actual_factor=actual_share/(source_area/source_area.sum()); target_factor=target_share/(source_area/source_area.sum())

    invalid=0
    for t in towns:
        for rings in t['polygons']:
            try:
                poly=Polygon([tuple(p[v]) for v in rings[0]], [[tuple(p[v]) for v in r] for r in rings[1:]])
                if not poly.is_valid: invalid+=1
            except Exception: invalid+=1

    out_towns=[]
    for i,t in enumerate(towns):
        vids=t['vids']; cc=p[vids].mean(axis=0) if vids else np.zeros(2)
        out_towns.append({
            'county':t['county'],'town':t['town'],'targetFactor':round(float(target_factor[i]),6),'actualFactor':round(float(actual_factor[i]),6),
            'centroid':[round(float(cc[0]),7),round(float(cc[1]),7)]
        })
    out_tris=[[a,b,c,ti] for a,b,c,ti in triangles]
    edges=sorted([list(e) for e in edge_owners.keys()])
    audit=sorted([{'region':f"{t['county']}|{t['town']}",'target':round(float(target_factor[i]),4),'actual':round(float(actual_factor[i]),4),'ratio':round(float(actual_factor[i]/target_factor[i]),4)} for i,t in enumerate(towns)], key=lambda r:r['ratio'], reverse=True)
    payload={
        'version':1,'method':'shared-boundary-area-constraint','targetMaxColatDeg':policy['target_max_colat_deg'],
        'vertices':[[round(float(x),7),round(float(y),7)] for x,y in p],
        'triangles':out_tris,'edges':edges,'towns':out_towns,
        'audit':audit,'diagnostics':{'meanAbsLogRatio':round(meanerr,6),'maxAbsLogRatio':round(maxerr,6),'invalidPolygons':invalid,'vertices':nvert,'triangles':len(triangles)}
    }
    OUT_PATH.parent.mkdir(parents=True,exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':')))
    print('wrote',OUT_PATH,'bytes',OUT_PATH.stat().st_size,'diagnostics',payload['diagnostics'],flush=True)
    print('worst',audit[:8],flush=True)

if __name__=='__main__':
    main()
