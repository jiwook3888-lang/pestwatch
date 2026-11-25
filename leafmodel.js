"use strict";
// 📷 오프라인 사진 판별 (무료 · 키 불필요 · 기기 안에서 실행)
// 모델: Greenathon Plant AI (Apache-2.0, PlantVillage 38종 학습, TensorFlow.js)
// 한계: 실험실에서 찍은 잎 한 장 사진으로 학습한 모델이라 현장 사진에서는 정확도가 떨어질 수 있음.
window.LeafModel = (() => {
  // [작목, 병명(한글), 유형, 참고자료 연결명]
  const C = [
    ["사과", "검은별무늬병", "곰팡이"], ["사과", "검은썩음병", "곰팡이"], ["사과", "붉은별무늬병", "곰팡이"], ["사과", "건강", "건강"],
    ["블루베리", "건강", "건강"], ["체리", "흰가루병", "곰팡이", "흰가루병"], ["체리", "건강", "건강"],
    ["옥수수", "회색잎반점병", "곰팡이"], ["옥수수", "녹병", "곰팡이"], ["옥수수", "그을음무늬병", "곰팡이"], ["옥수수", "건강", "건강"],
    ["포도", "검은썩음병", "곰팡이"], ["포도", "에스카병(가지마름)", "곰팡이"], ["포도", "갈색무늬병(잎마름)", "곰팡이"], ["포도", "건강", "건강"],
    ["감귤", "그린병(HLB) 의심", "세균"], ["복숭아", "세균구멍병", "세균"], ["복숭아", "건강", "건강"],
    ["고추", "세균점무늬병", "세균", "세균점무늬병"], ["고추", "건강", "건강"],
    ["감자", "겹둥근무늬병", "곰팡이"], ["감자", "역병", "곰팡이", "역병"], ["감자", "건강", "건강"],
    ["라즈베리", "건강", "건강"], ["콩", "건강", "건강"], ["호박", "흰가루병", "곰팡이", "흰가루병"],
    ["딸기", "잎마름병(잎끝타기)", "곰팡이"], ["딸기", "건강", "건강"],
    ["토마토", "세균점무늬병", "세균", "세균점무늬병"], ["토마토", "겹둥근무늬병", "곰팡이"], ["토마토", "역병", "곰팡이", "역병"],
    ["토마토", "잎곰팡이병", "곰팡이"], ["토마토", "점무늬병(셉토리아)", "곰팡이"], ["토마토", "점박이응애", "해충", "점박이응애"],
    ["토마토", "갈색둥근무늬병(타깃스팟)", "곰팡이"], ["토마토", "황화잎말림바이러스(TYLCV)", "바이러스", "바이러스병"],
    ["토마토", "모자이크바이러스", "바이러스", "바이러스병"], ["토마토", "건강", "건강"],
  ];
  // 입력 작목 → 모델 작목
  const ALIAS = { 사과: ["사과"], 블루베리: ["블루베리"], 체리: ["체리", "앵두"], 옥수수: ["옥수수"], 포도: ["포도", "샤인머스캣", "머루"],
    감귤: ["감귤", "귤", "오렌지", "한라봉", "레몬"], 복숭아: ["복숭아", "천도"], 고추: ["고추", "피망", "파프리카"], 감자: ["감자"],
    라즈베리: ["라즈베리", "산딸기", "복분자"], 콩: ["콩", "대두", "콩나물"], 호박: ["호박", "애호박", "단호박", "주키니"], 딸기: ["딸기"], 토마토: ["토마토", "방울토마토"] };
  const SUPPORTED = Object.keys(ALIAS);
  const REMEDY = {
    곰팡이: "1) 병든 잎·과실은 따서 포장 밖에서 소각·매몰\n2) 통풍·배수 개선, 밀식·과습 피하기\n3) 발생 초기 작목별 등록 살균제 살포(농약안전정보시스템 psis.rda.go.kr 확인), 계통이 다른 약제 교호 사용\n4) 다음 작기 무병묘 사용, 돌려짓기",
    세균: "1) 병든 부위 제거, 가위 등 작업도구 소독\n2) 비가림·과습 방지, 비바람 뒤 관찰 강화\n3) 작목별 등록 세균 방제약제 살포(psis.rda.go.kr 확인)\n4) 무병 종자·묘 사용, 종자 소독",
    바이러스: "1) 감염주 조기 제거(치료약 없음)\n2) 매개충(진딧물·총채벌레·가루이) 방제\n3) 방충망 설치, 주변 잡초 제거\n4) 저항성 품종 선택",
    해충: "1) 잎 뒷면 확인 후 초기 방제\n2) 계통이 다른 등록약제 교호 사용\n3) 천적 활용, 잡초 제거",
    건강: "뚜렷한 병징이 확인되지 않았어요. 정기 예찰을 이어가고, 의심 증상이 생기면 다시 촬영하세요.",
  };

  let modelP = null;
  function load(onProgress) {
    if (!modelP) {
      if (!window.tf) return Promise.reject(new Error("판별 모듈을 불러오지 못했어요"));
      modelP = tf.loadLayersModel(new URL("model/model.json", location.href).href, { onProgress })
        .catch(e => { modelP = null; throw new Error("판별 모델을 불러오지 못했어요: " + e.message); });
    }
    return modelP;
  }

  function cropOf(input) {
    const s = (input || "").replace(/\s/g, "");
    return SUPPORTED.find(k => ALIAS[k].some(a => s.includes(a))) || null;
  }

  function blobToImg(blob) {
    return new Promise((res, rej) => {
      const u = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(u); res(img); };
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error("사진을 읽을 수 없어요")); };
      img.src = u;
    });
  }

  // 정사각형 가운데를 잘라 224x224로
  function toCanvas(img) {
    const c = document.createElement("canvas"); c.width = c.height = 224;
    const s = Math.min(img.width, img.height);
    c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 224, 224);
    return c;
  }

  async function predictProbs(model, blobs) {
    const sum = new Float32Array(C.length);
    for (const b of blobs.slice(0, 4)) {
      const img = await blobToImg(b);
      const probs = tf.tidy(() => model.predict(tf.browser.fromPixels(toCanvas(img)).toFloat().div(255).expandDims()).dataSync());
      probs.forEach((p, i) => { sum[i] += p; });
    }
    const n = Math.min(blobs.length, 4);
    return Array.from(sum, v => v / n);
  }

  async function diagnose({ crop, blobs, onProgress }) {
    const model = await load(onProgress);
    const probs = await predictProbs(model, blobs);
    const mapped = cropOf(crop);
    const all = probs.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p);
    let pool = all, note;
    if (mapped) {
      const own = all.filter(x => C[x.i][0] === mapped);
      const tot = own.reduce((a, x) => a + x.p, 0) || 1;
      pool = own.map(x => ({ i: x.i, p: x.p / tot, raw: x.p }));
      const topAll = all[0];
      note = `입력 작목 ‘${crop}’을(를) 모델의 ‘${mapped}’ 학습 범위로 보고 판별했어요.` +
        (C[topAll.i][0] !== mapped && topAll.p > 0.5 ? ` (참고: 작목 구분 없이 보면 ‘${C[topAll.i][0]} ${C[topAll.i][1]}’ 사진과 가장 비슷했어요. 작목을 확인하세요.)` : "");
    } else {
      note = `⚠️ ‘${crop}’은(는) 이 모델이 학습한 작목(${SUPPORTED.join(", ")})이 아니라서 결과를 믿기 어려워요. 📋 증상 체크 추론을 함께 쓰세요.`;
    }
    const top = pool.slice(0, 3).filter((x, k) => k === 0 || x.p >= 0.05);
    const candidates = top.map(x => {
      const [cr, name, kind] = C[x.i];
      const pct = Math.round(x.p * 100);
      return {
        name: kind === "건강" ? `${cr} 건강(병징 없음)` : `${cr} ${name}`,
        category: kind === "해충" ? "충해" : kind === "건강" ? "기타" : "병해",
        confidence: mapped ? Math.min(85, pct) : Math.min(50, pct),
        evidence: [
          `사진의 잎 색·무늬가 ‘${cr} ${name}’ 학습 사진과 ${pct}% 비슷하게 판별됨`,
          kind !== "건강" ? `병원 유형: ${kind}` : "학습한 병해 사진보다 건강한 잎 사진에 더 가까움",
          blobs.length > 1 ? `사진 ${Math.min(blobs.length, 4)}장의 판별 결과를 평균함` : "사진 1장으로 판별함 (여러 장이면 더 안정적)",
        ],
        against: "공개 학습 사진(잎 한 장, 단순 배경) 기반이라 현장 사진은 오차가 있을 수 있어요.",
        _i: x.i,
      };
    });
    const t = C[top[0].i];
    const ref = t[3] ? (window.PEST_REF || []).find(p => p.name === t[3]) : null;
    candidates.forEach(c => delete c._i);
    const isHealthy = t[2] === "건강";
    return {
      engine: "offline",
      photo_quality: "기기 안에서 사진을 분석했어요. 병든 잎 한 장을 가까이, 배경을 단순하게 찍을수록 정확해요.",
      crop_match: note,
      candidates,
      severity: isHealthy ? "경미" : "보통",
      symptoms: ref ? ref.symptoms : isHealthy ? "뚜렷한 병징 없음" : `${t[0]} ${t[1]} 의심 증상`,
      diagnosis: ref ? ref.diagnosis : isHealthy ? "사진상 뚜렷한 병해가 확인되지 않음" : `${t[0]} ${t[1]}(${t[2]}성) 의심 — 현장 관찰로 확인 필요`,
      remedy: ref ? ref.remedy : REMEDY[t[2]] || REMEDY.곰팡이,
      field_checks: isHealthy ? ["잎 뒷면·줄기·과실도 함께 확인"] : ["병반 부위를 가까이 다시 촬영해 비교", "📋 증상 체크 추론으로 교차 확인", "확신이 낮으면 정밀진단 의뢰"],
      caution: /HLB|그린병/.test(t[1]) ? "감귤 그린병(HLB)은 국내 미발생 검역병이에요. 의심되면 즉시 관계기관에 신고하세요." : "",
      at: new Date().toLocaleString("ko-KR"),
    };
  }

  return { diagnose, load, SUPPORTED, cropOf };
})();
