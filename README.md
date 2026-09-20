# Taiwan Planet

一顆把台灣行政區拓撲重新投影到球面的互動小行星。

## 正式版本

`main` 是唯一權威版本（canonical version）。

目前正式視覺基準來自 commit `08e59f4c36899a3cf818d0a671f58dc78fe3c06c`，之後的 main commit 只做結構清理與維護，除非 commit 訊息另有說明。

## 目前設計

- 台北六區（大同、中山、中正、大安、松山、信義）構成北極核心。
- 本島與行政區經離線 solver 重新投影到球面。
- 澎湖、金門、馬祖、綠島、蘭嶼、小琉球使用獨立的球面 cartogram layer。
- 行政區標籤使用 HTML overlay，旋轉時保持正向。
- 單指拖曳旋轉。
- 雙指縮放／扭轉。
- iOS Safari 的頁面縮放、長按選單、文字選取等原生干擾手勢被鎖定。
- 沒有行政區點擊、選取或資訊面板。

## 正式 runtime

玩家端實際需要：

- `index.html`
- `feedback/ultralite.js`
- `feedback/palette.js`
- `baked/meta.json`
- `baked/map.bin`

## Bake pipeline

以下檔案只用於重新產生球面幾何：

- `feedback/geo.js`
- `feedback/solver.js`
- `feedback/solver_v2.js`
- `scripts/bake-ultralite.mjs`
- `.github/workflows/bake-ultralite.yml`

修改 solver 或離島 cartogram 參數後，GitHub Actions 會在 `main` 上重新產生 `baked/map.bin` 與 `baked/meta.json`。

## 操作

- **單指拖曳**：旋轉行星
- **雙指**：縮放／扭轉

除此之外沒有可點擊 UI。
