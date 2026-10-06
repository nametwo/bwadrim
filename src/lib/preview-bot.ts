// 링크 미리보기를 만들려고 페이지를 가져가는 봇 감지 (DATA-01, JOIN-12, BUG-22).
// 카카오톡·아이메시지 등은 대화방에 링크가 오가면 제목·설명을 읽으러 고객 링크를 먼저 연다.
// 사람이 연 게 아니니 link_opened를 남기지 않는다. 화면과 미리보기 정보는 똑같이 내보낸다.
// User-Agent에 스스로 밝힌 이름으로만 알아본다 — 보통 브라우저처럼 보내는 미리보기(삼성 메시지 등, 확인 못 함)는 못 거른다.
// next/server의 userAgent().isBot에는 카카오·구글 메시지가 없어 따로 둔다.
//
// 출처(2026-10-06 확인):
//  - 카카오톡: devtalk.kakao.com/t/scrap/33984 (카카오 공지) 'kakaotalk-scrap/1.0; +https://devtalk.kakao.com/t/scrap/33984'.
//    링크를 입력하거나 공유할 때 카카오 서버가 가져가고 최소 1시간 캐시한다
//  - 페이스북·메신저·인스타그램: developers.facebook.com/docs/sharing/webmasters/web-crawlers 'facebookexternalhit/1.1'
//  - 아이메시지: 보내는 폰이 가져간다. 애플은 UA를 밝히지 않는다(TN3156은 'JavaScript를 실행하지 않는다'만).
//    알려진 기록은 사파리 UA 뒤에 'facebookexternalhit/1.1 Facebot Twitterbot/1.0'을 붙인 것
//  - 구글 메시지: developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers 'GoogleMessages'
//  - 왓츠앱: developers.facebook.com/documentation/business-messaging/whatsapp/link-previews 'WhatsApp/2.x.x.x A|I|N'
//  - 슬랙: api.slack.com/robots 'Slackbot-LinkExpanding'. 라인('facebookexternalhit/1.1;line-poker/1.0')·텔레그램·디스코드는 공개 기록
//
// 앱 안 브라우저(in-app-browser.ts)는 사람이다: 카톡 앱 안은 'KAKAOTALK 10.x'(띄어 씀), 페이스북 앱 안은 'FBAN/FBAV', 라인 앱 안은 'Line/'.
// 그래서 'kakaotalk' 한 단어나 'line'으로는 거르지 않는다. 'Cubot' 같은 폰 이름이 걸리지 않게 'bot' 한 단어로도 거르지 않는다.
const PATTERNS: RegExp[] = [
  /kakaotalk-scrap/i,
  /facebookexternalhit|facebookcatalog|Facebot/i,
  /Twitterbot/i,
  /GoogleMessages/i,
  /WhatsApp\//i,
  /TelegramBot/i,
  /Slackbot/i,
  /Discordbot/i,
  /LinkedInBot/i,
  /SkypeUriPreview/i,
  // 검색·AI 수집기(Next.js 봇 목록·메타 문서와 같은 이름). 고객 링크는 검색에 안 올리지만(noindex) 가져가 볼 수는 있다
  /Googlebot|Google-[\w-]+|[\w-]+-Google\b/i,
  /bingbot|BingPreview/i,
  /Applebot/i,
  /Yeti\//i, // 네이버
  /meta-external|meta-webindexer/i,
];

export function isPreviewBot(userAgent: string): boolean {
  // 브라우저는 늘 User-Agent를 보낸다. 비어 있으면 사람이 연 게 아니다
  if (!userAgent.trim()) return true;
  return PATTERNS.some((re) => re.test(userAgent));
}
