"use strict";
// 농촌진흥청 데이터 (NCPMS 병해충 · PSIS 등록농약)
// PC: exe가 키로 전체를 내려받아 보관 / 휴대폰: PC에서 내보낸 DB 파일을 가져와 사용
window.RDA = (() => {
  let db = null;          // {syncedAt, crops, pests, pestiCols, pesti, details}
  let byCrop = new Map(); // crop -> [pest]
  let pestiByCrop = new Map(); // crop -> [row]
  let mode = "mobile", idb = null;
  const C = {}; // 열 이름 → 인덱스

  const norm = s => String(s || "").replace(/[\s()·,]/g, "").toLowerCase();
  const PESTI_LABEL = { cropName: "작물", diseaseWeedName: "병해충·잡초", useName: "용도", pestiKorName: "품목명", pestiBrandName: "상표명", compName: "회사", pestiUse: "사용방법", dilutUnit: "희석배수(10a당)", useSuittime: "사용시기", useNum: "사용횟수", indictSymbl: "작용기작", engName: "주성분" };
  const DETAIL_LABEL = {
    cropName: "작물", sickNameKor: "병명", sickNameEng: "영문명", sickNameChn: "한자명", insectKorName: "해충명", speciesName: "학명", insectSpeciesKor: "학명",
    symptoms: "증상", developmentCondition: "발생환경", infectionRoute: "전염경로", preventionMethod: "방제방법",
    biologyPrvnbeMth: "생물적 방제", chemicalPrvnbeMth: "화학적 방제", ecologyInfo: "생태", damageInfo: "피해", preventMethod: "방제방법",
    stleInfo: "형태", qrantInfo: "검역정보", generalInfo: "일반정보", etc: "기타",
  };

  function index() {
    byCrop = new Map(); pestiByCrop = new Map();
    if (!db) return;
    (db.pestiCols || []).forEach((c, i) => { C[c] = i; });
    for (const p of db.pests || []) { const k = norm(p.crop); if (!byCrop.has(k)) byCrop.set(k, []); byCrop.get(k).push(p); }
    for (const r of db.pesti || []) { const k = norm(r[C.cropName]); if (!pestiByCrop.has(k)) pestiByCrop.set(k, []); pestiByCrop.get(k).push(r); }
  }

  function idbReq(fn, modeRW = "readonly") {
    return new Promise((res, rej) => {
      const t = idb.transaction("meta", modeRW); const q = fn(t.objectStore("meta"));
      t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("저장공간 부족"));
    });
  }

  async function init(opts) {
    mode = opts.mode; idb = opts.idb || null;
    try {
      if (mode === "pc") { const r = await fetch("/api/rda/db"); const j = await r.json(); db = j && j.syncedAt !== undefined ? j : null; }
      else if (idb) db = (await idbReq(st => st.get("rdadb"))) || null;
    } catch (e) { db = null; }
    index();
    return !!db;
  }

  // 앱에 내장된 농진청 자료(data/rda_db.json)를 자동으로 넣음. 사용자가 직접 받은 더 최신 자료는 덮어쓰지 않음
  async function loadBundled(onProgress) {
    let meta;
    try { const r = await fetch("data/rda_meta.json", { cache: "no-cache" }); if (!r.ok) return false; meta = await r.json(); } catch (e) { return false; }
    if (!meta || !meta.syncedAt) return false;
    if (db && db.syncedAt && db.syncedAt >= meta.syncedAt) return false;
    if (db && !db.bundled && db.syncedAt) return false;
    onProgress && onProgress(meta);
    const r = await fetch("data/rda_db.json", { cache: "no-cache" }); if (!r.ok) return false;
    const text = await r.text();
    const j = JSON.parse(text); j.bundled = true;
    if (db && db.details) j.details = Object.assign({}, db.details, j.details || {});
    await importFile(JSON.stringify(j));
    return true;
  }

  async function importFile(text) {
    const j = JSON.parse(text);
    if (!Array.isArray(j.crops) || !Array.isArray(j.pesti)) throw new Error("농진청 DB 파일이 아니에요");
    if (mode === "pc") {
      const r = await fetch("/api/rda/db", { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
      const x = await r.json(); if (!r.ok) throw new Error(x.error || "가져오기 실패");
    } else await idbReq(st => st.put(j, "rdadb"), "readwrite");
    db = j; index();
    return stats();
  }

  const stats = () => db ? { syncedAt: db.syncedAt, crops: db.crops.length, pests: db.pests.length, pesti: db.pesti.length } : null;
  const crops = () => db ? db.crops : [];

  function cropKeyMatch(crop) {
    const k = norm(crop); if (!k) return [];
    const keys = [...new Set([...byCrop.keys(), ...pestiByCrop.keys()])];
    const exact = keys.filter(x => x === k);
    return exact.length ? exact : keys.filter(x => x.includes(k) || k.includes(x));
  }

  // 작목의 병해충 이름 목록 (NCPMS 목록 + 농약 등록 대상)
  function pestNames(crop) {
    const out = new Map();
    for (const ck of cropKeyMatch(crop)) {
      for (const p of byCrop.get(ck) || []) out.set(p.name, p.t === "충" ? "해충" : "병해");
      for (const r of pestiByCrop.get(ck) || []) { const n = r[C.diseaseWeedName]; if (n && !out.has(n)) out.set(n, "" + (r[C.useName] || "농약 등록")); }
    }
    return [...out.entries()];
  }

  function findPest(crop, name) {
    const n = norm(name); if (!n) return null;
    let best = null;
    for (const ck of cropKeyMatch(crop)) for (const p of byCrop.get(ck) || []) {
      const pn = norm(p.name);
      if (pn === n) return p;
      if (!best && (pn.includes(n) || n.includes(pn))) best = p;
    }
    if (!best && db) best = db.pests.find(p => norm(p.name) === n) || null;
    return best;
  }

  function search(q, limit = 120) {
    if (!db) return [];
    const n = norm(q); if (!n) return [];
    return db.pests.filter(p => norm(p.name).includes(n) || norm(p.crop).includes(n)).slice(0, limit);
  }

  async function detail(p) {
    const ck = (p.t === "충" ? "insect:" : "sick:") + p.key;
    if (db?.details?.[ck]) return db.details[ck];
    if (mode !== "pc") throw new Error("휴대폰에서는 PC에서 한 번 조회한 상세정보만 볼 수 있어요. (PC에서 조회 후 DB 파일을 다시 옮기세요)");
    const r = await fetch(`/api/rda/detail?t=${p.t === "충" ? "insect" : "sick"}&key=${encodeURIComponent(p.key)}`);
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "조회 실패");
    if (db) { db.details = db.details || {}; db.details[ck] = j; }
    return j;
  }

  // 등록농약: 내려받은 데이터에서 찾고, 없으면 PC는 실시간 조회
  async function pesticides(crop, pest) {
    const np = norm(pest);
    let rows = [];
    for (const ck of cropKeyMatch(crop)) rows.push(...(pestiByCrop.get(ck) || []));
    if (np) rows = rows.filter(r => { const d = norm(r[C.diseaseWeedName]); return d.includes(np) || (np.length >= 2 && np.includes(d) && d.length >= 2); });
    { const seen = new Set(); rows = rows.filter(r => { const k = r.join("|"); if (seen.has(k)) return false; seen.add(k); return true; }); }
    if (rows.length || mode !== "pc") return { cols: db?.pestiCols || [], rows, live: false };
    const r = await fetch(`/api/rda/pesticides?crop=${encodeURIComponent(crop)}&pest=${encodeURIComponent(pest || "")}`);
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "조회 실패");
    return { cols: j.cols, rows: j.rows, live: true };
  }

  function cleanText(v) {
    return String(v || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
  }
  function pick(d, keys) {
    const f = (d.fields || []).filter(([k]) => keys.includes(k)).map(([, v]) => cleanText(v)).filter(Boolean);
    return f.join("\n\n");
  }
  function toForm(d) {
    return {
      symptoms: pick(d, ["symptoms", "damageInfo"]),
      diagnosis: pick(d, ["developmentCondition", "infectionRoute", "ecologyInfo"]),
      remedy: pick(d, ["preventionMethod", "preventMethod", "biologyPrvnbeMth", "chemicalPrvnbeMth"]),
    };
  }

  return { init, loadBundled, importFile, stats, crops, pestNames, findPest, search, detail, pesticides, cleanText, toForm, PESTI_LABEL, DETAIL_LABEL, get loaded() { return !!db; }, get mode() { return mode; } };
})();
