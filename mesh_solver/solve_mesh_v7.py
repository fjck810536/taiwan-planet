#!/usr/bin/env python3
"""v7: topology-safe mesh plus local boundary-block Gauss-Seidel area solve.

Global simultaneous pressure steps stall because one nearly-degenerate local
triangle forces the line search for the whole island toward zero.  v7 instead
updates one *administrative neighbour pair* at a time.  All control segments of
that shared boundary form one block, so the boundary moves coherently.  A block
is accepted only when:
  1. every incident triangle keeps positive orientation and area margin,
  2. every polygon touched by the moved vertices remains Shapely-valid, and
  3. the global squared log area-share error decreases.
Thus a pathological corner cannot freeze unrelated regions, and accepted moves
cannot introduce the self-intersections observed in v4-v6 residual passes.
"""
from pathlib import Path
from collections import defaultdict

HERE = Path(__file__).resolve().parent
V6 = HERE / 'solve_mesh_v6.py'
text = V6.read_text()
marker = "\nns = {'__name__': '__main__', '__file__': str(BASE)}"
pos = text.rfind(marker)
if pos < 0:
    raise RuntimeError('v7 could not locate v6 execution boundary')

env = {'__name__': 'v6_overlay_builder', '__file__': str(V6)}
exec(compile(text[:pos], str(V6), 'exec'), env, env)
src = env['src']; BASE = env['BASE']

start_marker = "    # Residual solve: pressure flow across shared administrative edges.\n"
end_marker = "            _,_,mm,xx=err(P);print('iter',it,'mean',mm,'max',xx,'nantou',nfactor(P),'step',step,flush=True)\n"
start = src.find(start_marker)
end0 = src.find(end_marker, start)
if start < 0 or end0 < 0:
    raise RuntimeError('v7 could not locate v6 residual block')
end = end0 + len(end_marker)

local_solver = r'''    # Residual solve: local Gauss-Seidel updates of whole shared-boundary blocks.
    Pbase=P.copy();cfg_local=cfg
    local_alpha=float(cfg_local.get('local_edge_alpha',.10));maxpressure=float(cfg_local.get('max_edge_pressure',1.5))
    sweeps=int(cfg_local.get('local_edge_sweeps',16));report_every=max(1,int(cfg_local.get('local_report_every',1)))
    coast_lock=bool(cfg_local.get('lock_coastline_during_residual',True));locked=set(int(v) for v in nvs)
    if coast_lock:locked.update(coastV)
    tva=[np.array(t['vids'],int) for t in towns]
    vertex_towns=[set() for _ in range(len(P))]
    for ti,vs in enumerate(tva):
        for v in vs:vertex_towns[int(v)].add(ti)
    tri_by_vertex=[set() for _ in range(len(P))]
    for q,(a,b,c,ti) in enumerate(tris):
        tri_by_vertex[a].add(q);tri_by_vertex[b].add(q);tri_by_vertex[c].add(q)
    pair_edges=defaultdict(list)
    for (a,b),ownset in edgeowners.items():
        if len(ownset)==2:
            i,j=sorted(ownset);pair_edges[(i,j)].append((a,b))
    blocks=list(pair_edges.items())
    edge_scale=float(np.median([np.linalg.norm(P0[a]-P0[b]) for es in pair_edges.values() for a,b in es])) if blocks else 1.0
    max_delta=edge_scale*float(cfg_local.get('local_max_move_ratio',.28))

    def tri_area_at(Q,q):
        a,b,c,ti=tris[q];return sphere_area(unit_plane(Q[a]),unit_plane(Q[b]),unit_plane(Q[c]))
    triA=np.array([tri_area_at(P,q) for q in range(len(tris))])
    curA=np.zeros(len(towns))
    for q,(_,_,_,ti) in enumerate(tris):curA[ti]+=triA[q]
    def score_from_area(a):
        sh=a/max(a.sum(),1e-15);ee=np.log(np.maximum(sh,1e-15)/np.maximum(tshare,1e-15))
        return float(np.mean(ee*ee)),ee,float(np.mean(abs(ee))),float(np.max(abs(ee)))
    score,curE,m0,x0=score_from_area(curA)
    def town_valid_at(Q,ti):
        t=towns[ti]
        for rings in t['polygons']:
            try:
                poly=Polygon([tuple(Q[v]) for v in rings[0]],[[tuple(Q[v]) for v in r] for r in rings[1:]])
                if not poly.is_valid:return False
            except Exception:return False
        return True
    print('local residual start mean',m0,'max',x0,'score2',score,'blocks',len(blocks),'edgeScale',edge_scale,'locked',len(locked),flush=True)
    accepted_moves=0;accepted_iters=0
    for sweep in range(sweeps):
        cent_now=np.array([P[vs].mean(0) for vs in tva])
        # Recompute pressure order every sweep.  Within a sweep, accepted blocks
        # immediately update curE, so later blocks see the newest local pressure.
        order=sorted(blocks,key=lambda item:abs(curE[item[0][0]]-curE[item[0][1]]),reverse=True)
        sweep_accept=0;score_start=score
        for (i,j),es in order:
            dp=float(np.clip(curE[i]-curE[j],-maxpressure,maxpressure))
            if abs(dp)<1e-5:continue
            acc=defaultdict(lambda:np.zeros(2));ww=defaultdict(float)
            for a,b in es:
                A=P[a];B=P[b];edge=B-A;L=float(np.linalg.norm(edge))
                if L<=1e-12:continue
                normal=np.array([-edge[1],edge[0]])/L
                if float(np.dot(normal,cent_now[i]-cent_now[j]))<0:normal=-normal
                for v in (a,b):
                    if v in locked:continue
                    acc[v]+=normal*L;ww[v]+=L
            movable=sorted(acc)
            if not movable:continue
            dirs=[]
            for v in movable:
                d=acc[v]/max(ww[v],1e-15);dn=float(np.linalg.norm(d));dirs.append(d/dn if dn>1e-15 else d)
            dirs=np.array(dirs);old=P[movable].copy()
            base_delta=min(max_delta,local_alpha*edge_scale*abs(dp));sign=1.0 if dp>0 else -1.0
            incident=set();affected_towns=set()
            for v in movable:
                incident.update(tri_by_vertex[v]);affected_towns.update(vertex_towns[v])
            incident=sorted(incident);affected_towns=sorted(affected_towns)
            accepted=False
            for ls in range(9):
                step=0.5**ls;P[movable]=old + sign*base_delta*step*dirs
                rr=np.linalg.norm(P[movable],axis=1);over=rr>maxrho
                if np.any(over):P[np.array(movable)[over]]*= (maxrho/rr[over])[:,None]
                ok=True
                for q in incident:
                    a,b,c,ti=tris[q];sa=signed2(P,a,b,c)
                    if sa<=0 or sa<initA[q]*minratio:ok=False;break
                if ok:
                    for ti in affected_towns:
                        if not town_valid_at(P,ti):ok=False;break
                if not ok:
                    P[movable]=old;continue
                newvals={q:tri_area_at(P,q) for q in incident};trialA=curA.copy()
                for q,nv in newvals.items():
                    ti=tris[q][3];trialA[ti]+=nv-triA[q]
                trial_score,trialE,trial_mean,trial_max=score_from_area(trialA)
                if trial_score < score-1e-12:
                    curA=trialA;curE=trialE;score=trial_score
                    for q,nv in newvals.items():triA[q]=nv
                    accepted=True;sweep_accept+=1;accepted_moves+=1
                    break
                P[movable]=old
            if not accepted:P[movable]=old
        accepted_iters+=1
        _,_,mm,xx=score_from_area(curA)
        if sweep%report_every==0:
            print('local sweep',sweep,'accepted',sweep_accept,'mean',mm,'max',xx,'score2',score,'nantou',nfactor(P),flush=True)
        if sweep_accept==0 or score_start-score<1e-9:
            print('local residual converged',sweep,'accepted',sweep_accept,'deltaScore',score_start-score,flush=True);break
'''

src = src[:start] + local_solver + src[end:]
src = src.replace("'method':'adaptive-shared-control-edge-pressure-v6'", "'method':'adaptive-shared-control-local-boundary-v7'", 1)
src = src.replace("'residualAcceptedIterations':accepted_iters", "'residualAcceptedIterations':accepted_iters,'residualAcceptedMoves':accepted_moves", 1)

ns = {'__name__': '__main__', '__file__': str(BASE)}
exec(compile(src, str(BASE), 'exec'), ns, ns)
