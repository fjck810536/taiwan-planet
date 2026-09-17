#!/usr/bin/env python3
"""v6: v5 plus topology-safe adaptive repair of simplified TopoJSON arcs.

RDP is useful for a small control mesh but is not topology preserving.  Rather
than globally lowering tolerance, run the normal simplification first, detect
invalid administrative polygons in the projected control geometry, and restore
all source TopoJSON arcs used by those polygons to their original point lists.
Because TopoJSON arcs are shared objects, both sides of every restored boundary
receive exactly the same vertices.
"""
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
V5 = HERE / 'solve_mesh_v5.py'
text = V5.read_text()
marker = "\nns = {'__name__': '__main__', '__file__': str(BASE)}"
pos = text.rfind(marker)
if pos < 0:
    raise RuntimeError('v6 could not locate v5 execution boundary')

# Execute only v5's overlay-building portion.  This produces its transformed
# v2 source in `src` without running main().
env = {'__name__': 'v5_overlay_builder', '__file__': str(V5)}
exec(compile(text[:pos], str(V5), 'exec'), env, env)
src = env['src']; BASE = env['BASE']

adaptive = r'''    tol=float(pol['solver'].get('control_simplify_tolerance',0.006))
    raw_count=sum(len(a) for a in full_arcs)
    def simplify_one(a):
        xy=np.array([source_xy(clon,clat,*p)*scale for p in a]);idx=rdp_indices(xy,tol);return [a[i] for i in idx]
    simp=[simplify_one(a) for a in full_arcs]
    restored_arcs=set();repair_history=[]
    for repair_pass in range(8):
        bad=[];need=set()
        for g in obj['geometries']:
            pr=g.get('properties',{});county=clean(pr.get('COUNTYNAME') or pr.get('countyname'));town=clean(pr.get('TOWNNAME') or pr.get('townname'))
            if town in OFFSHORE:continue
            for pi,pref in enumerate(geom_polys(g)):
                rings=[ring_from_refs(simp,refs) for refs in pref]
                if not rings or not mainland(rings[0]):continue
                try:
                    xy_rings=[[tuple(source_xy(clon,clat,*q)*scale) for q in ring] for ring in rings]
                    poly=Polygon(xy_rings[0],xy_rings[1:])
                    valid=poly.is_valid
                except Exception:
                    valid=False
                if not valid:
                    bad.append(f"{county}|{town}|poly{pi}")
                    for refs in pref:
                        for r in refs:need.add(r if r>=0 else -r-1)
        new_arcs=need-restored_arcs
        repair_history.append({'pass':repair_pass,'invalid':bad,'restore':len(new_arcs)})
        print('topology repair',repair_pass,'invalid',bad,'restoreArcs',len(new_arcs),flush=True)
        if not bad:break
        if not new_arcs:
            print('warning topology repair cannot resolve remaining source polygons',bad,flush=True);break
        for ai in new_arcs:simp[ai]=full_arcs[ai]
        restored_arcs.update(new_arcs)
    control_count=sum(len(a) for a in simp)
    print('arc points raw',raw_count,'control',control_count,'tol',tol,'restoredArcs',len(restored_arcs),flush=True)
'''
src, n = re.subn(
    r"    tol=float\(pol\['solver'\]\.get\('control_simplify_tolerance',0\.006\)\)\n    simp=\[\]; raw_count=0; control_count=0\n    for a in full_arcs:\n        raw_count\+=len\(a\);xy=np\.array\(\[source_xy\(clon,clat,\*p\)\*scale for p in a\]\);idx=rdp_indices\(xy,tol\);sa=\[a\[i\] for i in idx\];simp\.append\(sa\);control_count\+=len\(sa\)\n    print\('arc points raw',raw_count,'control',control_count,'tol',tol,flush=True\)\n",
    adaptive,
    src,
    count=1,
)
if n != 1:
    raise RuntimeError('v6 overlay could not replace control-mesh simplification block')

src = src.replace("'method':'coarse-shared-control-edge-pressure-v5'", "'method':'adaptive-shared-control-edge-pressure-v6'", 1)

ns = {'__name__': '__main__', '__file__': str(BASE)}
exec(compile(src, str(BASE), 'exec'), ns, ns)
