// 側欄面板點標題就能收合，收合狀態記在瀏覽器裡。
// 獨立成小檔案先執行，不用等 app.js 把天圖程式（約 2.4 MB）載完，畫面才不會先全開再收起來。

const KEY = "apu-prospector-panels-v1";

let closed = {};
try {
  closed = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
} catch {
  closed = {};
}

for (const panel of document.querySelectorAll("details.panel")) {
  const name = panel.dataset.panel;
  if (closed[name]) panel.open = false;
  panel.addEventListener("toggle", () => {
    closed[name] = !panel.open;
    try {
      localStorage.setItem(KEY, JSON.stringify(closed));
    } catch {
      // 無痕模式等情況存不了，不影響使用
    }
  });
}
