#!/usr/bin/env python3
import json, math, urllib.request
from collections import defaultdict
from pathlib import Path
import numpy as np
from shapely.geometry import Polygon
from shapely.ops import triangulate

ROOT=Path(__file__).resolve().parent
POLICY_PATH=ROOT/'policy.json'; OUT_PATH=ROOT/'generated'/'mesh.json'
DATA_URL='https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json'
MAINLAND_BOX=(120.0,122.12,21.72,25.58)
OFFSHORE={'綠島鄉','兰嶼鄉','蘭嶼鄉','琉球鄉'}
NANTOU='南投縣'; NANTOU_ADJ={'台中市','彰化縣','雲林縣','嘉義縣','高雄市','花蓮縣'}

def clean(s): return str(s or '').replace('臺','台').strip()
def fetch_json(url):
    req=urllib.request.Request(url,headers={'User-Agent':'taiwan-planet-mesh-solver/2.0'})
    with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)
def source_xy(clon,clat,lon,lat):
    l1=math.radians(clon);p1=math.radians(clat);l2=math.radians(lon);p2=math.radians(lat);d=l2-l1
    ca=max(-1,min(1,math.sin(p1)*math.sin(p2)+math.cos(p1)*math.cos(p2)*math.cos(d))); ang=math.acos(ca)
    b=math.atan2(math.sin(d)*math.cos(p2),math.cos(p1)*math.sin(p2)-math.sin(p1)*math.cos(p2)*math.cos(d));r=2*math.tan(ang/2)
    return np.array([r*math.sin(b),r*math.cos(b)],float)
def unit_plane(q):
    x,y=map(float,q); r=math.hypot(x,y)
    if r<1e-15:return np.array([0.,0.,1.])
    c=2*math.atan(r/2);s=math.sin(c);return np.array([s*x/r,s*y/r,math.cos(c)])
def unit_geo(lon,lat):
    l=math.radians(lon);p=math.radians(lat);c=math.cos(p);return np.array([c*math.cos(l),c*math.sin(l),math.sin(p)])
def sphere_area(a,b,c):
    return 2*math.atan2(abs(np.dot(a,np.cross(b,c))),max(1e-15,1+np.dot(a,b)+np.dot(b,c)+np.dot(c,a)))
def signed2(P,a,b,c):
    A,B,C=P[a],P[b],P[c];return (B[0]-A[0])*(C[1]-A[1])-(B[1]-A[1])*(C[0]-A[0])

def decode_arcs(topo):
    tr=topo.get('transform');sc=tr['scale'] if tr else [1,1];tt=tr['translate'] if tr else [0,0];out=[]
    for arc in topo['arcs']:
        x=y=0; pts=[]
        for a,b in arc:
            if tr:x+=a;y+=b;lon=x*sc[0]+tt[0];lat=y*sc[1]+tt[1]
            else:lon=a;lat=b
            pts.append((float(lon),float(lat)))
        out.append(pts)
    return out

def rdp_indices(points,tol):
    n=len(points)
    if n<=2:return list(range(n))
    keep={0,n-1}; stack=[(0,n-1)]
    while stack:
        i,j=stack.pop();a=points[i];b=points[j];ab=b-a;den=float(np.dot(ab,ab));best=-1;idx=None
        for k in range(i+1,j):
            ap=points[k]-a;t=0 if den<=1e-24 else max(0,min(1,float(np.dot(ap,ab)/den)));d=np.linalg.norm(points[k]-(a+t*ab))
            if d>best:best=d;idx=k
        if idx is not None and best>tol:keep.add(idx);stack.append((i,idx));stack.append((idx,j))
    return sorted(keep)

def ring_from_refs(arcs,refs):
    out=[]
    for j,r in enumerate(refs):
        pts=arcs[r] if r>=0 else list(reversed(arcs[-r-1]))
        if j:pts=pts[1:]
        out.extend(pts)
    if len(out)>1 and out[0]==out[-1]:out.pop()
    return out

def geom_polys(g):
    if g['type']=='Polygon':return [g['arcs']]
    if g['type']=='MultiPolygon':return g['arcs']
    return []
def mainland(r):
    if not r:return False
    lon=sum(x for x,y in r)/len(r);lat=sum(y for x,y in r)/len(r);a,b,c,d=MAINLAND_BOX
    return a<=lon<=b and c<=lat<=d

def alloc(items,w,amount,caps,target):
    rem=amount;active=[i for i in items if w[i]>0]
    for _ in range(20):
        if rem<=1e-15 or not active:break
        tw=sum(w[i] for i in active);dist=0;nxt=[]
        if tw<=0:break
        for i in active:
            cap=max(0,caps[i]-target[i]);gain=min(cap,rem*w[i]/tw);target[i]+=gain;dist+=gain
            if cap-gain>1e-15:nxt.append(i)
        if dist<=1e-15:break
        rem-=dist;active=nxt
    return rem

def main():
    pol=json.loads(POLICY_PATH.read_text()); topo=fetch_json(DATA_URL); full_arcs=decode_arcs(topo)
    obj=topo['objects'].get('towns') or next(iter(topo['objects'].values()))
    allpts=[p for a in full_arcs for p in a];lons=[p[0] for p in allpts];lats=[p[1] for p in allpts];clon=(min(lons)+max(lons))/2;clat=(min(lats)+max(lats))/2
    maxcol=math.radians(pol['target_max_colat_deg']);maxrho=2*math.tan(maxcol/2);rawmax=max(np.linalg.norm(source_xy(clon,clat,*p)) for p in allpts);scale=maxrho/rawmax
    tol=float(pol['solver'].get('control_simplify_tolerance',0.006))
    simp=[]; raw_count=0; control_count=0
    for a in full_arcs:
        raw_count+=len(a);xy=np.array([source_xy(clon,clat,*p)*scale for p in a]);idx=rdp_indices(xy,tol);sa=[a[i] for i in idx];simp.append(sa);control_count+=len(sa)
    print('arc points raw',raw_count,'control',control_count,'tol',tol,flush=True)
    raw=[]
    for g in obj['geometries']:
        pr=g.get('properties',{});county=clean(pr.get('COUNTYNAME') or pr.get('countyname'));town=clean(pr.get('TOWNNAME') or pr.get('townname'))
        if town in OFFSHORE:continue
        ps=[]
        for pref in geom_polys(g):
            rings=[ring_from_refs(simp,refs) for refs in pref]
            if rings and mainland(rings[0]):ps.append(rings)
        if ps:raw.append((county,town,ps))
    key2v={};ll=[];p0=[]
    def vid(q):
        k=(round(q[0],10),round(q[1],10))
        if k not in key2v:key2v[k]=len(ll);ll.append(q);p0.append(source_xy(clon,clat,*q)*scale)
        return key2v[k]
    towns=[];edgeowners=defaultdict(set);adj=defaultdict(set)
    for ti,(county,town,ps) in enumerate(raw):
        polys=[];vs=set()
        for rings in ps:
            vr=[]
            for ring in rings:
                ids=[vid(q) for q in ring]
                if len(ids)>=3:
                    vr.append(ids);vs.update(ids)
                    for a,b in zip(ids,ids[1:]+ids[:1]):e=tuple(sorted((a,b)));edgeowners[e].add(ti);adj[a].add(b);adj[b].add(a)
            if vr:polys.append(vr)
        towns.append({'county':county,'town':town,'polygons':polys,'vids':sorted(vs)})
    P0=np.array(p0,float);P=P0.copy();ll=np.array(ll,float);print('towns',len(towns),'control vertices',len(P),flush=True)
    tris=[]
    for ti,t in enumerate(towns):
        for rings in t['polygons']:
            poly=Polygon([tuple(P0[v]) for v in rings[0]],[[tuple(P0[v]) for v in r] for r in rings[1:]])
            if not poly.is_valid:poly=poly.buffer(0)
            cmap={(round(P0[v,0],10),round(P0[v,1],10)):v for r in rings for v in r};cand=[v for r in rings for v in r]
            for tr in triangulate(poly):
                if tr.area<=1e-18 or tr.intersection(poly).area/tr.area<.999999:continue
                ids=[];ok=True
                for x,y in list(tr.exterior.coords)[:3]:
                    v=cmap.get((round(x,10),round(y,10)))
                    if v is None:
                        v=min(cand,key=lambda z:(P0[z,0]-x)**2+(P0[z,1]-y)**2)
                        if (P0[v,0]-x)**2+(P0[v,1]-y)**2>1e-14:ok=False;break
                    ids.append(v)
                if ok and len(set(ids))==3:
                    a,b,c=ids
                    if signed2(P0,a,b,c)<0:b,c=c,b
                    tris.append((a,b,c,ti))
    print('triangles',len(tris),flush=True)
    gunit=[unit_geo(*q) for q in ll];source=np.zeros(len(towns))
    for a,b,c,ti in tris:source[ti]+=sphere_area(gunit[a],gunit[b],gunit[c])
    totalL=np.zeros(len(towns));coastL=np.zeros(len(towns));coastV=set()
    for (a,b),own in edgeowners.items():
        L=np.linalg.norm(P0[a]-P0[b])
        for ti in own:totalL[ti]+=L
        if len(own)==1:ti=next(iter(own));coastL[ti]+=L;coastV|={a,b}
    coast=np.divide(coastL,totalL,out=np.zeros_like(totalL),where=totalL>0)
    cent=np.array([P0[t['vids']].mean(0) for t in towns]);rad=np.linalg.norm(cent,axis=1);rad/=max(rad.max(),1e-12)
    factors=np.ones(len(towns))
    for i,t in enumerate(towns):
        if t['county']==NANTOU:factors[i]=pol['nantou_factor']
        elif t['county'] in NANTOU_ADJ:factors[i]=pol['nantou_adjacent_factor']
    target=source*factors;pool=source.sum()-target.sum();caps=source*float(pol['receiver_cap_factor']);w=np.zeros(len(towns));tiers={k:[] for k in ['north','south','second','general']}
    core=set(pol['taipei_core_no_gain']);tn=set(pol['taipei_north']);nn=set(pol['new_taipei_north']);sp=set(pol['south_prime']);bonus=pol['north_bonus']
    for i,t in enumerate(towns):
        if t['county']=='台北市' and t['town'] in core:continue
        if factors[i]<1:continue
        north=t['county']=='基隆市' or (t['county']=='台北市' and t['town'] in tn) or (t['county']=='新北市' and t['town'] in nn)
        south=t['county']=='屏東縣' and t['town'] in sp
        if north:k='north'
        elif south:k='south'
        elif coast[i]>.001 and rad[i]>=.64:k='second'
        elif coast[i]>.001:k='general'
        else:continue
        tiers[k].append(i);manual=float(bonus.get(t['county'],bonus.get(t['town'],1))) if north else 1
        w[i]=manual*math.sqrt(max(source[i],1e-15))*(.35+coast[i])*(.5+rad[i]**3)
    rem=0
    for k,s in pol['receiver_shares'].items():rem+=alloc(tiers[k],w,pool*float(s),caps,target)
    allrecv=[i for x in tiers.values() for i in x]
    if rem>1e-15:rem=alloc(allrecv,w,rem,caps,target)
    tshare=target/target.sum();initA=np.array([abs(signed2(P0,*t[:3])) for t in tris]);cfg=pol['solver'];minratio=float(cfg.get('min_triangle_area_ratio',0.0002))
    north=int(np.argmax(ll[:,1]));south=int(np.argmin(ll[:,1]));east=int(np.argmax(ll[:,0]));west=int(np.argmin(ll[:,0]));anchors={north,south,east,west}
    neigh=[np.array(sorted(adj.get(v,())),int) for v in range(len(P))]
    def areas(Q):
        u=[unit_plane(q) for q in Q];a=np.zeros(len(towns))
        for x,y,z,ti in tris:a[ti]+=sphere_area(u[x],u[y],u[z])
        return a
    def err(Q):
        a=areas(Q);sh=a/a.sum();e=np.log(np.maximum(sh,1e-15)/np.maximum(tshare,1e-15));return a,e,float(np.mean(abs(e))),float(np.max(abs(e)))
    nids=[i for i,t in enumerate(towns) if t['county']==NANTOU];nvs=set(v for i in nids for v in towns[i]['vids']);weights=np.zeros(len(P));front=set(nvs)
    for v in nvs:weights[v]=1
    for depth,val in [(1,.55),(2,.28),(3,.12)]:
        nxt=set()
        for v in front:
            for u in adj.get(v,()):
                if weights[u]==0:nxt.add(u)
        for u in nxt:weights[u]=val
        front=nxt
    affected=[j for j,(a,b,c,ti) in enumerate(tris) if weights[a]>0 or weights[b]>0 or weights[c]>0]
    def nfactor(Q):
        a=areas(Q);return (a[nids].sum()/a.sum())/(source[nids].sum()/source.sum())
    passes=int(cfg.get('nantou_hard_passes',30));minstep=float(cfg.get('nantou_min_linear_step',.82))
    for hp in range(passes):
        gf=nfactor(P)
        if gf<=float(pol['nantou_factor'])*1.04:break
        rawscale=math.sqrt(float(pol['nantou_factor'])/max(gf,1e-12));base=max(minstep,min(1,rawscale));center=P[list(nvs)].mean(0);accepted=False
        for retry in range(16):
            s=1-(1-base)*(0.5**retry);cand=center+(P-center)*(1-(1-s)*weights[:,None])
            rr=np.linalg.norm(cand,axis=1);over=rr>maxrho;cand[over]*=(maxrho/rr[over])[:,None]
            for v in anchors:cand[v]=P0[v]
            ok=True
            for j in affected:
                a,b,c,_=tris[j];sa=signed2(cand,a,b,c)
                if sa<=0 or abs(sa)<initA[j]*minratio:ok=False;break
            if ok:P=cand;accepted=True;break
        if not accepted:break
        if hp%2==0:print('nantou hard',hp,'factor',nfactor(P),'step',s,flush=True)
    print('nantou hard final',nfactor(P),flush=True)
    own=np.zeros(len(P));tva=[]
    for t in towns:
        ar=np.array(t['vids'],int);tva.append(ar);own[ar]+=1
    own=np.maximum(own,1);smooth=float(cfg.get('smooth_strength',.08));alpha=float(cfg.get('area_alpha',.10));maxstep=float(cfg.get('max_local_scale_step',.018));iters=int(cfg.get('iterations',120));_,_,m0,x0=err(P);print('residual start mean',m0,'max',x0,flush=True)
    for it in range(iters):
        _,e,base,_=err(P);D=np.zeros_like(P)
        for ti in np.argsort(-abs(e)):
            vs=tva[ti]
            if len(vs)<3:continue
            c=P[vs].mean(0);ls=max(-maxstep,min(maxstep,-alpha*e[ti]/2));s=math.exp(ls);D[vs]+=c+(P[vs]-c)*s-P[vs]
        D/=own[:,None];lap=np.zeros_like(P)
        for v,ns in enumerate(neigh):
            if len(ns):lap[v]=P[ns].mean(0)-P[v]
        D+=smooth*lap
        for v in anchors:D[v]=0
        step=1;accepted=False
        for _ in range(14):
            cand=P+step*D;rr=np.linalg.norm(cand,axis=1);over=rr>maxrho;cand[over]*=(maxrho/rr[over])[:,None]
            for v in anchors:cand[v]=P0[v]
            ok=True
            for j,(a,b,c,ti) in enumerate(tris):
                sa=signed2(cand,a,b,c)
                if sa<=0 or abs(sa)<initA[j]*minratio:ok=False;break
            if ok:
                _,_,ce,_=err(cand)
                if ce<=base*1.0005:P=cand;accepted=True;break
            step*=.5
        if not accepted:print('residual stalled',it,base,flush=True);break
        if it%10==0:print('iter',it,'mean',err(P)[2],'nantou',nfactor(P),'step',step,flush=True)
    actual,e,meanerr,maxerr=err(P);ash=actual/actual.sum();af=ash/(source/source.sum());tf=tshare/(source/source.sum())
    invalid=0
    for t in towns:
        for rings in t['polygons']:
            try:
                poly=Polygon([tuple(P[v]) for v in rings[0]],[[tuple(P[v]) for v in r] for r in rings[1:]])
                if not poly.is_valid:invalid+=1
            except:invalid+=1
    outtown=[]
    for i,t in enumerate(towns):
        cc=P[t['vids']].mean(0);outtown.append({'county':t['county'],'town':t['town'],'targetFactor':round(float(tf[i]),6),'actualFactor':round(float(af[i]),6),'centroid':[round(float(cc[0]),7),round(float(cc[1]),7)]})
    audit=sorted([{'region':f"{t['county']}|{t['town']}",'target':round(float(tf[i]),4),'actual':round(float(af[i]),4),'ratio':round(float(af[i]/tf[i]),4)} for i,t in enumerate(towns)],key=lambda x:x['ratio'],reverse=True)
    payload={'version':2,'method':'coarse-shared-control-area-constraint','targetMaxColatDeg':pol['target_max_colat_deg'],'vertices':[[round(float(x),7),round(float(y),7)] for x,y in P],'triangles':[[a,b,c,ti] for a,b,c,ti in tris],'edges':[list(e) for e in sorted(edgeowners)],'towns':outtown,'audit':audit,'diagnostics':{'meanAbsLogRatio':round(meanerr,6),'maxAbsLogRatio':round(maxerr,6),'invalidPolygons':invalid,'vertices':len(P),'triangles':len(tris),'nantouFactor':round(float(nfactor(P)),6),'rawArcPoints':raw_count,'controlArcPoints':control_count,'simplifyTolerance':tol}}
    OUT_PATH.parent.mkdir(parents=True,exist_ok=True);OUT_PATH.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':')))
    print('wrote',OUT_PATH,'diagnostics',payload['diagnostics'],flush=True);print('worst',audit[:8],flush=True)
if __name__=='__main__':main()
