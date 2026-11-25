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
      const r = indexedDB.open("pestwatch", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("records", { keyPath: "id" }); r.result.createObjectStore("photos"); };
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
  if (name === "new") setTimeout(() => formMap.invalidateSize(), 50);
}
$$("nav button").forEach(b => b.onclick = () => showTab(b.dataset.tab));

/* ---------- 입력 지도 ---------- */
const formMap = L.map("formMap").setView(DEFAULT_CENTER, 7);
L.tileLayer(TILE_URL, TILE_OPT).addTo(formMap);
let formMarker = null;
function setFormPoint(lat, lng, { zoom = true, reverse = true } = {}) {
  const f = $("#recForm");
  f.lat.value = (+lat).toFixed(6); f.lng.value = (+lng).toFixed(6);
  if (!formMarker) {
    formMarker = L.marker([lat, lng], { draggable: true }).addTo(formMap);
    formMarker.on("dragend", e => { const p = e.target.getLatLng(); setFormPoint(p.lat, p.lng, { zoom: false }); });
  } else formMarker.setLatLng([lat, lng]);
  if (zoom) formMap.setView([lat, lng], Math.max(formMap.getZoom(), 16));
  if (reverse) reverseGeocode(lat, lng);
}
formMap.on("click", e => setFormPoint(e.latlng.lat, e.latlng.lng, { zoom: false }));
["lat", "lng"].forEach(n => $("#recForm")[n].addEventListener("change", () => {
  const f = $("#recForm"); const la = parseFloat(f.lat.value), ln = parseFloat(f.lng.value);
  if (!isNaN(la) && !isNaN(ln)) setFormPoint(la, ln);
}));

function fmtAddr(j) {
  const a = j.address || {};
  // 한국식 주소 조합 (도/시군구/읍면동/리/번지)
  const parts = [a.province || a.state, a.city || a.county, a.borough, a.town || a.suburb || a.village, a.quarter, a.hamlet, a.road, a.house_number]
    .filter(Boolean);
  const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
  return uniq.length ? uniq.join(" ") : (j.display_name || "");
}
async function reverseGeocode(lat, lng) {
  const f = $("#recForm");
  $("#locStatus").textContent = "주소 확인 중…";
  try {
    const j = await DB.reverse(lat, lng);
    const addr = fmtAddr(j);
    if (addr) f.address.value = addr;
    $("#locStatus").textContent = "위치 기록됨";
  } catch (e) {
    $("#locStatus").textContent = "좌표는 기록됨 (주소 자동조회 실패 — 직접 입력하세요)";
  }
}

$("#btnLocate").onclick = () => {
  const f = $("#recForm");
  f.visitedAt.value = nowLocal();
  if (!navigator.geolocation) { $("#locStatus").textContent = "이 환경에서는 위치 기능을 쓸 수 없습니다. 지도 클릭 또는 주소 검색을 이용하세요."; return; }
  $("#locStatus").textContent = "현재 위치 확인 중… (처음에는 위치 권한 허용 창이 뜰 수 있습니다)";
  $("#btnLocate").disabled = true;
  navigator.geolocation.getCurrentPosition(pos => {
    $("#btnLocate").disabled = false;
    const { latitude, longitude, accuracy } = pos.coords;
    setFormPoint(latitude, longitude);
    $("#locStatus").textContent = `위치 기록됨 (오차 약 ${Math.round(accuracy)}m)`;
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
    const list = await DB.search(q);
    if (!list.length) { box.innerHTML = '<div class="muted">검색 결과가 없습니다. 읍·면·리 단위로 검색해 보세요.</div>'; return; }
    box.innerHTML = list.map((x, i) => `<div data-i="${i}">${esc(x.display_name)}</div>`).join("");
    $$("div[data-i]", box).forEach(d => d.onclick = () => {
      const x = list[d.dataset.i]; box.innerHTML = "";
      setFormPoint(+x.lat, +x.lon, { reverse: false });
      $("#recForm").address.value = q;
      $("#locStatus").textContent = "검색 위치로 지정됨 (마커를 끌어 미세 조정 가능)";
    });
  } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}
$("#btnAddrSearch").onclick = addrSearch;
$("#addrSearch").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addrSearch(); } });

/* ---------- 사진 ---------- */
function resizeImage(file, max = 1920) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w <= max && h <= max && file.size < 1.5e6) { resolve(file); URL.revokeObjectURL(url); return; }
      const s = Math.min(max / w, max / h, 1); w = Math.round(w * s); h = Math.round(h * s);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      c.toBlob(b => { URL.revokeObjectURL(url); resolve(b || file); }, "image/jpeg", 0.88);
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
$("#pestList").innerHTML = PEST_REF.map(p => `<option value="${esc(p.name)}">${esc(p.category)} · ${esc(p.crops)}</option>`).join("");
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
  $("#refList").innerHTML = list.map(p => `<div class="ref"><h4>${esc(p.name)}</h4><div class="tag">${esc(p.category)} · ${esc(p.crops)}</div>
    <p><b>증상</b> ${esc(p.symptoms)}</p><p><b>진단</b> ${esc(p.diagnosis)}</p><p><b>대처</b>\n${esc(p.remedy)}</p>
    <button data-use="${esc(p.name)}">이 내용으로 새 기록 작성</button></div>`).join("");
  $$("button[data-use]").forEach(b => b.onclick = () => {
    showTab("new"); const f = $("#recForm"); f.pestName.value = b.dataset.use;
    f.symptoms.value = f.diagnosis.value = f.remedy.value = ""; fillFromRef(false);
  });
}
$("#refQ").oninput = renderRef;

/* ---------- 저장 ---------- */
function resetForm() {
  const f = $("#recForm"); f.reset();
  editingId = null; existingPhotos = [];
  pendingPhotos.forEach(p => URL.revokeObjectURL(p.url)); pendingPhotos = [];
  renderThumbs();
  if (formMarker) { formMap.removeLayer(formMarker); formMarker = null; }
  $("#locStatus").textContent = ""; $("#searchResults").innerHTML = "";
  $("#editBadge").classList.add("hidden");
  $("#btnSave").textContent = "💾 저장";
  f.visitedAt.value = nowLocal();
  // 마지막 기록 위치 근처로 지도 이동
  const last = records.find(r => r.lat != null);
  if (last) formMap.setView([last.lat, last.lng], 12);
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
      address: f.address.value.trim(), lat: num(f.lat.value), lng: num(f.lng.value),
      visitedAt: fromInputDT(f.visitedAt.value) || fromInputDT(nowLocal()),
      crop: f.crop.value.trim(), area: f.area.value.trim(), category: f.category.value, pestName: f.pestName.value.trim(),
      severity: f.severity.value, symptoms: f.symptoms.value, diagnosis: f.diagnosis.value, remedy: f.remedy.value,
      notes: f.notes.value, status: f.status.value, photos: [...existingPhotos],
    };
    const saved = await DB.save(editingId, rec, pendingPhotos);
    toast(editingId ? "수정되었습니다." : "저장되었습니다.");
    await refresh();
    resetForm();
    openDetail(saved.id);
  } catch (err) {
    alert("저장하지 못했습니다: " + err.message);
  } finally { btn.disabled = false; if (btn.textContent.includes("중…")) btn.textContent = editingId ? "💾 수정 저장" : "💾 저장"; }
};

function startEdit(r) {
  resetForm();
  editingId = r.id;
  const f = $("#recForm");
  ["farmName", "farmer", "phone", "email", "address", "crop", "area", "category", "pestName", "severity", "symptoms", "diagnosis", "remedy", "notes", "status"]
    .forEach(k => { if (f[k]) f[k].value = r[k] ?? ""; });
  f.visitedAt.value = toInputDT(r.visitedAt);
  if (r.lat != null && r.lng != null) setFormPoint(r.lat, r.lng, { reverse: false });
  existingPhotos = [...(r.photos || [])];
  renderThumbs();
  $("#editBadge").classList.remove("hidden");
  $("#btnSave").textContent = "💾 수정 저장";
  closeModal(); showTab("new");
}

/* ---------- 목록 ---------- */
async function refresh() { records = await DB.list(); }
function filtered() {
  const q = $("#q").value.trim(), c = $("#fCat").value, s = $("#fStatus").value, from = $("#fFrom").value, to = $("#fTo").value;
  return records.filter(r => {
    if (q && !(r.farmName + r.farmer + r.address + r.crop + r.pestName + r.symptoms + r.notes).includes(q)) return false;
    if (c && r.category !== c) return false;
    if (s && r.status !== s) return false;
    const d = (r.visitedAt || "").slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}
function renderList() {
  const list = filtered();
  $("#summary").textContent = `총 ${records.length}건 중 ${list.length}건 표시`;
  $("#listBody").innerHTML = list.length ? list.map(r => `<tr data-id="${esc(r.id)}">
    <td>${r.photos?.length ? `<img src="${esc(P(r.photos[0]))}">` : ""}</td>
    <td>${esc(r.visitedAt?.slice(0, 16))}</td><td><b>${esc(r.farmName)}</b><div class="muted">${esc(r.farmer)}</div></td>
    <td>${esc(r.address)}</td><td>${esc(r.crop)}</td><td>${esc(r.pestName)}<div class="muted">${esc(r.category)}</div></td>
    <td><span class="sev ${esc(r.severity)}">${esc(r.severity)}</span></td><td><span class="st ${esc(r.status)}">${esc(r.status)}</span></td></tr>`).join("")
    : `<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">기록이 없습니다. ‘새 예찰 기록’에서 작성하세요.</td></tr>`;
  $$("#listBody tr[data-id]").forEach(tr => tr.onclick = () => openDetail(tr.dataset.id));
}
async function loadList() { try { await refresh(); renderList(); } catch (e) { toast(e.message); } }
["q", "fCat", "fStatus", "fFrom", "fTo"].forEach(id => $("#" + id).addEventListener("input", renderList));

/* ---------- 상세 ---------- */
let detailMap = null;
function detailHTML(r) {
  const rows = [["방문일시", r.visitedAt], ["농가주", r.farmer], ["연락처", r.phone], ["이메일", r.email], ["주소", r.address],
    ["좌표", r.lat != null ? `${(+r.lat).toFixed(6)}, ${(+r.lng).toFixed(6)}` : ""], ["작물", r.crop], ["재배면적", r.area],
    ["구분", r.category], ["병해충명", r.pestName], ["심각도", r.severity], ["증상", r.symptoms], ["진단", r.diagnosis],
    ["대처방안", r.remedy], ["비고", r.notes], ["처리상태", r.status]];
  return `<div class="detail"><h3>${esc(r.farmName)}</h3><div class="muted">기록 ${esc(r.createdAt)}${r.updatedAt !== r.createdAt ? " · 수정 " + esc(r.updatedAt) : ""}</div>
    <div class="thumbs">${(r.photos || []).map(p => `<div class="thumb"><img src="${esc(P(p))}" data-full="${esc(P(p))}"></div>`).join("")}</div>
    ${r.lat != null ? '<div id="detailMap" class="map"></div>' : ""}
    <dl class="kv">${rows.filter(x => x[1]).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>`;
}
function openDetail(id) {
  const r = records.find(x => x.id === id); if (!r) return;
  current = r;
  $("#detail").innerHTML = detailHTML(r);
  $("#modal").classList.remove("hidden");
  if (detailMap) { detailMap.remove(); detailMap = null; }
  if (r.lat != null) {
    detailMap = L.map("detailMap").setView([r.lat, r.lng], 16);
    L.tileLayer(TILE_URL, TILE_OPT).addTo(detailMap);
    L.marker([r.lat, r.lng]).addTo(detailMap);
  }
}
function closeModal() { $("#modal").classList.add("hidden"); if (detailMap) { detailMap.remove(); detailMap = null; } }
$("#modalClose").onclick = closeModal;
$("#modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") { $("#lightbox").classList.add("hidden"); closeModal(); } });
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
    ${row("방문일시", r.visitedAt)}${row("작물 / 면적", [r.crop, r.area].filter(Boolean).join(" / "))}
    ${row("병해충명", `${r.pestName} (${r.category}, ${r.severity})`)}${row("증상", r.symptoms)}${row("진단", r.diagnosis)}
    ${row("대처방안", r.remedy)}${r.notes ? row("비고", r.notes) : ""}</table>
    <div class="pimgs">${(r.photos || []).slice(0, 6).map(p => `<img src="${esc(P(p))}">`).join("")}</div>
    <p style="text-align:right;margin-top:20px">${new Date().toLocaleDateString("ko-KR")}</p>`;
  const imgs = $$("#printArea img");
  Promise.all(imgs.map(i => i.complete ? 1 : new Promise(res => { i.onload = i.onerror = res; }))).then(() => window.print());
};

/* ---------- 전체 지도 ---------- */
let bigMap = null, bigLayer = null;
const SEV_COLOR = { 경미: "#43a047", 보통: "#ef8f00", 심각: "#c62828" };
async function renderBigMap() {
  try { await refresh(); } catch (e) { toast(e.message); }
  if (!bigMap) {
    bigMap = L.map("bigMap").setView(DEFAULT_CENTER, 7);
    L.tileLayer(TILE_URL, TILE_OPT).addTo(bigMap);
    bigLayer = L.featureGroup().addTo(bigMap);
  }
  setTimeout(() => bigMap.invalidateSize(), 50);
  bigLayer.clearLayers();
  const pts = records.filter(r => r.lat != null && r.lng != null);
  pts.forEach(r => {
    const icon = L.divIcon({ className: "", html: `<div class="mk" style="background:${SEV_COLOR[r.severity] || "#607d8b"}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
    L.marker([r.lat, r.lng], { icon }).addTo(bigLayer)
      .bindPopup(`<b>${esc(r.farmName)}</b><br>${esc(r.visitedAt?.slice(0, 10))} · ${esc(r.crop)}<br>${esc(r.pestName)} <span class="sev ${esc(r.severity)}">${esc(r.severity)}</span><br><a href="#" data-open="${esc(r.id)}">상세 보기</a>`);
  });
  $("#mapCount").textContent = `위치가 기록된 ${pts.length}곳`;
  if (pts.length) setTimeout(() => bigMap.fitBounds(bigLayer.getBounds().pad(0.2), { maxZoom: 15 }), 80);
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
$("#btnCSV").onclick = () => {
  if (DB.mode === "pc") { location.href = "/api/export.csv"; return; }
  const head = ["방문일시", "농가명", "농가주", "연락처", "이메일", "주소", "위도", "경도", "작물", "면적", "구분", "병해충명", "심각도", "증상", "진단", "대처방안", "비고", "처리상태", "사진수"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = records.map(x => [x.visitedAt, x.farmName, x.farmer, x.phone, x.email, x.address, x.lat, x.lng, x.crop, x.area, x.category, x.pestName, x.severity, x.symptoms, x.diagnosis, x.remedy, x.notes, x.status, (x.photos || []).length].map(q).join(","));
  downloadBlob(new Blob(["\ufeff" + [head.map(q).join(","), ...rows].join("\r\n")], { type: "text/csv" }), `예찰기록_${stamp()}.csv`);
};

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
  }
  try { await refresh(); } catch (e) { toast("기록 불러오기 실패: " + e.message); }
  resetForm();
})();
