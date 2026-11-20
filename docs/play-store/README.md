# 플레이 스토어 출시 순서 (OPS-08)

엔지니어용 안드로이드 앱(`com.bwadrim.app`)을 플레이에 처음 내는 순서다. 앱 빌드는 `android/README.md`.
이 폴더:
- `listing.md`: 스토어 등록정보 글(앱 이름·간단한 설명·자세한 설명·출시 노트)
- `console.md`: 앱 콘텐츠 설문 답(데이터 보안·콘텐츠 등급·타겟층·앱 액세스 영어 안내)
- `feature-graphic.png`: 그래픽 이미지 1024×500
- `screenshots/`: 휴대전화 스크린샷 1080×1920, 파일 이름 순서대로 올린다

## 0. 올리기 전에 (제품 담당자)

- [x] `src/lib/business-info.ts` 채우기(NFR-10): 2026-11-20에 대표·사업자등록번호·보호책임자·시행일을 다 넣었다 비어 있으면 처리방침에 '정하는 중'으로 보여 심사에서 걸릴 수 있다
- [ ] 플레이 콘솔 계정 인증(대표자 신원·전화)이 끝났는지, 대시보드에 '테스터 12명·14일' 안내가 없는지 본다. 이 의무는 2023-11-13 뒤에 만든 **개인** 계정에만 있다고 공식 문서에 적혀 있다
- [ ] 심사용 이메일 계정 만들기(Supabase → Authentication → Add user, Auto Confirm, `user_metadata` `{"name":"Play Reviewer"}`). 한 달 한도를 늘린다: `insert into engineer_plans …`(`supabase/schema.sql` 주석). 비밀번호는 콘솔 '앱 액세스'에만 적는다
- [ ] 운영 DB에 `supabase/schema.sql` 다시 실행(처리방침의 '1년 뒤 삭제'가 실제로 돌게, 할일.md)

## 1. 앱 만들기

플레이 콘솔 → 앱 만들기
- 앱 이름: `봐드림 - 영상으로 보는 원격 A/S`(`listing.md`)
- 기본 언어: 한국어. 앱/게임: 앱. 무료
- 선언 두 개에 체크(개발자 프로그램 정책, 미국 수출 법규)

## 2. 내부 테스트로 먼저 올리기

심사 없이 몇 분 안에 테스터에게 간다(처음 한 번은 몇 시간 걸릴 수 있다).
1. GitHub → Actions → **Android 앱 빌드** → Run workflow(main). 끝나면 Artifacts의 `app-release-bundle.aab`
2. 콘솔 → 테스트 및 출시 → 테스트 → **내부 테스트** → 새 버전 만들기 → `.aab` 올리기. Play 앱 서명은 기본(구글이 관리)으로 둔다
3. 출시 노트는 `listing.md`의 '새로운 기능'
4. 테스터 탭에서 이메일 목록을 만들고(본인·아버지 구글 계정), 참여 링크를 폰에서 연다

## 3. 주소창 없애기 (2026-11-20 끝남: 앱 서명 키 `6D:A8:…:94:C9`를 넣었다)

플레이에서 받은 앱은 구글이 다시 서명해서, 그 지문이 `assetlinks.json`에 없으면 앱 위에 주소창이 뜬다.
1. 콘솔 → 테스트 및 출시 → 설정 → **앱 무결성** → 앱 서명 → '앱 서명 키 인증서'의 **SHA-256**을 복사한다
2. 그 값을 `public/.well-known/assetlinks.json`의 `sha256_cert_fingerprints`에 더한다(지금 있는 업로드 키 지문은 지우지 않는다. 직접 깐 APK용)
3. 배포한 뒤 `https://bwadrim.com/.well-known/assetlinks.json`이 열리는지 보고, 플레이에서 받은 앱을 지웠다 다시 깔아 주소창이 없는지 본다

## 4. 실제 갤럭시로 한 바퀴

플레이에서 받은 앱으로: 카카오 로그인 → 새 A/S → 카톡으로 링크 보내기 → 다른 폰으로 링크 열고 통화 → 가리키기·방향·멈추고 그리기·사진 찍고 저장 → 끝내기. 기본 브라우저가 삼성 인터넷인 폰에서도 열어 본다(OPS-08 제약).

## 5. 스토어 등록정보·앱 콘텐츠

- 성장 → 스토어 등록정보: `listing.md`의 글, 아이콘 `public/icons/icon-512.png`, `feature-graphic.png`, `screenshots/` 8장
- 정책 → 앱 콘텐츠: `console.md` 순서대로
- 스토어 설정: 카테고리 **비즈니스**, 이메일 `contact@bwadrim.com`, 웹사이트 `https://bwadrim.com`

## 6. 프로덕션

콘솔 → 프로덕션 → 새 버전(내부 테스트 버전을 승격) → 국가: 대한민국 → 검토를 위해 보내기. 첫 심사는 며칠 걸릴 수 있다.

## 그래픽 다시 만들기

화면이 바뀌면 다시 찍는다(한국어 글꼴은 jsDelivr의 Pretendard를 받아 쓴다).

```sh
npm run screens
node scripts/play-store/make-assets.mjs
```

스크린샷 순서·제목은 `scripts/play-store/make-assets.mjs` 맨 위 `SCREENSHOTS`. 플레이 규칙: 제목 글은 그림의 20% 이하, '최고·1위·무료·지금 받기' 같은 말 금지, 그래픽 이미지에 기기 테두리·남의 상표 금지(https://support.google.com/googleplay/android-developer/answer/9866151).
