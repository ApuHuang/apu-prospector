// 側欄面板點標題就能收合；整個控制區也可以藏起來，讓天圖佔滿畫面。狀態記在瀏覽器裡。
// 獨立成小檔案先執行，不用等 app.js 把天圖程式（約 2.4 MB）載完，畫面才不會先全開再收起來。

const KEY = "apu-prospector-panels-v1";

// { 面板名稱: true 表示收起, sidebar: true 表示整個控制區藏起來 }
let closed = {};
try {
  closed = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
} catch {
  closed = {};
}

function store() {
  try {
    localStorage.setItem(KEY, JSON.stringify(closed));
  } catch {
    // 無痕模式等情況存不了，不影響使用
  }
}

for (const panel of document.querySelectorAll("details.panel")) {
  const name = panel.dataset.panel;
  if (closed[name]) panel.open = false;
  panel.addEventListener("toggle", () => {
    closed[name] = !panel.open;
    store();
  });
}

const app = document.querySelector("#app");
const btn = document.querySelector("#btn-controls");

function setControlsHidden(hidden) {
  app.classList.toggle("controls-hidden", hidden);
  btn.textContent = hidden ? "顯示控制" : "隱藏控制";
  btn.setAttribute("aria-pressed", String(hidden));
}

setControlsHidden(!!closed.sidebar);
btn.addEventListener("click", () => {
  closed.sidebar = !app.classList.contains("controls-hidden");
  setControlsHidden(closed.sidebar);
  store();
});
