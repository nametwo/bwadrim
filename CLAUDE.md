@AGENTS.md

# 봐드림 — 작업 가이드

원격 화상 A/S 웹 서비스. 엔지니어(폰+PC 웹) ↔ 고객(폰 카메라). README.md에 범위·제약·지표가 정리되어 있으니 먼저 읽을 것.

## 기능 요구사항 문서 (필수)

`docs/requirements.md`가 제품 동작의 기준 문서다. 제품 담당자는 코드를 보지 않고 이 문서의 요구사항 ID(예: `CALL-03`)로 소통한다.

- 기능을 추가·수정·삭제하면 **같은 커밋에서** 해당 요구사항을 갱신한다: 문구, 상태(✅/🚧/⬜), 확인 방법, 제약, 관련 코드
- 새 요구사항은 영역의 다음 번호를 쓴다. 삭제된 기능의 ID는 재사용하지 않고 `폐기`로 표시한다
- 문서 맨 아래 변경 이력에 날짜와 바뀐 ID를 한 줄로 남긴다
- 요청이 기존 요구사항과 충돌하면 구현 전에 어느 ID가 어떻게 바뀌는지 먼저 말한다
- 코드로 확인하지 않은 동작은 ✅로 적지 않는다

## 원칙

- 고객 쪽은 **로그인·설치·앱 없음**. 링크 클릭 → 버튼 한 번 → 카메라. 탭 두 번 이하
- 고객 UI는 나이 든 사장님 기준: 큰 버튼, 한글, 한 화면에 한 가지 행동
- 엔지니어 UI는 폰에서 한 손 조작 가능해야 함. 영상 위에 터치 오버레이, 도구 버튼 최소화
- "항상 연결된다"가 UX의 일부. ICE 서버에 TURN을 반드시 포함하고, relay 사용 여부를 이벤트로 남길 것
- 미디어는 브라우저 네이티브 WebRTC P2P로 확정 (관리형 SDK 안 씀). TURN은 Cloudflare 단일. 미디어 로직은 `src/lib/webrtc` 안에만 두고 UI에 새어나가지 않게 (LiveKit 전환 가능성 대비)
- 카메라/마이크 요청은 반드시 사용자 제스처 이후에 호출

## 구조

```
src/proxy.ts                                     # 세션 갱신 + 엔지니어 라우트 보호 (Next 16: middleware → proxy)
src/app/
  (engineer)/login, /dashboard, /room/[id], /stats  # 로그인 필요. 방 생성·종료는 서버 액션. stats = 핵심 지표(DATA-06)
  join/[token]                                   # 고객 진입, 공개. 32자리 링크 토큰(ROOM-12)
  api/turn                                       # 링크 토큰 검증 후 Cloudflare TURN 단기 자격증명 발급
  api/events                                     # 고객(비로그인) 쪽 지표 이벤트 수집
src/lib/
  supabase/{client,server,admin}.ts              # admin = service role, 서버 전용
  webrtc/                                        # peer 연결, ICE 설정, 시그널링, 포인터 좌표(pointer.ts), 화면 멈춤·그리기(draw.ts), 카메라 전환·손전등(camera.ts), DataChannel 래퍼(data-link.ts), 방향 지시 메시지(guide.ts)
  tracking/                                      # 평면 앵커 추적(AR 핀, CALL-14). 설계는 tracking/README.md, 벤치는 scripts/tracking-bench
  join-token.ts                                  # 고객 링크 토큰 형식 검사
  wake-lock.ts                                   # 통화 중 화면 꺼짐 방지
  in-app-browser.ts                              # 카톡 등 인앱 브라우저 감지·외부 브라우저로 열기
  events.ts                                      # 지표 이벤트 기록
  metrics.ts                                     # 핵심 지표 계산 (통계 화면)
src/components/                                  # 엔지니어·고객 화면 공용 UI (포인터 동그라미, 정지 화면 그리기). anchor/·anchor-overlay = AR 핀 층(CALL-14), guide-dpad·guide-overlay = 방향 지시(CALL-15)
supabase/schema.sql
docs/requirements.md                             # 기능 요구사항 (기준 문서)
```

## 시그널링

Supabase Realtime **비공개** broadcast 채널, 역할별 일방통행 두 개 (CALL-12):
- `room:{id}:e` 엔지니어 → 고객. 보내기는 방 주인(로그인 JWT)만 — `supabase/schema.sql`의 `realtime.messages` 정책
- `room:{id}:c` 고객 → 엔지니어. 링크를 연 누구나

각자 자기 채널로 보내고 상대 채널만 듣는다. 고객은 `:e`에서 온 신호만 믿을 것 (엔지니어 사칭 차단). 공개 채널로 되돌리지 말 것.
메시지 타입: `offer` / `answer` / `ice` / `pointer` / `cam` / `bye`.
AR 핀(CALL-14)은 전용 DataChannel `anchor`(고객이 offer에 포함). 기준 사진 조각이 'draw'의 포인터·그리기를 막지 않게 따로 연다. 엔지니어 영상 제스처: 짧게 탭 = 레이저 포인터(CALL-08), 0.5초 길게 누름 = AR 핀.
포인터·드로잉은 연결 후 DataChannel로 옮길 것 (지연 최소화). 좌표는 0~1 정규화.
방향 지시(CALL-15, `src/lib/webrtc/guide.ts`)는 전용 DataChannel `guide`(고객이 offer에 포함, `CallSession.guideLink`). 'draw'에 섞으면 정지 사진 조각 뒤에 막혀 1.5초가 지나 화살표가 저절로 사라진다(고객에겐 '멈춤'으로 보임). 엔지니어가 십자키(`src/components/guide-dpad.tsx`, 상하좌우 + 가운데 가까이/멀리)를 누르는 동안 `hold`를 0.4초마다 재전송하고 떼면 `release`. 고객 쪽(`guide-overlay.tsx`)은 1.5초간 `hold`가 없으면 스스로 지운다. 고객 화면에 방향 지시가 떠 있는 동안은 AR 핀 층(`hidden`)과 상태 문구를 숨긴다. 실험실 `/lab/guide`는 통화 없이 흉내 낸다.

## 디자인 토큰

색·모서리·크기는 `src/app/globals.css`의 `@theme` 토큰을 쓸 것 (hex 직접 쓰지 말 것). 이름은 피그마 변수와 같음: https://www.figma.com/design/Hqnz1fYrJJAhO7nDGNKRwn (`a/b` → `--color-a-b`, `a/default` → `--color-a`)
- 파랑(`primary`)은 "지금 누를 것" 하나에만. 보조 동작·선택 상태는 중립색
- 노랑(`guide-signal`)은 방향 지시에만. 통화 화면은 `call-*`, 빨강(`danger`)은 종료·오류에만
- 가리키기(`pointer`)는 디자인 시스템상 브랜드 블루지만, 지금 CALL-08·09 구현은 빨강이다. 바꾸려면 요구사항부터 고칠 것
- 지금 코드의 다른 예외(바꾸려면 요구사항부터): 카톡 공유 버튼 노랑(카카오 색), CALL-11 손전등 켜짐 노랑, '지금 누를 것' 버튼은 아직 검정. 작업 중인 AR(CALL-14)도 빨강 화살표·amber 정지 표시를 쓴다

## 이벤트 이름 (events 테이블)

`room_created`, `link_opened`, `camera_granted`, `camera_denied`, `connected`, `relay_used`, `pointer_used`, `freeze_used`, `anchor_used`, `guide_used`, `ended`, `resolved_remotely`

## 환경 변수

`.env.example` 참고. TURN 자격증명은 서버에서만 다루고 클라이언트엔 단기 토큰만 내려줄 것.

## 하지 말 것

- PC 화면 공유, 원격 제어, 설치형은 1차 범위 아님
- 브라우저 localStorage에 세션 정보 저장 금지 (고객 폰은 공용일 수 있음)
- 고객 이름·전화번호·연락처 저장 금지 (NFR-07). 받는 사람 고르기는 문자 앱·카톡에 맡긴다
