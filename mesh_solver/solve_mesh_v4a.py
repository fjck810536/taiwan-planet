#!/usr/bin/env python3
"""v4 visual-control experiment: only replace county-level Nantou adjacency targets with exact town adjacency.

Everything else is executed from the historical solve_mesh_v4.py unchanged.
"""
from pathlib import Path

BASE = Path(__file__).with_name('solve_mesh_v4.py')
code = BASE.read_text()

marker = 'src = src.replace("anchors={north,south,east,west}", "anchors=set()", 1)\n'
patch = r"""

# v4a ONLY: replace v2's county-level Nantou-adjacent target proxy with the
# exact township adjacency graph derived from shared mesh edges.
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
    print('v4a direct Nantou neighbor towns',sorted(f"{towns[i]['county']}|{towns[i]['town']}" for i in nantou_adj_ids),flush=True)
'''
src, n = re.subn(
    r"    factors=np\.ones\(len\(towns\)\)\n    for i,t in enumerate\(towns\):\n        if t\['county'\]==NANTOU:factors\[i\]=pol\['nantou_factor'\]\n        elif t\['county'\] in NANTOU_ADJ:factors\[i\]=pol\['nantou_adjacent_factor'\]\n",
    target_graph,
    src,
    count=1,
)
if n != 1:
    raise RuntimeError('v4a could not replace county-level Nantou adjacency targets')
"""

if marker not in code:
    raise RuntimeError('v4a could not find v4 injection marker')
code = code.replace(marker, marker + patch, 1)

ns = {'__name__': '__main__', '__file__': str(BASE)}
exec(compile(code, str(BASE), 'exec'), ns, ns)
