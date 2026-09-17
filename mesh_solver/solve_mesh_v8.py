#!/usr/bin/env python3
"""v8: v7 plus aggregate pressure across the south-prime cluster interface.

v7 keeps every coastline vertex locked, which is desirable for coastline shape,
but the five south-prime towns can then gain total area only through their
administrative interface with the rest of Taiwan.  Per-town pressure saturates
at the normal cap and transports area into that terminal cluster very slowly.

v8 keeps the coastline locked and preserves the exact same local safety guards.
For an administrative boundary crossing into/out of `south_prime`, it augments
the town-to-town pressure with the aggregate south-cluster area error and uses a
higher pressure cap.  Geometry is still accepted one neighbour-pair block at a
time, only when triangle orientation, polygon validity, and the global area
objective all improve.  Thus this is an area-transport acceleration, not a new
coastline deformation degree of freedom.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent
V7 = HERE / 'solve_mesh_v7.py'
text = V7.read_text()
marker = "\nns = {'__name__': '__main__', '__file__': str(BASE)}"
pos = text.rfind(marker)
if pos < 0:
    raise RuntimeError('v8 could not locate v7 execution boundary')

# Execute only v7's overlay-building portion.  It produces the fully transformed
# solver source in `src` without running main().
env = {'__name__': 'v7_overlay_builder', '__file__': str(V7)}
exec(compile(text[:pos], str(V7), 'exec'), env, env)
src = env['src']; BASE = env['BASE']

old = """    blocks=list(pair_edges.items())
    edge_scale=float(np.median([np.linalg.norm(P0[a]-P0[b]) for es in pair_edges.values() for a,b in es])) if blocks else 1.0
    max_delta=edge_scale*float(cfg_local.get('local_max_move_ratio',.28))
"""
new = """    blocks=list(pair_edges.items())
    south_names=set(pol.get('south_prime',[]))
    south_ids=[i for i,t in enumerate(towns) if t['town'] in south_names]
    south_set=set(south_ids)
    south_target_share=float(tshare[south_ids].sum()) if south_ids else 0.0
    south_pressure_gain=float(cfg_local.get('south_cluster_pressure_gain',1.0))
    south_maxpressure=float(cfg_local.get('south_cluster_max_pressure',3.0))
    south_interface_blocks=sum(1 for (i,j),_ in blocks if (i in south_set)!=(j in south_set))
    edge_scale=float(np.median([np.linalg.norm(P0[a]-P0[b]) for es in pair_edges.values() for a,b in es])) if blocks else 1.0
    max_delta=edge_scale*float(cfg_local.get('local_max_move_ratio',.28))
    print('south cluster towns',sorted(f\"{towns[i]['county']}|{towns[i]['town']}\" for i in south_ids),'interfaceBlocks',south_interface_blocks,'gain',south_pressure_gain,'maxPressure',south_maxpressure,flush=True)
"""
if old not in src:
    raise RuntimeError('v8 could not locate v7 block setup')
src = src.replace(old, new, 1)

old = """    accepted_moves=0;accepted_iters=0
    for sweep in range(sweeps):
"""
new = """    accepted_moves=0;accepted_iters=0;south_interface_accepts=0
    south_ratio=((curA[south_ids].sum()/max(curA.sum(),1e-15))/max(south_target_share,1e-15)) if south_ids else 1.0
    for sweep in range(sweeps):
"""
if old not in src:
    raise RuntimeError('v8 could not locate v7 accepted-move setup')
src = src.replace(old, new, 1)

old = """        order=sorted(blocks,key=lambda item:abs(curE[item[0][0]]-curE[item[0][1]]),reverse=True)
        sweep_accept=0;score_start=score
        for (i,j),es in order:
            dp=float(np.clip(curE[i]-curE[j],-maxpressure,maxpressure))
            if abs(dp)<1e-5:continue
"""
new = """        def pressure_for_pair(item):
            (i,j),_=item
            raw=float(curE[i]-curE[j])
            cross=(i in south_set)!=(j in south_set)
            if cross and south_ids:
                sshare=float(curA[south_ids].sum()/max(curA.sum(),1e-15))
                sratio=sshare/max(south_target_share,1e-15)
                sgap=float(np.log(max(sratio,1e-15)))
                raw += south_pressure_gain*sgap*(1.0 if i in south_set else -1.0)
            limit=south_maxpressure if cross else maxpressure
            return float(np.clip(raw,-limit,limit))
        order=sorted(blocks,key=lambda item:abs(pressure_for_pair(item)),reverse=True)
        sweep_accept=0;sweep_south_accept=0;score_start=score
        for (i,j),es in order:
            cross_south=(i in south_set)!=(j in south_set)
            dp=pressure_for_pair(((i,j),es))
            if abs(dp)<1e-5:continue
"""
if old not in src:
    raise RuntimeError('v8 could not locate v7 pressure ordering block')
src = src.replace(old, new, 1)

old = """                    accepted=True;sweep_accept+=1;accepted_moves+=1
                    break
"""
new = """                    accepted=True;sweep_accept+=1;accepted_moves+=1
                    if cross_south:
                        sweep_south_accept+=1;south_interface_accepts+=1
                    break
"""
if old not in src:
    raise RuntimeError('v8 could not locate v7 accepted block update')
src = src.replace(old, new, 1)

old = """        _,_,mm,xx=score_from_area(curA)
        if sweep%report_every==0:
            print('local sweep',sweep,'accepted',sweep_accept,'mean',mm,'max',xx,'score2',score,'nantou',nfactor(P),flush=True)
"""
new = """        _,_,mm,xx=score_from_area(curA)
        south_ratio=((curA[south_ids].sum()/max(curA.sum(),1e-15))/max(south_target_share,1e-15)) if south_ids else 1.0
        if sweep%report_every==0:
            print('local sweep',sweep,'accepted',sweep_accept,'southAccepted',sweep_south_accept,'mean',mm,'max',xx,'score2',score,'nantou',nfactor(P),'southRatio',south_ratio,flush=True)
"""
if old not in src:
    raise RuntimeError('v8 could not locate v7 sweep report block')
src = src.replace(old, new, 1)

src = src.replace("'method':'adaptive-shared-control-local-boundary-v7'", "'method':'adaptive-shared-control-south-cluster-v8'", 1)
src = src.replace(
    "'residualAcceptedIterations':accepted_iters,'residualAcceptedMoves':accepted_moves",
    "'residualAcceptedIterations':accepted_iters,'residualAcceptedMoves':accepted_moves,'southInterfaceAcceptedMoves':south_interface_accepts,'southClusterRatio':south_ratio",
    1,
)

ns = {'__name__': '__main__', '__file__': str(BASE)}
exec(compile(src, str(BASE), 'exec'), ns, ns)
