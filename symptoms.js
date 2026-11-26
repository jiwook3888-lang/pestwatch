"use strict";
// 증상 체크 추론 (무료 · 인터넷/키 불필요)
// 현장에서 관찰한 증상을 고르면 참고자료의 병해충별 대표 증상과 맞춰 후보와 근거를 보여줍니다.
window.SymptomCheck = (() => {
  const GROUPS = [
    { title: "병반·곰팡이", items: [
      ["sunken", "움푹 들어간 둥근 병반"], ["conc", "동심원 무늬·주황 포자덩이"], ["whitepow", "밀가루 같은 흰 곰팡이"],
      ["graymold", "잿빛 곰팡이·물러짐"], ["angular", "잎맥 사이 각진 노란 병반"], ["downy", "잎 뒷면 회백~자색 곰팡이"],
      ["water", "물에 데친 듯한 병반"], ["smallspot", "작은 갈색 점무늬"], ["burnt", "불에 탄 듯 검게 마름"] ] },
    { title: "시듦·변형", items: [
      ["wiltday", "낮에 시들고 밤에 회복"], ["wiltgreen", "푸른 채로 급격히 시듦"], ["basal", "줄기 밑동 갈변·잘록"],
      ["ooze", "세균 점액·줄기 단면 갈변"], ["hook", "가지 끝 갈고리처럼 휨"], ["mosaic", "모자이크·얼룩 무늬"],
      ["curl", "잎 오그라짐·기형"], ["stunt", "생육 위축"], ["yellow", "잎 황화(누렇게)"], ["tipburn", "잎끝 마름·배꼽썩음"] ] },
    { title: "해충 흔적", items: [
      ["silver", "은백색 긁힌 자국"], ["stipple", "흰 깨알 같은 흡즙 반점"], ["web", "거미줄"], ["honeydew", "끈적한 감로·그을음"],
      ["holes", "구멍·갉아먹은 흔적"], ["fruitbore", "과실 속 파먹음"], ["frass", "배설물"], ["eggmass", "가지에 알덩어리·산란흔"] ] },
    { title: "보이는 벌레", items: [
      ["b_aphid", "작은 벌레 무리(진딧물류)"], ["b_white", "흰 날벌레(가루이)"], ["b_thrips", "가늘고 작은 노란·검은 벌레"],
      ["b_mite", "아주 작은 붉은·노란 점(응애)"], ["b_larva", "애벌레·나방"], ["b_hopper", "매미 모양 곤충"] ] },
    { title: "발생 환경", items: [
      ["e_rain", "최근 비·고온다습"], ["e_dry", "건조·고온"], ["e_coolhum", "저온다습·결로(시설)"], ["e_flood", "침수·배수 불량"] ] },
  ];
  const LABEL = Object.fromEntries(GROUPS.flatMap(g => g.items));

  // 병해충별 대표 증상 (3 = 핵심, 1 = 보조)
  const SIGNS = {
    "탄저병": { sunken: 3, conc: 3, e_rain: 1, water: 1 },
    "흰가루병": { whitepow: 3, yellow: 1, e_dry: 1 },
    "잿빛곰팡이병": { graymold: 3, e_coolhum: 2, water: 1 },
    "노균병": { angular: 3, downy: 3, e_coolhum: 1, yellow: 1 },
    "역병": { basal: 3, water: 2, e_flood: 2, e_rain: 1, wiltgreen: 1 },
    "풋마름병(청고병)": { wiltday: 3, wiltgreen: 3, ooze: 2, e_rain: 1 },
    "세균점무늬병": { smallspot: 3, water: 1, yellow: 1, e_rain: 1 },
    "바이러스병": { mosaic: 3, curl: 2, stunt: 2, b_aphid: 1, b_thrips: 1, b_white: 1 },
    "진딧물": { b_aphid: 3, honeydew: 2, curl: 2 },
    "점박이응애": { stipple: 3, b_mite: 3, web: 2, e_dry: 1, yellow: 1 },
    "총채벌레": { silver: 3, b_thrips: 3, curl: 1 },
    "담배가루이(온실가루이)": { b_white: 3, honeydew: 2, yellow: 1 },
    "담배나방": { fruitbore: 3, b_larva: 2, frass: 2, holes: 1 },
    "열대거세미나방": { holes: 3, b_larva: 2, frass: 2 },
    "꽃매미·갈색날개매미충": { b_hopper: 3, eggmass: 2, honeydew: 1 },
    "과수화상병(의심)": { burnt: 3, hook: 3, ooze: 2 },
    "생리장해(영양결핍)": { yellow: 2, tipburn: 3, stunt: 1 },
  };

  function renderChips(box, selected) {
    box.innerHTML = GROUPS.map(g => `<div class="chip-g"><div class="chip-t">${g.title}</div><div class="chips">${
      g.items.map(([k, l]) => `<button type="button" class="chip ${selected.has(k) ? "on" : ""}" data-k="${k}">${l}</button>`).join("")}</div></div>`).join("");
    box.querySelectorAll(".chip").forEach(b => b.onclick = () => {
      selected.has(b.dataset.k) ? selected.delete(b.dataset.k) : selected.add(b.dataset.k);
      b.classList.toggle("on");
    });
  }

  function cropMatch(crop, refCrops) {
    if (!crop) return false;
    if (/전반/.test(refCrops)) return true;
    return refCrops.split(/[,·\s]+/).filter(Boolean).some(c => crop.includes(c) || c.includes(crop));
  }

  function infer({ crop, selected }) {
    const sel = [...selected];
    if (!sel.length) throw new Error("관찰한 증상을 하나 이상 골라 주세요.");
    const symptomSel = sel.filter(k => !k.startsWith("e_"));
    const scored = window.PEST_REF.map(p => {
      const signs = SIGNS[p.name] || {};
      const total = Object.values(signs).reduce((a, b) => a + b, 0) || 1;
      const hit = sel.filter(k => signs[k]);
      const hitW = hit.reduce((a, k) => a + signs[k], 0);
      const symHits = hit.filter(k => !k.startsWith("e_")).length;
      const precision = symptomSel.length ? symHits / symptomSel.length : 0;
      const coverage = hitW / total;
      const cm = cropMatch(crop, p.crops);
      let s = 0.55 * precision + 0.45 * coverage + (cm ? 0.08 : 0);
      if (!symHits) s = 0;
      const missingCore = Object.entries(signs).filter(([k, w]) => w >= 3 && !selected.has(k)).map(([k]) => LABEL[k]);
      return { p, s, hit, cm, missingCore };
    }).filter(x => x.s > 0.12).sort((a, b) => b.s - a.s).slice(0, 3);

    if (!scored.length) throw new Error("고른 증상과 맞는 병해충을 참고자료에서 찾지 못했어요. 증상을 더 고르거나 사진 AI 추론을 이용해 주세요.");
    const top = scored[0].p;
    const candidates = scored.map(x => ({
      name: x.p.name, category: x.p.category, confidence: Math.min(80, Math.round(x.s * 80)),
      evidence: [
        ...x.hit.map(k => `‘${LABEL[k]}’ ${k.startsWith("e_") ? "발생 조건" : "증상"}이 ${x.p.name}의 특징과 일치`),
        x.cm ? `입력한 작목(${crop})이 주요 기주 작물(${x.p.crops})에 해당` : `입력한 작목(${crop || "미입력"})은 참고자료의 주요 기주(${x.p.crops})에 없음`,
      ],
      against: x.missingCore.length ? `대표 증상 중 ‘${x.missingCore.join("’, ‘")}’ 여부를 현장에서 확인하세요.` : "",
    }));
    const symText = sel.filter(k => !k.startsWith("e_")).map(k => LABEL[k]).join(", ");
    return {
      engine: "symptom",
      photo_quality: "사진 분석 없이, 선택한 증상으로만 추론했어요.",
      crop_match: crop ? `입력 작목: ${crop}` : "작목 미입력",
      candidates,
      severity: "보통",
      symptoms: symText ? `${symText} 관찰` : top.symptoms,
      diagnosis: top.diagnosis,
      remedy: top.remedy,
      field_checks: scored[0].missingCore.map(m => `${m} 여부 확인`),
      caution: /화상병/.test(top.name) ? "과수화상병 의심 시 임의 제거하지 말고 즉시 농업기술센터·농촌진흥청에 신고하세요." : "",
      at: new Date().toLocaleString("ko-KR"),
    };
  }

  return { renderChips, infer, LABEL };
})();
