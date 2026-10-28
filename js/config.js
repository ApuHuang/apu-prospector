// 場地、器材、圖層的預設值。使用者在畫面上改過的會存進 localStorage 蓋掉這裡。

// 第一次開啟時的地點；每個人可以在「今晚可見度 → 觀測地點」改成自己的
export const DEFAULT_SITE = {
  name: "嘉義六腳",
  lat: 23.49, // 公開版只到鄉鎮精度（約 1 km），實際場地請在畫面上改
  lon: 120.29, // 東經為正
  tzHours: 8,
  moonDays: 5, // 滿月前後幾天不拍，0 = 不檢查
};

// 六腳場地的遮蔽設定（方位角由北往東量，from > to 表示跨過正北）；
// 「其他方向 30°」是規劃時自訂的預設值
export const DEFAULT_HORIZON = {
  segments: [
    { from: 135, to: 225, minAlt: 50 },
    { from: 225, to: 315, minAlt: 20 },
  ],
  defaultAlt: 30,
};

export const BASE_SURVEYS = [
  // mirror：法國 CDS 整個連不上時改讀的備用鏡像（不在 CDS 的才有用），見 app.js 的 setCdsDown
  { id: "CDS/P/DSS2/color", label: "DSS2 彩色（光學）", mirror: "https://stpubdata.s3.us-east-1.amazonaws.com/mast/skybackgrounds/DSSColor" },
  { id: "CDS/P/Mellinger/color", label: "Mellinger 彩色（大視野）" },
  { id: "CDS/P/PanSTARRS/DR1/color-z-zg-g", label: "Pan-STARRS（Dec > −30°）" },
];

// readout：滑鼠讀值與框內統計用的單位
export const OVERLAYS = [
  {
    key: "ha", group: "Hα 發射", label: "Hα 全天（Finkbeiner）", hips: "CDS/P/Finkbeiner",
    mirror: "https://skies.esac.esa.int/FinkbeinerHa",
    fmt: "fits", cmap: "prospector-ha", stretch: "log", min: 3, max: 800, opacity: 0.85,
    unit: "R", note: "VTSS + SHASSA + WHAM 合成，解析度約 6′，單位 Rayleigh",
  },
  {
    key: "vtss", group: "Hα 發射", label: "Hα VTSS（北天，較細）", hips: "CDS/P/VTSS/Ha",
    mirror: "https://skies.esac.esa.int/VTSSHa",
    fmt: "fits", cmap: "prospector-ha", stretch: "asinh", min: 0, max: 80, opacity: 0.85,
    unit: "", note: "只涵蓋約 1/3 天區（北天銀河），解析度約 1.6′",
  },
  {
    key: "iphas", group: "Hα 發射", label: "Hα IPHAS（北銀河面，高解析）", hips: "CDS/P/IPHAS/DR2/halpha",
    fmt: "png", cmap: "prospector-ha", stretch: "linear", min: 0, max: 255, opacity: 0.9,
    unit: "", note: "只有北天銀河面 |b| < 5°，解析度約 1″，可看到細節",
  },
  {
    // startUrl：先從這裡讀 properties、抓第一批切圖，Aladin 1 秒後才查 MocServer 換到最快的鏡像。
    // MocServer 上的主網址 cade.irap.omp.eu 從台灣連不上，不指定的話第一批切圖會一直卡在那裡（docs/load-speed.md）
    key: "iris", group: "塵埃 / IFN", label: "紅外 100µm（IRIS）", hips: "ov-gso/P/IRIS/4",
    startUrl: "https://alasky.cds.unistra.fr/IRAP/ov-gso_P_IRIS_4",
    fmt: "fits", cmap: "prospector-dust", stretch: "log", min: 0.5, max: 30, opacity: 0.8,
    unit: "MJy/sr", note: "IRAS 重處理，解析度約 4′，高銀緯處的亮度大致對應 IFN",
    validMin: -10, // 無資料區是 -32768
  },
  {
    key: "planck", group: "塵埃 / IFN", label: "Planck 857 GHz", hips: "CDS/P/PLANCK/R3/HFI857",
    fmt: "fits", cmap: "prospector-dust", stretch: "log", min: 0.5, max: 60, opacity: 0.8,
    unit: "MJy/sr", note: "冷塵埃，解析度約 5′",
  },
  {
    key: "sfd", group: "塵埃 / IFN", label: "E(B−V) 消光（SFD98）", hips: "ov-gso/P/EBV/SFD98",
    fmt: "fits", cmap: "prospector-dust", stretch: "sqrt", min: 0, max: 1, opacity: 0.8,
    unit: "mag", note: "塵埃柱密度換算的紅化量",
  },
];

export const PRESETS = {
  emission: { label: "Hα 發射星雲", base: "CDS/P/DSS2/color", layers: { ha: 0.85 }, catalogs: ["messier", "sh2", "lbn"] },
  ifn: { label: "IFN / 塵埃", base: "CDS/P/DSS2/color", layers: { iris: 0.8 }, catalogs: ["messier", "ldn", "barnard", "vdb"] },
  optical: { label: "純光學", base: "CDS/P/DSS2/color", layers: {}, catalogs: ["messier", "sh2", "lbn", "ldn", "vdb"] },
};

// [名稱, 感光元件寬 mm, 高 mm, 像素寬, 像素高, 像素 µm]
export const CAMERAS = [
  ["ZWO ASI2600MM/MC Pro", 23.5, 15.7, 6248, 4176, 3.76],
  ["ZWO ASI533MM/MC Pro", 11.31, 11.31, 3008, 3008, 3.76],
  ["ZWO ASI294MM/MC Pro", 19.1, 13.0, 4144, 2822, 4.63],
  ["ZWO ASI183MM/MC Pro", 13.2, 8.8, 5496, 3672, 2.4],
  ["ZWO ASI071MC Pro", 23.6, 15.6, 4944, 3284, 4.78],
  ["ZWO ASI1600MM Pro", 17.7, 13.4, 4656, 3520, 3.8],
  ["ZWO ASI585MC Pro", 11.2, 6.3, 3840, 2160, 2.9],
  ["ZWO ASI6200MM/MC Pro", 36.0, 24.0, 9576, 6388, 3.76],
  ["ZWO ASI2400MC Pro", 36.0, 24.0, 6072, 4042, 5.94],
  ["QHY268M/C", 23.5, 15.7, 6280, 4210, 3.76],
  ["QHY600M/C", 36.0, 24.0, 9576, 6388, 3.76],
];

// 相機型號是預設值，請在畫面上改成實際使用的
export const DEFAULT_RIGS = [
  {
    id: "A", name: "E-130D", enabled: true, color: "#4dabf7",
    focal: 430, camera: "ZWO ASI2600MM/MC Pro", sensorW: 23.5, sensorH: 15.7, pixelUm: 3.76,
    pa: 0, cols: 1, rows: 1, overlap: 0.15,
  },
  {
    id: "B", name: "RedCat 51", enabled: true, color: "#ffd43b",
    focal: 250, camera: "ZWO ASI2600MM/MC Pro", sensorW: 23.5, sensorH: 15.7, pixelUm: 3.76,
    pa: 0, cols: 1, rows: 1, overlap: 0.15,
  },
];

export const DEFAULT_VIEW = { ra: 329.0, dec: 58.0, fov: 18 };
