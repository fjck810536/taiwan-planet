// Taiwan Planet v1 — the only intentionally open cartogram tuning surface.
//
// These values affect only offshore-island placement/scale on the FINAL sphere.
// They do not participate in the mainland solver, pole definition, camera,
// compass, labels, or gesture system.
//
// radiusDeg   = visual angular radius of the island patch
// bearingDeg  = direction from the reference mainland point (0=N, 90=E)
// distanceDeg = angular distance from the reference mainland point
export const OFFSHORE_GROUPS = [
  { id: "澎湖", label: "澎湖", county: "澎湖縣", towns: null,
    reference: [120.18, 23.50], bearingDeg: 270, distanceDeg: 42, radiusDeg: 54, labelOffset: [0, -18] },
  { id: "金門", label: "金門", county: "金門縣", towns: null,
    reference: [120.25, 24.35], bearingDeg: 255, distanceDeg: 68, radiusDeg: 50, labelOffset: [0, -18] },
  { id: "馬祖", label: "馬祖", county: "連江縣", towns: null,
    reference: [121.05, 25.18], bearingDeg: 315, distanceDeg: 58, radiusDeg: 48, labelOffset: [0, -18] },
  { id: "綠島", label: "綠島", county: "台東縣", towns: new Set(["綠島鄉"]),
    reference: [121.10, 22.78], bearingDeg: 90, distanceDeg: 38, radiusDeg: 4, labelOffset: [0, -18] },
  { id: "蘭嶼", label: "蘭嶼", county: "台東縣", towns: new Set(["蘭嶼鄉", "兰嶼鄉"]),
    reference: [121.08, 22.38], bearingDeg: 125, distanceDeg: 58, radiusDeg: 6, labelOffset: [0, -18] },
  { id: "小琉球", label: "小琉球", county: "屏東縣", towns: new Set(["琉球鄉"]),
    reference: [120.50, 22.47], bearingDeg: 245, distanceDeg: 28, radiusDeg: 3, labelOffset: [0, -18] }
];
