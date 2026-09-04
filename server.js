import "dotenv/config";
import express from "express";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Gemini API의 실제 활성 한도는 프로젝트/모델에 따라 달라질 수 있습니다.
// Render에서는 환경 변수로 표시 기준을 바꿀 수 있도록 합니다.
const DISPLAY_DAILY_LIMIT = Number(process.env.GEMINI_RPD_LIMIT || 20);
const DISPLAY_RPM_LIMIT = Number(process.env.GEMINI_RPM_LIMIT || 20);

let usage = {
  dayKey: getPacificDayKey(),
  requests: 0,
  timestamps: [],
  lastError: null,
  detectedLimit: null
};

function getPacificNowParts(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
}

function getPart(parts, name) {
  return Number(parts.find((p) => p.type === name)?.value);
}

function getPacificDayKey(date = new Date()) {
  const parts = getPacificNowParts(date);
  return `${getPart(parts, "year")}-${String(getPart(parts, "month")).padStart(2, "0")}-${String(getPart(parts, "day")).padStart(2, "0")}`;
}

function resetUsageIfNeeded() {
  const dayKey = getPacificDayKey();
  if (usage.dayKey !== dayKey) {
    usage = {
      dayKey,
      requests: 0,
      timestamps: [],
      lastError: null,
      detectedLimit: usage.detectedLimit
    };
  }
}

function recordRequest() {
  resetUsageIfNeeded();
  const now = Date.now();
  usage.requests += 1;
  usage.timestamps.push(now);
  usage.timestamps = usage.timestamps.filter((t) => now - t < 60_000);
}

function getNextPacificMidnight(date = new Date()) {
  let cursor = new Date(date);
  for (let i = 0; i < 24 * 60 + 10; i++) {
    cursor = new Date(cursor.getTime() + 60_000);
    const parts = getPacificNowParts(cursor);
    const hour = getPart(parts, "hour");
    const minute = getPart(parts, "minute");
    // Intl.DateTimeFormat의 일부 환경에서는 자정이 24:00으로 반환될 수 있습니다.
    if ((hour === 0 || hour === 24) && minute === 0) return cursor;
  }
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

function getQuotaSnapshot() {
  resetUsageIfNeeded();
  const now = Date.now();
  usage.timestamps = usage.timestamps.filter((t) => now - t < 60_000);

  const dailyLimit = usage.detectedLimit || DISPLAY_DAILY_LIMIT;
  const rpmLimit = DISPLAY_RPM_LIMIT > 0 ? DISPLAY_RPM_LIMIT : null;
  const remaining = Math.max(0, dailyLimit - usage.requests);
  const nextReset = getNextPacificMidnight();
  const remainingSeconds = Math.max(1, Math.ceil((nextReset.getTime() - now) / 1000));

  return {
    model: MODEL,
    requestsToday: usage.requests,
    dailyLimit,
    remainingRequests: remaining,
    rpmUsed: usage.timestamps.length,
    rpmLimit,
    resetAt: nextReset.toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }),
    resetInSeconds: remainingSeconds,
    source: usage.detectedLimit
      ? "Gemini 오류 응답에서 확인된 한도"
      : "Render 표시 설정값"
  };
}

async function generateWithRetry(params, retries = 3, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      recordRequest();
      return await ai.models.generateContent(params);
    } catch (error) {
      const errorMsg = error?.message || error?.toString() || "";
      const status = error?.status || error?.code;

      const limitMatch = errorMsg.match(/limit:\s*(\d+)/i);
      if (limitMatch) {
        usage.detectedLimit = Number(limitMatch[1]);
      }
      usage.lastError = errorMsg.slice(0, 500);

      if (status === 429) {
        throw error;
      }

      const is503 =
        status === 503 ||
        errorMsg.includes("503") ||
        errorMsg.includes("UNAVAILABLE") ||
        errorMsg.includes("high demand");

      if (is503 && attempt < retries) {
        console.warn(
          `[Gemini API 503 Error] 서버 과부하 발생. ${delay / 1000}초 후 재시도 (${attempt}/${retries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        throw error;
      }
    }
  }
}

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const allowedTypes = new Set(["recommendation", "quiz", "question", "story"]);

app.get("/api/quota", (_req, res) => {
  res.json(getQuotaSnapshot());
});

app.post("/api/generate", async (req, res) => {
  try {
    const {
      type = "recommendation",
      request = "",
      condition = "",
      difficulty = "쉬움",
      count = 1
    } = req.body;

    if (!allowedTypes.has(type)) {
      return res.status(400).json({ error: "지원하지 않는 생성 종류입니다." });
    }

    if (typeof request !== "string" || request.length > 500) {
      return res.status(400).json({ error: "요청은 500자 이내로 입력해주세요." });
    }

    if (typeof condition !== "string" || condition.length > 300) {
      return res.status(400).json({ error: "조건은 300자 이내로 입력해주세요." });
    }

    const safeCount = Math.min(Math.max(Number(count) || 1, 1), 5);

    const prompt = `
너는 '오늘 뭐 하지?'라는 청소년용 심심풀이 웹앱의 콘텐츠 생성 AI다.
안전하고 가볍고 재미있는 콘텐츠를 한국어로 만든다.
위험한 행동, 불법 행위, 성적인 내용, 술/담배/약물, 도박, 무기, 위험한 챌린지는 제안하지 않는다.
병원이나 침대에서도 할 수 있다는 조건이 있다면 움직임이 많이 필요한 활동은 피한다.
답변은 과하게 길지 않게 한다.

'오늘의 추천'은 뻔한 활동만 반복하지 말고, 실내/야외, 혼자/친구와, 1~5분/10~30분/1시간 이상, 창작/게임/정리/관찰/대화/휴식/공부/소소한 도전 등 서로 다른 결의 아이디어를 폭넓게 섞는다.
특히 '추천' 결과가 이전과 비슷하지 않도록 제목과 활동 방식이 겹치지 않게 만든다.

종류: ${type}
사용자 요청: ${request || "(특별한 요청 없음)"}
조건: ${condition || "(없음)"}
난이도: ${difficulty}
생성 개수: ${safeCount}

JSON만 반환한다.

recommendation/question:
{"items":[{"title":"제목","description":"내용","rarity":"일반"}]}

quiz:
{"items":[{"title":"문제","choices":["A","B","C","D"],"answer":0,"explanation":"짧은 해설"}]}

story:
{"items":[{"title":"제목","description":"짧은 완결형 이야기"}]}
`;

    const response = await generateWithRetry({
      model: MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 1.0
      }
    });

    const text = response.text || "";
    const data = JSON.parse(text);

    if (!Array.isArray(data.items)) {
      throw new Error("AI 결과 형식이 올바르지 않습니다.");
    }

    res.json({
      items: data.items.slice(0, safeCount),
      quota: getQuotaSnapshot()
    });
  } catch (err) {
    console.error("Gemini API 처리 오류:", err);

    const errorMsg = err?.message || "";
    const status = err?.status || err?.code;
    const quotaMatch = errorMsg.match(/limit:\s*(\d+)/i);
    if (quotaMatch) usage.detectedLimit = Number(quotaMatch[1]);

    if (
      status === 429 ||
      errorMsg.includes("429") ||
      errorMsg.includes("RESOURCE_EXHAUSTED") ||
      errorMsg.toLowerCase().includes("quota")
    ) {
      const isDailyQuota =
        errorMsg.includes("PerDay") ||
        errorMsg.includes("RequestsPerDay") ||
        errorMsg.includes("quota_exceeded") ||
        errorMsg.toLowerCase().includes("per day");

      if (isDailyQuota) {
        const now = new Date();
        const resetTime = getNextPacificMidnight(now);
        const remainingSeconds = Math.max(
          1,
          Math.ceil((resetTime.getTime() - now.getTime()) / 1000)
        );
        const hours = Math.floor(remainingSeconds / 3600);
        const minutes = Math.floor((remainingSeconds % 3600) / 60);
        const seconds = remainingSeconds % 60;
        const timeParts = [];
        if (hours > 0) timeParts.push(`${hours}시간`);
        if (minutes > 0) timeParts.push(`${minutes}분`);
        if (seconds > 0) timeParts.push(`${seconds}초`);

        const resetKST = resetTime.toLocaleString("ko-KR", {
          timeZone: "Asia/Seoul",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        });

        return res.status(429).json({
          error:
            `오늘의 무료 AI 요청 한도를 초과했습니다. ${timeParts.join(" ")} 후인 ${resetKST}부터 다시 시도해 주세요.`,
          quota: getQuotaSnapshot()
        });
      }

      return res.status(429).json({
        error: "AI 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        quota: getQuotaSnapshot()
      });
    }

    if (
      status === 503 ||
      errorMsg.includes("503") ||
      errorMsg.includes("UNAVAILABLE") ||
      errorMsg.includes("high demand")
    ) {
      return res.status(503).json({
        error: "현재 AI 서버에 요청이 몰려 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.",
        quota: getQuotaSnapshot()
      });
    }

    res.status(500).json({
      error: "Gemini 생성에 실패했습니다. API 키와 서버 상태를 확인해주세요.",
      quota: getQuotaSnapshot()
    });
  }
});

app.use((_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`오늘 뭐 하지? Gemini: http://localhost:${PORT}`);
  console.log(
    `[Quota display] model=${MODEL}, RPD=${DISPLAY_DAILY_LIMIT}, RPM=${DISPLAY_RPM_LIMIT}`
  );
});
