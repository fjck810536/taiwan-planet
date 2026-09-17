#!/usr/bin/env python3
"""Experimental v5: correct target graph, preserve hard Nantou, stage validity.

Changes from v4 are deliberately causal and small:
- `nantou_adjacent_factor` applies only to towns that really share an edge with
  a Nantou town, not to every town in a county/city that touches Nantou.
- Nantou's hard-pass vertices are frozen during residual transport.
- Polygon validity is audited at P0, after the radial preconditioner, and after
  residual transport so simplification and deformation failures are separable.
"""
from pathlib import Path
import re

BASE = Path(__file__).with_name('solve_mesh_v2.py')
src = BASE.read_text()

# The four extrema are not needed as hard anchors for a pressure solve.
src = src.replace("anchors={north,south,east,west}", "anchors=set()", 1)

# v2 used a county-level proxy for "touches Nantou".  Build the exact town graph
# from shared control-mesh edges instead.  This prevents distant Kaohsiung,
# Hualien, Taichung, etc. coastal towns from becoming donors merely because
# another town in the same municipality/county touches Nantou.
target_graph = r'''    town_neighbors=[set() for _ in towns]
    for ownset in edgeowners.values():
        if len(ownset)==2:
            i,j=tuple(ownset);town_neighbors[i].add(j);town_neighbors[j].add(i)
    nantou_ids0={i for i,t in enumerate(towns) if t['county']==NANTOU}
    nantou_adj_ids=set()
    for i in nantou_ids0:
        nantou_adj_ids.update(j for j in town_neighbors[i] if j not in nantou_ids0)
    factors=np.ones(len(towns))
    for i,t in enumerate(towns):
        if i in nantou_ids0:factors[i]=pol['nantou_factor']
        elif i in nantou_adj_ids:factors[i]=pol['nantou_adjacent_factor']
    print('direct Nantou neighbor towns',sorted(f"{towns[i]['county']}|{towns[i]['town']}" for i in nantou_adj_ids),flush=True)
'''
src, n = re.subn(
    r"    factors=np\.ones\(len\(towns\)\)\n    for i,t in enumerate\(towns\):\n        if t\['county'\]==NANTOU:factors\[i\]=pol\['nantou_factor'\]\n        elif t\['county'\] in NANTOU_ADJ:factors\[i\]=pol\['nantou_adjacent_factor'\]\n",
    target_graph,
    src,
    count=1,
)
if n != 1:
    raise RuntimeError('v5 overlay could not replace county-level Nantou adjacency targets')

radial = r'''    nids=[i for i,t in enumerate(towns) if t['county']==NANTOU];nvs=np.unique(np.concatenate([np.array(towns[i]['vids'],int) for i in nids]))
    def invalid_regions(Q):
        detail=[]
        for ti,t in enumerate(towns):
            for pi,rings in enumerate(t['polygons']):
                try:
                    poly=Polygon([tuple(Q[v]) for v in rings[0]],[[tuple(Q[v]) for v in r] for r in rings[1:]])
                    if not poly.is_valid:detail.append(f"{t['county']}|{t['town']}|poly{pi}")
                except Exception as ex:
                    detail.append(f"{t['county']}|{t['town']}|poly{pi}|{type(ex).__name__}")
        return detail
    invalid_p0=invalid_regions(P0);print('invalid P0',invalid_p0,flush=True)
    def nfactor(Q):
        a=areas(Q);return (a[nids].sum()/a.sum())/(source[nids].sum()/source.sum())
    # Smooth radial diffeomorphism: r' = r * (1-a*exp(-(r/R)^2)).
    # For 0<=a<1 its continuous radial derivative stays positive.
    nc=P0[nvs].mean(0);nr=max(np.linalg.norm(P0[nvs]-nc,axis=1).max(),1e-9)
    R=nr*float(cfg.get('nantou_radial_radius_multiplier',3.0));maxamp=float(cfg.get('nantou_radial_max_amplitude',0.92))
    def radial_candidate(amp):
        V=P0-nc;rr=np.linalg.norm(V,axis=1);gain=1-amp*np.exp(-(rr/R)**2);Q=nc+V*gain[:,None]
        return Q
    lo,hi=0.0,maxamp;target_nf=float(pol['nantou_factor']);hiQ=radial_candidate(hi);hiF=nfactor(hiQ)
    if hiF>target_nf:
        print('warning radial preconditioner cannot reach target; high factor',hiF,flush=True);P=hiQ
    else:
        for _ in range(28):
            mid=(lo+hi)/2;Q=radial_candidate(mid);f=nfactor(Q)
            if f>target_nf:lo=mid
            else:hi=mid
        P=radial_candidate(hi)
    invalid_radial=invalid_regions(P)
    print('nantou radial amplitude',hi,'radius',R,'factor',nfactor(P),flush=True)
    print('invalid radial',invalid_radial,flush=True)
'''
src, n = re.subn(
    r"    nids=\[i for i,t in enumerate\(towns\) if t\['county'\]==NANTOU\].*?    print\('nantou hard final',nfactor\(P\),flush=True\)\n",
    radial,
    src,
    count=1,
    flags=re.S,
)
if n != 1:
    raise RuntimeError('v5 overlay could not replace Nantou hard-pass block')

residual = r'''    # Residual solve: pressure flow across shared administrative edges.
    Pbase=P.copy();smooth=float(cfg.get('smooth_strength',.08));alpha=float(cfg.get('area_pressure_alpha',.14));iters=int(cfg.get('iterations',120))
    maxpressure=float(cfg.get('max_edge_pressure',1.5));coast_lock=bool(cfg.get('lock_coastline_during_residual',True));report_every=int(cfg.get('report_every',10))
    internal=[(a,b,tuple(sorted(own))) for (a,b),own in edgeowners.items() if len(own)==2]
    edge_scale=float(np.median([np.linalg.norm(P0[a]-P0[b]) for a,b,_ in internal])) if internal else 1.0
    maxmove=edge_scale*float(cfg.get('max_edge_move_ratio',.22))
    tva=[np.array(t['vids'],int) for t in towns]
    locked=set(int(v) for v in nvs)
    if coast_lock:locked.update(coastV)
    _,_,m0,x0=err(P);print('residual start mean',m0,'max',x0,'internalEdges',len(internal),'edgeScale',edge_scale,'locked',len(locked),flush=True)
    accepted_iters=0
    for it in range(iters):
        _,e,base,_=err(P);pressure=np.clip(e,-maxpressure,maxpressure);cent_now=np.array([P[vs].mean(0) for vs in tva]);D=np.zeros_like(P);W=np.zeros(len(P))
        for a,b,owners in internal:
            i,j=owners;A=P[a];B=P[b];edge=B-A;L=float(np.linalg.norm(edge))
            if L<=1e-12:continue
            normal=np.array([-edge[1],edge[0]])/L
            if float(np.dot(normal,cent_now[i]-cent_now[j]))<0:normal=-normal
            dp=float(pressure[i]-pressure[j])
            if abs(dp)<1e-12:continue
            # Positive dp: i is too large relative to j; move boundary toward i.
            vec=normal*dp*L
            D[a]+=vec;D[b]+=vec;W[a]+=L;W[b]+=L
        active=W>0
        if np.any(active):D[active]/=W[active,None]
        D*=alpha*edge_scale
        mag=np.linalg.norm(D,axis=1);over=mag>maxmove
        if np.any(over):D[over]*=(maxmove/mag[over])[:,None]
        # Smooth only the residual displacement from the radial hard-pass state.
        disp=P-Pbase;lap=np.zeros_like(P)
        for v,ns in enumerate(neigh):
            if len(ns):lap[v]=disp[ns].mean(0)-disp[v]
        D+=smooth*lap
        for v in locked:D[v]=0
        step=1.0;accepted=False;best=None
        for _ in range(18):
            cand=P+step*D;rr=np.linalg.norm(cand,axis=1);outside=rr>maxrho
            cand[outside]*=(maxrho/rr[outside])[:,None]
            ok=True;minrel=1e99
            for j,(a,b,c,ti) in enumerate(tris):
                sa=signed2(cand,a,b,c);rel=sa/max(initA[j],1e-18);minrel=min(minrel,rel)
                if sa<=0 or rel<minratio:ok=False;break
            if ok:
                _,_,ce,_=err(cand)
                if best is None or ce<best[0]:best=(ce,cand.copy(),step,minrel)
                if ce<=base*(1+1e-7):P=cand;accepted=True;break
            step*=.5
        if not accepted:
            if best is not None and best[0]<=base*(1+5e-5):
                P=best[1];accepted=True;step=best[2]
            else:
                print('residual stalled',it,'mean',base,'best',None if best is None else best[0],flush=True);break
        accepted_iters+=1
        if it%report_every==0:
            _,_,mm,xx=err(P);print('iter',it,'mean',mm,'max',xx,'nantou',nfactor(P),'step',step,flush=True)
'''
src, n = re.subn(
    r"    own=np\.zeros\(len\(P\)\);tva=\[\].*?        if it%10==0:print\('iter',it,'mean',err\(P\)\[2\],'nantou',nfactor\(P\),'step',step,flush=True\)\n",
    residual,
    src,
    count=1,
    flags=re.S,
)
if n != 1:
    raise RuntimeError('v5 overlay could not replace residual controller block')

invalid_block = r'''    invalid_detail=invalid_regions(P);invalid=len(invalid_detail)
    print('invalid residual',invalid_detail,flush=True)
'''
src, n = re.subn(
    r"    invalid=0\n    for t in towns:.*?            except:invalid\+=1\n",
    invalid_block,
    src,
    count=1,
    flags=re.S,
)
if n != 1:
    raise RuntimeError('v5 overlay could not replace invalid-polygon audit block')

src = src.replace("'method':'coarse-shared-control-area-constraint'", "'method':'coarse-shared-control-edge-pressure-v5'", 1)
src = src.replace(
    "'invalidPolygons':invalid",
    "'invalidPolygons':invalid,'invalidPolygonRegions':invalid_detail,'invalidP0':invalid_p0,'invalidRadial':invalid_radial,'residualAcceptedIterations':accepted_iters",
    1,
)

ns = {'__name__': '__main__', '__file__': str(BASE)}
exec(compile(src, str(BASE), 'exec'), ns, ns)
