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
  (engineer)/login, /dashboard, /room/[id], /stats  # 로그인 필요. 방 생성·종료는 서버 액션. stats = 핵심 지표(DATA-06). layout = 앱 안 브라우저면 인터넷 앱으로(AUTH-09)
  join/[token]                                   # 고객 진입, 공개. 32자리 링크 토큰(ROOM-12). start-screen(시작), camera-help(거부 원인별 안내), camera-start(통화)
  api/turn                                       # 링크 토큰 검증 후 Cloudflare TURN 단기 자격증명 발급
  api/events                                     # 고객(비로그인) 쪽 지표 이벤트 수집
  api/kakao/share-webhook                        # 카카오톡 공유 전송 성공 웹훅 → kakao_sent(채팅방 종류·해시, ROOM-15)
src/lib/
  supabase/{client,server,admin}.ts              # admin = service role, 서버 전용
  webrtc/                                        # peer 연결, ICE 설정, 시그널링, 포인터 좌표(pointer.ts), 화면 멈춤·그리기(draw.ts), 카메라 전환·손전등(camera.ts), DataChannel 래퍼(data-link.ts), 방향 지시 메시지(guide.ts), 사진 찍기·주고받기(photo.ts, CALL-16), 대시보드 탭에서 마이크 미리 받기(mic-ahead.ts, CALL-01)
  tracking/                                      # 평면 앵커 추적(AR 핀, CALL-14). 설계는 tracking/README.md, 벤치는 scripts/tracking-bench
  join-token.ts                                  # 고객 링크 토큰 형식 검사
  engineer-name.ts                               # 엔지니어 표시 이름 (user_metadata.name, OPS-03). 고객 시작 화면 기사님 카드
  photo-save.ts                                  # 통화 중 찍은 사진 저장 (폰 공유 창·다운로드, CALL-16)
  format.ts                                      # 화면 시각·시간 글자 ('오늘 오후 5:03', 한국 시간 고정)
  wake-lock.ts                                   # 통화 중 화면 꺼짐 방지
  in-app-browser.ts                              # 카톡 등 인앱 브라우저 감지·외부 브라우저로 열기
  kakao-share.ts                                 # 카톡 보내기(카카오링크, ROOM-14). 카카오 키가 있을 때만. SDK는 링크 보내기 화면에서 미리 받는다
  events.ts                                      # 지표 이벤트 기록
  metrics.ts                                     # 핵심 지표 계산 (통계 화면). endedConnected = 끝난 상담이 고객과 연결됐었는지 (대시보드 칩·끝난 상담 화면도 같이 씀)
src/components/                                  # 엔지니어·고객 화면 공용 UI (포인터 동그라미, 정지 화면 그리기). anchor/·anchor-overlay = AR 핀 층(CALL-14), guide-dpad(방향 링·가까이/멀리 알약)·guide-pad-geometry·guide-overlay(고객 노란 원 화살표·네 모서리)·guide-pill = 방향 지시(CALL-15), open-in-browser = 앱 안 브라우저 안내(고객 JOIN-10·엔지니어 AUTH-09)
  ui/                                            # 디자인 시스템 부품(NFR-08, 피그마 컴포넌트와 같은 이름): button(Button·ButtonLink·buttonClass), icons(선 아이콘), sheet(아래 확인 창), notice-screen(한 화면 한 안내), bottom-cta(아래에 붙는 버튼 자리), brand(로고), status-chip, step-item, banner, call-control(통화 원형 버튼), stat-card, engineer-card, call-timer
supabase/schema.sql
docs/requirements.md                             # 기능 요구사항 (기준 문서)
할일.md                                          # 나중에 할 일 메모. 하기로 하면 requirements.md로 옮기고 지운다
```

## 시그널링

Supabase Realtime **비공개** broadcast 채널, 역할별 일방통행 두 개 (CALL-12):
- `room:{id}:e` 엔지니어 → 고객. 보내기는 방 주인(로그인 JWT)만 — `supabase/schema.sql`의 `realtime.messages` 정책
- `room:{id}:c` 고객 → 엔지니어. 링크를 연 누구나

각자 자기 채널로 보내고 상대 채널만 듣는다. 고객은 `:e`에서 온 신호만 믿을 것 (엔지니어 사칭 차단). 공개 채널로 되돌리지 말 것.
메시지 타입: `offer` / `answer` / `ice` / `pointer` / `cam` / `bye`.
AR 핀(CALL-14)은 전용 DataChannel `anchor`(고객이 offer에 포함). 기준 사진 조각이 'draw'의 포인터·그리기를 막지 않게 따로 연다. 엔지니어 영상 제스처: 짧게 탭 = 레이저 포인터(CALL-08), 0.5초 길게 누름 = AR 핀.
포인터·드로잉은 연결 후 DataChannel로 옮길 것 (지연 최소화). 좌표는 0~1 정규화.
방향 지시(CALL-15, `src/lib/webrtc/guide.ts`)는 전용 DataChannel `guide`(고객이 offer에 포함, `CallSession.guideLink`). 'draw'에 섞으면 정지 사진 조각 뒤에 막혀 1.5초가 지나 화살표가 저절로 사라진다(고객에겐 '멈춤'으로 보임). 엔지니어가 방향 링(`src/components/guide-dpad.tsx`, 상하좌우 네 조각 + 가운데 구멍 = 멈춤)이나 그 아래 '− 멀리 | 가까이 +' 알약을 누르는 동안 `hold`를 0.4초마다 재전송하고 떼면 `release`. 누른 자리 판정은 `src/components/guide-pad-geometry.ts`(단위 테스트 있음). 고객 쪽(`guide-overlay.tsx`)은 1.5초간 `hold`가 없으면 스스로 지운다. 고객 화면에 방향 지시가 떠 있는 동안은 AR 핀 층(`hidden`)과 상태 문구를 숨긴다. 실험실 `/lab/guide`는 통화 없이 흉내 낸다.
사진 찍기(CALL-16, `src/lib/webrtc/photo.ts`)는 전용 DataChannel `photo`(고객이 offer에 포함, `CallSession.photoLink`). 엔지니어가 `photo-req`를 보내면 고객 폰이 자기 카메라로 찍어(ImageCapture → 잠깐 해상도 올리기 → 영상 프레임) JPEG base64 조각으로 돌려준다. 고객 화면에 '기사님이 사진을 찍었어요'. 사진은 서버에 올리지 않고 엔지니어 메모리에만 있다가, 상담을 닫은 뒤 사진이 있을 때만 사진 저장 화면(`room/[id]/photo-save-view.tsx`)에서 저장할지 묻는다. 저장 안 하고 나가면 사라진다.

## 화면 카탈로그

`npm run screens` → 모든 화면·상태(통화 중 도구, 오류, 이어받기 등)를 폰·PC로 찍어 `screens/index.html` 한 장에 모은다. 요구사항 ID로 걸러 볼 수 있다. e2e와 같은 가짜 Supabase·가짜 카메라·실제 WebRTC 루프백을 쓰고, 앱 코드는 건드리지 않는다(브라우저 API는 `e2e/screens/browser-hooks.ts`로 흉내).
- 화면이나 상태를 새로 만들면 `e2e/screens/catalog.screens.ts`에 `shot()`을 하나 더한다. 못 가는 상태는 `unreachable()`로 이유를 남긴다
- 카탈로그는 버튼·상태를 `data-testid`와 역할(role)로 찾는다. 새 화면·상태에는 `data-testid`를 붙여 둘 것 — 문구·디자인만 바뀌면 카탈로그를 고칠 일이 없다
- 찾던 버튼이 없어지는 등 한 장면이 막히면 그 장면만 '못 찍은 상태'(이유 포함)로 남고 나머지는 계속 찍힌다
- `next dev`는 폴더당 하나만 뜬다. 개발 서버가 켜져 있으면 끄거나, 다른 폴더(git worktree)에서 돌릴 것

## 디자인 토큰

색·모서리·크기·글자·그림자는 `src/app/globals.css`의 `@theme` 토큰을 쓸 것 (hex 직접 쓰지 말 것). 이름은 피그마 변수·스타일과 같음: https://www.figma.com/design/Hqnz1fYrJJAhO7nDGNKRwn (`a/b` → `--color-a-b`, `a/default` → `--color-a`, 텍스트 스타일 `Title/M` → `text-title-m`, 효과 `Shadow/Card` → `shadow-card`)
- 버튼·확인 창·안내 화면·아이콘은 `src/components/ui`를 쓸 것. 새로 만들지 말고 variant를 늘릴 것. 버튼에 이모지 쓰지 말 것(폰마다 모양이 다름) — `ui/icons.tsx`
- 화면 짜임(토스식, NFR-08): 본문 맨 위 큰 제목 하나(할 일·지금 상태) + 회색 한두 줄, 누를 것은 `ui/bottom-cta`(아래에 붙음). 위쪽 바엔 제목 없이 뒤로·닫기만. 묶음은 테두리 대신 면(흰 화면엔 `bg-bg-subtle` 카드, 대시보드·통계는 `bg-bg-muted` 바탕에 흰 카드, 모서리 `rounded-3xl`). 설명 글을 늘리기 전에 배치·제목으로 풀 것
- 파랑(`primary`)은 "지금 누를 것" 하나에만. 보조 동작은 회색 바탕(`secondary`)이나 글자 버튼(`ghost`), 선택 상태는 흰 바탕 + 진한 테두리 등 중립색. 통화 화면 버튼은 `call`·`call-danger`·`call-ghost`, 켜진 도구는 `CallControl state="active"`(흰 원)
- 노랑(`guide-signal`)은 방향 지시에만. 통화 화면은 `call-*`, 빨강(`danger`)은 종료·오류에만. 종료는 확인 창(`ui/sheet`)을 한 번 거친다
- 고객 화면: 본문 `text-body-l`(18px) 이상, 누를 버튼 `size="xl"`(64px), 누를 것은 화면 아래쪽. 엔지니어 통화 화면: 누르는 자리가 바뀌지 않게(안내가 사라져도 자리는 남긴다)
- 가리키기(`pointer`)는 디자인 시스템상 브랜드 블루지만, 지금 CALL-08·09·14 구현은 빨강이다. 바꾸려면 요구사항부터 고칠 것
- 지금 코드의 다른 예외(바꾸려면 요구사항부터): 카톡 보내기 버튼 노랑(카카오 색), 고객 '허용' 화살표 노랑(JOIN-02). AR(CALL-14)은 빨강 화살표·amber 정지 표시를 쓴다
- 피그마 화면의 고객 이름·전화번호 입력, 방 코드, '엔지니어' 호칭은 따르지 않는다(NFR-07, ROOM-02 폐기). 고객 화면에서는 '기사님'

## 화면 문구

사람이 쓴 말처럼. 쓰고 나서 소리 내어 읽어 보고 어색하면 고친다.
- 해요체. 고객(사장님)에게는 '-시-'를 살린다('닫으셔도 돼요'). 버튼 이름은 동사로 짧게, 안내에서는 버튼 이름을 그대로 부른다
- 한 문장에 한 가지. 두 가지면 띠·안내의 제목/두 번째 줄로 나눈다. 대시(—)나 가운데점(·)으로 두 문장을 잇지 않는다(가운데점은 '통화 중 · 3:12' 같은 정보 나열에만)
- 괄호 설명 대신 풀어 쓴다('마이크 꺼짐(보기만)' ✗ → '마이크가 꺼져 있어요 / 고객님은 목소리를 못 들어요')
- 상투어·번역투 금지: '원활하지 않아요', '이용해 주셔서 감사합니다', '~할 수 있습니다', '주의할 점'. 같은 어미('~해 드려요')를 한 화면에 반복하지 않는다
- 공식 같은 문구 금지: 'X 없이, Y 하나로', 딱 맞춘 세 줄 나열. 구체적으로 무엇을 하는지 쓴다
- 보조 용언은 띄어 쓴다('눌러 주세요', '봐 주세요'). 화면에서는 '세션' 대신 '상담'
- 문구를 바꾸면 `docs/requirements.md`의 인용과 e2e 테스트의 기대 문구도 같이 바꾼다

## 이벤트 이름 (events 테이블)

`room_created`, `link_opened`, `camera_granted`, `camera_denied`, `connected`, `relay_used`, `pointer_used`, `freeze_used`, `anchor_used`, `guide_used`, `photo_taken`, `kakao_sent`, `ended`

`resolved_remotely`('출장 없이 해결?')는 2026-10-03부터 남기지 않는다(예전 기록만 있음, DATA-01). `rooms.resolved_remotely` 칸도 지우지 않고 두되 새로 쓰지 않는다.

## 환경 변수

`.env.example` 참고. TURN 자격증명은 서버에서만 다루고 클라이언트엔 단기 토큰만 내려줄 것.

## 하지 말 것

- PC 화면 공유, 원격 제어, 설치형은 1차 범위 아님
- 브라우저 localStorage에 세션 정보 저장 금지 (고객 폰은 공용일 수 있음)
- 고객 이름·전화번호·연락처 저장 금지 (NFR-07). 받는 사람 고르기는 문자 앱·카톡에 맡긴다
