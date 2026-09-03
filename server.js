import "dotenv/config";
import express from "express";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function generateWithRetry(params, retries = 3, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (error) {
      const errorMsg = error?.message || error?.toString() || "";
      const status = error?.status || error?.code;

      // 429(쿼터/요청 제한)는 재시도하지 않음
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
          `[Gemini API 503 Error] 서버 과부하 발생. ${
            delay / 1000
          }초 후 재시도 (${attempt}/${retries})...`
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

const allowedTypes = new Set([
  "recommendation",
  "quiz",
  "question",
  "story"
]);

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
      return res.status(400).json({
        error: "지원하지 않는 생성 종류입니다."
      });
    }

    if (typeof request !== "string" || request.length > 500) {
      return res.status(400).json({
        error: "요청은 500자 이내로 입력해주세요."
      });
    }

    if (typeof condition !== "string" || condition.length > 300) {
      return res.status(400).json({
        error: "조건은 300자 이내로 입력해주세요."
      });
    }

    const safeCount = Math.min(
      Math.max(Number(count) || 1, 1),
      5
    );

    const prompt = `
너는 '오늘 뭐 하지?'라는 청소년용 심심풀이 웹앱의 콘텐츠 생성 AI다.
안전하고 가볍고 재미있는 콘텐츠를 한국어로 만든다.
위험한 행동, 불법 행위, 성적인 내용, 술/담배/약물, 도박, 무기, 위험한 챌린지는 제안하지 않는다.
병원이나 침대에서도 할 수 있다는 조건이 있다면 움직임이 많이 필요한 활동은 피한다.
답변은 과하게 길지 않게 한다.

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
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.9
      }
    });

    const text = response.text || "";
    const data = JSON.parse(text);

    if (!Array.isArray(data.items)) {
      throw new Error("AI 결과 형식이 올바르지 않습니다.");
    }

    res.json({
      items: data.items.slice(0, safeCount)
    });

  } catch (err) {
    console.error("Gemini API 처리 오류:", err);

    const errorMsg = err?.message || "";
    const status = err?.status || err?.code;

   // 429: 무료 API 한도 초과
if (
  status === 429 ||
  errorMsg.includes("429") ||
  errorMsg.includes("RESOURCE_EXHAUSTED") ||
  errorMsg.includes("quota")
) {
  // 일일 요청 한도(RPD) 초과인지 확인
  const isDailyQuota =
    errorMsg.includes("PerDay") ||
    errorMsg.includes("RequestsPerDay") ||
    errorMsg.includes("quota_exceeded");

  if (isDailyQuota) {
    // Gemini API의 일일 quota는 Pacific Time 자정에 초기화됨.
    // 서버 환경과 관계없이 정확하게 계산하기 위해 UTC 기준으로
    // 현재 시각을 Pacific Time으로 변환한다.
    const now = new Date();

    const pacificParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(now);

    const getPart = (name) =>
      Number(pacificParts.find((p) => p.type === name)?.value);

    const pacificYear = getPart("year");
    const pacificMonth = getPart("month");
    const pacificDay = getPart("day");

    // 다음 날 Pacific Time 00:00 계산
    const nextReset = new Date(
      Date.UTC(
        pacificYear,
        pacificMonth - 1,
        pacificDay + 1,
        0,
        0,
        0
      )
    );

    // Pacific Time의 UTC 오프셋 계산
    const resetParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(nextReset);

    const resetHour = Number(
      resetParts.find((p) => p.type === "hour")?.value
    );

    // 위 방식은 DST 때문에 직접 UTC 시간을 만들 때 주의가 필요하므로
    // 다음 Pacific 자정을 찾을 때 시간을 조금씩 앞으로 이동한다.
    let resetTime = new Date(now);

    while (true) {
      resetTime = new Date(resetTime.getTime() + 60 * 1000);

      const check = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).formatToParts(resetTime);

      const hour = Number(check.find((p) => p.type === "hour")?.value);
      const minute = Number(check.find((p) => p.type === "minute")?.value);

      if (hour === 0 && minute === 0) {
        break;
      }
    }

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

    // 한국 시간으로 표시
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
        `오늘의 무료 AI 요청 한도를 초과했습니다.\n` +
        `${timeParts.join(" ")} 후인 ${resetKST}부터 다시 시도해 주세요.`
    });
  }

  // 일일 한도가 아닌 일시적인 429
  return res.status(429).json({
    error:
      "AI 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
  });
}

    // 503: Gemini 서버 과부하
    if (
      status === 503 ||
      errorMsg.includes("503") ||
      errorMsg.includes("UNAVAILABLE") ||
      errorMsg.includes("high demand")
    ) {
      return res.status(503).json({
        error:
          "현재 AI 서버에 요청이 몰려 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요."
      });
    }

    res.status(500).json({
      error:
        "Gemini 생성에 실패했습니다. API 키와 서버 상태를 확인해주세요."
    });
  }
});

app.use((_, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, () => {
  console.log(
    `오늘 뭐 하지? v3 Gemini: http://localhost:${PORT}`
  );
});