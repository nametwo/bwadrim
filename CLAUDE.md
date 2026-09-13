@AGENTS.md

# 봐드림 — 작업 가이드

원격 화상 A/S 웹 서비스. 엔지니어(폰+PC 웹) ↔ 고객(폰 카메라). README.md에 범위·제약·지표가 정리되어 있으니 먼저 읽을 것.

## 원칙

- 고객 쪽은 **로그인·설치·앱 없음**. 링크 클릭 → 버튼 한 번 → 카메라. 탭 두 번 이하
- 고객 UI는 나이 든 사장님 기준: 큰 버튼, 한글, 한 화면에 한 가지 행동
- 엔지니어 UI는 폰에서 한 손 조작 가능해야 함. 영상 위에 터치 오버레이, 도구 버튼 최소화
- "항상 연결된다"가 UX의 일부. ICE 서버에 TURN을 반드시 포함하고, relay 사용 여부를 이벤트로 남길 것
- 카메라/마이크 요청은 반드시 사용자 제스처 이후에 호출

## 구조

```
src/app/
  (engineer)/login, /dashboard, /room/[id]      # 로그인 필요
  join/[code]                                    # 고객 진입, 공개
  api/rooms                                      # 방 생성, 코드 발급
src/lib/
  supabase/{client,server}.ts
  webrtc/                                        # peer 연결, ICE 설정, 시그널링
  events.ts                                      # 지표 이벤트 기록
supabase/schema.sql
```

## 시그널링

Supabase Realtime broadcast 채널 `room:{id}`. 메시지 타입: `offer` / `answer` / `ice` / `pointer` / `freeze` / `bye`.
포인터·드로잉은 연결 후 DataChannel로 옮길 것 (지연 최소화). 좌표는 0~1 정규화.

## 이벤트 이름 (events 테이블)

`room_created`, `link_opened`, `camera_granted`, `camera_denied`, `connected`, `relay_used`, `pointer_used`, `freeze_used`, `ended`, `resolved_remotely`

## 환경 변수

`.env.example` 참고. TURN 자격증명은 서버에서만 다루고 클라이언트엔 단기 토큰만 내려줄 것.

## 하지 말 것

- PC 화면 공유, 원격 제어, 설치형은 1차 범위 아님
- 브라우저 localStorage에 세션 정보 저장 금지 (고객 폰은 공용일 수 있음)
