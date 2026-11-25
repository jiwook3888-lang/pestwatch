"use strict";
// 🗺️ 지도·주소 모듈: 카카오지도(키가 있으면) / OpenStreetMap(키가 없을 때 자동 대체)
// 주소: 카카오 장소·주소 통합검색 + 도로명주소 변환, 다음 우편번호(도로명주소) 검색
window.GeoKit = (() => {
  const KAKAO_KEY = "pestwatch.kakaoKey";
  const getKakaoKey = () => { try { return localStorage.getItem(KAKAO_KEY) || ""; } catch (e) { return ""; } };
  const setKakaoKey = k => { try { k ? localStorage.setItem(KAKAO_KEY, k.trim()) : localStorage.removeItem(KAKAO_KEY); } catch (e) { } };

  let provider = "osm"; // "kakao" | "osm"
  let kakaoError = "";
  let nominatim = null; // {reverse(lat,lng), search(q)} — app.js에서 주입 (PC는 서버 경유)

  function loadScript(src, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      const t = setTimeout(() => reject(new Error("시간 초과")), timeout);
      s.src = src; s.async = true;
      s.onload = () => { clearTimeout(t); resolve(); };
      s.onerror = () => { clearTimeout(t); reject(new Error("불러오기 실패")); };
      document.head.appendChild(s);
    });
  }

  async function init(opts) {
    nominatim = opts.nominatim;
    const key = getKakaoKey();
    provider = "osm"; kakaoError = "";
    if (!key) return provider;
    try {
      await loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`);
      if (!window.kakao?.maps?.load) throw new Error("키 또는 도메인 등록을 확인하세요");
      await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("초기화 시간 초과")), 10000); kakao.maps.load(() => { clearTimeout(t); res(); }); });
      if (!kakao.maps.services) throw new Error("services 라이브러리 없음");
      provider = "kakao";
    } catch (e) {
      kakaoError = e.message;
    }
    return provider;
  }

  /* ---------- 지도 어댑터 ---------- */
  const zToLevel = z => Math.max(1, Math.min(14, 20 - z));
  const levelToZ = l => 20 - l;

  function createMap(el, { center = [36.5, 127.8], zoom = 7, onClick } = {}) {
    if (provider === "kakao") return kakaoMap(el, center, zoom, onClick);
    return leafletMap(el, center, zoom, onClick);
  }

  function leafletMap(el, center, zoom, onClick) {
    const m = L.map(el).setView(center, zoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(m);
    if (onClick) m.on("click", e => onClick(e.latlng.lat, e.latlng.lng));
    let marker = null; const pins = L.featureGroup().addTo(m);
    return {
      setView(lat, lng, z) { m.setView([lat, lng], z ?? m.getZoom()); },
      getZoom: () => m.getZoom(),
      setMarker(lat, lng, onDrag) {
        if (!marker) {
          marker = L.marker([lat, lng], { draggable: !!onDrag }).addTo(m);
          if (onDrag) marker.on("dragend", e => { const p = e.target.getLatLng(); onDrag(p.lat, p.lng); });
        } else marker.setLatLng([lat, lng]);
      },
      clearMarker() { if (marker) { m.removeLayer(marker); marker = null; } },
      setPins(list) { // list: [{lat,lng,html,popup,onOpen}]
        pins.clearLayers();
        list.forEach(p => {
          const icon = L.divIcon({ className: "", html: p.html, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });
          L.marker([p.lat, p.lng], { icon }).addTo(pins).bindPopup(p.popup);
        });
      },
      fitPins() { if (pins.getLayers().length) m.fitBounds(pins.getBounds().pad(0.2), { maxZoom: 15 }); },
      relayout() { m.invalidateSize(); },
      destroy() { m.remove(); },
    };
  }

  function kakaoMap(el, center, zoom, onClick) {
    const km = kakao.maps;
    const m = new km.Map(el, { center: new km.LatLng(center[0], center[1]), level: zToLevel(zoom) });
    m.addControl(new km.ZoomControl(), km.ControlPosition.RIGHT);
    m.addControl(new km.MapTypeControl(), km.ControlPosition.TOPRIGHT);
    if (onClick) km.event.addListener(m, "click", e => onClick(e.latLng.getLat(), e.latLng.getLng()));
    let marker = null, overlays = [], openPop = null;
    return {
      setView(lat, lng, z) { if (z != null) m.setLevel(zToLevel(z)); m.setCenter(new km.LatLng(lat, lng)); },
      getZoom: () => levelToZ(m.getLevel()),
      setMarker(lat, lng, onDrag) {
        const pos = new km.LatLng(lat, lng);
        if (!marker) {
          marker = new km.Marker({ position: pos, map: m, draggable: !!onDrag });
          if (onDrag) km.event.addListener(marker, "dragend", () => { const p = marker.getPosition(); onDrag(p.getLat(), p.getLng()); });
        } else marker.setPosition(pos);
      },
      clearMarker() { if (marker) { marker.setMap(null); marker = null; } },
      setPins(list) {
        overlays.forEach(o => o.setMap(null)); overlays = [];
        if (openPop) { openPop.setMap(null); openPop = null; }
        list.forEach(p => {
          const pos = new km.LatLng(p.lat, p.lng);
          const node = document.createElement("div"); node.innerHTML = p.html; node.style.cursor = "pointer";
          const o = new km.CustomOverlay({ position: pos, content: node, yAnchor: 1, map: m });
          node.onclick = () => {
            if (openPop) openPop.setMap(null);
            const pop = document.createElement("div"); pop.className = "kpop"; pop.innerHTML = p.popup + '<button class="kpop-x" type="button">✕</button>';
            openPop = new km.CustomOverlay({ position: pos, content: pop, yAnchor: 1.35, zIndex: 10, map: m });
            pop.querySelector(".kpop-x").onclick = () => { openPop.setMap(null); openPop = null; };
          };
          overlays.push(o);
        });
        this._list = list;
      },
      fitPins() {
        const list = this._list || []; if (!list.length) return;
        const b = new km.LatLngBounds(); list.forEach(p => b.extend(new km.LatLng(p.lat, p.lng)));
        m.setBounds(b); if (m.getLevel() < 4) m.setLevel(4);
      },
      relayout() { const c = m.getCenter(); m.relayout(); m.setCenter(c); },
      destroy() { overlays.forEach(o => o.setMap(null)); if (marker) marker.setMap(null); el.innerHTML = ""; },
    };
  }

  /* ---------- 주소 서비스 ---------- */
  function fmtNominatim(j) {
    const a = j.address || {};
    const parts = [a.province || a.state, a.city || a.county, a.borough, a.town || a.suburb || a.village, a.quarter, a.hamlet, a.road, a.house_number].filter(Boolean);
    const u = parts.filter((p, i) => parts.indexOf(p) === i);
    return u.length ? u.join(" ") : (j.display_name || "");
  }

  // 좌표 → {road, jibun}
  async function reverse(lat, lng) {
    if (provider === "kakao") {
      return new Promise((resolve, reject) => {
        new kakao.maps.services.Geocoder().coord2Address(lng, lat, (res, st) => {
          if (st !== kakao.maps.services.Status.OK || !res.length) return reject(new Error("주소 없음"));
          const r = res[0];
          resolve({ road: r.road_address ? r.road_address.address_name + (r.road_address.building_name ? ` (${r.road_address.building_name})` : "") : "", jibun: r.address?.address_name || "" });
        });
      });
    }
    const j = await nominatim.reverse(lat, lng);
    return { road: "", jibun: fmtNominatim(j) };
  }

  // 통합검색: 장소명·건물명·도로명·지번 → [{name, road, jibun, lat, lng}]
  async function search(q) {
    if (provider === "kakao") {
      const S = kakao.maps.services;
      const addr = new Promise(res => new S.Geocoder().addressSearch(q, (r, st) => res(st === S.Status.OK ? r.map(x => ({
        name: x.road_address?.building_name || "", road: x.road_address?.address_name || "", jibun: x.address?.address_name || x.address_name, lat: +x.y, lng: +x.x, kind: "📮 주소",
      })) : [])));
      const kw = new Promise(res => new S.Places().keywordSearch(q, (r, st) => res(st === S.Status.OK ? r.slice(0, 10).map(x => ({
        name: x.place_name, road: x.road_address_name, jibun: x.address_name, lat: +x.y, lng: +x.x, kind: "🏷️ " + (x.category_group_name || "장소"),
      })) : [])));
      const [a, k] = await Promise.all([addr, kw]);
      return [...a, ...k];
    }
    const list = await nominatim.search(q);
    return list.map(x => ({ name: "", road: "", jibun: x.display_name, lat: +x.lat, lng: +x.lon, kind: "📍 위치" }));
  }

  // 도로명주소 → 좌표 (다음 우편번호 결과 처리용)
  async function geocode(addr) {
    if (provider === "kakao") {
      return new Promise(res => new kakao.maps.services.Geocoder().addressSearch(addr, (r, st) =>
        res(st === kakao.maps.services.Status.OK && r.length ? { lat: +r[0].y, lng: +r[0].x } : null)));
    }
    try { const l = await nominatim.search(addr); return l.length ? { lat: +l[0].lat, lng: +l[0].lon } : null; } catch (e) { return null; }
  }

  // 다음(카카오) 우편번호 서비스 — 키 없이 도로명주소 통합검색
  let postcodeLoaded = null;
  async function openPostcode(container, onDone) {
    if (!postcodeLoaded) postcodeLoaded = loadScript("https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js");
    await postcodeLoaded;
    container.innerHTML = "";
    new daum.Postcode({
      width: "100%", height: "100%",
      oncomplete: d => onDone({ road: d.roadAddress + (d.buildingName ? ` (${d.buildingName})` : ""), roadOnly: d.roadAddress, jibun: d.jibunAddress || d.autoJibunAddress, zonecode: d.zonecode }),
    }).embed(container, { autoClose: false });
  }

  return {
    init, createMap, reverse, search, geocode, openPostcode, getKakaoKey, setKakaoKey,
    get provider() { return provider; }, get kakaoError() { return kakaoError; },
  };
})();
