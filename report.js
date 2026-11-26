"use strict";
// 병해충 예찰 보고서: 기간별 집계 · 그래프 · 지역 지도 · 방제 권고 · 저장 · PDF · 엑셀
window.Report = (() => {
  const CAT_COLOR = { 병해: "#3b82f6", 충해: "#f2994a", 생리장해: "#8b5cf6", 기타: "#94a3b8" };
  const SEV_COLOR = { 경미: "#2fb36a", 보통: "#f2994a", 심각: "#e5484d" };
  const PALETTE = ["#1f7a4d", "#2f9e66", "#4db884", "#7cc47f", "#a3d9a5", "#c7e8c8"];
  const SAVE_KEY = "pestwatch.reports";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const num = v => { const n = parseFloat(String(v ?? "").replace(/[^\d.]/g, "")); return isFinite(n) ? n : null; };
  const pct = (a, b) => b ? Math.round(1000 * a / b) / 10 : 0;

  /* ---------- 기간 ---------- */
  function period({ kind, year, q, month, from, to }) {
    year = +year;
    if (kind === "year") return { from: `${year}-01-01`, to: `${year}-12-31`, label: `${year}년 연간` };
    if (kind === "quarter") { const m0 = (q - 1) * 3; return { from: ymd(new Date(year, m0, 1)), to: ymd(new Date(year, m0 + 3, 0)), label: `${year}년 ${q}분기` }; }
    if (kind === "month") return { from: ymd(new Date(year, month - 1, 1)), to: ymd(new Date(year, month, 0)), label: `${year}년 ${month}월` };
    return { from, to, label: `${from} ~ ${to}` };
  }
  function prevPeriod(from, to) {
    const f = new Date(from + "T00:00:00"), t = new Date(to + "T00:00:00");
    const days = Math.round((t - f) / 864e5) + 1;
    const pt = new Date(f); pt.setDate(pt.getDate() - 1);
    const pf = new Date(pt); pf.setDate(pf.getDate() - days + 1);
    return { from: ymd(pf), to: ymd(pt) };
  }
  const inRange = (r, from, to) => { const d = (r.visitedAt || "").slice(0, 10); return d >= from && d <= to; };

  /* ---------- 지역 (시군구 + 읍면동) ---------- */
  function regionOf(r) {
    const toks = `${r.jibun || ""} ${r.address || ""}`.split(/\s+/).filter(Boolean);
    const sgg = toks.find(t => /[가-힣](시|군|구)$/.test(t) && !/(특별시|광역시|자치시)$/.test(t)) || toks.find(t => /(시|군|구)$/.test(t));
    const emd = toks.find(t => /[가-힣](읍|면|동|가)$/.test(t) && !/\d/.test(t));
    if (!sgg && !emd) return "주소 미상";
    return [sgg, emd].filter(Boolean).join(" ");
  }

  /* ---------- 집계 ---------- */
  function aggregate(all, opt) {
    const p = period(opt);
    let recs = all.filter(r => inRange(r, p.from, p.to));
    if (opt.advisor) recs = recs.filter(r => (r.advisor || "") === opt.advisor);
    const pv = prevPeriod(p.from, p.to);
    let prev = all.filter(r => inRange(r, pv.from, pv.to));
    if (opt.advisor) prev = prev.filter(r => (r.advisor || "") === opt.advisor);

    const farms = new Set(recs.map(r => (r.farmName || "") + "|" + (r.address || r.jibun || "")));
    const inc = recs.map(r => num(r.incidence)).filter(v => v != null);
    const kpi = {
      total: recs.length, prevTotal: prev.length, farms: farms.size,
      pests: new Set(recs.map(r => r.pestName).filter(Boolean)).size,
      severe: recs.filter(r => r.severity === "심각").length,
      avgInc: inc.length ? Math.round(10 * inc.reduce((a, b) => a + b, 0) / inc.length) / 10 : null,
      done: recs.filter(r => r.status === "완료").length,
    };

    const group = (keyFn) => {
      const m = new Map();
      for (const r of recs) { const k = keyFn(r); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return m;
    };
    const pestMap = group(r => r.pestName || "미정");
    const byPest = [...pestMap].map(([name, rs]) => {
      const iv = rs.map(r => num(r.incidence)).filter(v => v != null);
      const cat = mode(rs.map(r => r.category));
      return {
        name, category: cat, count: rs.length,
        crops: [...new Set(rs.map(r => r.crop).filter(Boolean))].slice(0, 6).join(", "),
        regions: [...new Set(rs.map(regionOf))].length,
        severe: rs.filter(r => r.severity === "심각").length,
        avgInc: iv.length ? Math.round(10 * iv.reduce((a, b) => a + b, 0) / iv.length) / 10 : null,
        prev: prev.filter(r => (r.pestName || "미정") === name).length,
      };
    }).sort((a, b) => b.count - a.count);
    const byCrop = [...group(r => r.crop || "미입력")].map(([name, rs]) => ({ name, count: rs.length, top: mode(rs.map(r => r.pestName).filter(Boolean)) || "" })).sort((a, b) => b.count - a.count);
    const byCat = ["병해", "충해", "생리장해", "기타"].map(c => ({ name: c, count: recs.filter(r => (r.category || "기타") === c).length }));
    const bySev = ["경미", "보통", "심각"].map(s => ({ name: s, count: recs.filter(r => r.severity === s).length }));

    // 월별 (최대 24개월)
    const months = [];
    { const f = new Date(p.from.slice(0, 7) + "-01T00:00:00"), t = new Date(p.to.slice(0, 7) + "-01T00:00:00");
      for (let d = new Date(f); d <= t && months.length < 24; d.setMonth(d.getMonth() + 1)) months.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); }
    const byMonth = months.map(m => { const rs = recs.filter(r => (r.visitedAt || "").slice(0, 7) === m); const o = { name: m, count: rs.length }; for (const c of ["병해", "충해", "생리장해", "기타"]) o[c] = rs.filter(r => (r.category || "기타") === c).length; return o; });

    // 지역
    const regions = [...group(regionOf)].map(([name, rs]) => {
      const pts = rs.filter(r => r.lat != null && r.lng != null);
      const pc = countBy(rs.map(r => r.pestName).filter(Boolean));
      return {
        name, count: rs.length, severe: rs.filter(r => r.severity === "심각").length,
        lat: pts.length ? pts.reduce((a, r) => a + r.lat, 0) / pts.length : null,
        lng: pts.length ? pts.reduce((a, r) => a + r.lng, 0) / pts.length : null,
        top: pc.slice(0, 3).map(([n, c]) => `${n}(${c})`).join(", "),
      };
    }).sort((a, b) => b.count - a.count);
    const points = recs.filter(r => r.lat != null && r.lng != null).map(r => ({ lat: r.lat, lng: r.lng, sev: r.severity, cat: r.category, pest: r.pestName, farm: r.farmName, date: (r.visitedAt || "").slice(0, 10) }));

    // 방제 권고: 상위 병해충별 현장 대처방안(가장 많이 쓴 것) + 참고자료
    const refs = window.PEST_REF || [];
    const advice = byPest.filter(x => x.name !== "미정").slice(0, 6).map(x => {
      const rs = pestMap.get(x.name);
      const rem = countBy(rs.map(r => (r.remedy || "").trim()).filter(Boolean))[0]?.[0] || "";
      const ref = refs.find(f => f.name === x.name || x.name.includes(f.name));
      return { name: x.name, count: x.count, crops: x.crops, remedy: rem || ref?.remedy || "", source: rem ? "현장 기록" : ref ? "참고자료" : "" };
    });

    const advisors = [...new Set(all.map(r => r.advisor).filter(Boolean))].sort();
    return {
      v: 1, label: p.label + (opt.advisor ? ` · ${opt.advisor}` : ""), from: p.from, to: p.to, prevFrom: pv.from, prevTo: pv.to,
      title: opt.title || `병해충 예찰 결과 보고 (${p.label})`, org: opt.org || "", madeAt: new Date().toLocaleString("ko-KR"),
      kpi, byPest, byCrop, byCat, bySev, byMonth, regions, points, advice, advisors, recIds: recs.map(r => r.id),
    };
  }
  function countBy(arr) { const m = new Map(); arr.forEach(v => m.set(v, (m.get(v) || 0) + 1)); return [...m].sort((a, b) => b[1] - a[1]); }
  function mode(arr) { return countBy(arr.filter(Boolean))[0]?.[0] || ""; }

  /* ---------- SVG 그래프 ---------- */
  function hbar(items, { color = "#1f7a4d", colorFn, max = 12, unit = "건", W = narrow() ? 360 : 640, L = narrow() ? 92 : 150 } = {}) {
    items = items.slice(0, max);
    if (!items.length) return '<p class="muted small">자료 없음</p>';
    const rowH = 30, R = 56, H = items.length * rowH + 8;
    const mx = Math.max(...items.map(i => i.count), 1);
    const bars = items.map((it, i) => {
      const y = 4 + i * rowH, w = Math.max(2, (W - L - R) * it.count / mx);
      return `<text x="${L - 10}" y="${y + 19}" text-anchor="end" class="ch-l">${esc(trunc(it.name, L > 120 ? 11 : 6))}</text>
        <rect x="${L}" y="${y + 5}" width="${w}" height="${rowH - 12}" rx="5" fill="${colorFn ? colorFn(it) : color}"/>
        <text x="${L + w + 6}" y="${y + 19}" class="ch-v">${it.count}${unit}</text>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${bars}</svg>`;
  }
  function stackCols(months, keys, colors) {
    if (!months.length) return '<p class="muted small">자료 없음</p>';
    const W = narrow() ? 360 : 640, H = narrow() ? 220 : 240, L = 30, B = 34, T = 14, R = 6;
    const mx = Math.max(...months.map(m => m.count), 1), step = niceStep(mx), top = Math.ceil(mx / step) * step;
    const cw = (W - L - R) / months.length, bw = Math.min(46, cw * 0.62);
    const y = v => T + (H - T - B) * (1 - v / top);
    let g = "";
    for (let v = 0; v <= top; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="ch-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ch-ax">${v}</text>`;
    const cols = months.map((m, i) => {
      let acc = 0, x = L + i * cw + (cw - bw) / 2, out = "";
      for (const k of keys) { const v = m[k] || 0; if (!v) continue; out += `<rect x="${x}" y="${y(acc + v)}" width="${bw}" height="${y(acc) - y(acc + v)}" fill="${colors[k]}"/>`; acc += v; }
      const lab = months.length > 12 ? m.name.slice(2).replace("-", ".") : (+m.name.slice(5)) + (narrow() && months.length > 6 ? "" : "월");
      return out + (m.count ? `<text x="${x + bw / 2}" y="${y(m.count) - 4}" text-anchor="middle" class="ch-v">${m.count}</text>` : "") + `<text x="${x + bw / 2}" y="${H - B + 16}" text-anchor="middle" class="ch-ax">${lab}</text>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${g}${cols}</svg>` + legend(keys, colors);
  }
  function ratioBar(items, colors) {
    const tot = items.reduce((a, b) => a + b.count, 0);
    if (!tot) return '<p class="muted small">자료 없음</p>';
    let x = 0;
    const segs = items.filter(i => i.count).map(i => { const w = 100 * i.count / tot; const s = `<rect x="${x}%" y="0" width="${w}%" height="26" fill="${colors[i.name]}"/>` + (w > 9 ? `<text x="${x + w / 2}%" y="18" text-anchor="middle" class="ch-in">${Math.round(w)}%</text>` : ""); x += w; return s; }).join("");
    return `<svg viewBox="0 0 640 26" preserveAspectRatio="none" class="chart ratio">${segs}</svg>` + legend(items.map(i => i.name), colors, items.reduce((o, i) => (o[i.name] = i.count, o), {}));
  }
  function legend(keys, colors, counts) { return `<div class="ch-leg">${keys.map(k => `<span><i style="background:${colors[k]}"></i>${esc(k)}${counts ? ` ${counts[k]}건` : ""}</span>`).join("")}</div>`; }
  function niceStep(mx) { const raw = mx / 4, p = Math.pow(10, Math.floor(Math.log10(raw || 1))); return [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) || p * 10; }
  const narrow = () => window.innerWidth < 720;
  const trunc = (s, n) => (s = String(s)).length > n ? s.slice(0, n - 1) + "…" : s;

  /* ---------- 보고서 화면 ---------- */
  function html(a) {
    const k = a.kpi, diff = k.total - k.prevTotal;
    const diffTxt = k.prevTotal ? `${diff >= 0 ? "+" : ""}${diff}건 (${diff >= 0 ? "+" : ""}${pct(diff, k.prevTotal)}%)` : "직전 기간 기록 없음";
    const top = a.byPest[0];
    const summary = k.total
      ? `${a.label} 동안 농가 ${k.farms}곳에서 ${k.total}건을 예찰했습니다. 가장 많이 확인된 병해충은 ${esc(top.name)}(${top.count}건${top.crops ? ", " + esc(top.crops) : ""})이며, 심각 단계는 ${k.severe}건(${pct(k.severe, k.total)}%)입니다. 직전 같은 기간(${a.prevFrom} ~ ${a.prevTo})보다 예찰 건수가 ${diffTxt}.`
      : "이 기간에는 예찰 기록이 없습니다.";
    return `<article class="rpt">
      <div class="rpt-h"><div><h2>${esc(a.title)}</h2><p class="muted">${a.label.startsWith(a.from) ? "" : esc(a.label) + " · "}${a.from} ~ ${a.to}${a.org ? " · " + esc(a.org) : ""}</p></div><p class="muted small">작성 ${esc(a.madeAt)}</p></div>
      <div class="kpis">
        <div><b>${k.total}</b><span>예찰 건수</span><em class="${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${k.prevTotal ? (diff >= 0 ? "▲ " : "▼ ") + Math.abs(diff) : "-"}</em></div>
        <div><b>${k.farms}</b><span>조사 농가</span></div>
        <div><b>${k.pests}</b><span>병해충 종류</span></div>
        <div><b>${k.severe}</b><span>심각 단계</span><em>${pct(k.severe, k.total)}%</em></div>
        <div><b>${k.avgInc ?? "-"}${k.avgInc != null ? "%" : ""}</b><span>평균 발생률</span></div>
      </div>
      <section class="rpt-s"><h3>1. 요약</h3><p>${summary}</p></section>
      <section class="rpt-s"><h3>2. 병해충별 발생 빈도</h3>${hbar(a.byPest.map(p => ({ ...p })), { colorFn: it => CAT_COLOR[it.category] || CAT_COLOR.기타 })}${legend(Object.keys(CAT_COLOR), CAT_COLOR)}</section>
      <div class="rpt-2">
        <section class="rpt-s"><h3>3. 구분별 비율</h3>${ratioBar(a.byCat, CAT_COLOR)}<h3 style="margin-top:16px">심각도 비율</h3>${ratioBar(a.bySev, SEV_COLOR)}</section>
        <section class="rpt-s"><h3>4. 작목별 예찰 건수</h3>${hbar(a.byCrop, { max: 8, color: PALETTE[0], W: narrow() ? 360 : 420, L: 90 })}</section>
      </div>
      <section class="rpt-s"><h3>5. 월별 발생 추이</h3>${stackCols(a.byMonth, ["병해", "충해", "생리장해", "기타"], CAT_COLOR)}</section>
      <section class="rpt-s"><h3>6. 지역별 발생 분포</h3><div id="reportMap" class="map rpt-map"></div><p class="muted small">원 크기 = 예찰 건수, 빨간색일수록 심각 비율이 높아요.</p>
        <table class="rpt-t"><thead><tr><th>지역</th><th>건수</th><th>심각</th><th>주요 병해충</th></tr></thead><tbody>${a.regions.map(r => `<tr><td>${esc(r.name)}</td><td>${r.count}</td><td>${r.severe}</td><td>${esc(r.top)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">자료 없음</td></tr>'}</tbody></table></section>
      <section class="rpt-s"><h3>7. 병해충별 상세</h3>
        <table class="rpt-t"><thead><tr><th>병해충</th><th>구분</th><th>건수</th><th>직전 대비</th><th>지역 수</th><th>심각</th><th>평균 발생률</th><th>주요 작목</th></tr></thead><tbody>${a.byPest.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td>${p.count}</td><td>${p.count - p.prev >= 0 ? "+" : ""}${p.count - p.prev}</td><td>${p.regions}</td><td>${p.severe}</td><td>${p.avgInc != null ? p.avgInc + "%" : "-"}</td><td>${esc(p.crops)}</td></tr>`).join("") || '<tr><td colspan="8" class="muted">자료 없음</td></tr>'}</tbody></table></section>
      <section class="rpt-s"><h3>8. 주요 방제 권고</h3>${a.advice.length ? `<ol class="advice">${a.advice.map(x => `<li><b>${esc(x.name)}</b> <span class="muted small">${x.count}건${x.crops ? " · " + esc(x.crops) : ""}</span><p>${esc(x.remedy || "기록된 대처방안이 없어요.")}</p>${x.source ? `<span class="muted small">출처: ${x.source}</span>` : ""}</li>`).join("")}</ol>` : '<p class="muted small">자료 없음</p>'}
        <p class="muted small">약제 사용 시 농약안전정보시스템(psis.rda.go.kr)의 작목별 등록약제와 안전사용기준을 꼭 확인하세요.</p></section>
    </article>`;
  }

  let map = null;
  function drawMap(a) {
    const el = document.getElementById("reportMap"); if (!el || !window.GeoKit) return;
    if (map) { try { map.destroy(); } catch (e) { } map = null; }
    const regs = a.regions.filter(r => r.lat != null);
    map = GeoKit.createMap(el, { center: regs[0] ? [regs[0].lat, regs[0].lng] : [36.5, 127.8], zoom: regs.length ? 10 : 7 });
    const mx = Math.max(1, ...regs.map(r => r.count));
    map.setPins(regs.map(r => {
      const d = Math.round(26 + 44 * Math.sqrt(r.count / mx)), sr = r.count ? r.severe / r.count : 0;
      const col = sr >= 0.4 ? "#e5484d" : sr >= 0.15 ? "#f2994a" : "#1f7a4d";
      return {
        lat: r.lat, lng: r.lng,
        html: `<div class="bub" style="width:${d}px;height:${d}px;margin-left:${15 - d / 2}px;margin-top:${30 - d / 2}px;background:${col}">${r.count}</div>`,
        popup: `<b>${esc(r.name)}</b><br>예찰 ${r.count}건 · 심각 ${r.severe}건<br>${esc(r.top)}`,
      };
    }));
    setTimeout(() => { map.relayout(); if (regs.length) map.fitPins(); }, 150);
  }

  function refit() { if (map) { map.relayout(); map.fitPins(); } }

  /* ---------- 저장 ---------- */
  const listSaved = () => { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "[]"); } catch (e) { return []; } };
  function save(a) {
    const l = listSaved().filter(x => x.id !== a.id);
    const item = { ...a, id: a.id || "R" + Date.now(), savedAt: new Date().toLocaleString("ko-KR") };
    l.unshift(item); localStorage.setItem(SAVE_KEY, JSON.stringify(l.slice(0, 60)));
    return item;
  }
  function removeSaved(id) { localStorage.setItem(SAVE_KEY, JSON.stringify(listSaved().filter(x => x.id !== id))); }

  /* ---------- 엑셀 ---------- */
  let xlsxP = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return xlsxP ||= new Promise((res, rej) => { const s = document.createElement("script"); s.src = "vendor/xlsx.mini.min.js"; s.onload = res; s.onerror = () => { xlsxP = null; rej(new Error("엑셀 모듈을 불러오지 못했어요")); }; document.head.appendChild(s); });
  }
  function sheet(rows, widths) { const ws = XLSX.utils.aoa_to_sheet(rows); if (widths) ws["!cols"] = widths.map(w => ({ wch: w })); return ws; }
  const REC_HEAD = ["방문일시", "담당지도사", "농가명", "농가주", "연락처", "도로명주소", "지번주소", "지역", "위도", "경도", "작목", "면적", "구분", "병해충명", "심각도", "발생률(%)", "증상", "진단", "대처방안", "비고", "처리상태", "사진수", "AI 추론 1순위"];
  const recRow = x => [x.visitedAt, x.advisor, x.farmName, x.farmer, x.phone, x.address, x.jibun, regionOf(x), x.lat, x.lng, x.crop, x.area, x.category, x.pestName, x.severity, num(x.incidence) ?? "", x.symptoms, x.diagnosis, x.remedy, x.notes, x.status, (x.photos || []).length, x.aiResult?.candidates?.[0] ? `${x.aiResult.candidates[0].name}(${x.aiResult.candidates[0].confidence}%)` : ""];
  const recWidths = [18, 10, 14, 8, 14, 28, 28, 16, 10, 10, 10, 10, 8, 14, 7, 8, 30, 30, 40, 20, 8, 6, 18];
  async function exportRecords(list, name) {
    await loadXlsx();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet([REC_HEAD, ...list.map(recRow)], recWidths), "예찰기록");
    XLSX.writeFile(wb, `${name}_${stampNow()}.xlsx`);
  }
  async function exportReport(a, all) {
    await loadXlsx();
    const wb = XLSX.utils.book_new(), k = a.kpi;
    XLSX.utils.book_append_sheet(wb, sheet([[a.title], ["기간", `${a.from} ~ ${a.to}`, a.label], ["작성", a.madeAt], [], ["항목", "값"], ["예찰 건수", k.total], ["직전 기간 건수", k.prevTotal], ["조사 농가", k.farms], ["병해충 종류", k.pests], ["심각 단계", k.severe], ["심각 비율(%)", pct(k.severe, k.total)], ["평균 발생률(%)", k.avgInc ?? ""], ["처리 완료", k.done]], [18, 24, 16]), "요약");
    XLSX.utils.book_append_sheet(wb, sheet([["병해충", "구분", "건수", "직전 기간", "증감", "지역 수", "심각", "평균 발생률(%)", "주요 작목"], ...a.byPest.map(p => [p.name, p.category, p.count, p.prev, p.count - p.prev, p.regions, p.severe, p.avgInc ?? "", p.crops])], [16, 8, 6, 8, 6, 7, 6, 12, 30]), "병해충별");
    XLSX.utils.book_append_sheet(wb, sheet([["작목", "건수", "주요 병해충"], ...a.byCrop.map(c => [c.name, c.count, c.top])], [14, 6, 16]), "작목별");
    XLSX.utils.book_append_sheet(wb, sheet([["월", "합계", "병해", "충해", "생리장해", "기타"], ...a.byMonth.map(m => [m.name, m.count, m.병해, m.충해, m.생리장해, m.기타])], [10, 6, 6, 6, 8, 6]), "월별");
    XLSX.utils.book_append_sheet(wb, sheet([["지역", "건수", "심각", "주요 병해충", "위도", "경도"], ...a.regions.map(r => [r.name, r.count, r.severe, r.top, r.lat ?? "", r.lng ?? ""])], [22, 6, 6, 36, 10, 10]), "지역별");
    XLSX.utils.book_append_sheet(wb, sheet([["병해충", "건수", "작목", "방제 권고", "출처"], ...a.advice.map(x => [x.name, x.count, x.crops, x.remedy, x.source])], [14, 6, 20, 70, 10]), "방제권고");
    const ids = new Set(a.recIds || []); const recs = (all || []).filter(r => ids.has(r.id));
    if (recs.length) XLSX.utils.book_append_sheet(wb, sheet([REC_HEAD, ...recs.map(recRow)], recWidths), "기록목록");
    XLSX.writeFile(wb, `병해충보고서_${a.label.replace(/[\\/:*?"<>|\s]+/g, "_")}.xlsx`);
  }
  const stampNow = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; };

  return { aggregate, html, drawMap, refit, listSaved, save, removeSaved, exportReport, exportRecords, regionOf, period };
})();
