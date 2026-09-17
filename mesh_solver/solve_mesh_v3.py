#!/usr/bin/env python3
"""Experimental v3: run v2 with a radial Nantou preconditioner and displacement smoothing.
Kept as a small overlay until the controller is validated by Actions diagnostics.
"""
from pathlib import Path
import re

BASE = Path(__file__).with_name('solve_mesh_v2.py')
src = BASE.read_text()

radial = r'''    nids=[i for i,t in enumerate(towns) if t['county']==NANTOU];nvs=np.unique(np.concatenate([np.array(towns[i]['vids'],int) for i in nids]))
    def nfactor(Q):
        a=areas(Q);return (a[nids].sum()/a.sum())/(source[nids].sum()/source.sum())
    # Smooth radial diffeomorphism: r' = r * (1-a*exp(-(r/R)^2)).
    # For 0<=a<1 its radial derivative is positive, so the continuous map cannot fold.
    nc=P0[nvs].mean(0);nr=max(np.linalg.norm(P0[nvs]-nc,axis=1).max(),1e-9)
    R=nr*float(cfg.get('nantou_radial_radius_multiplier',3.0));maxamp=float(cfg.get('nantou_radial_max_amplitude',0.92))
    def radial_candidate(amp):
        V=P0-nc;rr=np.linalg.norm(V,axis=1);gain=1-amp*np.exp(-(rr/R)**2);Q=nc+V*gain[:,None]
        for v in anchors:Q[v]=P0[v]
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
    print('nantou radial amplitude',hi,'radius',R,'factor',nfactor(P),flush=True)
'''

src, n = re.subn(
    r"    nids=\[i for i,t in enumerate\(towns\) if t\['county'\]==NANTOU\].*?    print\('nantou hard final',nfactor\(P\),flush=True\)\n",
    radial,
    src,
    count=1,
    flags=re.S,
)
if n != 1:
    raise RuntimeError('v3 overlay could not replace Nantou hard-pass block')

old = """        lap=np.zeros_like(P)\n        for v,ns in enumerate(neigh):\n            if len(ns):lap[v]=P[ns].mean(0)-P[v]\n        D+=smooth*lap"""
new = """        disp=P-P0;lap=np.zeros_like(P)\n        for v,ns in enumerate(neigh):\n            if len(ns):lap[v]=disp[ns].mean(0)-disp[v]\n        D+=smooth*lap"""
if old not in src:
    raise RuntimeError('v3 overlay could not replace smoothing block')
src = src.replace(old, new, 1)
src = src.replace("'method':'coarse-shared-control-area-constraint'", "'method':'coarse-shared-control-radial-preconditioned'", 1)

ns = {'__name__': '__main__', '__file__': str(BASE)}
exec(compile(src, str(BASE), 'exec'), ns, ns)
