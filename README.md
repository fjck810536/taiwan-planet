# Taiwan Planet

用於解決台灣人有時候搞不清楚所謂「南部、北部」的北本位地圖。

**一鍵知道北部在哪。**

## [▶ 直接玩 Taiwan Planet](https://fjck810536.github.io/taiwan-planet/)

手機可直接開啟。以 iOS Safari portrait-first 設計。

## v1 定案

`main` 是唯一權威版本（canonical version）。本島拓撲、球面投影、南北極、鏡頭、手勢、標籤與指北針視為 v1 核心定案。

目前只刻意保留 **離島 cartogram** 的尺寸與位置調整空間；之後若要微調澎湖、金門、馬祖、綠島、蘭嶼或小琉球，只改：

`config/offshore-cartogram.mjs`

其中：

- `radiusDeg`：島在球面上的視覺大小
- `bearingDeg`：相對參考點的方向
- `distanceDeg`：相對參考點的球面距離

修改後 GitHub Actions 會自動重新 bake 正式幾何。

## 操作

- **單指拖曳**：旋轉星球
- **雙指 pinch**：縮放
- **雙指扭轉**：改變鏡頭 roll
- **右下紅白指北針**：顯示畫面中心沿球面最短路徑通往北極的方向
- **點一下指北針**：保留目前位置與縮放，把北方平滑對齊螢幕正上方
- 接近北極時，因局部「北方」逐漸失去定義，指北針會開始不穩並在極點高速亂轉

## 世界定義

北極由台北市 **大同、中山、中正、大安、松山、信義** 六區的球面中心共同定義；南極是其球體直徑的正對面。

澎湖、金門、馬祖、綠島、蘭嶼、小琉球是獨立的 final-sphere cartogram layer，不參與本島 solver。

## Runtime

玩家端正式 runtime：

- `index.html`
- `feedback/ultralite.js`
- `feedback/palette.js`
- `baked/meta.json`
- `baked/map.bin`

重新 bake 才需要：

- `config/offshore-cartogram.mjs`
- `feedback/geo.js`
- `feedback/solver.js`
- `feedback/solver_v2.js`
- `scripts/bake-ultralite.mjs`
- `.github/workflows/bake-ultralite.yml`

正式入口：<https://fjck810536.github.io/taiwan-planet/>
