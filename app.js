"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DEFAULT_CENTER = [36.5, 127.8]; // 대한민국 중심
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_OPT = { maxZoom: 19, attribution: "&copy; OpenStreetMap" };

let records = [];
let editingId = null;
let existingPhotos = []; // 저장된 사진 파일명
let pendingPhotos = [];  // {blob, url, name}
let current = null;      // 상세보기 중인 기록
let currentAI = null;    // AI 추론 결과
const CAT_EM = {};
const CAT_LETTER = c => esc((c || "기타").slice(0, 1));
const SEV_EM = {};
const ST_EM = {};

function toast(msg, ms = 2500) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
async function api(url, opt = {}) {
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("오류 " + r.status));
  return j;
}
function pad(n) { return String(n).padStart(2, "0"); }
function nowLocal() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
const toInputDT = s => (s || "").replace(" ", "T");
const fromInputDT = s => { s = (s || "").replace("T", " "); return s.length === 16 ? s + ":00" : s; };

/* ---------- 저장소: PC(exe 서버) 또는 휴대폰(브라우저 내부 저장) ---------- */
const Server = {
  mode: "pc",
  list: () => api("/api/records"),
  async save(id, rec, blobs) {
    if (blobs.length) {
      const fd = new FormData(); blobs.forEach(p => fd.append("photos", p.blob, p.name));
      rec.photos.push(...((await api("/api/upload", { method: "POST", body: fd })).files || []));
    }
    const opt = { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rec) };
    return api(id ? "/api/records/" + id : "/api/records", opt);
  },
  remove: id => api("/api/records/" + id, { method: "DELETE" }),
  photo: n => "/photos/" + encodeURIComponent(n),
  reverse: (la, ln) => api(`/api/geo/reverse?lat=${la}&lng=${ln}`),
  search: q => api("/api/geo/search?q=" + encodeURIComponent(q)),
  backup: () => api("/api/backup"),
  importData: data => api("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
};
const Local = {
  mode: "mobile", db: null, urls: {},
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("pestwatch", 2);
      r.onupgradeneeded = () => {
        const d = r.result, has = n => d.objectStoreNames.contains(n);
        if (!has("records")) d.createObjectStore("records", { keyPath: "id" });
        if (!has("photos")) d.createObjectStore("photos");
        if (!has("meta")) d.createObjectStore("meta");
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const st = t.objectStore(store); let out;
      const q = fn(st); if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("저장공간 부족"));
    });
  },
  async list() {
    const recs = (await this.tx("records", "readonly", st => st.getAll())) || [];
    for (const r of recs) for (const p of r.photos || []) if (!this.urls[p]) {
      const b = await this.tx("photos", "readonly", st => st.get(p)); if (b) this.urls[p] = URL.createObjectURL(b);
    }
    return recs.sort((a, b) => (b.visitedAt || "").localeCompare(a.visitedAt || ""));
  },
  newId() { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(16).slice(2, 14)}`; },
  async save(id, rec, blobs) {
    for (const p of blobs) { const n = this.newId() + ".jpg"; await this.tx("photos", "readwrite", st => st.put(p.blob, n)); this.urls[n] = URL.createObjectURL(p.blob); rec.photos.push(n); }
    const now = fromInputDT(nowLocal());
    let old = null; if (id) old = await this.tx("records", "readonly", st => st.get(id));
    if (old) for (const p of old.photos || []) if (!rec.photos.includes(p)) await this.tx("photos", "readwrite", st => st.delete(p));
    const out = { ...rec, id: id || this.newId(), createdAt: old?.createdAt || now, updatedAt: now };
    await this.tx("records", "readwrite", st => st.put(out));
    return out;
  },
  async remove(id) {
    const old = await this.tx("records", "readonly", st => st.get(id));
    for (const p of old?.photos || []) await this.tx("photos", "readwrite", st => st.delete(p));
    await this.tx("records", "readwrite", st => st.delete(id));
  },
  photo(n) { return this.urls[n] || ""; },
  async nomi(u) { const r = await fetch(u, { headers: { "Accept-Language": "ko" } }); if (!r.ok) throw new Error("주소 조회 실패"); return r.json(); },
  reverse(la, ln) { return this.nomi(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=ko&lat=${la}&lon=${ln}`); },
  search(q) { return this.nomi("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=kr&accept-language=ko&q=" + encodeURIComponent(q)); },
  async backup() {
    const recs = (await this.tx("records", "readonly", st => st.getAll())) || []; const photos = {};
    for (const r of recs) for (const p of r.photos || []) { const b = await this.tx("photos", "readonly", st => st.get(p)); if (b) photos[p] = await blobToB64(b); }
    return { app: "pestwatch", version: 1, exportedAt: fromInputDT(nowLocal()), records: recs, photos };
  },
  async importData(data) {
    let added = 0, skipped = 0;
    for (const r of data.records || []) {
      if (await this.tx("records", "readonly", st => st.get(r.id))) { skipped++; continue; }
      for (const p of r.photos || []) if (data.photos?.[p]) await this.tx("photos", "readwrite", st => st.put(b64ToBlob(data.photos[p]), p));
      await this.tx("records", "readwrite", st => st.put(r)); added++;
    }
    return { added, skipped };
  },
};
/* ---------- 공유 저장소 (Supabase 무료) : 링크를 받은 사람 모두가 같은 기록을 저장·조회 ---------- */
const CLOUD_KEYS = { url: "pestwatch.cloudUrl", anon: "pestwatch.cloudAnon", code: "pestwatch.teamCode" };
const Cloud = {
  mode: "mobile", cloud: true,
  get cfg() { return { url: (localStorage.getItem(CLOUD_KEYS.url) || "").replace(/\/+$/, ""), anon: localStorage.getItem(CLOUD_KEYS.anon) || "", code: localStorage.getItem(CLOUD_KEYS.code) || "" }; },
  configured() { const c = this.cfg; return !!(c.url && c.anon && c.code); },
  async req(path, opt = {}) {
    const c = this.cfg;
    const headers = { apikey: c.anon, Authorization: "Bearer " + c.anon, "x-team-code": c.code, ...(opt.headers || {}) };
    let r;
    try { r = await fetch(c.url + "/rest/v1/" + path, { ...opt, headers }); }
    catch (e) { throw new Error("공유 저장소에 연결하지 못했어요. 인터넷 연결을 확인해 주세요."); }
    if (!r.ok) {
      const t = await r.text();
      if (/row-level security|42501|permission denied/i.test(t)) throw new Error("공유 암호가 틀렸어요.");
      if (r.status === 401 || /JWT|apikey|Invalid API key/i.test(t)) throw new Error("공유 저장소 주소나 키가 맞지 않아요. 설정을 확인해 주세요.");
      if (r.status === 404) throw new Error("공유 저장소에 표가 없어요. 설정용 SQL을 먼저 실행해 주세요.");
      throw new Error("공유 저장소 오류 (" + r.status + "): " + t.slice(0, 160));
    }
    const body = await r.text();
    return body ? JSON.parse(body) : null;
  },
  async check() {
    await this.req("records?select=id&limit=1");
    // 암호가 틀리면 읽기는 0건으로 보이므로, 쓰기로 확인
    await this.req("records", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id: "_check", data: { check: true } }]) });
    await this.req("records?id=eq._check", { method: "DELETE" });
  },
  async list() {
    let out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await this.req(`records?select=data&id=neq._check&order=updated_at.desc&offset=${from}&limit=1000`);
      out.push(...rows.map(r => r.data)); if (rows.length < 1000) break;
    }
    const need = [];
    for (const r of out) for (const p of r.photos || []) if (!Local.urls[p]) {
      const b = Local.db ? await Local.tx("photos", "readonly", st => st.get(p)) : null;
      if (b) Local.urls[p] = URL.createObjectURL(b); else need.push(p);
    }
    for (let i = 0; i < need.length; i += 20) {
      const part = need.slice(i, i + 20);
      const rows = await this.req("photos?select=name,data&name=in.(" + part.map(n => '"' + n.replace(/"/g, "") + '"').join(",") + ")");
      for (const x of rows) { const b = b64ToBlob(x.data); Local.urls[x.name] = URL.createObjectURL(b); if (Local.db) await Local.tx("photos", "readwrite", st => st.put(b, x.name)); }
    }
    return out.sort((a, b) => (b.visitedAt || "").localeCompare(a.visitedAt || ""));
  },
  async putPhoto(name, blob) {
    const small = await resizeImage(blob, 1280, true);
    await this.req("photos", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ name, data: await blobToB64(small) }]) });
    Local.urls[name] = URL.createObjectURL(small); if (Local.db) await Local.tx("photos", "readwrite", st => st.put(small, name));
  },
  async save(id, rec, blobs) {
    for (const p of blobs) { const n = Local.newId() + ".jpg"; await this.putPhoto(n, p.blob); rec.photos.push(n); }
    const now = fromInputDT(nowLocal());
    let old = null; if (id) { const r = await this.req("records?select=data&id=eq." + encodeURIComponent(id)); old = r[0]?.data || null; }
    const gone = (old?.photos || []).filter(p => !rec.photos.includes(p));
    const out = { ...rec, id: id || Local.newId(), createdAt: old?.createdAt || now, updatedAt: now };
    await this.req("records", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id: out.id, data: out, updated_at: new Date().toISOString() }]) });
    if (gone.length) await this.req("photos?name=in.(" + gone.map(n => '"' + n + '"').join(",") + ")", { method: "DELETE" }).catch(() => { });
    return out;
  },
  async remove(id) {
    const r = await this.req("records?select=data&id=eq." + encodeURIComponent(id)); const old = r[0]?.data;
    await this.req("records?id=eq." + encodeURIComponent(id), { method: "DELETE" });
    if (old?.photos?.length) await this.req("photos?name=in.(" + old.photos.map(n => '"' + n + '"').join(",") + ")", { method: "DELETE" }).catch(() => { });
  },
  // 농진청 중계 함수 (Supabase Edge Function 'rda')
  async rda(api, params) {
    const c = this.cfg;
    const q = new URLSearchParams({ api, ...params });
    let r;
    try { r = await fetch(`${c.url}/functions/v1/rda?${q}`, { headers: { apikey: c.anon, Authorization: "Bearer " + c.anon, "x-team-code": c.code } }); }
    catch (e) { throw new Error("농진청 중계에 연결하지 못했어요. 인터넷 연결을 확인하거나, 중계 함수(rda)를 만들었는지 확인해 주세요."); }
    const t = await r.text();
    if (r.status === 404) throw new Error("농진청 중계 함수(rda)가 아직 없어요. 안내문대로 Supabase에 만들어 주세요.");
    if (r.status === 401) throw new Error("중계 함수의 ‘JWT 확인(Verify JWT)’을 꺼 주세요.");
    if (!r.ok) { let m = t; try { m = JSON.parse(t).error || t; } catch (e) { } throw new Error("농진청 중계 오류: " + String(m).slice(0, 200)); }
    const doc = new DOMParser().parseFromString(t, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("농진청 응답을 읽지 못했어요: " + t.slice(0, 120));
    const ec = doc.getElementsByTagName("errorCode")[0]?.textContent?.trim();
    if (ec && ec !== "00" && !/NORMAL/.test(ec)) {
      const em = doc.getElementsByTagName("errorMsg")[0]?.textContent?.trim() || "";
      throw new Error(/10[124]/.test(ec) ? `농진청 키 오류 [${ec} ${em}] — 중계 함수 Secrets의 키를 확인해 주세요.` : `농진청 오류 [${ec} ${em}]`);
    }
    return doc;
  },
  photo(n) { return Local.urls[n] || ""; },
  reverse(la, ln) { return Local.reverse(la, ln); },
  search(q) { return Local.search(q); },
  async backup() {
    const recs = await this.list(); const photos = {};
    for (const r of recs) for (const p of r.photos || []) { const u = Local.urls[p]; if (u) photos[p] = await blobToB64(await (await fetch(u)).blob()); }
    return { app: "pestwatch", version: 1, exportedAt: fromInputDT(nowLocal()), records: recs, photos };
  },
  async importData(data) {
    let added = 0, skipped = 0;
    const have = new Set((await this.req("records?select=id")).map(r => r.id));
    for (const r of data.records || []) {
      if (have.has(r.id)) { skipped++; continue; }
      for (const p of r.photos || []) if (data.photos?.[p]) await this.putPhoto(p, b64ToBlob(data.photos[p]));
      await this.req("records", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id: r.id, data: r }]) });
      added++;
    }
    return { added, skipped };
  },
};
function blobToB64(b) { return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(b); }); }
function b64ToBlob(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: "image/jpeg" }); }
let DB = Server;
const P = n => DB.photo(n);

/* ---------- 탭 ---------- */
function showTab(name) {
  $$("nav button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + name));
  if (name === "list") loadList();
  if (name === "map") renderBigMap();
  if (name === "report") refresh().catch(() => { }).then(initReportCtl);
  if (name === "new") setTimeout(() => formMap?.relayout(), 50);
}
$$("nav button").forEach(b => b.onclick = () => showTab(b.dataset.tab));

/* ---------- 입력 지도 ---------- */
let formMap = null;
function initFormMap() {
  if (formMap) formMap.destroy();
  $("#formMap").innerHTML = ""; $("#formMap").className = "map small";
  formMap = GeoKit.createMap($("#formMap"), { center: DEFAULT_CENTER, zoom: 7, onClick: (la, ln) => setFormPoint(la, ln, { zoom: false }) });
  const f = $("#recForm"), la = parseFloat(f.lat.value), ln = parseFloat(f.lng.value);
  if (!isNaN(la) && !isNaN(ln)) setFormPoint(la, ln, { reverse: false });
}
function setFormPoint(lat, lng, { zoom = true, reverse = true } = {}) {
  const f = $("#recForm");
  f.lat.value = (+lat).toFixed(6); f.lng.value = (+lng).toFixed(6);
  formMap.setMarker(lat, lng, (la, ln) => setFormPoint(la, ln, { zoom: false }));
  if (zoom) formMap.setView(lat, lng, Math.max(formMap.getZoom(), 16));
  if (reverse) reverseGeocode(lat, lng);
}
["lat", "lng"].forEach(n => $("#recForm")[n].addEventListener("change", () => {
  const f = $("#recForm"); const la = parseFloat(f.lat.value), ln = parseFloat(f.lng.value);
  if (!isNaN(la) && !isNaN(ln)) setFormPoint(la, ln);
}));

async function reverseGeocode(lat, lng) {
  const f = $("#recForm");
  $("#locStatus").textContent = "주소 확인 중…";
  try {
    const a = await GeoKit.reverse(lat, lng);
    f.address.value = a.road || a.jibun || f.address.value;
    f.jibun.value = a.jibun || "";
    $("#locStatus").textContent = a.road ? "위치·도로명주소 기록 완료" : "위치 기록 완료 (도로명주소가 없는 곳이면 도로명주소 찾기로 보완하세요)";
  } catch (e) {
    $("#locStatus").textContent = "좌표는 기록됨 (주소 자동조회 실패 — 도로명주소 찾기 또는 직접 입력)";
  }
}

$("#btnLocate").onclick = () => {
  const f = $("#recForm");
  f.visitedAt.value = nowLocal();
  if (!navigator.geolocation) { $("#locStatus").textContent = "이 환경에서는 위치 기능을 쓸 수 없습니다. 지도 클릭 또는 주소 검색을 이용하세요."; return; }
  $("#locStatus").textContent = "현재 위치 확인 중… (처음엔 위치 권한 허용 창이 떠요)";
  $("#btnLocate").disabled = true;
  navigator.geolocation.getCurrentPosition(pos => {
    $("#btnLocate").disabled = false;
    const { latitude, longitude, accuracy } = pos.coords;
    setFormPoint(latitude, longitude);
    $("#locStatus").textContent = `위치 기록 완료 (오차 약 ${Math.round(accuracy)}m)`;
    if (accuracy > 500) toast("위치 오차가 큽니다. 지도에서 마커를 끌어 실제 농가 위치로 조정하세요.", 4500);
  }, err => {
    $("#btnLocate").disabled = false;
    const m = { 1: "위치 권한이 거부되었습니다. Windows 설정 > 개인정보 > 위치를 켜고 다시 시도하세요.", 2: "위치를 확인할 수 없습니다 (Wi-Fi/GPS 확인).", 3: "위치 확인 시간이 초과되었습니다." }[err.code] || err.message;
    $("#locStatus").textContent = m + " 지도 클릭 또는 주소 검색으로 지정할 수 있습니다.";
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
};

async function addrSearch() {
  const q = $("#addrSearch").value.trim(); if (!q) return;
  const box = $("#searchResults"); box.innerHTML = '<div class="muted">검색 중…</div>';
  try {
    const list = await GeoKit.search(q);
    if (!list.length) { box.innerHTML = '<div class="muted">검색 결과가 없어요. 도로명+건물번호(예: ○○로 123)나 도로명주소 찾기를 이용해 보세요.</div>'; return; }
    box.innerHTML = list.map((x, i) => `<div data-i="${i}">${esc(x.kind)} <b>${esc(x.name || x.road || x.jibun)}</b>${x.road && x.name ? `<small>${esc(x.road)}</small>` : ""}${x.jibun && x.jibun !== (x.name || x.road || x.jibun) ? `<small>지번 ${esc(x.jibun)}</small>` : ""}</div>`).join("");
    $$("div[data-i]", box).forEach(d => d.onclick = async () => {
      const x = list[d.dataset.i]; box.innerHTML = "";
      setFormPoint(x.lat, x.lng, { reverse: !x.road });
      const f = $("#recForm");
      if (x.road) { f.address.value = x.road + (x.name && !x.road.includes(x.name) ? ` (${x.name})` : ""); f.jibun.value = x.jibun || ""; }
      $("#locStatus").textContent = "검색 위치로 지정됨 (핀을 끌어 미세 조정 가능)";
    });
  } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}
$("#btnPostcode").onclick = async () => {
  $("#postModal").classList.remove("hidden");
  try {
    await GeoKit.openPostcode($("#postWrap"), async d => {
      $("#postModal").classList.add("hidden");
      const f = $("#recForm");
      f.address.value = d.road; f.jibun.value = d.jibun || "";
      const p = await GeoKit.geocode(d.roadOnly);
      if (p) { setFormPoint(p.lat, p.lng, { reverse: false }); $("#locStatus").textContent = "도로명주소와 위치를 지정했어요."; }
      else $("#locStatus").textContent = "도로명주소 입력됨 (지도 위치는 직접 눌러 지정하세요)";
    });
  } catch (e) { $("#postWrap").innerHTML = `<p class="muted">도로명주소 검색을 불러오지 못했어요. 인터넷 연결을 확인하세요.</p>`; }
};
$("#postClose").onclick = () => $("#postModal").classList.add("hidden");
$("#btnAddrSearch").onclick = addrSearch;
$("#addrSearch").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addrSearch(); } });

/* ---------- 사진 ---------- */
function resizeImage(file, max = 1920, force = false) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      if (!force && w <= max && h <= max && file.size < 1.5e6) { resolve(file); URL.revokeObjectURL(url); return; }
      const s = Math.min(max / w, max / h, 1); w = Math.round(w * s); h = Math.round(h * s);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      c.toBlob(b => { URL.revokeObjectURL(url); resolve(b || file); }, "image/jpeg", force ? 0.8 : 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}
async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const blob = await resizeImage(f);
    pendingPhotos.push({ blob, url: URL.createObjectURL(blob), name: f.name.replace(/\.[^.]+$/, "") + ".jpg" });
  }
  renderThumbs();
}
function renderThumbs() {
  const box = $("#photoPreview");
  box.innerHTML = existingPhotos.map((p, i) => `<div class="thumb"><img src="${esc(P(p))}" data-full="${esc(P(p))}"><button type="button" data-ex="${i}">✕</button></div>`).join("")
    + pendingPhotos.map((p, i) => `<div class="thumb"><img src="${p.url}" data-full="${p.url}"><button type="button" data-pe="${i}">✕</button></div>`).join("");
  $$("button[data-ex]", box).forEach(b => b.onclick = () => { existingPhotos.splice(+b.dataset.ex, 1); renderThumbs(); });
  $$("button[data-pe]", box).forEach(b => b.onclick = () => { URL.revokeObjectURL(pendingPhotos[+b.dataset.pe].url); pendingPhotos.splice(+b.dataset.pe, 1); renderThumbs(); });
}
["#photoInput", "#cameraInput"].forEach(id => $(id).onchange = e => { addFiles([...e.target.files]); e.target.value = ""; });
const dz = $("#dropZone");
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("over"); addFiles([...e.dataTransfer.files]); });
document.addEventListener("paste", e => {
  if (!$("#tab-new").classList.contains("active")) return;
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (files.length) addFiles(files);
});
document.addEventListener("click", e => {
  const img = e.target.closest("img[data-full]");
  if (img) { $("#lightImg").src = img.dataset.full; $("#lightbox").classList.remove("hidden"); }
});
$("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");

/* ---------- 참고자료 ---------- */
function updatePestList() {
  const crop = $("#recForm").crop.value.trim();
  const items = new Map(PEST_REF.map(p => [p.name, `${p.category} · ${p.crops}`]));
  if ((RDA.loaded || RDA.hasLive()) && crop) for (const [n, k] of RDA.pestNames(crop)) if (!items.has(n)) items.set(n, k);
  $("#pestList").innerHTML = [...items].slice(0, 400).map(([n, k]) => `<option value="${esc(n)}">${esc(k)}</option>`).join("");
}
function updateCropList() {
  $("#cropList").innerHTML = RDA.crops().map(c => `<option value="${esc(c)}">`).join("");
}
updatePestList();
$("#recForm").crop.addEventListener("change", () => {
  updatePestList();
  const crop = $("#recForm").crop.value.trim();
  if (RDA.hasLive() && crop) RDA.loadCrop(crop).then(ok => { if (ok) updatePestList(); }).catch(() => { });
});
function fillFromRef(force) {
  const f = $("#recForm");
  const name = f.pestName.value.trim();
  const ref = PEST_REF.find(p => p.name === name) || PEST_REF.find(p => name && (p.name.includes(name) || name.includes(p.name.replace(/\(.*\)/, ""))));
  if (!ref) { if (force) toast("참고자료에 없는 병해충입니다. 직접 입력하세요."); return; }
  const anyFilled = f.symptoms.value || f.diagnosis.value || f.remedy.value;
  if (f.symptoms.value === ref.symptoms && f.diagnosis.value === ref.diagnosis && f.remedy.value === ref.remedy) return;
  if (anyFilled && force && !confirm("증상/진단/대처방안 칸을 참고자료 내용으로 바꿀까요?")) return;
  if (anyFilled && !force) return;
  f.pestName.value = ref.name;
  f.category.value = ref.category;
  f.symptoms.value = ref.symptoms; f.diagnosis.value = ref.diagnosis; f.remedy.value = ref.remedy;
  toast("참고 내용을 불러왔습니다. 현장 상황에 맞게 수정하세요.");
}
$("#btnFillRef").onclick = () => fillFromRef(true);
$("#recForm").pestName.addEventListener("change", () => fillFromRef(false));

function renderRef() {
  const q = $("#refQ").value.trim();
  const list = PEST_REF.filter(p => !q || (p.name + p.crops + p.category + p.symptoms).includes(q));
  $("#refList").innerHTML = list.map(p => `<div class="ref"><h4>${CAT_EM[p.category] || ""} ${esc(p.name)}</h4><div class="tag">${esc(p.category)} · ${esc(p.crops)}</div>
    <p><b>증상</b> ${esc(p.symptoms)}</p><p><b>진단</b> ${esc(p.diagnosis)}</p><p><b>대처</b>\n${esc(p.remedy)}</p>
    <button data-use="${esc(p.name)}">이 내용으로 새 기록</button></div>`).join("");
  $$("button[data-use]").forEach(b => b.onclick = () => {
    showTab("new"); const f = $("#recForm"); f.pestName.value = b.dataset.use;
    f.symptoms.value = f.diagnosis.value = f.remedy.value = ""; fillFromRef(false);
  });
}
$("#refQ").oninput = renderRef;

/* ---------- AI 추론 ---------- */
function aiHTML(a, interactive = true) {
  const c = a.candidates || [];
  return `<div class="ai-card"><h4>${a.engine === "symptom" ? "" : ""} 병해충 추론 결과</h4>
    <div class="ai-meta"><span class="eng">${{ symptom: "증상 체크 추론", claude: "Claude 사진 추론", gemini: "Gemini 사진 추론", offline: "기기 안 사진 판별" }[a.engine] || "사진 추론"}</span> · ${esc(a.at || "")} · ${esc(a.crop || "")} · 참고용</div>
    ${a.fallbackNote ? `<div class="ai-warn">${esc(a.fallbackNote)}</div>` : ""}
    ${a.caution ? `<div class="ai-warn">${esc(a.caution)}</div>` : ""}
    ${c.map((x, i) => `<div class="cand ${i === 0 ? "top" : ""}"><div class="cand-h"><span class="rank">${i + 1}순위</span><b>${CAT_EM[x.category] || ""} ${esc(x.name)}</b><span class="muted small">${esc(x.category)}</span>
        ${interactive ? `<button type="button" class="ghost" data-apply="${i}" style="margin-left:auto;padding:6px 10px">이걸로 적용</button>` : ""}</div>
      <div class="conf">확신도 <span class="bar"><i style="width:${Math.max(0, Math.min(100, +x.confidence || 0))}%"></i></span> ${esc(x.confidence)}%</div>
      <b class="small">판단 근거</b><ul>${(x.evidence || []).map(e => `<li>${esc(e)}</li>`).join("")}</ul>
      ${x.against ? `<div class="against">확인 필요: ${esc(x.against)}</div>` : ""}</div>`).join("")}
    <div class="ai-sec"><b>작목 확인</b><div>${esc(a.crop_match)}</div></div>
    <div class="ai-sec"><b>사진 상태</b><div>${esc(a.photo_quality)}</div></div>
    ${(a.field_checks || []).length ? `<div class="ai-sec"><b>현장에서 더 확인할 것</b><div>${a.field_checks.map(x => "• " + esc(x)).join("\n")}</div></div>` : ""}
  </div>`;
}
function renderAI() {
  const box = $("#aiResult");
  if (!currentAI) { box.innerHTML = ""; return; }
  box.innerHTML = aiHTML(currentAI, true);
  $$("button[data-apply]", box).forEach(b => b.onclick = () => applyAI(+b.dataset.apply));
}
function applyAI(i) {
  const a = currentAI, c = a.candidates[i], f = $("#recForm");
  if (!c) return;
  const filled = f.symptoms.value || f.diagnosis.value || f.remedy.value;
  if (filled && !confirm("증상·진단·대처방안 칸을 AI 결과로 바꿀까요?")) return;
  f.pestName.value = c.name;
  f.category.value = ["병해", "충해", "생리장해", "기타"].includes(c.category) ? c.category : "기타";
  if (a.severity) f.severity.value = a.severity;
  f.symptoms.value = a.symptoms || "";
  f.diagnosis.value = (i === 0 ? a.diagnosis : `${c.name} 가능성 (확신도 ${c.confidence}%)`) + "\n\n[판단 근거]\n" + (c.evidence || []).map(e => "- " + e).join("\n");
  f.remedy.value = a.remedy || "";
  if (i !== 0) { const ref = PEST_REF.find(p => p.name === c.name); if (ref) f.remedy.value = ref.remedy; }
  if (a.caution) f.notes.value = (f.notes.value ? f.notes.value + "\n" : "") + "" + a.caution;
  toast("AI 결과를 적용했어요. 현장 상황에 맞게 고쳐 주세요.");
  f.pestName.scrollIntoView({ behavior: "smooth", block: "center" });
}
async function photoBlobs() {
  const out = pendingPhotos.map(p => p.blob);
  for (const n of existingPhotos) { try { out.push(await (await fetch(P(n))).blob()); } catch (e) { } }
  return out;
}
$("#btnAI").onclick = async () => {
  const f = $("#recForm"), btn = $("#btnAI");
  const crop = f.crop.value.trim();
  if (!crop) { toast("작목을 먼저 입력해 주세요."); f.crop.focus(); return; }
  if (!pendingPhotos.length && !existingPhotos.length) { toast("사진을 먼저 첨부해 주세요."); return; }
  if (!PestAI.ready()) { toast("설정에서 선택한 AI의 키를 넣거나, ‘기기 안 판별(무료)’을 고르세요."); openSettings(); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 사진 분석 중…';
  try {
    const blobs = await photoBlobs();
    const offline = () => LeafModel.diagnose({ crop, blobs, onProgress: p => { btn.innerHTML = `<span class="spinner"></span> 판별 모델 준비 중… ${Math.round(p * 100)}%`; } });
    let res;
    if (PestAI.getEngine() === "offline") res = await offline();
    else {
      try { res = await PestAI.diagnose({ crop, notes: f.notes.value.trim(), blobs }); }
      catch (e) {
        if (!e.fallback) throw e;
        toast("" + e.message + " 대신 기기 안 판별(무료)로 추론했어요.", 6000);
        btn.innerHTML = '<span class="spinner"></span> 기기 안 판별로 분석 중…';
        res = await offline();
        res.fallbackNote = e.message + " 그래서 기기 안 판별(무료) 결과를 보여 드려요.";
      }
    }
    res.crop = crop;
    currentAI = res; renderAI();
    $("#aiResult").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (e.message === "NO_KEY") openSettings(); else alert("" + e.message);
  } finally { btn.disabled = false; setAIButton(); }
};

/* ---------- 증상 체크 추론 ---------- */
const symSel = new Set();
$("#btnSym").onclick = () => {
  const p = $("#symPanel"); p.classList.toggle("hidden");
  if (!p.classList.contains("hidden")) { SymptomCheck.renderChips($("#symChips"), symSel); p.scrollIntoView({ behavior: "smooth", block: "start" }); }
};
$("#btnSymClear").onclick = () => { symSel.clear(); SymptomCheck.renderChips($("#symChips"), symSel); };
$("#btnSymRun").onclick = () => {
  const f = $("#recForm"), crop = f.crop.value.trim();
  if (!crop) { toast("작목을 먼저 입력해 주세요."); f.crop.focus(); return; }
  try {
    const res = SymptomCheck.infer({ crop, selected: symSel });
    res.crop = crop; currentAI = res; renderAI();
    $("#symPanel").classList.add("hidden");
    $("#aiResult").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { toast("" + e.message); }
};

/* ---------- 설정 ---------- */
function setAIButton() {
  const e = PestAI.getEngine();
  if (!setAIButton.icon) setAIButton.icon = ($("#btnAI").querySelector("svg") || {}).outerHTML || "";
  $("#btnAI").innerHTML = `${setAIButton.icon}사진으로 추론<small>${{ offline: "무료 · 키 불필요 · 기기 안에서 분석", gemini: "Gemini · 인터넷 필요", claude: "Claude(유료) · 인터넷 필요" }[e] || ""}</small>`;
}
function syncEngineUI() {
  const eng = PestAI.getEngine();
  setAIButton();
  $("#offlineBox").classList.toggle("hidden", eng !== "offline");
  $$('#engineSeg input').forEach(i => i.checked = i.value === eng);
  $("#geminiBox").classList.toggle("hidden", eng !== "gemini");
  $("#claudeBox").classList.toggle("hidden", eng !== "claude");
  $("#keyState").parentElement.querySelector(".actions").classList.toggle("hidden", eng === "offline");
  if (eng === "offline") { $("#keyState").className = "status ok"; $("#keyState").textContent = "키 없이 바로 쓸 수 있어요."; return; }
  const k = eng === "claude" ? PestAI.getKey() : PestAI.getGeminiKey();
  const inp = eng === "claude" ? $("#apiKeyInput") : $("#geminiKeyInput");
  inp.value = ""; inp.placeholder = k ? `저장됨 (${k.slice(0, 6)}…${k.slice(-4)})` : (eng === "claude" ? "sk-ant-..." : "AIza...");
  $("#keyState").className = "status " + (k ? "ok" : "");
  $("#keyState").textContent = k ? "키가 저장되어 있어요." : "아직 키가 없어요. (키 없이도 증상 체크 추론은 쓸 수 있어요)";
}
function openSettings() {
  syncEngineUI();
  refreshRdaState();
  $("#originText").textContent = location.origin;
  const kk = GeoKit.getKakaoKey();
  $("#kakaoKeyInput").value = ""; $("#kakaoKeyInput").placeholder = kk ? `저장됨 (${kk.slice(0, 4)}…${kk.slice(-4)})` : "32자리 키";
  $("#kakaoState").className = "status " + (GeoKit.provider === "kakao" ? "ok" : kk ? "err" : "");
  $("#kakaoState").textContent = GeoKit.provider === "kakao" ? "카카오지도를 쓰고 있어요." : kk ? `카카오지도를 불러오지 못해 기본 지도를 쓰는 중 (${GeoKit.kakaoError}). 키와 도메인 등록을 확인하세요.` : "지금은 무료 OpenStreetMap 지도를 쓰고 있어요.";
  if (DB.mode !== "pc") renderCloud();
  $("#modeInfo").innerHTML = DB === Cloud ? "휴대폰 · 공유 저장소 모드: 기록과 사진이 공유 저장소(Supabase)에 저장돼요. 인터넷이 필요해요." : DB.mode === "pc"
    ? "PC 프로그램 모드: 기록과 키는 문서\\병해충예찰데이터 폴더에 저장돼요. 키는 PC와 휴대폰에 각각 넣어야 해요."
    : "휴대폰 모드 · 기록은 이 휴대폰 브라우저 안에 저장돼요. 목록 › 백업 내보내기로 PC에 옮기세요.";
  $("#settingsModal").classList.remove("hidden");
}
/* 공유 저장소 설정 */
function readJoinLink() {
  const m = location.hash.match(/join=([^&]+)/); if (!m) return;
  try {
    const j = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
    if (j.u && j.k) { localStorage.setItem(CLOUD_KEYS.url, j.u); localStorage.setItem(CLOUD_KEYS.anon, j.k); }
    history.replaceState(null, "", location.pathname);
    if (!localStorage.getItem(CLOUD_KEYS.code)) setTimeout(() => { openSettings(); $("#cloudCodeInput").focus(); toast("공유 링크로 들어왔어요. 공유 암호를 넣고 ‘연결’을 누르세요.", 6000); }, 600);
  } catch (e) { }
}
async function localRecords() { try { return (await Local.tx("records", "readonly", st => st.getAll())) || []; } catch (e) { return []; } }
async function renderCloud() {
  const c = Cloud.cfg, on = DB === Cloud, st = $("#cloudState");
  $("#cloudUrlInput").value = c.url; $("#cloudAnonInput").value = c.anon; $("#cloudCodeInput").value = "";
  $("#cloudCodeInput").placeholder = c.code ? "저장됨 (바꿀 때만 입력)" : "관리자에게 받은 암호";
  st.className = "status " + (on ? "ok" : "");
  st.textContent = on ? "연결됨: 이 링크를 쓰는 모든 사람의 기록이 함께 저장·조회돼요." : "지금은 이 휴대폰 안에만 저장돼요.";
  $("#btnCloudOff").classList.toggle("hidden", !on);
  const n = on ? (await localRecords()).length : 0;
  $("#btnCloudUpload").classList.toggle("hidden", !n);
  $("#btnCloudUpload").textContent = `이 휴대폰에만 있던 기록 ${n}건 올리기`;
  refreshRdaState();
}
async function reloadAll() { await refresh(); try { await loadList(); } catch (e) { } }
$("#btnCloudSave").onclick = async () => {
  const url = $("#cloudUrlInput").value.trim(), anon = $("#cloudAnonInput").value.trim(), code = $("#cloudCodeInput").value.trim() || Cloud.cfg.code;
  if (!url || !anon || !code) { toast("세 칸을 모두 채워 주세요."); return; }
  const prev = { ...Cloud.cfg };
  localStorage.setItem(CLOUD_KEYS.url, url); localStorage.setItem(CLOUD_KEYS.anon, anon); localStorage.setItem(CLOUD_KEYS.code, code);
  const st = $("#cloudState"); st.className = "status"; st.textContent = "연결 확인 중…";
  try {
    await Cloud.check();
    DB = Cloud; await reloadAll(); toast("공유 저장소에 연결했어요.");
  } catch (e) {
    localStorage.setItem(CLOUD_KEYS.url, prev.url); localStorage.setItem(CLOUD_KEYS.anon, prev.anon);
    if (prev.code) localStorage.setItem(CLOUD_KEYS.code, prev.code); else localStorage.removeItem(CLOUD_KEYS.code);
    await renderCloud(); st.className = "status err"; st.textContent = "연결 실패: " + e.message; return;
  }
  renderCloud();
};
$("#btnCloudOff").onclick = async () => {
  if (!confirm("공유 저장소 연결을 끊을까요? 공유 기록은 그대로 남고, 이 휴대폰은 다시 휴대폰 안 저장으로 바뀌어요.")) return;
  localStorage.removeItem(CLOUD_KEYS.code); DB = Local; await reloadAll(); renderCloud();
};
$("#btnCloudLink").onclick = async () => {
  const c = Cloud.cfg; const url = $("#cloudUrlInput").value.trim() || c.url, anon = $("#cloudAnonInput").value.trim() || c.anon;
  if (!url || !anon) { toast("Supabase 주소와 공개 키를 먼저 넣어 주세요."); return; }
  const link = location.origin + location.pathname + "#join=" + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify({ u: url, k: anon })))));
  try { await navigator.clipboard.writeText(link); toast("공유 링크를 복사했어요. 암호는 따로 알려 주세요.", 5000); }
  catch (e) { prompt("이 링크를 복사해서 보내세요 (암호는 따로 알려 주세요)", link); }
};
$("#btnCloudUpload").onclick = async () => {
  const b = $("#btnCloudUpload"); b.disabled = true; b.textContent = "올리는 중…";
  try {
    const r = await Cloud.importData(await Local.backup());
    toast(`올리기 완료: ${r.added}건 추가, ${r.skipped}건은 이미 있음`, 5000);
    if (confirm("다 올렸어요. 이 휴대폰 안에 있던 사본은 정리할까요? (공유 저장소에는 남아요)")) {
      for (const x of await localRecords()) await Local.remove(x.id);
    }
    await reloadAll();
  } catch (e) { toast("올리기 실패: " + e.message, 5000); }
  b.disabled = false; renderCloud();
};
$$('#engineSeg input').forEach(i => i.onchange = () => { PestAI.setEngine(i.value); syncEngineUI(); });
$("#btnSettings").onclick = openSettings;
$("#settingsClose").onclick = () => $("#settingsModal").classList.add("hidden");
$("#settingsModal").onclick = e => { if (e.target.id === "settingsModal") $("#settingsModal").classList.add("hidden"); };
$("#btnKeySave").onclick = () => {
  const eng = PestAI.getEngine();
  const v = (eng === "claude" ? $("#apiKeyInput") : $("#geminiKeyInput")).value.trim();
  if (!v) { toast("키를 붙여넣어 주세요."); return; }
  eng === "claude" ? PestAI.setKey(v) : PestAI.setGeminiKey(v);
  syncEngineUI(); toast("키를 저장했어요.");
};
$("#btnKeyClear").onclick = () => { PestAI.getEngine() === "claude" ? PestAI.setKey("") : PestAI.setGeminiKey(""); syncEngineUI(); toast("키를 지웠어요."); };
$("#btnKakaoSave").onclick = () => {
  const v = $("#kakaoKeyInput").value.trim();
  if (!v) { toast("카카오 JavaScript 키를 붙여넣어 주세요."); return; }
  GeoKit.setKakaoKey(v); toast("저장했어요. 화면을 다시 불러옵니다…"); setTimeout(() => location.reload(), 800);
};
$("#btnKakaoClear").onclick = () => { GeoKit.setKakaoKey(""); toast("카카오 키를 지웠어요. 다시 불러옵니다…"); setTimeout(() => location.reload(), 800); };

/* ---------- 농진청 정보 ---------- */
function rdaNeed() {
  const p = $("#rdaPanel"); p.classList.remove("hidden");
  p.innerHTML = `<h4>농진청 데이터가 아직 없어요</h4><p class="small">${DB.mode === "pc"
    ? "설정 › 농촌진흥청 정보에서 무료 키를 넣고 전체 내려받기를 눌러 주세요."
    : "설정에서 공유 저장소에 연결하면 휴대폰에서 바로 조회할 수 있어요. (관리자가 농진청 중계 함수를 한 번 만들어 두어야 해요)"}</p><button type="button" class="primary" onclick="openSettings()">설정 열기</button>`;
}
function detailHTML2(p, d) {
  const fields = (d.fields || []).filter(([k, v]) => RDA.cleanText(v) && !/key$/i.test(k) && !/^(cropName)$/.test(k));
  return `<h4>${p.t === "충" ? "" : ""} ${esc(p.name)} <span class="muted small">· ${esc(p.crop)}${p.eng ? " · " + esc(p.eng) : ""}</span></h4>
    ${(d.images || []).length ? `<div class="rda-imgs">${d.images.slice(0, 8).map(u => `<img src="${esc(u)}" data-full="${esc(u)}" alt="" loading="lazy">`).join("")}</div>` : ""}
    <dl class="rda-fields">${fields.map(([k, v]) => `<dt>${esc(RDA.DETAIL_LABEL[k] || k)}</dt><dd>${esc(RDA.cleanText(v))}</dd>`).join("") || '<dd class="muted">상세 내용이 없어요.</dd>'}</dl>
    <p class="muted small">출처: 농촌진흥청 국가농작물병해충관리시스템(NCPMS)</p>`;
}
async function showRdaPest(p, box, withFill) {
  box.classList.remove("hidden");
  box.innerHTML = `<p class="muted">${esc(p.name)} 정보를 불러오는 중…</p>`;
  try {
    const d = await RDA.detail(p);
    box.innerHTML = detailHTML2(p, d) + (withFill ? `<div class="actions"><button type="button" class="ghost" data-close>닫기</button><button type="button" class="primary" data-fill>증상·진단·방제를 칸에 넣기</button></div>` : "");
    box.querySelector("[data-fill]")?.addEventListener("click", () => {
      const f = $("#recForm"), x = RDA.toForm(d);
      if ((f.symptoms.value || f.diagnosis.value || f.remedy.value) && !confirm("증상·진단·대처방안 칸을 농진청 정보로 바꿀까요?")) return;
      f.pestName.value = p.name; f.category.value = p.t === "충" ? "충해" : "병해";
      if (x.symptoms) f.symptoms.value = x.symptoms;
      if (x.diagnosis) f.diagnosis.value = x.diagnosis;
      if (x.remedy) f.remedy.value = x.remedy;
      toast("농진청 정보를 넣었어요. 현장 상황에 맞게 고쳐 주세요.");
    });
    box.querySelector("[data-close]")?.addEventListener("click", () => box.classList.add("hidden"));
  } catch (e) { box.innerHTML = `<p>${esc(e.message)}</p>`; }
}
$("#btnRdaInfo").onclick = async () => {
  const f = $("#recForm"), crop = f.crop.value.trim(), name = f.pestName.value.trim();
  if (!RDA.loaded && !RDA.hasLive()) return rdaNeed();
  if (!crop || !name) { toast("작목과 병해충명을 먼저 입력해 주세요."); return; }
  if (RDA.hasLive()) {
    const box = $("#rdaPanel"); box.classList.remove("hidden"); box.innerHTML = '<p class="muted">농진청에서 찾는 중…</p>';
    try { await RDA.loadCrop(crop); } catch (e) { box.innerHTML = `<p>${esc(e.message)}</p>`; return; }
    updatePestList();
  }
  const p = RDA.findPest(crop, name);
  if (!p) {
    const opts = RDA.pestNames(crop).filter(([, k]) => !k.startsWith("")).slice(0, 40);
    $("#rdaPanel").classList.remove("hidden");
    $("#rdaPanel").innerHTML = `<h4>‘${esc(crop)}’에서 ‘${esc(name)}’을(를) 찾지 못했어요</h4>${opts.length ? `<p class="small">이 작목의 농진청 병해충: </p><div class="chips">${opts.map(([n]) => `<button type="button" class="chip" data-n="${esc(n)}">${esc(n)}</button>`).join("")}</div>` : '<p class="small">이 작목의 병해충 목록이 없어요. 작목 이름을 농진청 표기(예: 고추, 사과, 벼)로 바꿔 보세요.</p>'}`;
    $$("#rdaPanel [data-n]").forEach(b => b.onclick = () => { f.pestName.value = b.dataset.n; $("#btnRdaInfo").click(); });
    return;
  }
  showRdaPest(p, $("#rdaPanel"), true);
};
function pestiTable(res, selectable) {
  const show = ["pestiKorName", "pestiBrandName", "diseaseWeedName", "useName", "pestiUse", "dilutUnit", "useSuittime", "useNum", "indictSymbl", "compName"];
  const idx = Object.fromEntries(res.cols.map((c, i) => [c, i]));
  return `<div class="ptable-wrap"><table class="ptable"><thead><tr>${selectable ? "<th>선택</th>" : ""}${show.map(c => `<th>${esc(RDA.PESTI_LABEL[c])}</th>`).join("")}</tr></thead><tbody>${
    res.rows.slice(0, 300).map((r, i) => `<tr>${selectable ? `<td><input type="checkbox" data-row="${i}" style="width:auto"></td>` : ""}${show.map(c => `<td class="${["dilutUnit", "useSuittime", "useNum", "useName"].includes(c) ? "n" : ""}">${esc(r[idx[c]] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    ${res.rows.length > 300 ? `<p class="muted small">처음 300건만 보여요. 병해충명을 더 정확히 넣어 보세요.</p>` : ""}`;
}
$("#btnRdaPesti").onclick = async () => {
  const f = $("#recForm"), crop = f.crop.value.trim(), pest = f.pestName.value.trim(), box = $("#rdaPanel");
  if (!crop) { toast("작목을 먼저 입력해 주세요."); return; }
  if (!RDA.loaded && DB.mode !== "pc" && !RDA.hasLive()) return rdaNeed();
  box.classList.remove("hidden"); box.innerHTML = '<p class="muted">등록농약을 찾는 중…</p>';
  try {
    const res = await RDA.pesticides(crop, pest);
    if (!res.rows.length) { box.innerHTML = `<h4>등록농약을 찾지 못했어요</h4><p class="small">‘${esc(crop)}’ ${pest ? "· ‘" + esc(pest) + "’" : ""}에 등록된 농약이 없거나 이름 표기가 달라요. 병해충명을 줄여서(예: 탄저) 다시 찾아보세요.</p>`; return; }
    const idx = Object.fromEntries(res.cols.map((c, i) => [c, i]));
    box.innerHTML = `<h4>${esc(crop)} ${pest ? "· " + esc(pest) : ""} 등록농약 ${res.rows.length}건 ${res.live ? '<span class="muted small">(실시간 조회)</span>' : ""}</h4>
      <p class="muted small">사용 전 반드시 라벨과 안전사용기준(사용시기·횟수)을 확인하세요. 출처: 농약안전정보시스템(PSIS)</p>
      ${pestiTable(res, true)}
      <div class="actions"><button type="button" class="ghost" data-close>닫기</button><button type="button" class="primary" data-add>선택한 농약을 대처방안에 넣기</button></div>`;
    box.querySelector("[data-close]").onclick = () => box.classList.add("hidden");
    box.querySelector("[data-add]").onclick = () => {
      const sel = $$("input[data-row]:checked", box).map(c => res.rows[+c.dataset.row]);
      if (!sel.length) { toast("넣을 농약을 체크해 주세요."); return; }
      const lines = sel.map(r => `${r[idx.pestiKorName]}(${r[idx.pestiBrandName]}) — ${r[idx.dilutUnit] || ""}, ${r[idx.pestiUse] || ""} / 안전사용: ${r[idx.useSuittime] || "-"}, ${r[idx.useNum] || "-"}${r[idx.indictSymbl] ? " / 작용기작 " + r[idx.indictSymbl] : ""}`);
      f.remedy.value = (f.remedy.value ? f.remedy.value.trimEnd() + "\n\n" : "") + "[등록농약]\n" + lines.join("\n");
      toast(`${sel.length}건을 대처방안에 넣었어요.`);
    };
  } catch (e) { box.innerHTML = `<p>${esc(e.message)}</p>${/키/.test(e.message) ? '<button type="button" class="primary" onclick="openSettings()">설정 열기</button>' : ""}`; }
};

/* 참고 탭: 농진청 병해충 검색 */
function renderRdaRef() {
  const q = $("#refQ").value.trim(), st = RDA.stats();
  $("#rdaRefInfo").textContent = st ? `농진청 데이터: 작물 ${st.crops.toLocaleString()}종 · 병해충 ${st.pests.toLocaleString()}건 · 등록농약 ${st.pesti.toLocaleString()}건 (${st.syncedAt || ""})` : RDA.hasLive() ? "작목 이름(예: 고추, 사과)을 넣으면 농진청에서 바로 찾아와요." : "농진청 데이터가 아직 없어요. 설정에서 내려받거나 가져오세요.";
  const list = q ? RDA.search(q) : [];
  $("#rdaRefList").innerHTML = list.map((p, i) => `<div class="rda-item" data-i="${i}"><span>${p.t === "충" ? "" : ""}</span><div><b>${esc(p.name)}</b> <span class="muted small">${esc(p.crop)}${p.eng ? " · " + esc(p.eng) : ""}</span></div></div>`).join("") + (q && !list.length && (st || RDA.hasLive()) ? '<p class="muted small">농진청 목록에서 찾지 못했어요.</p>' : "");
  $$("#rdaRefList .rda-item").forEach(el => el.onclick = () => {
    const p = list[+el.dataset.i];
    const box = document.createElement("div"); box.className = "rda-panel";
    el.after(box); el.onclick = () => box.classList.toggle("hidden");
    showRdaPest(p, box, false).then(async () => {
      try { const res = await RDA.pesticides(p.crop, p.name); if (res.rows.length) box.insertAdjacentHTML("beforeend", `<h4>등록농약 ${res.rows.length}건</h4>` + pestiTable(res, false)); } catch (e) { }
    });
  });
}
$("#refQ").addEventListener("input", () => {
  clearTimeout(renderRdaRef._t);
  renderRdaRef._t = setTimeout(() => {
    renderRdaRef();
    const q = $("#refQ").value.trim();
    if (RDA.hasLive() && q.length >= 1) RDA.loadCrop(q).then(ok => { if (ok) renderRdaRef(); }).catch(e => { $("#rdaRefInfo").textContent = e.message; });
  }, 500);
});
$("#btnRdaLiveTest").onclick = async () => {
  const ls = $("#rdaLiveState"); ls.className = "status"; ls.textContent = "농진청에 물어보는 중…";
  try { const n = await RDA.liveTest(); ls.className = "status ok"; ls.textContent = `실시간 조회가 돼요. (예: 고추 병해 ${n}건)`; }
  catch (e) { ls.className = "status err"; ls.textContent = e.message; }
};

/* 설정: 농진청 */
let rdaPoll = null;
async function refreshRdaState() {
  const st = RDA.stats();
  $("#rdaState").className = "status " + (st ? "ok" : "");
  $("#rdaState").textContent = st ? `작물 ${st.crops.toLocaleString()}종 · 병해충 ${st.pests.toLocaleString()}건 · 등록농약 ${st.pesti.toLocaleString()}건 (${st.syncedAt || "가져옴"})` : "아직 농진청 데이터가 없어요.";
  $("#rdaPcBox").classList.toggle("hidden", DB.mode !== "pc");
  $("#rdaMobileBox").classList.toggle("hidden", DB.mode === "pc");
  if (DB.mode !== "pc") {
    const ls = $("#rdaLiveState");
    ls.className = "status " + (RDA.hasLive() ? "" : "err");
    ls.textContent = RDA.hasLive() ? "공유 저장소에 연결돼 있어요. 아래 버튼으로 농진청 조회가 되는지 확인해 보세요." : "공유 저장소에 연결하면 실시간 조회를 쓸 수 있어요.";
    $("#btnRdaLiveTest").disabled = !RDA.hasLive();
    return;
  }
  try {
    const k = await (await fetch("/api/rda/settings")).json();
    $("#ncpmsKeyInput").placeholder = k.ncpmsKey ? `저장됨 (${k.ncpmsKey})` : "NCPMS에서 받은 키";
    $("#psisKeyInput").placeholder = k.psisKey ? `저장됨 (${k.psisKey})` : "PSIS에서 받은 키";
    const s = await (await fetch("/api/rda/status")).json();
    showSync(s);
  } catch (e) { }
}
function showSync(s) {
  const prog = $("#rdaProg");
  if (s.state === "running") {
    prog.classList.remove("hidden");
    prog.firstElementChild.style.width = s.total ? Math.round(100 * s.done / s.total) + "%" : "3%";
    $("#rdaState").className = "status"; $("#rdaState").textContent = `${s.step || "내려받는 중"} ${s.total ? `${(s.done || 0).toLocaleString()} / ${s.total.toLocaleString()}` : ""} — 창을 닫지 말고 기다려 주세요.`;
    $("#btnRdaSync").disabled = true;
    clearTimeout(rdaPoll); rdaPoll = setTimeout(async () => { try { showSync(await (await fetch("/api/rda/status")).json()); } catch (e) { } }, 2000);
  } else {
    $("#btnRdaSync").disabled = false; prog.classList.add("hidden");
    if (s.state === "error") { $("#rdaState").className = "status err"; $("#rdaState").style.whiteSpace = "pre-line"; $("#rdaState").textContent = "내려받기 실패\n" + s.message; }
    if (s.state === "done") {
      $("#rdaState").className = "status ok"; $("#rdaState").textContent = "내려받기 완료: " + s.message;
      RDA.init({ mode: "pc" }).then(() => { updateCropList(); updatePestList(); renderRdaRef(); });
      s.state = "shown";
    }
  }
}
$("#btnRdaKeySave").onclick = async () => {
  const body = { ncpmsKey: $("#ncpmsKeyInput").value.trim() || "-", psisKey: $("#psisKeyInput").value.trim() || "-" };
  if (body.ncpmsKey === "-" && body.psisKey === "-") { toast("키를 붙여넣어 주세요."); return; }
  await fetch("/api/rda/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  $("#ncpmsKeyInput").value = ""; $("#psisKeyInput").value = ""; toast("농진청 키를 저장했어요. 키가 되는지 확인할게요…"); await refreshRdaState();
  await testRdaKeys();
};
async function testRdaKeys() {
  const st = $("#rdaState");
  st.className = "status"; st.textContent = "농진청 서버에 키 확인 중…";
  try {
    const t = await (await fetch("/api/rda/test")).json();
    const line = (n, x) => `${x.ok ? "" : ""} ${n}: ${x.message}`;
    st.className = "status " + (t.ncpms.ok || t.psis.ok ? (t.ncpms.ok && t.psis.ok ? "ok" : "") : "err");
    st.style.whiteSpace = "pre-line";
    st.textContent = line("병해충(NCPMS)", t.ncpms) + "\n" + line("농약(PSIS)", t.psis) + (t.ncpms.ok || t.psis.ok ? "\n이제 ‘전체 내려받기’를 누르세요." : "");
    return t;
  } catch (e) { st.className = "status err"; st.textContent = "키 확인 실패: " + e.message; }
}
$("#btnRdaSync").onclick = async () => {
  if (!confirm("농진청 데이터를 전체 내려받을까요? 10~20분 정도 걸려요.")) return;
  const r = await fetch("/api/rda/sync", { method: "POST" }); const j = await r.json();
  if (!r.ok) { toast("" + (j.error || "시작 실패")); return; }
  showSync({ state: "running", step: "시작", done: 0, total: 0 });
};
$("#rdaImport").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    toast("농진청 DB 가져오는 중…");
    const st = await RDA.importFile(await f.text());
    updateCropList(); updatePestList(); renderRdaRef(); refreshRdaState();
    alert(`가져오기 완료: 작물 ${st.crops}종 · 병해충 ${st.pests}건 · 등록농약 ${st.pesti}건`);
  } catch (err) { alert("가져오기 실패: " + err.message); }
};

/* ---------- 저장 ---------- */
function resetForm() {
  const f = $("#recForm"); f.reset();
  editingId = null; existingPhotos = []; currentAI = null; renderAI();
  pendingPhotos.forEach(p => URL.revokeObjectURL(p.url)); pendingPhotos = [];
  renderThumbs();
  formMap?.clearMarker();
  $("#locStatus").textContent = ""; $("#searchResults").innerHTML = "";
  $("#editBadge").classList.add("hidden");
  $("#btnSave").textContent = "저장";
  f.visitedAt.value = nowLocal();
  // 마지막 기록 위치 근처로 지도 이동
  const last = records.find(r => r.lat != null);
  if (last) formMap?.setView(last.lat, last.lng, 12);
  f.advisor.value = (() => { try { return localStorage.getItem("pestwatch.advisor") || ""; } catch (e) { return ""; } })();
}
$("#btnReset").onclick = () => { if (!pendingPhotos.length || confirm("작성 중인 내용을 지울까요?")) resetForm(); };

$("#recForm").onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const btn = $("#btnSave"); btn.disabled = true;
  try {
    btn.textContent = "저장 중…";
    const num = v => v === "" ? null : Number(v);
    const rec = {
      farmName: f.farmName.value.trim(), farmer: f.farmer.value.trim(), phone: f.phone.value.trim(), email: f.email.value.trim(),
      address: f.address.value.trim(), jibun: f.jibun.value.trim(), advisor: f.advisor.value.trim(), lat: num(f.lat.value), lng: num(f.lng.value),
      visitedAt: fromInputDT(f.visitedAt.value) || fromInputDT(nowLocal()),
      crop: f.crop.value.trim(), area: f.area.value.trim(), category: f.category.value, pestName: f.pestName.value.trim(),
      severity: f.severity.value, incidence: f.incidence.value.trim(), symptoms: f.symptoms.value, diagnosis: f.diagnosis.value, remedy: f.remedy.value,
      notes: f.notes.value, status: f.status.value, photos: [...existingPhotos], aiResult: currentAI || null,
    };
    const saved = await DB.save(editingId, rec, pendingPhotos);
    try { if (rec.advisor) localStorage.setItem("pestwatch.advisor", rec.advisor); } catch (e) { }
    toast(editingId ? "수정했어요!" : "저장했어요!");
    await refresh();
    resetForm();
    openDetail(saved.id);
  } catch (err) {
    alert("저장하지 못했습니다: " + err.message);
  } finally { btn.disabled = false; if (btn.textContent.includes("중…")) btn.textContent = editingId ? "수정 저장" : "저장"; }
};

function startEdit(r) {
  resetForm();
  editingId = r.id;
  const f = $("#recForm");
  ["farmName", "farmer", "phone", "email", "address", "jibun", "advisor", "crop", "area", "category", "pestName", "severity", "incidence", "symptoms", "diagnosis", "remedy", "notes", "status"]
    .forEach(k => { if (f[k]) f[k].value = r[k] ?? ""; });
  f.visitedAt.value = toInputDT(r.visitedAt);
  if (r.lat != null && r.lng != null) setFormPoint(r.lat, r.lng, { reverse: false });
  existingPhotos = [...(r.photos || [])];
  renderThumbs();
  currentAI = r.aiResult || null; renderAI();
  $("#editBadge").classList.remove("hidden");
  $("#btnSave").textContent = "수정 저장";
  closeModal(); showTab("new");
}

/* ---------- 목록 ---------- */
async function refresh() { records = await DB.list(); }
function filtered() {
  const q = $("#q").value.trim(), c = $("#fCat").value, s = $("#fStatus").value, from = $("#fFrom").value, to = $("#fTo").value;
  return records.filter(r => {
    if (q && !(r.farmName + r.farmer + (r.advisor || "") + (r.jibun || "") + r.address + r.crop + r.pestName + r.symptoms + r.notes).includes(q)) return false;
    if (c && r.category !== c) return false;
    if (s && r.status !== s) return false;
    const d = (r.visitedAt || "").slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}
function renderStats() {
  const ym = fromInputDT(nowLocal()).slice(0, 7);
  const n = records.length, month = records.filter(r => (r.visitedAt || "").startsWith(ym)).length;
  const sev = records.filter(r => r.severity === "심각").length, open = records.filter(r => r.status !== "완료").length;
  $("#stats").innerHTML = [["", n, "전체 기록"], ["", month, "이번 달 방문"], ["", sev, "심각"], ["", open, "조치 진행 중"]]
    .map(([e, v, l]) => `<div class="stat"><div class="em">${e}</div><b>${v}</b><span>${l}</span></div>`).join("");
}
function renderList() {
  renderStats();
  const list = filtered();
  $("#summary").textContent = `총 ${records.length}건 중 ${list.length}건`;
  $("#listBody").innerHTML = list.length ? list.map(r => `<div class="rec" data-id="${esc(r.id)}">
    <div class="ph">${r.photos?.length ? `<img src="${esc(P(r.photos[0]))}" alt="">` : `<span class="ph-l">${CAT_LETTER(r.category)}</span>`}</div>
    <div><div class="t">${esc(r.farmName)} ${r.crop ? `<span class="muted" style="font-weight:600;font-size:14px">· ${esc(r.crop)}</span>` : ""}</div>
      <div class="p">${CAT_EM[r.category] || ""} ${esc(r.pestName || "병해충 미정")}${r.aiResult ? ' <span class="ai-tag" title="AI 추론 기록 있음">AI</span>' : ""}</div>
      <div class="s">${esc(r.visitedAt?.slice(0, 16))} · ${esc(r.address || "주소 없음")}</div></div>
    <div class="tags"><span class="sev ${esc(r.severity)}">${SEV_EM[r.severity] || ""} ${esc(r.severity)}</span><span class="st ${esc(r.status)}">${ST_EM[r.status] || ""} ${esc(r.status)}</span></div></div>`).join("")
    : `<div class="empty"><div class="big-em"></div><p>${records.length ? "조건에 맞는 기록이 없어요." : "아직 기록이 없어요. 새 기록에서 첫 예찰을 남겨 보세요!"}</p></div>`;
  $$("#listBody .rec").forEach(el => el.onclick = () => openDetail(el.dataset.id));
}
async function loadList() { try { await refresh(); renderList(); } catch (e) { toast(e.message); } }
["q", "fCat", "fStatus", "fFrom", "fTo"].forEach(id => $("#" + id).addEventListener("input", renderList));

/* ---------- 상세 ---------- */
let detailMap = null;
function detailHTML(r) {
  const rows = [["방문일시", r.visitedAt], ["농가주", r.farmer], ["연락처", r.phone], ["이메일", r.email], ["도로명주소", r.address], ["지번주소", r.jibun], ["담당지도사", r.advisor],
    ["좌표", r.lat != null ? `${(+r.lat).toFixed(6)}, ${(+r.lng).toFixed(6)}` : ""], ["작목", r.crop], ["재배면적", r.area],
    ["병해충명", r.pestName], ["증상", r.symptoms], ["진단", r.diagnosis], ["대처방안", r.remedy], ["비고", r.notes]];
  return `<div class="detail"><h3>${esc(r.farmName)}</h3>
    <div class="d-tags"><span class="sev ${esc(r.severity)}">${SEV_EM[r.severity] || ""} ${esc(r.severity)}</span><span class="st ${esc(r.status)}">${ST_EM[r.status] || ""} ${esc(r.status)}</span><span class="st 완료">${CAT_EM[r.category] || ""} ${esc(r.category)}</span></div>
    <div class="muted small">기록 ${esc(r.createdAt)}${r.updatedAt !== r.createdAt ? " · 수정 " + esc(r.updatedAt) : ""}</div>
    <div class="thumbs">${(r.photos || []).map(p => `<div class="thumb"><img src="${esc(P(p))}" data-full="${esc(P(p))}"></div>`).join("")}</div>
    ${r.lat != null ? '<div id="detailMap" class="map"></div>' : ""}
    <dl class="kv">${rows.filter(x => x[1]).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${r.aiResult ? aiHTML(r.aiResult, false) : ""}</div>`;
}
function openDetail(id) {
  const r = records.find(x => x.id === id); if (!r) return;
  current = r;
  $("#detail").innerHTML = detailHTML(r);
  $("#modal").classList.remove("hidden");
  if (detailMap) { detailMap.destroy(); detailMap = null; }
  if (r.lat != null) {
    detailMap = GeoKit.createMap($("#detailMap"), { center: [r.lat, r.lng], zoom: 16 });
    detailMap.setMarker(r.lat, r.lng);
  }
}
function closeModal() { $("#modal").classList.add("hidden"); if (detailMap) { detailMap.destroy(); detailMap = null; } }
$("#modalClose").onclick = closeModal;
$("#modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") { $("#lightbox").classList.add("hidden"); closeModal(); $("#settingsModal").classList.add("hidden"); } });
$("#btnEdit").onclick = () => current && startEdit(current);
$("#btnDelete").onclick = async () => {
  if (!current || !confirm(`‘${current.farmName}’ 기록과 사진을 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try { await DB.remove(current.id); toast("삭제되었습니다."); closeModal(); await loadList(); }
  catch (e) { alert(e.message); }
};
$("#btnPrint").onclick = () => {
  const r = current; if (!r) return;
  const row = (k, v) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`;
  $("#printArea").innerHTML = `<h1>병해충 예찰 진단 결과서</h1>
    <table>${row("농가명", r.farmName)}${row("농가주", r.farmer)}${row("연락처", r.phone)}${row("주소", r.address)}
    ${row("방문일시", r.visitedAt)}${r.advisor ? row("담당지도사", r.advisor) : ""}${row("작물 / 면적", [r.crop, r.area].filter(Boolean).join(" / "))}
    ${row("병해충명", `${r.pestName} (${r.category}, ${r.severity}${r.incidence ? ", 발생률 " + r.incidence + "%" : ""})`)}${row("증상", r.symptoms)}${row("진단", r.diagnosis)}
    ${row("대처방안", r.remedy)}${r.notes ? row("비고", r.notes) : ""}${r.aiResult?.candidates?.length ? row("AI 추론(참고)", r.aiResult.candidates.map((c, i) => `${i + 1}. ${c.name} (${c.confidence}%)\n   근거: ${(c.evidence || []).join(" / ")}`).join("\n")) : ""}</table>
    <div class="pimgs">${(r.photos || []).slice(0, 6).map(p => `<img src="${esc(P(p))}">`).join("")}</div>
    <p style="text-align:right;margin-top:20px">${new Date().toLocaleDateString("ko-KR")}</p>`;
  const imgs = $$("#printArea img");
  Promise.all(imgs.map(i => i.complete ? 1 : new Promise(res => { i.onload = i.onerror = res; }))).then(() => window.print());
};

/* ---------- 보고서 ---------- */
let curReport = null;
function exportRecordsXlsx(list, name) { return Report.exportRecords(list, name); }
function initReportCtl() {
  const y = new Date().getFullYear(), years = new Set([y]);
  records.forEach(r => { const v = +(r.visitedAt || "").slice(0, 4); if (v) years.add(v); });
  const keepY = $("#rYear").value;
  $("#rYear").innerHTML = [...years].sort((a, b) => b - a).map(v => `<option value="${v}">${v}년</option>`).join("");
  if (keepY) $("#rYear").value = keepY;
  if (!$("#rM").options.length) {
    $("#rM").innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}월</option>`).join("");
    $("#rM").value = new Date().getMonth() + 1; $("#rQ").value = Math.floor(new Date().getMonth() / 3) + 1;
    const d = new Date(); $("#rTo").value = d.toISOString().slice(0, 10); d.setMonth(d.getMonth() - 3); $("#rFrom").value = d.toISOString().slice(0, 10);
  }
  const keepA = $("#rAdv").value;
  $("#rAdv").innerHTML = '<option value="">전체</option>' + [...new Set(records.map(r => r.advisor).filter(Boolean))].sort().map(a => `<option>${esc(a)}</option>`).join("");
  $("#rAdv").value = keepA;
  if (!$("#rOrg").value) $("#rOrg").value = localStorage.getItem("pestwatch.org") || "";
  syncReportKind();
  $("#rNote").textContent = DB === Cloud ? "공유 저장소의 모든 사람 기록으로 만들어요." : DB.mode === "pc" ? "이 PC 프로그램에 저장된 기록으로 만들어요." : "이 휴대폰에 저장된 기록으로 만들어요. 여러 사람 기록을 합치려면 설정에서 공유 저장소를 연결하세요.";
  renderSavedReports();
}
function syncReportKind() {
  const k = $("#rKind").value;
  $("#rYearL").classList.toggle("hidden", k === "custom");
  $("#rQL").classList.toggle("hidden", k !== "quarter");
  $("#rML").classList.toggle("hidden", k !== "month");
  $("#rFromL").classList.toggle("hidden", k !== "custom"); $("#rToL").classList.toggle("hidden", k !== "custom");
}
$("#rKind").onchange = syncReportKind;
function reportOpt() {
  return { kind: $("#rKind").value, year: $("#rYear").value, q: +$("#rQ").value, month: +$("#rM").value, from: $("#rFrom").value, to: $("#rTo").value, advisor: $("#rAdv").value, title: $("#rTitle").value.trim(), org: $("#rOrg").value.trim() };
}
function showReport(a) {
  curReport = a;
  $("#reportOut").classList.remove("hidden");
  $("#reportOut").innerHTML = Report.html(a);
  Report.drawMap(a);
  ["#btnRSave", "#btnRPdf", "#btnRXlsx"].forEach(s => $(s).disabled = false);
  $("#reportOut").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("#btnRMake").onclick = async () => {
  const o = reportOpt();
  if (o.kind === "custom" && (!o.from || !o.to || o.from > o.to)) { toast("시작일과 종료일을 확인해 주세요."); return; }
  const b = $("#btnRMake"); b.disabled = true; b.textContent = "만드는 중…";
  try { await refresh(); if (o.org) localStorage.setItem("pestwatch.org", o.org); showReport(Report.aggregate(records, o)); }
  catch (e) { toast("보고서 만들기 실패: " + e.message, 5000); }
  b.disabled = false; b.textContent = "보고서 만들기";
};
$("#btnRSave").onclick = () => {
  if (!curReport) return;
  curReport = Report.save(curReport); renderSavedReports(); toast("보고서를 저장했어요. 아래 ‘저장한 보고서’에서 다시 열 수 있어요.");
};
$("#btnRPdf").onclick = () => {
  if (!curReport) return;
  document.body.classList.add("print-report");
  setTimeout(() => Report.refit(), 100);
  setTimeout(() => { window.print(); setTimeout(() => { document.body.classList.remove("print-report"); Report.refit(); }, 500); }, 900);
};
$("#btnRXlsx").onclick = async () => {
  if (!curReport) return;
  try { await Report.exportReport(curReport, records); } catch (e) { toast("엑셀 만들기 실패: " + e.message, 5000); }
};
$("#btnRRecs").onclick = async () => {
  const o = reportOpt(), p = Report.period(o);
  if (!p.from || !p.to) { toast("기간을 확인해 주세요."); return; }
  try {
    await refresh();
    const list = records.filter(r => { const d = (r.visitedAt || "").slice(0, 10); return d >= p.from && d <= p.to && (!o.advisor || r.advisor === o.advisor); });
    if (!list.length) { toast("이 기간에는 기록이 없어요."); return; }
    await Report.exportRecords(list, `예찰기록_${p.label.replace(/\s+/g, "")}`);
  } catch (e) { toast("엑셀 만들기 실패: " + e.message, 5000); }
};
function renderSavedReports() {
  const l = Report.listSaved();
  $("#savedReports").innerHTML = l.length ? l.map(x => `<div class="sv"><div><b>${esc(x.title)}</b><span class="muted small">${esc(x.label)} · 예찰 ${x.kpi.total}건 · 저장 ${esc(x.savedAt || "")}</span></div>
    <button type="button" data-ropen="${esc(x.id)}">열기</button><button type="button" class="ghost" data-rdel="${esc(x.id)}">삭제</button></div>`).join("")
    : '<p class="muted small">아직 저장한 보고서가 없어요. 보고서를 만든 뒤 ‘저장’을 누르세요. 저장한 보고서는 그때의 집계 그대로 남아요.</p>';
  $$("#savedReports [data-ropen]").forEach(b => b.onclick = () => { const x = Report.listSaved().find(r => r.id === b.dataset.ropen); if (x) showReport(x); });
  $$("#savedReports [data-rdel]").forEach(b => b.onclick = () => { if (confirm("이 보고서를 삭제할까요?")) { Report.removeSaved(b.dataset.rdel); renderSavedReports(); } });
}

/* ---------- 전체 지도 ---------- */
let bigMap = null;
const SEV_COLOR = { 경미: "#2fb36a", 보통: "#f2994a", 심각: "#e5484d" };
async function renderBigMap() {
  try { await refresh(); } catch (e) { toast(e.message); }
  if (!bigMap) bigMap = GeoKit.createMap($("#bigMap"), { center: DEFAULT_CENTER, zoom: 7 });
  setTimeout(() => bigMap.relayout(), 50);
  const pts = records.filter(r => r.lat != null && r.lng != null);
  bigMap.setPins(pts.map(r => ({
    lat: r.lat, lng: r.lng,
    html: `<div class="pin" style="background:${SEV_COLOR[r.severity] || "#607d8b"}"><span>${CAT_LETTER(r.category)}</span></div>`,
    popup: `<b>${esc(r.farmName)}</b><br>${esc(r.visitedAt?.slice(0, 10))} · ${esc(r.crop)}<br>${CAT_EM[r.category] || ""} ${esc(r.pestName)} <span class="sev ${esc(r.severity)}">${SEV_EM[r.severity] || ""} ${esc(r.severity)}</span>${r.advisor ? `<br>${esc(r.advisor)}` : ""}<br><a href="#" data-open="${esc(r.id)}">상세 보기</a>`,
  })));
  $("#mapCount").textContent = `${pts.length}곳 · ${GeoKit.provider === "kakao" ? "카카오지도" : "OpenStreetMap"}`;
  if (pts.length) setTimeout(() => bigMap.fitPins(), 120);
}
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-open]");
  if (a) { e.preventDefault(); openDetail(a.dataset.open); }
});

/* ---------- 기타 ---------- */
$("#btnDataFolder").onclick = () => fetch("/api/open-data-folder");
$("#btnQuit").onclick = async () => {
  if (!confirm("프로그램을 종료할까요?")) return;
  try { await fetch("/api/quit"); } catch (e) { }
  document.body.innerHTML = '<div style="padding:60px;text-align:center;font-size:18px">프로그램이 종료되었습니다. 이 창을 닫아 주세요.</div>';
  setTimeout(() => window.close(), 500);
};

/* ---------- 백업 · 가져오기 · CSV ---------- */
function downloadBlob(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => fromInputDT(nowLocal()).replace(/[-: ]/g, "").slice(0, 12);
$("#btnBackup").onclick = async () => {
  try {
    toast("백업 파일 만드는 중…");
    const data = await DB.backup();
    const name = `예찰기록백업_${DB.mode === "pc" ? "PC" : "휴대폰"}_${stamp()}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const file = new File([blob], name, { type: "application/json" });
    if (DB.mode === "mobile" && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "예찰 기록 백업" }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    downloadBlob(blob, name);
    toast(`백업 파일 저장: ${data.records.length}건`);
  } catch (e) { alert("백업 실패: " + e.message); }
};
$("#importInput").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.records)) throw new Error("예찰 기록 백업 파일이 아닙니다");
    const r = await DB.importData(data);
    alert(`가져오기 완료: 새 기록 ${r.added}건 추가, 이미 있는 기록 ${r.skipped}건 건너뜀`);
    await loadList();
  } catch (err) { alert("가져오기 실패: " + err.message); }
};
$("#btnCSV").onclick = async () => {
  try { await exportRecordsXlsx(typeof filtered === "function" ? filtered() : records, "예찰기록"); }
  catch (e) { toast("엑셀 만들기 실패: " + e.message, 5000); }
};

/* ---------- PC: 설정을 프로그램 데이터 폴더에도 저장 (업데이트해도 유지) ---------- */
async function syncPrefs() {
  try {
    const server = await (await fetch("/api/prefs")).json();
    const local = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("pestwatch.")) local[k] = localStorage.getItem(k); }
    for (const [k, v] of Object.entries(server)) localStorage.setItem(k, v);           // 저장된 설정 복원
    const missing = Object.fromEntries(Object.entries(local).filter(([k]) => !(k in server)));
    if (Object.keys(missing).length) await fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(missing) });
    // 이후 바뀌는 설정은 바로 서버에도 저장
    const push = (k, v) => { if (String(k).startsWith("pestwatch.")) fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [k]: v }) }).catch(() => { }); };
    const set = Storage.prototype.setItem, rm = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k, v) { set.call(this, k, v); if (this === localStorage) push(k, String(v)); };
    Storage.prototype.removeItem = function (k) { rm.call(this, k); if (this === localStorage) push(k, null); };
  } catch (e) { }
}

(async () => {
  renderRef();
  let isPC = false;
  try { const r = await fetch("/api/ping"); isPC = r.ok && !!(await r.json()).app; } catch (e) { }
  if (!isPC) {
    DB = Local;
    document.body.classList.add("mobile-mode");
    try { await Local.open(); } catch (e) { alert("이 브라우저에서는 기록을 저장할 수 없습니다: " + e.message); }
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => { });
    readJoinLink();
    if (Cloud.configured()) DB = Cloud;
    RDA.setLive((api, p) => Cloud.rda(api, p), () => DB === Cloud);
  }
  if (DB.mode === "pc") await syncPrefs();
  await GeoKit.init({ nominatim: { reverse: (la, ln) => DB.reverse(la, ln), search: q => DB.search(q) } });
  initFormMap();
  setAIButton();
  try { await RDA.init({ mode: DB.mode, idb: DB.mode === "pc" ? null : Local.db }); } catch (e) { }
  updateCropList(); updatePestList(); renderRdaRef();
  RDA.loadBundled(() => toast("농진청 작물·병해충·농약 자료를 넣는 중이에요…", 4000))
    .then(ok => { if (ok) { updateCropList(); updatePestList(); renderRdaRef(); refreshRdaState(); const st = RDA.stats(); toast(`농진청 자료를 넣었어요: 작물 ${st.crops.toLocaleString()}종 · 병해충 ${st.pests.toLocaleString()}건 · 등록농약 ${st.pesti.toLocaleString()}건`, 5000); } })
    .catch(e => console.warn("내장 농진청 자료", e));
  try { await refresh(); } catch (e) { toast((DB === Cloud ? "공유 저장소에서 " : "") + "기록 불러오기 실패: " + e.message, 6000); }
  resetForm();
  if (GeoKit.getKakaoKey() && GeoKit.provider !== "kakao") toast("카카오지도를 불러오지 못해 기본 지도로 열었어요. 설정을 확인하세요.", 4500);
})();
