#!/usr/bin/env python3
"""v9: v8 plus a topology-safe terminal-coast degree of freedom for south_prime.

v8 proved that stronger pressure across the administrative interface of the
south-prime cluster barely changes its total area while every coastline vertex
is locked.  v9 therefore leaves the v8 shared-boundary solve untouched, then
runs a second, deliberately small pass that may move only coastline vertices of
south_prime towns along smoothed local coast normals.

Each town-coast block is accepted only when all incident triangles retain
positive orientation/area margin, every touched administrative polygon stays
valid, and the same global squared log-area objective decreases.  The 115-degree
stereographic footprint clamp remains active.  Thus v9 adds one narrowly scoped
geometric degree of freedom without relaxing topology or validity guards.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent
V8 = HERE / 'solve_mesh_v8.py'
text = V8.read_text()
marker = "\nns = {'__name__': '__main__', '__file__': str(BASE)}"
pos = text.rfind(marker)
if pos < 0:
    raise RuntimeError('v9 could not locate v8 execution boundary')

env = {'__name__': 'v8_overlay_builder', '__file__': str(V8)}
exec(compile(text[:pos], str(V8), 'exec'), env, env)
src = env['src']; BASE = env['BASE']

insert_marker = "    invalid_detail=invalid_regions(P);invalid=len(invalid_detail)\n"
if insert_marker not in src:
    raise RuntimeError('v9 could not locate post-residual validity audit')

coast_pass = r'''    # v9 terminal-coast pass: south_prime coastline only.
    south_coast_sweeps=int(cfg_local.get('south_coast_sweeps',18))
    south_coast_alpha=float(cfg_local.get('south_coast_alpha',0.065))
    south_coast_max_move_ratio=float(cfg_local.get('south_coast_max_move_ratio',0.16))
    south_coast_pressure_cap=float(cfg_local.get('south_coast_pressure_cap',2.2))
    south_coast_max_delta=edge_scale*south_coast_max_move_ratio
    south_coast_edges=defaultdict(list)
    for (a,b),ownset in edgeowners.items():
        if len(ownset)==1:
            ti=next(iter(ownset))
            if ti in south_set:
                south_coast_edges[ti].append((a,b))
    south_coast_blocks=sorted(south_coast_edges.items())
    south_coast_accepts=0;south_coast_iters=0
    print('south coast blocks',[(f"{towns[ti]['county']}|{towns[ti]['town']}",len(es)) for ti,es in south_coast_blocks],
          'sweeps',south_coast_sweeps,'alpha',south_coast_alpha,'maxDelta',south_coast_max_delta,flush=True)
    for csweep in range(south_coast_sweeps):
        cent_now=np.array([P[vs].mean(0) for vs in tva])
        # Prioritize towns furthest below target. curE<0 means under target.
        coast_order=sorted(south_coast_blocks,key=lambda item:curE[item[0]])
        sweep_accept=0;score_start=score
        for ti,es in coast_order:
            pressure=float(np.clip(-curE[ti],-south_coast_pressure_cap,south_coast_pressure_cap))
            if abs(pressure)<1e-5:continue
            acc=defaultdict(lambda:np.zeros(2));ww=defaultdict(float)
            c=cent_now[ti]
            for a,b in es:
                A=P[a];B=P[b];edge=B-A;L=float(np.linalg.norm(edge))
                if L<=1e-12:continue
                mid=(A+B)*0.5
                normal=np.array([-edge[1],edge[0]])/L
                # Pick the normal pointing away from the town centroid.
                if float(np.dot(normal,c-mid))>0:normal=-normal
                for v in (a,b):
                    # Nantou is nowhere near this pass, but keep its hard lock explicit.
                    if v in nvs:continue
                    acc[v]+=normal*L;ww[v]+=L
            movable=sorted(acc)
            if not movable:continue
            dirs=[]
            for v in movable:
                d=acc[v]/max(ww[v],1e-15);dn=float(np.linalg.norm(d));dirs.append(d/dn if dn>1e-15 else d)
            dirs=np.array(dirs);old=P[movable].copy()
            # pressure>0 => town is too small => move coast outward.
            base_delta=min(south_coast_max_delta,south_coast_alpha*edge_scale*abs(pressure))
            sign=1.0 if pressure>0 else -1.0
            incident=set();affected_towns=set()
            for v in movable:
                incident.update(tri_by_vertex[v]);affected_towns.update(vertex_towns[v])
            incident=sorted(incident);affected_towns=sorted(affected_towns)
            accepted=False
            for ls in range(11):
                step=0.5**ls;P[movable]=old + sign*base_delta*step*dirs
                rr=np.linalg.norm(P[movable],axis=1);over=rr>maxrho
                if np.any(over):P[np.array(movable)[over]]*= (maxrho/rr[over])[:,None]
                ok=True
                for q in incident:
                    a,b,cq,owner=tris[q];sa=signed2(P,a,b,cq)
                    if sa<=0 or sa<initA[q]*minratio:ok=False;break
                if ok:
                    for tj in affected_towns:
                        if not town_valid_at(P,tj):ok=False;break
                if not ok:
                    P[movable]=old;continue
                newvals={q:tri_area_at(P,q) for q in incident};trialA=curA.copy()
                for q,nv in newvals.items():
                    owner=tris[q][3];trialA[owner]+=nv-triA[q]
                trial_score,trialE,trial_mean,trial_max=score_from_area(trialA)
                if trial_score < score-1e-12:
                    curA=trialA;curE=trialE;score=trial_score
                    for q,nv in newvals.items():triA[q]=nv
                    accepted=True;sweep_accept+=1;south_coast_accepts+=1
                    break
                P[movable]=old
            if not accepted:P[movable]=old
        south_coast_iters+=1
        south_ratio=((curA[south_ids].sum()/max(curA.sum(),1e-15))/max(south_target_share,1e-15)) if south_ids else 1.0
        _,_,mm,xx=score_from_area(curA)
        if csweep%max(1,report_every)==0 or csweep==south_coast_sweeps-1:
            print('south coast sweep',csweep,'accepted',sweep_accept,'mean',mm,'max',xx,'score2',score,
                  'nantou',nfactor(P),'southRatio',south_ratio,flush=True)
        if sweep_accept==0 or score_start-score<1e-10:
            print('south coast converged',csweep,'accepted',sweep_accept,'deltaScore',score_start-score,flush=True);break
'''

src = src.replace(insert_marker, coast_pass + insert_marker, 1)
src = src.replace("'method':'adaptive-shared-control-south-cluster-v8'", "'method':'adaptive-shared-control-terminal-coast-v9'", 1)
src = src.replace(
    "'southInterfaceAcceptedMoves':south_interface_accepts,'southClusterRatio':south_ratio",
    "'southInterfaceAcceptedMoves':south_interface_accepts,'southClusterRatio':south_ratio,'southCoastAcceptedMoves':south_coast_accepts,'southCoastSweeps':south_coast_iters",
    1,
)

ns = {'__name__': '__main__', '__file__': str(BASE)}
exec(compile(src, str(BASE), 'exec'), ns, ns)
