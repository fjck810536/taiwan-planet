# mesh_solver

這條線是 Taiwan Planet 的 **離線共享邊界面積約束求解器**，用來取代不會穩定收斂的 Gaussian feedback warp。

## 原則

- `feedback/` 保留作為對照組，不修改。
- 瀏覽器／iPhone **不跑 nonlinear solve**；只載入 `generated/mesh.json`。
- 同一條行政界線使用同一組 vertex id，因此相鄰行政區不會因各自縮放而裂開。
- 南投每個鄉鎮的 design target 是原相對面積的 `0.35`。
- 南投直接相鄰縣市先設 `0.90`。
- 吐出的 design area：北端 40%、恆春端 25%、次外圍海岸 25%、一般海岸 10%。
- 台北核心六區不接收額外面積；北投、士林、內湖可接收；基隆及基隆周邊有額外權重。
- 每個 iteration 都直接以 **球面實際 area share / target area share** 回饋，不再把 target 轉成 Gaussian seed。
- proposed step 若造成任何既有 triangulation 翻面，會自動縮小 step；115° 是硬半徑上限，不在每輪重新 normalize。

## Pipeline

```text
towns-10t TopoJSON
  -> decode shared TopoJSON arcs
  -> one shared vertex graph
  -> initial 115° stereographic positions
  -> fixed polygon triangulation
  -> target-area policy
  -> iterative shared-boundary relaxation
  -> flip guard + displacement smoothing
  -> generated/mesh.json
  -> mesh_solver/index.html viewer
```

## 本機執行

```bash
python -m pip install numpy shapely
python mesh_solver/solve_mesh.py
```

輸出：`mesh_solver/generated/mesh.json`

GitHub Actions 也會在 solver / policy / viewer 變更時重算並把輸出 commit 回 repository。
