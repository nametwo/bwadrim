# 추적 벤치마크 (scripts/tracking-bench)

`src/lib/tracking`의 평면 앵커 추적기(`PlanarTracker`)를 **정답(GT)이 있는 합성 영상**으로 잰다.
실제 A/S 대상처럼 생긴 평면(단말기·공유기·보일러 조절기·분전반·광택 패널·명판)을 폰 카메라로 찍은 것처럼 렌더하고,
프레임마다 핀의 정답 위치와 추적 결과를 비교해 README(`src/lib/tracking/README.md`) "품질 목표" 표의 지표를 낸다.

시나리오는 세 묶음이다.

| 묶음 | 수 | 무엇 | 기본 실행 | 게이트 |
|---|---|---|---|---|
| **base** | 49 | 기존 합성 영상 (깨끗한 평면·JPEG 흉내) | O | 부분집합 15개 |
| **realism** | 19 | base와 **같은 궤적·핀**에 실감 효과를 켠 변형 (`real/<원본 id>`) — 렌즈 왜곡·입체 부조·ISP·초점 호흡/헌팅·면광원 반사, 일부는 **실제 WebRTC 코덱(VP8/VP9)** | O | X |
| **holdout** | 16 | 과적합 확인용. 다른 기기(홀드아웃 전용 텍스처)·핀·궤적·시드 + 모든 실감 효과 + 실제 코덱 | X (`--holdout`) | X |

```bash
npm run bench:tracking                          # base + realism (68개) — 표 출력
npm run bench:tracking -- --suite=base          # base만 (예전 기본 실행과 같다)
npm run bench:tracking -- --suite=realism       # 실감 묶음만 (원본과 나란히 비교하려면 --suite=base,realism)
npm run bench:tracking -- --holdout             # 홀드아웃만 — 추적기 튜닝에 쓰지 말 것 (아래 "홀드아웃")
npm run bench:tracking -- --scenario=acquire    # 일부만 (id 부분문자열·범주·묶음 이름, 쉼표로 여러 개)
npm run bench:tracking -- --no-codec            # 실제 코덱 시나리오 빼기 (Chromium 캡처 없이)
npm run bench:tracking -- --json                # + out/latest.json (홀드아웃이면 out/latest-holdout.json)
npm run bench:tracking -- --json --compare=scripts/tracking-bench/out/prev.json   # 이전 결과와 차이
npm run bench:tracking -- --frames-dir=/tmp/frames --scenario=router            # 점검용 PNG
npm run bench:tracking -- --tracker=oracle      # 하네스 검증: 정답 H → 모든 지표 완벽
npm run bench:tracking -- --tracker=null        # 하네스 검증: 항상 못 찾음 → 추적 0%, 틀림 0%
npm run bench:tracking -- --list                # 시나리오 목록 (--holdout/--suite와 함께 쓸 수 있음)
npm run bench:tracking -- --help
npx vitest run scripts/tracking-bench           # 단위 테스트 + 품질 게이트
```

## 무엇을 재나 (README 정의 그대로)

| 지표 | 정의 |
|---|---|
| 표시 | `state ∈ {tracking, weak}` 이고 H가 있음 |
| 오차 | 표시 중일 때 `H·pinRef`와 정답 핀 사이 거리 (작업 해상도 px, 긴 변 320) |
| **틀린 표시** | 표시 중인데 **핀이 화면 밖**(8px 여유)이거나 **오차 > 8px**. 분모는 처리한 전체 프레임 |
| 추적률 | 핀이 **보이는**(화면 안이고 손·부조에 안 가려진) 프레임 중 "표시 && 오차 ≤ 8px" 비율 |
| 오차 중앙값 / p95 | 표시 중이고 핀이 화면 안인 프레임의 오차 |
| 최초 탐색 (고객 쪽) | 처리 시작부터 처음 올바르게 표시될 때까지 프레임 수. 목표는 "5프레임 내 ≥ 90%" (시나리오 단위 비율) |
| 재검출 (복귀) | 핀이 0.3초 이상 안 보이다가 다시 보이고 ROI 절반 이상이 화면에 들어온 순간부터 처음 올바르게 표시될 때까지 프레임 수. "10프레임 내 ≥ 80%" (이벤트 단위 비율) |
| 처리 시간 | `process()` 한 번의 벽시계 시간. `TrackResult.redetected`로 추적/재검출 프레임을 나눠 중앙값·p95 |
| **화면 밖 안내 (hint)** | 계약 v2 `TrackResult.hint`. 정답 핀이 카메라 앞이지만 **프레임 밖**인 프레임에서 "표시 안 함 + `reason='offscreen'` + 유효한 hint"를 낸 비율(**제공률**)과, 프레임 중심에서 본 `hint·핀` 방향과 정답 핀 방향 사이 각도(**방향 오차**, 중앙값·p95·최대·>45° 비율). 핀이 화면 안인데 `reason='offscreen'`이면 **오안내**로 따로 센다. 목표는 없음(참고 수치) |

- 손에 가려진 핀(또는 입체 부조 — 포트 구멍 안쪽 벽 등 — 에 가려진 핀)을 제자리(오차 ≤ 8px)에 그리는 것은 틀린 표시가 아니다. 추적률 분모에서는 뺀다.
- `setReference`에는 런타임처럼 `anchor = 핀(ref 픽셀)`을 넘긴다. `trackable=false`면 런타임처럼 추적을 돌리지 않는다 (모든 프레임 표시 안 함, 표에 `trackable=false`).
- 범주별 판정은 그 범주 시나리오의 프레임을 **모아서** 한다 (시나리오별 판정은 참고). **묶음(base/realism/holdout)은 섞지 않는다** — 표에 `[실감]`, `[홀드아웃]` 접두어로 따로 나온다. 목표는 같은 범주면 같다.

| 범주 | 목표 | 출처 |
|---|---|---|
| jitter 손떨림 | 추적률 ≥ 95%, 오차 중앙값 ≤ 2px, 틀림 ≤ 0.5% | README |
| motion 이동·확대·기울임 | 추적률 ≥ 85%, 오차 중앙값 ≤ 3px, 틀림 ≤ 1% | README |
| repetitive 반복 패턴 | 틀림 ≤ 1% | README |
| lowtex 무늬 없음 | 틀림 ≤ 1% (trackable=false·lost 허용) | README |
| reentry 화면 밖→복귀 | 10프레임 내 재검출 ≥ 80%, 틀림 ≤ 1% | README |
| acquire 고객 최초 탐색 | 5프레임 내 ≥ 90%, 틀림 ≤ 1% | README |
| stress (흔들기·조명·그림자·손 가림·방향 전환·심한 압축) | 틀림 ≤ 1% (나머지는 참고 수치) | 벤치 자체 |
| drift 긴 시퀀스 | 이동 기준 (추적률 ≥ 85%, 중앙값 ≤ 3px, 틀림 ≤ 1%) + 처음/마지막 10초 오차 비교 | 벤치 자체 |
| 성능 | 추적 프레임 중앙값 ≤ 5ms, 재검출 프레임 중앙값 ≤ 15ms (데스크톱 Node) | README |

성능 줄 아래에 `setReference` 시간(시나리오당 1번, 중앙값·p95·최대 — 기준 이미지 렌더는 타이머 밖)이 나온다.
출력 끝에는 (1) 화면 밖 안내 표 (2) **실감 변형 ↔ 원본** 표(둘 다 이번 실행에 있을 때 — 추적률·오차·틀림·탐색/재검출을 나란히)
(3) 실제 코덱 캡처 표(코덱·인코더·실측 kbps·평균 QP·디코드 해상도·받은 프레임 수)가 나온다.

## 합성 영상은 어떻게 만드나

```
HTML/CSS/SVG ─Playwright Chromium→ 텍스처 PNG (.cache/textures, 캐시)  [홀드아웃 텍스처는 + photoize 사진 후처리]
   ↓ 선형광 밉맵
핀홀 카메라(긴 변 화각 65°) + 6자유도 궤적 + 손떨림 → 평면별 정확한 호모그래피
   ↓ 렌더(스트림 해상도 480x640 등): 비등방 삼선형 필터, 배경 평면은 대상 뒤로 떨어져 시차·접지 그림자,
     정반사 하이라이트(광택 패널), 몸·손 그림자, 비평면 가림(손), 롤링 셔터(행마다 시각), 노출 동안 모션 블러,
     렌즈 번짐 + 자동초점 지연 흐림, 동적 자동노출(매 프레임 측광, 시상수 0.45초)·조명 변화·깜빡임,
     샷+읽기 잡음(이득에 비례), sRGB 톤 곡선
   [실감] + 렌즈 왜곡 · 입체 부조(광선 추적) · 면광원 반사 · 초점 호흡/헌팅 · ISP 톤 곡선 → TNR → 샤프닝
   ↓ 엔지니어 쪽: [대역폭 축소] + JPEG(WebRTC 흉내, 기본 q75, 움직임이 크면 품질↓ 최저 18)
                  [실감 codec] 실제 WebRTC 인코더·디코더 (Chromium 루프백, 아래)       고객 쪽: 압축 없음
   ↓ 리샘플 → 작업 해상도(긴 변 320) 그레이 = 추적기 입력  (런타임 frame-source와 같은 필터·반올림)
```

- **텍스처** (`textures.ts`, `html/*.ts`): (a) 카드 단말기 (b) 공유기 뒷면 — 똑같은 LAN 포트 4개 (c) 보일러 온도조절기 — 7세그먼트 LCD
  (d) 분전반 — 똑같은 차단기 8개 (e) 광택 흰 가전 패널 — 작은 로고뿐 (f) 명판 스티커 — 촘촘한 작은 글씨 (g) 배경: 벽·책상.
  결정적(시드 고정)이며 HTML이 바뀌면 자동으로 다시 렌더한다. 랜드마크(`data-lm`)의 중심이 핀 후보.
  홀드아웃 전용 텍스처는 `html/holdout.ts` (아래).
- **카메라·장면** (`camera.ts`): 월드 = 대상 평면(Z=0, 단위 = 텍스처 픽셀). 궤적은 "핀 기준 cm" 키프레임 + 손떨림(느린 흔들림+생리적 떨림).
  가리는 손은 대상 위 수 cm에 떠 있는 평면 위의 SDF 모양(검지·손바닥·팔뚝) — 대상과 시차가 있는 비평면 가림.
- **렌더** (`render.ts`): 모션 블러는 선명한 한 장을 그린 뒤 표면(대상/배경/손)마다 **해석적 운동 벡터**를 따라 노출 구간을 선 적분
  (서브프레임 자세를 평균하는 정확한 방식과 평균 차이 0.02 계조 — 테스트로 확인, `--exact-blur`로 정확한 방식 사용 가능).
  롤링 셔터는 행마다 다른 자세로 그린다 (GT 핀도 같은 고정점 반복으로 계산).
  실감 효과가 있으면 별도 행 패스(`realRows`)로 그린다 — **base 시나리오의 렌더 경로·결과는 바이트 단위로 그대로**다.
- **사진 효과** (`sequence.ts`): 자동노출은 1/30초마다 장면을 측광해 목표 이득으로 로그 공간에서 따라가고(어두운 단말기↔흰 영수증을 훑으면
  밝기가 늦게 바뀜), 자동초점은 거리의 역수를 0.45초 늦게 따라가며 |1/d − 1/d_f|에 비례해 흐려진다 (폰 메인 카메라 광학 근사).
- **파이프라인** (`sequence.ts`, `imageops.ts`):
  - 엔지니어 쪽: 기준 = 탭한 프레임 그대로(압축된 영상), `initialH = I`, 30fps.
  - 고객 쪽: 기준 = 엔지니어 화면의 그 프레임(압축 영상) → 긴 변 640 → JPEG q80(DataChannel 전송과 같음) → 작업 해상도.
    앵커는 0.3초 늦게 도착(`latency`)하고 `initialH` 없이 시작, 처리 20fps(카메라 30fps 중 최신 프레임).
  - ROI = 기준 작업 해상도에서 핀 중심, 한 변 `0.5·min(w,h)`, 화면 안으로 자름.
  - JPEG은 기본으로 **DCT 양자화 시뮬레이터**(`jpegSimGray`, 표준 휘도 양자화표·libjpeg 품질 배율)를 쓴다. jpeg-js 왕복과 평균 차이 < 0.1 (테스트로 확인), 6배 빠르다.
    `--exact-jpeg`면 프레임마다 jpeg-js. 고객 쪽 기준 이미지는 항상 jpeg-js.
  - **작업 해상도 리샘플**(`resampleGray`/`downscaleArea`/`toWorking`)은 런타임 `src/lib/tracking/frame-source.ts`의 `resamplePlane`(VideoFrame 경로)과
    같은 식이다: 축소 = 정확한 겹침 가중치 면적 평균(가로·세로 정수배면 박스 합), **확대 = 픽셀 중심 정렬 선형 보간**(수신 해상도가 긴 변 320보다 작을 때 —
    런타임은 긴 변을 항상 320으로 맞춘다), 반올림 `floor(v + 0.5 + 1e-4)`. 디코더 Y 평면(16~235)은 리샘플 뒤 한 번에 `(Y−16)·255/219`로 편다(`toWorkingLimited`).
- **좌표 규약**: GT의 H·핀은 작업 해상도 **픽셀 중심 규약**(첫 픽셀 중심 = (0,0)) — 배열을 직접 다루는 추적기의 좌표와 같다.
  벤치의 정규화 좌표(y4m 사이드카)는 **가장자리 규약** `norm = (px + 0.5) / W = x_edge / W`다.
  **런타임 프로토콜(`pxToNorm`, session/protocol)의 norm은 `px_center / W_작업`** — 같은 점이 벤치 값보다 `0.5 / W_작업`(긴 변 320이면 0.0016) 작다.
  E2E 등에서 둘을 비교할 때는 `norm_런타임 = norm_벤치 − 0.5 / W_작업`으로 맞출 것 (작업 해상도에서 0.5px라 8px 판정에는 거의 영향 없음).

## 실감 효과 (`scenarios.ts` `RealismSpec`, 렌더 `render.ts realRows`)

모두 결정적(시드 고정)이고 프레임 캐시에 들어간다. 시나리오마다 켜고 끌 수 있다 (`realism: { lens, relief, isp, af, area, codec }`).

| 효과 | 모델 | 정답(GT) |
|---|---|---|
| **렌즈 왜곡** (`lens.ts`) | Brown–Conrady 방사 k1,k2 + 접선 p1,p2, 정규화 = 기준 초점거리. 폰 메인 카메라 k1 ≈ −0.05…−0.12 (술통형). 센서 픽셀마다 핀홀 좌표·야코비안 표 → 텍스처 발자국까지 정확 | 핀은 해석적 `distort`(롤링 셔터 행도 왜곡된 행으로). ref→프레임이 호모그래피가 아니므로 **정답 H = ROI 9×9 격자 대응점에 최소제곱으로 맞춘 H** (`dlt.ts`) — 좋은 평면 추적기가 낼 수 있는 최선 |
| **입체 부조** (`relief.ts`) | 키·버튼 +2~6mm 돌출, 포트·슬롯 −2~6mm 함몰 (텍스처 위 높이 지도, 상자 목록). 픽셀마다 광선을 따라 걸어 첫 표면(윗면·바닥·옆벽)을 찾는다 → 시점에 따라 시차·옆벽·가림. 옆벽은 광원 방향으로 명암, 돌출부는 낮은 곳에 그늘 | **핀은 그 자리 표면 위의 3D 점**(돌출 키면 윗면, 포트면 바닥). 그 점이 시점상 부조에 가리면 `occluded`. 평면 추적기가 내는 H로는 핀이 시차만큼 어긋난다 — 그게 현실 |
| **ISP** (`isp.ts`) | 톤 곡선(추가 감마·S커브·암부 들어올림, 렌더러 LUT에 합침) → **TNR**(움직임 적응 재귀 필터, 움직임 보상 없음 → 대비 낮은 가장자리가 움직일 때 끌림) → **언샤프 마스크**(σ≈1px, 코어링, 가장자리 테) | 기하 변화 없음. TNR은 프레임 i의 출력을 항상 i−window…i 원시 프레임으로만 계산 → 작업자 조각과 무관하게 같은 바이트 |
| **초점 호흡·헌팅** | 초점(거리 역수)이 늦게 따라가고 `hunts`마다 앞뒤로 흔들림 → 흐림 σ ∝ \|1/d − 1/d_f\|. 호흡: 화각 배율 (1 + F/d_f)/(1 + F/250mm), F = 4.2mm → 초점이 움직이면 영상이 ±1~2% 커졌다 작아짐 | 초점거리 f(t)를 GT와 렌더가 같이 쓴다 |
| **면광원 반사** | 형광등·창(사각형, 대상 앞 거리)이 광택 표면에 거울 반사로 비침, 가장자리 흐림(거칠기)·슐릭 프레넬. 강하면 톤 곡선에서 포화 → 그 밑 무늬가 사라지고 카메라와 함께 움직임 | 기하 변화 없음 |
| **실제 코덱** (`codec.ts`) | 아래 절 | 디코드된 프레임 번호의 GT |

`real/*` 변형은 base와 같은 궤적·핀·시드라서 `--suite=base,realism`이면 "실감 변형 ↔ 원본" 표로 효과만의 영향을 본다.
검증(`realism.test.ts`): 렌즈 왜곡(+롤링 셔터·모션 블러)·부조(돌출 +40, 함몰 −30 평면 단위) 점 무늬 무게중심이 GT와 0.15~0.3px 안에서 맞고,
효과를 무시한 투영과는 1.5~3px 넘게 다르다. TNR 조각 독립성·번짐, 샤프닝 테도 확인한다.

## 실제 WebRTC 코덱 (`codec.ts`, `codec-cache.ts`)

엔지니어 쪽 영상은 고객 폰 카메라 → 고객 브라우저 인코더 → 망 → 엔지니어 브라우저 디코더를 거친다. JPEG 흉내 대신 **진짜 인코더**를 쓴다:

1. 원본(고객 카메라, ISP까지, **컬러**) 프레임을 앞 구간 2초(`CODEC_LEAD_S`)부터 끝까지 30fps로 병렬 렌더 → y4m.
   영상 **아래에 32행 띠를 덧붙여** 프레임 번호를 새긴다(16칸: 흰/번호 13비트/홀짝/검정, 칸 가운데 절반 평균으로 읽음) — 이미지 영역은 건드리지 않는다.
   libwebrtc 해상도 단계(3/4·1/2·3/8·1/4)에서도 이미지 행 수가 정수로 떨어진다.
2. Playwright Chromium을 `--use-file-for-fake-video-capture=<y4m>`로 띄우고, 한 페이지에서 `RTCPeerConnection` 두 개 루프백.
   `setCodecPreferences`로 코덱 고정, `maxBitrate`(300~800kbps), 필요하면 `scaleResolutionDownBy`(인코더 해상도 축소), `degradationPreference`(기본 maintain-resolution).
3. 수신 `<video>`의 `requestVideoFrameCallback`마다 `new VideoFrame(video)`의 **Y 평면(디코더 출력 16~235)**을 읽어 띠로 번호를 확인한다 —
   런타임 frame-source(VideoFrame 경로)가 읽는 데이터와 같다. 가짜 카메라는 파일을 반복 재생하므로 첫 바퀴는 연결·대역폭 추정이 자리잡는 데 쓰고 **두 번째 바퀴**를 기록한다.
4. `.cache/codec/<id>.<키>.bin`에 저장 (키 = 원본 프레임 지문 + 코덱 설정 + 캡처 코드 해시). **캡처는 실시간이라 비결정적**이지만 한 번 떠서 캐시로 고정한다.
   원본이 바뀌면(장면·렌더 코드) 다시 캡처한다. 다시 뜨고 싶으면 그 파일을 지운다.

- 엔지니어 쪽: 처리 프레임 = **실제로 디코드되어 화면에 나온 프레임**(인코더가 버린 프레임은 빠진다), 기준 = 탭 순간 화면의 마지막 프레임.
- 고객 쪽: 기준 이미지 = 엔지니어 화면의 디코드 프레임(→ 긴 변 640 → JPEG q80). 고객 자기 카메라 영상은 압축 없음. 캡처는 기준 +0.5초까지만.
- 코덱: **VP8·VP9**(libvpx). **H.264는 못 쓴다** — Playwright Chromium은 독점 코덱이 빠진 빌드다(`RTCRtpSender.getCapabilities`에 없음). 실제 앱은 Chrome↔Chrome이면 보통 VP8, iOS Safari가 끼면 H.264.
- 한 시나리오 캡처 ≈ 원본 렌더 30초 + 실시간 루프백 20초 (4코어). 루프백은 망 손실·지터가 없다 (대역폭 상한만).

## 사진 텍스처 (위키미디어) → 절차적 대체

실제 사진(위키미디어 커먼즈의 공유기 뒷면·분전반·카드 단말기·보일러 조절기·가전 조작부·명판)을 받으려 했으나 **이 환경의 외부망 정책이
`commons.wikimedia.org`·`upload.wikimedia.org`를 막는다**(프록시 CONNECT 403). 그래서 홀드아웃 전용으로 **새 기기 6종**을 HTML로 만들고
`photoize.ts`로 "사진처럼" 후처리했다: 고르지 않은 조명(넓은 가우시안 + 경사), 때·닦은 자국(값 잡음), 지문(저대비 능선), 먼지 점,
찍은 카메라의 흐림 + 샤프닝, 센서 잡음, JPEG q88. 기하(랜드마크·부조)는 그대로다. 결정적(시드)이며 후처리 코드·설정도 텍스처 해시에 들어간다.

| id | 기기 | 핀 후보(랜드마크) |
|---|---|---|
| `ont` | 광모뎀(ONT) 뒷면 — 흰 광택 본체, 광 포트(초록 덮개 +5mm), **노란 LAN 4개(반복)**, 전화 2개 | dc, powerBtn, fiber, lan1~4, tel1~2, usb, reset, wps, label |
| `washer` | 세탁기 조작부 — 큰 다이얼(+6mm, 홈), 코스 LED, 7세그 표시창, 버튼 5개 | knob, btnPower, btnStart, btnTemp, btnRinse, btnSpin, btnResv, btnDet, display |
| `thermo` | 다른 회사 온도조절기 — 둥근 LCD, 물리 버튼 4개 | lcdTemp, btnMode, btnDown, btnUp, btnAway, led |
| `handheld` | 휴대형 카드 단말기 — 터치 화면(결제 UI), 고무 키 4×3, 카드 슬롯 | screenOk, screenCancel, key0~9, keyCancel/Clear/Enter, cardSlot, paperSlot |
| `panel2` | 다른 분전반 — 2줄, 1P/2P 섞임, 빈 덮개, 손글씨 라벨 | elb, elbTest, br1~13 |
| `metalplate` | 가스보일러 금속 명판 — 헤어라인 알루미늄, 리벳 | type, gas, output, power, serial, date |

부조는 HTML의 `data-relief="mm"`(+`data-relief-r`, `data-relief-shape="ellipse"`) 요소에서 모은다 (기존 텍스처는 `relief.ts`의 `BASE_RELIEF`).
이 텍스처들은 `--holdout`(또는 그 텍스처를 쓰는 시나리오)일 때만 렌더된다.
외부망이 되는 곳에서 실제 사진을 쓰려면 `TEXTURES`에 PNG를 읽는 항목을 더하면 된다 (출처·라이선스를 같이 적을 것, `.cache` 밖에 커밋하지 말 것).

## 시나리오

`--list`(+ `--suite=`/`--holdout`)로 전체 목록. 궤적 키 `{ t, dx, dy, d, yaw, pitch, roll }`는 **핀 기준 cm와 도**
(`dx,dy` = 카메라가 바라보는 점의 핀 대비 위치, `d` = 거리). 빠진 값은 앞 키에서 이어받는다.

### base (`scenarios.ts`, 49개)

- **jitter** (6): 거의 고정 / 보통 / 심한 손떨림, 가로 화면, 반복 대상(공유기 LAN 3번, 차단기 5번), 화면 가장자리 핀(ROI 잘림)
- **motion** (12): 천천히 훑기(가로·세로), 2배 다가가기 ×2, 멀어지기, 45°·60° 기울이기, 90°·45° 돌리기, HD 720x1280 스트림,
  고객 쪽(20fps·압축 없음) 찾은 뒤 훑기·다가가며 돌리기
- **repetitive** (3): LAN 포트 위 훑기, 차단기 줄 기울여 훑기, 차단기에 바짝 다가가기 (ROI 안에 같은 모양 2~3개)
- **lowtex** (3): 광택 흰 패널(정반사 하이라이트가 카메라와 함께 움직임) 고정·이동, 고객 쪽 탐색
- **reentry** (5): 옆/아래로 벗어났다 돌아오기(×2), 반복 대상, 고객 쪽 ×2, 다른 거리·각도로 복귀 — 복귀 이벤트 9개
- **acquire** (8, 고객 쪽): 각 대상 + 앵커 도착 전 폰을 돌리고 다가감 + 어두운 곳(이득↑·잡음↑) + 가로 화면
- **stress** (11): 빠른 흔들기(블러·롤링 셔터) ×2, 움직이는 중에 탭(흐린 기준), 조명 꺼짐·켜짐(자동노출 지연·톤 곡선 변화),
  형광등 깜빡임(롤링 셔터 띠), 몸 그림자, 손가락 가림 ×2, 세로→가로 전환(프레임 크기 바뀜), 심한 압축(q30·q22 + 대역폭 축소)
- **drift** (1): 60초 천천히 둘러보기

### realism (`scenarios-realism.ts`, 19개)

기본 = 렌즈 k1 −0.08(+k2·접선), 부조, 보통 ISP(`ISP_TYPICAL`), 초점 호흡, 대상별 천장 형광등 반사. 시나리오마다 k1(−0.06~−0.12)·ISP 세기·초점 헌팅을 바꿨다.
실제 코덱: 엔지니어 쪽 `motion/pan/boiler`(VP8 500k), `motion/zoom-in/pos`(VP8 600k + 헌팅), `motion/roll90/pos`(VP9 400k),
`repetitive/router-lan3/pan`(VP8 350k ÷2 = 240x320), `reentry/pos`(VP8 500k). 고객 쪽 기준 이미지: `acquire/*` 4개(VP8 300~500k, 하나는 ÷2), `motion/zoom-customer/boiler`.

### holdout (`holdout.ts`, 16개) — 과적합 확인용

범주별: jitter 2, motion 4(고객 쪽 1), repetitive 1, lowtex 1, reentry 2(고객 쪽 1), acquire 4, stress 1(손가락이 핀 버튼을 누름), drift 1(30초).
대상은 홀드아웃 전용 6종 + `appliance`(다른 핀·궤적). 모두 시드가 다르고, 엔지니어 쪽은 드리프트·무늬 없음을 빼면 실제 코덱(VP8/VP9 300~600k, 한 개는 저대역 ÷2),
고객 쪽 기준 이미지도 실제 코덱. 어두운 다용도실(노출 33ms, 조도 25%)·고객 폰 15fps·앵커 지연 0.3~0.5초 같은 실제 사용 조건을 섞었다.

**운영 규칙**: 추적기를 고치는 사람(에이전트)은 `holdout.ts`·`html/holdout.ts`·홀드아웃 결과·그 텍스처 PNG를 보지 않는다.
홀드아웃 숫자는 "개발 세트(base+realism)에서 좋아진 것이 일반화되는가"를 가끔 확인하는 데만 쓴다. 홀드아웃이 나쁘다고 홀드아웃에 맞춰 고치지 말고,
원인을 개발 세트에 비슷한 시나리오로 더해서 고친다. 홀드아웃을 통과/실패시키려고 홀드아웃 자체를 조정하지 않는다.

## 캐시·속도

- 렌더가 시간의 대부분이다. 처음 실행은 CPU-1개 작업자로 병렬 렌더(`--jobs`)해서 `.cache/frames/`에 저장하고,
  이후 실행은 캐시만 읽어 추적기만 돈다. (4코어 기준) base 약 7,500장 5분 남짓, realism 약 2,700장 + 코덱 캡처 10개 약 12분,
  holdout 약 3,000장 + 코덱 캡처 14개 약 14분. 캐시가 있으면 base+realism 약 50초(추적 35초), holdout 약 20초 (4코어 실측).
- 캐시 키는 "장면 함수들을 모든 프레임 시각에서 평가한 값 + 렌더 코드 해시 + 텍스처 해시"라서 궤적·조명·코드가 바뀌면 그 시나리오만 자동으로 다시 렌더한다.
- **기준 이미지**도 같은 지문으로 `.cache/refs/`에 캐시한다 (실감 시나리오는 기준 한 장 렌더에 ~1초 — 캐시가 없으면 기본 실행에 ~17초가 더 든다).
  `--no-cache`면 둘 다 안 쓴다.
  코드 해시는 base 소스(render/camera/sequence/imageops/textures/rng) + 실감 시나리오만 실감 소스(lens/relief/isp/dlt/photoize, `codehash.ts`) —
  실감 코드만 고치면 base 캐시는 그대로다. **주의**: 코덱 캡처 키에도 이 해시가 들어가므로 `sequence.ts` 같은 BASE 소스를 한 줄만 고쳐도
  코덱 캡처 24개(realism 10 + holdout 14)가 모두 다시 떠진다(실시간이라 ~25분, 결과도 조금 달라진다). 렌더와 무관한 코드는 BASE 소스 밖에 둘 것.
  수동으로 지우려면 `rm -rf scripts/tracking-bench/.cache/frames` (코덱 캡처는 `.cache/codec`).
- 추적기 시간은 렌더가 끝난 뒤 다른 부하 없이 잰다 (첫 시나리오 앞부분으로 JIT 예열 후).
- 기준선 추적기(oracle/null/shifted)는 영상을 보지 않으므로 렌더·코덱 캡처를 생략한다 (`--render`로 강제).

## JSON (`--json`)

`out/latest.json` (기준선 추적기면 `out/latest-<이름>.json`, 홀드아웃이면 `-holdout`이 붙는다, `--json=<파일>`로 바꿀 수 있음). 시각이 들어가지 않아 diff하기 좋다.

- `pass`, `suites`, `categories[]` (묶음·범주별 합산 지표·목표 판정·`hint`), `perf` (추적/재검출 ms 통계)
- `scenarios[]`: 시나리오별 지표 + `suite`·`variantOf`·`codec`(캡처 통계) + `hint`(화면 밖 안내) + `refMs`(`setReference` 한 번의 시간 — 기준 이미지 렌더·JPEG은 타이머 밖에서 미리 한다) + `roi`
  + `stageMs`(추적기가 `TrackResult.timings`로 보고한 단계별 평균 ms)
  + `trace` — 프레임별 한 글자·숫자 배열: `state`(T/W/L/S), `reason`(O=offscreen U=unverified X=untrackable I=invalid_frame, -=없음),
  `err`(px, 표시 안 함 null, 무한대 -1), `hintErr`(화면 밖 안내 방향 오차 도, 핀이 화면 안인데 hint만 있으면 -1), `ms`, `redetected`(0/1),
  `visible`(1=보임, o=화면 안이지만 가려짐, 0=화면 밖), `wrong`(0/1), `inliers`, `t`(ms)
- `--compare=<이전 JSON>`: 묶음·범주별 차이와, 크게 바뀐 시나리오를 표로 보여 준다.

## 점검용 PNG (`--frames-dir`)

작업 해상도 프레임을 2배로 키워 저장한다. 시나리오마다 폴더, `ref.png`(기준 + ROI) + N프레임마다(`--every`, 기본 10) + **틀린 표시 프레임 전부**(`_WRONG`, 최대 60장).

- 초록 십자 = 정답 핀 (파랑 = 손·부조에 가려짐), 노란 사각형 = 정답 ROI
- 빨강 원·사각형 = 추적 결과(tracking), 주황 = weak
- 청록 선 = 화면 밖 안내(hint) 화살표 방향 (프레임 중심 → hint·핀), 짧은 초록 선 = 정답 방향, 청록 사각형 = hint로 옮긴 ROI
- 보라 테두리 + `WRONG` = 틀린 표시. 상단 글자: 프레임 번호·시각·상태·오차·reason·hint 방향 오차·인라이어·처리 ms·재검출 여부

## 브라우저 E2E용 가짜 카메라 (`--y4m`)

```bash
npm run bench:tracking -- --y4m                       # 기본 3개: jitter/mild/pos, repetitive/router-lan3/pan, reentry/pos
npm run bench:tracking -- --y4m=motion/zoom-in/pos    # 원하는 시나리오 (real/* 실감 변형도 가능 — ISP까지 들어간 컬러)
```

`.cache/y4m/<시나리오>_<W>x<H>.y4m` (640x480·480x640, 30fps, 4:2:0 BT.601 제한 범위, 컬러) + 같은 이름 `.json` 사이드카 + `_ref.png`.

```ts
// Playwright
chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-video-capture=scripts/tracking-bench/.cache/y4m/jitter_mild_pos_480x640.y4m",
  ],
});
```

- 가짜 카메라는 파일을 **반복 재생**한다. 그래서 화면 맨 아래 8픽셀 띠에 프레임 번호를 새겼다:
  16칸, 칸0 = 흰색, 칸15 = 검정, 칸1..14 = 번호 비트0..13 (흰색=1). `y4m.ts`의 `decodeMarker()`와 같은 규칙으로 읽으면 된다
  (작업 해상도 320에서도 칸 하나가 20px, 띠 높이 ~4px). 띠는 ROI와 멀리 있지만 추적 실험에 방해되면 `--no-marker`.
  (코덱 캡처는 이 띠 대신 영상 아래에 덧붙인 32행 띠를 쓴다 — 위 "실제 WebRTC 코덱")
- 사이드카: `reference`(기준 프레임 번호·핀·ROI, 정규화 좌표), `frameGT[i]` = `{ i, t, pin, inFrame, occluded, H }`.
  좌표는 모두 **정규화(0~1, `x_px / W`)** — 브라우저 작업 해상도와 무관하게 비교할 수 있다. `H`는 기준(정규화) → 이 프레임(정규화)
  (실감 변형이면 렌즈 왜곡을 뺀 평면 호모그래피 — 핀 `pin`은 왜곡·부조까지 정확).
- 크기: 한 파일 50~60MB (3~4초). 캐시 폴더라 git에 안 들어간다.

## 품질 게이트 (`gate.test.ts`)

`npm test`에 포함. `src/lib/tracking/tracker.ts`가 없으면 메시지와 함께 건너뛴다.
대표 부분집합(`GATE_SUBSET`, **base만** 15개 시나리오·약 1,400장)을 실제 추적기로 돌려 README 범주별 목표를 확인한다. realism·holdout은 게이트에 없다.

- 첫 실행은 부분집합을 병렬 렌더(4코어 1분 남짓), 이후에는 캐시로 ~20초 (전체 벤치를 한 번 돌렸으면 대부분 공유).
- 성능 목표는 다른 테스트와 CPU를 나눠 쓰므로 기본 **2배 여유**. `TRACKING_GATE_PERF=strict`면 README 값 그대로, `=off`면 생략.
- 실패하면 범주별 표가 로그에 찍힌다. 자세히 보려면 `npm run bench:tracking -- --scenario=<범주> --frames-dir=/tmp/f`.

## 파일

| 파일 | 역할 |
|---|---|
| `run.ts` | CLI (`npm run bench:tracking`) |
| `scenarios.ts` | base 시나리오, `RealismSpec` 등 타입, 궤적 도우미, 게이트 부분집합 |
| `scenarios-realism.ts` | realism 묶음 (base 변형) |
| `holdout.ts`, `html/holdout.ts` | 홀드아웃 시나리오·전용 텍스처 (추적기 개발 중에는 보지 말 것) |
| `catalog.ts` | 묶음 전체 목록·거르기 (`selectScenarios`, `scenarioById`) |
| `sequence.ts` | 시나리오 → 장면·처리 시각·기준 이미지·프레임별 GT (실감: 왜곡·부조·ISP·코덱 포함) |
| `camera.ts` | 핀홀 카메라, 자세·궤적·손떨림, 평면 호모그래피, 손 SDF, 정반사, 작업 해상도 크기 |
| `render.ts` | 카메라 렌더러 (텍스처 필터·조명·가림·롤링 셔터·모션 블러·잡음·톤, 실감 행 패스 `realRows`) |
| `lens.ts`, `relief.ts`, `isp.ts`, `dlt.ts` | 렌즈 왜곡 · 입체 부조(높이 지도·광선 추적) · ISP(TNR·샤프닝·톤) · 정답 H 최소제곱 |
| `codec.ts`, `codec-cache.ts` | 실제 WebRTC 코덱 캡처(Chromium 루프백) · 캡처 캐시 |
| `imageops.ts` | 리샘플(런타임과 같은 면적 평균·선형 확대·limited 변환), JPEG 시뮬레이터 / jpeg-js 왕복 |
| `textures.ts`, `html/`, `photoize.ts` | 텍스처 HTML과 Playwright 렌더·캐시·부조 수집, 밉맵, 사진 후처리 |
| `harness.ts` | 시나리오 한 개 실행 → 프레임 기록(hint 포함), PNG 덤프 |
| `metrics.ts` | 지표·목표·묶음/범주 합산·표 출력 (화면 밖 안내 포함) |
| `trackers.ts` | planar(동적 import) / oracle(화면 밖이면 정답 hint) / null / shifted |
| `framecache.ts`, `codehash.ts`, `prerender.ts`, `render-worker.ts` | 프레임 캐시·지문, 병렬 렌더(작업 해상도 프레임·코덱 원본 프레임) |
| `y4m.ts` | y4m + 정답 사이드카 내보내기 |
| `*.test.ts` | 렌더↔GT 일치(점 무늬 무게중심, 실감 포함), 지표 정의(hint 포함), 하네스(기준선·시나리오 타당성·묶음·y4m), 품질 게이트 |

## 한계

- 부조는 상자(둥근 모서리·타원) 높이 지도다 — 경사면·곡면 모서리·버튼의 둥근 윗면은 없다. 옆벽 명암·그늘은 근사.
  배경은 대상 뒤 별도 평면이다.
- 렌즈 왜곡은 스트림 전체에 한 모델(초점 호흡과 무관)이고 피사계 심도(손만 흐려지는 것)·전자식 손떨림 보정(EIS)·렌즈 플레어는 없다.
- ISP는 휘도·채널별 단순 모델이다 (실제 ISP의 지역 톤 매핑·HDR 합성·색 잡음 제거·AI 보정 없음). TNR은 움직임 보상이 없는 종류만.
- 실제 코덱은 localhost 루프백이라 망 손실·지터·재전송·키프레임 요청이 없다 (대역폭 상한만). H.264 없음 (VP8/VP9). 캡처는 실시간이라
  다시 뜨면 조금 다른 결과가 나온다 — 캐시가 기준. base·JPEG 흉내 시나리오는 여전히 프레임마다 독립 JPEG(시간적 아티팩트 없음)이고
  디코더 limited-range(16~235) 양자화도 없다 (코덱 시나리오에만 있다).
- 사진 텍스처는 네트워크 정책 때문에 절차적 대체다 — 실제 사진의 원근·재질 다양성보다 좁다. base 텍스처는 HTML 렌더라 사진보다 깨끗하다.
  폰트는 기계에 설치된 것에 따라 조금 달라질 수 있다 (캐시 키는 HTML 기준).
- 모션 블러는 표면별 선형 운동 근사라 가림 경계(손 테두리)와 부조 옆벽에서 약간 부정확하다 (부조 윗면은 대상 평면 운동으로 흐린다).
- 성능 수치는 Node(데스크톱)의 `process()` 벽시계 시간이다. 저가 안드로이드는 3~4배 느리다고 본다 (README).
