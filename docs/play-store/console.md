# 플레이 콘솔 설문 답 (OPS-08)

플레이 콘솔 → 앱 → 정책 → **앱 콘텐츠**의 설문에 넣을 답이다. 근거는 개인정보 처리방침(`src/app/privacy/page.tsx`, NFR-10)과 실제 코드다.
모으는 것이 바뀌면(DATA-01, NFR-07, ROOM-16) 처리방침과 이 답을 같이 고친다. 2026-11-20에 Play 고객센터 문서로 확인했다(출처는 맨 아래).

## 개인정보처리방침

`https://bwadrim.com/privacy`

## 앱 액세스 → '일부 기능이 제한됨'

로그인해야 쓰는 앱이라 심사자용 계정과 순서를 영어로 적는다. 계정은 **이메일 계정**(관리자가 만듦, OPS-03)으로 만든다. 심사자는 카카오를 쓰지 않아도 된다.
- 만료·2단계 인증·일회용 코드가 없어야 한다. 한 달 상담 한도(ROOM-17)에 걸리지 않게 `engineer_plans`로 한도를 넉넉히(예: 1000건) 준다
- 표시 이름(`user_metadata.name`)은 `Play Reviewer`

콘솔에 넣을 글(이름 칸: `Engineer account`):

```
Username: <심사용 이메일>
Password: <심사용 비밀번호>

Bwadrim is a remote after-sales service tool for field engineers. The engineer sends a link to a customer, the customer opens it in a mobile browser (no app, no login), turns on the camera, and the engineer sees the live video and can point, draw, show direction arrows and take photos on it.

How to test:
1. Open the app. On the login screen tap the grey text "이메일로 로그인" (Log in with email) below the yellow Kakao button.
2. Enter the username and password above and tap "로그인" (Log in).
3. On the list screen tap the blue button "+ 새 A/S 시작" (Start new A/S). Allow the microphone.
4. Tap "링크 복사" (Copy link) and open the copied link in Chrome on a second phone, or in a desktop browser. This is the customer side.
5. On the customer side tap "카메라 켜고 시작하기" (Turn on camera and start) and allow the camera. The two sides connect in a few seconds.
6. On the engineer side: tap the video to show a red pointer on the customer's screen, long-press to pin a marker, use the arrow ring to show a direction, tap the pause button to freeze and draw, tap the camera icon to take a photo.
7. Tap the red end button and confirm to finish. The consultation then appears in the list.

Account deletion: "내 계정" (My account) at the top of the list screen → "회원 탈퇴" (Delete account) → "탈퇴하기" (Delete).
```

## 광고

광고 없음.

## 콘텐츠 등급 (IARC 설문)

- 카테고리: 게임이 아닌 앱 중 '그 밖의 앱'(유틸리티·생산성·커뮤니케이션 쪽). 폭력·성·약물·도박·욕설 질문은 모두 **아니요**
- 사용자끼리 소통하거나 콘텐츠를 주고받나요: **예** (기사님과 고객님이 실시간 영상·음성 통화를 한다)
- 사용자 위치를 다른 사용자와 공유하나요: **아니요**
- 디지털 상품 구매: **아니요** (결제 없음, ROOM-17)
- 제한 없는 인터넷·웹 접근: **아니요** (우리 사이트만 연다)
- 예상 결과: 전체 이용가에 '사용자 상호작용' 표시

## 타겟층 및 콘텐츠

- 대상 연령: **18세 이상**만 고른다(기사님·업체용). 아동을 끌 만한 그림을 등록정보에 쓰지 않는다
- 아동에게 호소하나요: 아니요

## 그 밖의 선언

| 항목 | 답 |
|---|---|
| 뉴스 앱 | 아니요 |
| 코로나19 접촉 추적·상태 앱 | 아니요 |
| 정부 앱 | 아니요 |
| 금융 기능 | 금융 기능 없음 |
| 건강 앱 | 건강 기능 없음 |
| 광고 ID | 쓰지 않음 (TWA라 앱에 광고 ID 권한이 없다) |

## 데이터 보안

### 첫 질문

- 사용자 데이터를 수집하거나 공유하나요: **예**
- 수집하는 모든 데이터는 전송 중에 암호화되나요: **예** (HTTPS, 영상은 WebRTC 암호화)
- 데이터 삭제를 요청할 방법을 제공하나요: **예**. 삭제 요청 URL은 `https://bwadrim.com/privacy#delete-account`. 앱 안에서는 '내 계정' → '회원 탈퇴'(AUTH-11)

### 데이터 종류 (모두 '수집', '공유' 아님)

공유가 아닌 이유: Supabase·Vercel·Cloudflare·Discord는 우리 대신 일을 맡은 업체(서비스 제공업체)다. 카카오톡으로 링크를 보내는 것은 사용자가 직접 고른 전송이다. 둘 다 플레이 정의상 '공유'가 아니다.

| 종류 | 무엇 | 필수/선택 | 목적 |
|---|---|---|---|
| 개인 정보 → 이름 | 카카오 닉네임, 이메일 계정 이름(기사님 표시 이름) | 필수 | 앱 기능, 계정 관리 |
| 개인 정보 → 이메일 주소 | 이메일 계정, 카카오에서 이메일에 동의한 경우 | 선택 | 계정 관리 |
| 개인 정보 → 사용자 ID | 카카오 회원번호, 서비스 계정 ID | 필수 | 앱 기능, 계정 관리 |
| 앱 활동 → 앱 상호작용 | 상담 만든·끝낸 시각, 연결 여부, 쓴 도구(가리키기·멈춤 등) | 필수 | 앱 기능, 분석 |
| 앱 활동 → 기타 사용자 생성 콘텐츠 | 기사님이 적은 받는 분 이름표(30자), 카톡 채팅방 구분 값(해시) | 선택 | 앱 기능 |
| 앱 정보 및 성능 → 기타 앱 성능 데이터 | 영상이 어떤 길로 연결됐는지, 연결 실패 | 필수 | 분석, 앱 기능(장애 알림) |

적지 않는 것과 이유:
- **사진·동영상·음성**: 실시간 영상과 음성은 두 기기가 WebRTC로 직접 주고받고, 중계 서버(TURN)도 암호화된 채로 넘길 뿐 내용을 볼 수 없다(종단 간 암호화). 통화 중 찍은 사진은 서버에 올리지 않고 기사님 기기에만 저장된다. 플레이 정의상 '수집'이 아니다
- **위치**: IP 주소로 위치를 알아내지 않는다
- **기기 ID**: 광고 ID·기기 고유 번호를 쓰지 않는다
- **연락처·전화번호**: 받지 않는다(NFR-07)
- 고객님 쪽 기록(브라우저 종류, 카메라 허용)은 앱이 아니라 고객 폰의 웹 브라우저에서 생긴다. 이 앱(기사님용) 설문에는 넣지 않는다. 처리방침에는 적혀 있다

### 프로필 사진 주소

카카오 가입 때 프로필 사진 **주소**를 받는다(처리방침에 적힘). 사진 파일은 받지 않아서 '사진'으로 적지 않는다. 심사에서 물으면 이 설명을 쓴다.

## 출처 (2026-11-20 확인)

- 데이터 보안: https://support.google.com/googleplay/android-developer/answer/10787469
- 계정 삭제: https://support.google.com/googleplay/android-developer/answer/13327111
- 앱 액세스: https://support.google.com/googleplay/android-developer/answer/15748846
- 타겟층: https://support.google.com/googleplay/android-developer/answer/9867159
- 콘텐츠 등급: https://support.google.com/googleplay/android-developer/answer/9859655
