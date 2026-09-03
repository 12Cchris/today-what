# 오늘 뭐 하지? v3 — Gemini 버전

기존 랜덤 뽑기에 Gemini AI 즉석 생성 기능을 추가한 모바일 웹앱입니다.

## 기능
- 🎲 랜덤 뽑기
- 🤖 Gemini AI 추천
- 🧠 AI 퀴즈
- 💬 AI 질문
- 📖 AI 짧은 이야기
- 💾 AI 결과를 내 랜덤 목록에 저장
- ✏️ 사용자 항목 추가
- 📱 모바일 반응형
- 🔐 Gemini API 키는 서버 환경변수에만 보관

## 실행

Node.js가 설치된 PC에서:

1. `npm install`
2. `.env.example`을 `.env`로 복사
3. `.env`의 `GEMINI_API_KEY`에 Gemini API 키 입력
4. `npm start`
5. 브라우저에서 `http://localhost:3000`

`GEMINI_MODEL`은 기본적으로 `gemini-3-flash-preview`로 설정되어 있습니다.
필요하면 환경변수에서 사용 가능한 다른 모델로 변경하세요.

## 보안
API 키를 `public/index.html`에 넣지 마세요.
공개 배포 시 요청 횟수 제한, 사용자별 일일 한도, 오류 처리 등을 추가하는 것을 권장드립니다.
