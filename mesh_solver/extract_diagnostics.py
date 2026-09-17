#!/usr/bin/env python3
"""Extract a small, reviewable diagnostic snapshot from generated/mesh.json.

The generated mesh is intentionally large and compact.  This script also
prints a shallow schema probe when a solver version changes its output shape,
so diagnostics do not silently depend on a stale mesh schema.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
MESH = HERE / "generated" / "mesh.json"
OUT = HERE / "generated" / "diagnostics.json"

GROUPS: dict[str, list[tuple[str, str]]] = {
    "keelung": [
        ("基隆市", "仁愛區"), ("基隆市", "信義區"), ("基隆市", "中正區"),
        ("基隆市", "中山區"), ("基隆市", "安樂區"), ("基隆市", "暖暖區"),
        ("基隆市", "七堵區"),
    ],
    "north_coast": [
        ("新北市", "萬里區"), ("新北市", "金山區"), ("新北市", "石門區"),
        ("新北市", "三芝區"), ("新北市", "淡水區"), ("新北市", "貢寮區"),
        ("新北市", "瑞芳區"), ("新北市", "汐止區"),
    ],
    "taipei_core_no_gain": [
        ("台北市", "大同區"), ("台北市", "中山區"), ("台北市", "中正區"),
        ("台北市", "大安區"), ("台北市", "松山區"), ("台北市", "信義區"),
    ],
    "taipei_north": [
        ("台北市", "北投區"), ("台北市", "士林區"), ("台北市", "內湖區"),
    ],
    "hengchun_south": [
        ("屏東縣", "恆春鎮"), ("屏東縣", "滿州鄉"), ("屏東縣", "車城鄉"),
        ("屏東縣", "牡丹鄉"), ("屏東縣", "枋山鄉"),
    ],
    "east_central_interior": [
        ("花蓮縣", "秀林鄉"), ("花蓮縣", "萬榮鄉"), ("花蓮縣", "卓溪鄉"),
        ("台東縣", "海端鄉"), ("台東縣", "延平鄉"),
    ],
    "west_inflated_belt": [
        ("高雄市", "路竹區"), ("高雄市", "湖內區"), ("高雄市", "岡山區"),
        ("台南市", "仁德區"), ("台南市", "歸仁區"), ("台南市", "北區"),
        ("台南市", "安南區"), ("台南市", "七股區"),
    ],
}


def schema_probe(data: dict) -> dict:
    out = {}
    for key, value in data.items():
        info = {"type": type(value).__name__}
        if isinstance(value, (list, dict)):
            info["length"] = len(value)
        if isinstance(value, dict):
            info["keys"] = list(value.keys())[:40]
        elif isinstance(value, list) and value and isinstance(value[0], dict):
            info["firstItemKeys"] = list(value[0].keys())[:40]
        out[key] = info
    return out


def find_report(data: dict) -> tuple[str, list[dict]] | None:
    """Find a town-level area report in current or nested solver schemas."""
    candidates: list[tuple[str, list[dict]]] = []

    def walk(value, path: str, depth: int = 0) -> None:
        if depth > 3:
            return
        if isinstance(value, list):
            if value and isinstance(value[0], dict):
                keys = set(value[0])
                if {"county", "town"} <= keys and (
                    {"target", "actual"} <= keys
                    or {"targetFactor", "actualFactor"} <= keys
                ):
                    candidates.append((path, value))
            return
        if isinstance(value, dict):
            for k, v in value.items():
                # Do not recurse into the huge numerical geometry arrays.
                if k in {"vertices", "triangles"}:
                    continue
                walk(v, f"{path}.{k}" if path else k, depth + 1)

    walk(data, "")
    return candidates[0] if candidates else None


def clean_row(row: dict) -> dict:
    target = float(row.get("target", row.get("targetFactor")))
    actual = float(row.get("actual", row.get("actualFactor")))
    ratio = float(row.get("ratio", row.get("actualToTarget", actual / target if target else math.inf)))
    return {
        "county": row["county"],
        "town": row["town"],
        "target": target,
        "actual": actual,
        "ratio": ratio,
        "logGap": math.log(max(ratio, 1e-15)),
        "relativeGapPct": (ratio - 1.0) * 100.0,
    }


def main() -> None:
    data = json.loads(MESH.read_text())
    probe = schema_probe(data)
    print("mesh schema", json.dumps(probe, ensure_ascii=False))

    found = find_report(data)
    if found is None:
        raise RuntimeError("No town-level target/actual report found; see mesh schema probe above")
    report_path, raw_report = found
    print("area report path", report_path, "rows", len(raw_report))
    report = [clean_row(r) for r in raw_report]
    by_key = {(r["county"], r["town"]): r for r in report}

    groups = {}
    missing = []
    for name, keys in GROUPS.items():
        rows = []
        for key in keys:
            row = by_key.get(key)
            if row is None:
                missing.append({"group": name, "county": key[0], "town": key[1]})
            else:
                rows.append(row)
        groups[name] = rows

    over = sorted(report, key=lambda r: r["ratio"], reverse=True)[:20]
    under = sorted(report, key=lambda r: r["ratio"])[:20]
    closest = sorted(report, key=lambda r: abs(r["logGap"]))[:20]

    within = {}
    for pct in (5, 10, 20, 35, 50):
        lo, hi = 1 - pct / 100, 1 + pct / 100
        within[str(pct)] = sum(lo <= r["ratio"] <= hi for r in report)

    output = {
        "meshMeta": data.get("meta", {}),
        "solverDiagnostics": data.get("diagnostics", {}),
        "meshSchema": probe,
        "areaReportPath": report_path,
        "townCount": len(report),
        "withinTargetPct": within,
        "observationGroups": groups,
        "topOverTarget": over,
        "topUnderTarget": under,
        "closestToTarget": closest,
        "missingObservationRows": missing,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {OUT}")
    print("solverDiagnostics", json.dumps(output["solverDiagnostics"], ensure_ascii=False))
    for name, rows in groups.items():
        print(f"[{name}]")
        for r in rows:
            print(
                f"  {r['county']}|{r['town']} target={r['target']:.4f} "
                f"actual={r['actual']:.4f} ratio={r['ratio']:.4f}"
            )


if __name__ == "__main__":
    main()
