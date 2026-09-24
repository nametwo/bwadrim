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
  (engineer)/login, /dashboard, /room/[id]      # 로그인 필요. 방 생성·종료는 서버 액션
  join/[code]                                    # 고객 진입, 공개
  api/turn                                       # 방 코드 검증 후 Cloudflare TURN 단기 자격증명 발급
  api/events                                     # 고객(비로그인) 쪽 지표 이벤트 수집
src/lib/
  supabase/{client,server,admin}.ts              # admin = service role, 서버 전용
  webrtc/                                        # peer 연결, ICE 설정, 시그널링, 포인터 좌표(pointer.ts), 화면 멈춤·그리기(draw.ts), 카메라 전환·손전등(camera.ts)
  wake-lock.ts                                   # 통화 중 화면 꺼짐 방지
  in-app-browser.ts                              # 카톡 등 인앱 브라우저 감지·외부 브라우저로 열기
  events.ts                                      # 지표 이벤트 기록
src/components/                                  # 엔지니어·고객 화면 공용 UI (포인터 동그라미, 정지 화면 그리기)
supabase/schema.sql
docs/requirements.md                             # 기능 요구사항 (기준 문서)
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
