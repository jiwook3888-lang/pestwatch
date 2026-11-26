"use strict";
// 📷 사진 기반 병해충 추론 (Claude API)
// API 키는 이 기기(브라우저) 안에만 저장되며, 사진은 추론할 때만 Anthropic API로 전송됩니다.
window.PestAI = (() => {
  const KEY = "pestwatch.apiKey";          // Claude (유료)
  const GKEY = "pestwatch.geminiKey";       // Google Gemini (무료 등급)
  const EKEY = "pestwatch.aiEngine";        // "gemini" | "claude"
  const MODEL = "claude-opus-5-5";
  const GEMINI_MODEL = "gemini-3.8-flash";

  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) || ""; v ? localStorage.setItem(k, v.trim()) : localStorage.removeItem(k); } catch (e) { return ""; } };
  const getKey = () => ls(KEY);
  const setKey = k => ls(KEY, k || "");
  const getGeminiKey = () => ls(GKEY);
  const setGeminiKey = k => ls(GKEY, k || "");
  const getEngine = () => ls(EKEY) || "offline";
  const setEngine = e => ls(EKEY, e);
  const ready = () => { const e = getEngine(); return e === "offline" ? true : e === "claude" ? !!getKey() : !!getGeminiKey(); };

  // API로 보낼 사진은 긴 변 1568px JPEG로 맞춤
  function toB64(blob, max = 1568) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(max / img.width, max / img.height, 1);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("사진을 읽을 수 없습니다")); };
      img.src = url;
    });
  }

  const SCHEMA = {
    type: "object",
    properties: {
      photo_quality: { type: "string", description: "사진 상태 평가 (초점, 거리, 병징 부위가 잘 보이는지)" },
      crop_match: { type: "string", description: "입력된 작목과 사진 속 식물이 맞아 보이는지 한 문장" },
      candidates: {
        type: "array",
        description: "가능성이 높은 순서의 병해충 후보 1~3개",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "병해충명 (한국에서 통용되는 이름)" },
            category: { type: "string", enum: ["병해", "충해", "생리장해", "기타"] },
            confidence: { type: "integer", description: "확신도 0~100" },
            evidence: { type: "array", items: { type: "string" }, description: "사진에서 관찰된 근거 (어느 부위에 어떤 모양·색·분포가 보이는지)" },
            against: { type: "string", description: "이 후보와 맞지 않거나 확인이 필요한 점" },
          },
          required: ["name", "category", "confidence", "evidence", "against"],
          additionalProperties: false,
        },
      },
      severity: { type: "string", enum: ["경미", "보통", "심각"] },
      symptoms: { type: "string", description: "관찰된 증상 요약" },
      diagnosis: { type: "string", description: "1순위 후보 기준 진단 소견 (발생 원인·조건 포함)" },
      remedy: { type: "string", description: "번호를 붙인 단계별 대처방안. 약제는 '등록약제'로만 표현" },
      field_checks: { type: "array", items: { type: "string" }, description: "현장에서 추가로 확인하면 진단이 확실해지는 것" },
      caution: { type: "string", description: "검역병 신고 필요 여부, 정밀진단 의뢰 권고 등. 없으면 빈 문자열" },
    },
    required: ["photo_quality", "crop_match", "candidates", "severity", "symptoms", "diagnosis", "remedy", "field_checks", "caution"],
    additionalProperties: false,
  };

  const SYSTEM = `당신은 한국 농업기술센터의 식물병해충 진단을 돕는 전문가입니다. 현장 예찰 공무원이 농가에서 찍은 사진을 보고 병해충을 추론합니다.
- 작목은 사용자가 직접 입력한 값을 사실로 받아들이고, 작목을 새로 추측하지 마세요. 사진이 그 작목과 달라 보이면 crop_match에 그렇게 적으세요.
- 근거(evidence)는 반드시 사진에서 실제로 보이는 것만 적으세요. 보이지 않는 것을 지어내지 마세요.
- 사진만으로 확정하기 어려우면 확신도를 낮게 주고 field_checks에 확인 방법(잎 뒷면, 줄기 단면, 확대경 관찰 등)을 적으세요.
- 대처방안은 경종적·물리적·생물적·화학적 방제 순으로, 특정 농약 상품명은 쓰지 말고 "작목별 등록약제(농약안전정보시스템 psis.rda.go.kr 확인)"로 안내하세요.
- 과수화상병 등 국가관리 검역병이 의심되면 caution에 즉시 신고 필요를 적으세요.
- 모든 문장은 한국어로, 농가에 전달할 수 있게 쉽고 간결하게 쓰세요.`;

  async function diagnoseGemini({ crop, notes, blobs }) {
    const apiKey = getGeminiKey();
    if (!apiKey) throw new Error("NO_KEY");
    if (!window.GoogleGenAI) throw new Error("AI 모듈을 불러오지 못했습니다");
    const ai = new window.GoogleGenAI({ apiKey });
    const parts = [];
    for (const b of blobs.slice(0, 4)) parts.push({ inlineData: { mimeType: "image/jpeg", data: await toB64(b) } });
    parts.push({ text: `작목: ${crop}\n${notes ? "현장 메모: " + notes + "\n" : ""}첨부한 사진 ${parts.length}장을 보고 병해충을 추론해 주세요. 지정된 JSON 형식으로만 답하세요.` });
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [{ role: "user", parts }],
          config: { systemInstruction: SYSTEM, responseMimeType: "application/json", responseJsonSchema: SCHEMA },
        });
        break;
      } catch (e) {
        const st = e?.status, msg = String(e?.message || e);
        const busy = st === 503 || st === 500 || st === 502 || st === 504 || /overloaded|high demand|UNAVAILABLE/i.test(msg);
        if (busy && attempt < 2) { await new Promise(r => setTimeout(r, [2000, 5000][attempt])); continue; }
        let err;
        if (st === 400 && /API key|API_KEY/i.test(msg)) err = new Error("Gemini API 키가 올바르지 않습니다. ⚙️ 설정에서 다시 입력하세요.");
        else if (st === 403) err = new Error("Gemini API 키 권한 오류입니다. 키를 새로 발급받아 보세요.");
        else if (st === 429) { err = new Error("Gemini 무료 사용량(분당/일일 한도)을 넘었어요."); err.fallback = true; }
        else if (busy) { err = new Error("Gemini 서버가 지금 붐벼서 응답하지 않아요."); err.fallback = true; }
        else if (!navigator.onLine || /fetch|network/i.test(msg)) { err = new Error("인터넷 연결이 안 돼서 Gemini를 쓸 수 없어요."); err.fallback = true; }
        else err = new Error("AI 추론 실패: " + msg);
        throw err;
      }
    }
    const text = res.text;
    if (!text) throw new Error("AI가 답하지 않았어요. 다른 사진으로 다시 시도하세요.");
    const out = JSON.parse(text);
    out.candidates = (out.candidates || []).sort((a, b) => b.confidence - a.confidence);
    out.engine = "gemini"; out.model = GEMINI_MODEL;
    out.at = new Date().toLocaleString("ko-KR");
    return out;
  }

  function diagnose(args) { return getEngine() === "claude" ? diagnoseClaude(args) : diagnoseGemini(args); }

  async function diagnoseClaude({ crop, notes, blobs }) {
    const apiKey = getKey();
    if (!apiKey) throw new Error("NO_KEY");
    if (!window.Anthropic) throw new Error("AI 모듈을 불러오지 못했습니다");
    const client = new window.Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    const images = [];
    for (const b of blobs.slice(0, 4)) images.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toB64(b) } });
    const text = `작목: ${crop}\n${notes ? "현장 메모: " + notes + "\n" : ""}첨부한 사진 ${images.length}장을 보고 병해충을 추론해 주세요.`;
    let res;
    try {
      res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: "user", content: [...images, { type: "text", text }] }],
      });
    } catch (e) {
      const st = e?.status;
      if (st === 401) throw new Error("API 키가 올바르지 않습니다. ⚙️ 설정에서 다시 입력하세요.");
      if (st === 429) throw new Error("요청이 많습니다. 잠시 후 다시 시도하세요.");
      if (st === 400 && /credit|billing/i.test(e.message)) throw new Error("API 크레딧이 부족합니다. Anthropic 콘솔에서 결제 정보를 확인하세요.");
      if (!navigator.onLine || e?.name === "APIConnectionError") throw new Error("인터넷 연결을 확인하세요. (AI 추론은 인터넷이 필요합니다)");
      throw new Error("AI 추론 실패: " + (e?.message || e));
    }
    if (res.stop_reason === "refusal") throw new Error("AI가 이 사진에 대한 답변을 거절했습니다. 다른 사진으로 시도하세요.");
    if (res.stop_reason === "max_tokens") throw new Error("AI 응답이 너무 길어 중단되었습니다. 다시 시도하세요.");
    const block = res.content.find(b => b.type === "text");
    if (!block) throw new Error("AI 응답이 비어 있습니다");
    const out = JSON.parse(block.text);
    out.candidates = (out.candidates || []).sort((a, b) => b.confidence - a.confidence);
    out.model = res.model; out.engine = "claude";
    out.at = new Date().toLocaleString("ko-KR");
    return out;
  }

  return { getKey, setKey, getGeminiKey, setGeminiKey, getEngine, setEngine, ready, diagnose, MODEL, GEMINI_MODEL };
})();
