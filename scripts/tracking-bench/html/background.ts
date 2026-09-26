// (g) 대상 주변 배경: 어수선한 벽(보일러실·현관) / 책상(가게 계산대). 대상 밖 방해 특징점 역할
import { FONT_KO, FONT_MONO, FONT_SANS, Rng, blotches, noise, page } from "./common";

export const BG_W = 2400;
export const BG_H = 1800;

export function wallHtml(): string {
  const rng = new Rng(7007);
  let b = "";
  // 페인트 벽 (롤러 자국, 얼룩)
  b += `<div class="abs" style="left:0;top:0;width:${BG_W}px;height:${BG_H}px;background:linear-gradient(180deg,#e7e2d8,#ddd7cb)"></div>`;
  b += noise({ freq: [0.004, 0.03], octaves: 3, seed: 71, opacity: 0.35, w: BG_W, h: BG_H, blend: "soft-light" });
  b += noise({ freq: 0.5, octaves: 2, seed: 72, opacity: 0.18, w: BG_W, h: BG_H });
  b += blotches(rng, BG_W, 1300, 18, "rgba(120,100,70,.5)", 90, 0.25);

  // 아래쪽 타일
  let tiles = "";
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 17; i++) {
      const tone = 212 + rng.int(18);
      tiles += `<rect x="${i * 150 + 3}" y="${j * 150 + 3}" width="144" height="144" rx="4" fill="rgb(${tone},${tone - 4},${tone - 10})"/>`;
    }
  }
  b += `<svg class="abs" style="left:0;top:1320px" width="${BG_W}" height="480"><rect width="100%" height="100%" fill="#9d978b"/>${tiles}</svg>`;
  b += noise({ freq: 0.03, octaves: 2, seed: 73, opacity: 0.25, y: 1320, w: BG_W, h: 480, blend: "soft-light" });

  // 동관 2개 + 밸브, 회색 PVC 배관
  const pipe = (x: number, color: string, hi: string) =>
    `<div class="abs" style="left:${x}px;top:0;width:44px;height:1320px;background:linear-gradient(90deg,${color} 0%,${hi} 35%,${color} 70%,#3a2a1a 100%)"></div>`;
  b += pipe(260, "#9a5b2e", "#e6a36a");
  b += pipe(340, "#9a5b2e", "#e6a36a");
  b += `<div class="abs" style="left:240px;top:620px;width:170px;height:60px;border-radius:12px;background:linear-gradient(180deg,#e03a2a,#9e1e14);box-shadow:0 4px 6px rgba(0,0,0,.5)"></div>`;
  b += `<div class="abs" style="left:0;top:180px;width:${BG_W}px;height:56px;background:linear-gradient(180deg,#9ea3a8,#e5e8ea 35%,#8b9095 90%)"></div>`;
  for (let i = 0; i < 6; i++) {
    b += `<div class="abs" style="left:${120 + i * 400}px;top:170px;width:34px;height:76px;border-radius:4px;background:linear-gradient(90deg,#7e8388,#d9dcdf,#6d7277)"></div>`;
  }

  // 달력 (광고 달력)
  b += `<div class="abs" style="left:1560px;top:300px;width:540px;height:680px;background:#fbfaf6;box-shadow:4px 6px 10px rgba(0,0,0,.35);transform:rotate(1.5deg)">
<div style="height:120px;background:#c9352b;color:#fff;font-family:${FONT_KO};font-size:64px;font-weight:bold;padding:22px 30px">9월 <span style="font-family:${FONT_SANS};font-size:34px;font-weight:normal">SEPTEMBER 2026</span></div>
<div style="display:grid;grid-template-columns:repeat(7,1fr);padding:14px 16px;font-family:${FONT_SANS};font-size:34px;row-gap:26px;text-align:center;color:#222">
${["일", "월", "화", "수", "목", "금", "토"].map((d, i) => `<div style="font-family:${FONT_KO};font-size:28px;color:${i === 0 ? "#c9352b" : i === 6 ? "#2659b0" : "#444"}">${d}</div>`).join("")}
${Array.from({ length: 35 }, (_, i) => {
  const d = i - 1;
  return `<div style="color:${i % 7 === 0 ? "#c9352b" : i % 7 === 6 ? "#2659b0" : "#222"}">${d >= 1 && d <= 30 ? d : ""}</div>`;
}).join("")}
</div>
<div style="position:absolute;bottom:18px;left:24px;font-family:${FONT_KO};font-size:30px;color:#333">대성보일러 서비스센터 ☎ 1588-0000</div>
</div>`;

  // 콘센트 + 꽂힌 플러그와 늘어진 전선
  b += `<div class="abs" style="left:1900px;top:1020px;width:200px;height:300px;border-radius:14px;background:linear-gradient(170deg,#fbfbfa,#e3e3df);box-shadow:3px 4px 8px rgba(0,0,0,.35)"></div>`;
  for (let k = 0; k < 2; k++) {
    const cy = 1085 + k * 135;
    b += `<div class="abs" style="left:1945px;top:${cy - 45}px;width:110px;height:110px;border-radius:50%;background:radial-gradient(circle,#f2f2ef 60%,#cfcfca 62%,#e7e7e3 70%);box-shadow:inset 0 3px 5px rgba(0,0,0,.3)"></div>`;
    b += `<div class="abs" style="left:1975px;top:${cy + 2}px;width:14px;height:14px;border-radius:50%;background:#222"></div><div class="abs" style="left:2011px;top:${cy + 2}px;width:14px;height:14px;border-radius:50%;background:#222"></div>`;
  }
  b += `<div class="abs" style="left:1958px;top:1186px;width:84px;height:84px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#555,#141414 70%);box-shadow:2px 4px 6px rgba(0,0,0,.6)"></div>`;
  b += `<svg class="abs" style="left:0;top:0" width="${BG_W}" height="${BG_H}"><path d="M2000 1250 C2010 1400 1880 1480 1700 1560 C1500 1650 1300 1700 1100 1800" stroke="#151515" stroke-width="18" fill="none" stroke-linecap="round"/>
<path d="M1998 1250 C2008 1400 1878 1480 1698 1560" stroke="#555" stroke-width="4" fill="none" opacity=".6"/></svg>`;

  // 스위치
  b += `<div class="abs" style="left:2120px;top:600px;width:170px;height:260px;border-radius:12px;background:linear-gradient(170deg,#fdfdfc,#e6e6e2);box-shadow:3px 4px 8px rgba(0,0,0,.3)"></div>`;
  b += `<div class="abs" style="left:2145px;top:630px;width:55px;height:200px;border-radius:6px;background:linear-gradient(180deg,#fff,#dcdcd8);box-shadow:inset 0 -3px 4px rgba(0,0,0,.2),0 2px 3px rgba(0,0,0,.25)"></div>`;
  b += `<div class="abs" style="left:2210px;top:630px;width:55px;height:200px;border-radius:6px;background:linear-gradient(180deg,#fff,#dcdcd8);box-shadow:inset 0 -3px 4px rgba(0,0,0,.2),0 2px 3px rgba(0,0,0,.25)"></div>`;

  // 포스트잇 메모 (손글씨)
  b += `<div class="abs" style="left:560px;top:900px;width:300px;height:280px;background:linear-gradient(180deg,#fff27a,#f5e25a);box-shadow:3px 5px 8px rgba(0,0,0,.3);transform:rotate(-6deg);font-family:${FONT_KO};font-size:34px;color:#1b2a6b;padding:28px;line-height:1.5;font-style:italic">A/S 기사님<br>010-1234-5678<br>화요일 오후</div>`;
  b += `<div class="abs" style="left:900px;top:980px;width:220px;height:200px;background:linear-gradient(180deg,#ffb3c7,#f59ab2);box-shadow:3px 5px 8px rgba(0,0,0,.3);transform:rotate(5deg);font-family:${FONT_KO};font-size:30px;color:#402;padding:22px;line-height:1.5">가스 점검<br>9/30</div>`;
  // 벽에 붙은 안내문 (A4)
  b += `<div class="abs" style="left:620px;top:330px;width:620px;height:460px;background:#fff;box-shadow:3px 4px 8px rgba(0,0,0,.25);transform:rotate(-1.2deg);padding:30px;font-family:${FONT_KO};color:#222">
<div style="font-size:52px;font-weight:bold;text-align:center;margin-bottom:18px">보일러실 안전수칙</div>
${["1. 환기구를 막지 마십시오", "2. 가연물을 두지 마십시오", "3. 가스 냄새가 나면 밸브를 잠그고", "   즉시 신고하십시오 (☎ 119)", "4. 배관 동파 주의 (겨울철 보온)"].map((l) => `<div style="font-size:34px;line-height:1.6">${l}</div>`).join("")}
</div>`;
  // 테이프 조각, 못 자국
  for (let i = 0; i < 26; i++) {
    const x = rng.range(0, BG_W);
    const y = rng.range(0, 1300);
    b += `<div class="abs" style="left:${x}px;top:${y}px;width:${rng.range(4, 9).toFixed(0)}px;height:${rng.range(4, 9).toFixed(0)}px;border-radius:50%;background:#6b645a;opacity:${rng.range(0.4, 0.8).toFixed(2)}"></div>`;
  }
  return page(BG_W, BG_H, b);
}

export function deskHtml(): string {
  const rng = new Rng(8008);
  let b = "";
  // 나뭇결 책상 (가로결, 판 이음매)
  b += `<div class="abs" style="left:0;top:0;width:${BG_W}px;height:${BG_H}px;background:#9a6a42"></div>`;
  b += `<svg class="abs" style="left:0;top:0" width="${BG_W}" height="${BG_H}"><filter id="wood" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.0025 0.06" numOctaves="4" seed="81"/>
<feColorMatrix type="matrix" values="0 0 0 0 0.55  0 0 0 0 0.36  0 0 0 0 0.2  1.6 0 0 0 -0.35"/></filter><rect width="100%" height="100%" filter="url(#wood)"/></svg>`;
  b += noise({ freq: [0.001, 0.2], octaves: 2, seed: 82, opacity: 0.35, w: BG_W, h: BG_H, blend: "overlay" });
  for (let i = 1; i < 4; i++) b += `<div class="abs" style="left:0;top:${i * 450}px;width:${BG_W}px;height:4px;background:#3d2716;opacity:.7"></div>`;

  // 거래명세서 (A4, 기울어짐)
  const rows = Array.from({ length: 9 }, (_, i) => {
    const q = 1 + rng.int(9);
    const p = (1 + rng.int(40)) * 500;
    return `<tr><td>${i + 1}</td><td style="text-align:left">${["보일러 필터", "배관 부속", "출장비", "밸브 교체", "온도센서", "패킹", "순환펌프", "점검비", "기타"][i]}</td><td>${q}</td><td>${p.toLocaleString("en-US")}</td><td>${(p * q).toLocaleString("en-US")}</td></tr>`;
  }).join("");
  b += `<div class="abs" style="left:160px;top:140px;width:760px;height:1060px;background:#fbfbf8;box-shadow:6px 8px 14px rgba(0,0,0,.45);transform:rotate(7deg);padding:40px;font-family:${FONT_KO};color:#1b1b1b">
<div style="font-size:64px;font-weight:bold;text-align:center;letter-spacing:12px;margin-bottom:24px">거래명세서</div>
<div style="font-size:28px;line-height:1.6">공급받는자: 행복마트 귀하<br>일자: 2026년 9월 24일</div>
<table style="width:100%;border-collapse:collapse;margin-top:24px;font-size:26px;text-align:center" border="2">
<tr style="background:#e8e8e2"><th>No</th><th>품목</th><th>수량</th><th>단가</th><th>금액</th></tr>${rows}</table>
<div style="font-size:34px;font-weight:bold;text-align:right;margin-top:30px">합계 ₩ 1,284,500</div>
</div>`;
  // 영수증 띠
  let rc = "";
  for (let i = 0; i < 22; i++) {
    rc += `<div>${i % 5 === 0 ? "-----------------" : `${["카드승인", "아메리카노", "라떼", "합계", "부가세", "승인번호"][i % 6]} ${(rng.int(90000) + 1000).toString()}`}</div>`;
  }
  b += `<div class="abs" style="left:1140px;top:760px;width:300px;height:900px;background:linear-gradient(90deg,#f1efe8,#fbfaf6 50%,#ece9e1);box-shadow:4px 6px 10px rgba(0,0,0,.4);transform:rotate(-9deg);padding:24px;font-family:${FONT_MONO};font-size:22px;line-height:1.55;color:#333">
<div style="font-family:${FONT_KO};font-size:30px;text-align:center;font-weight:bold">행복마트</div>${rc}</div>`;
  // 키보드 모서리
  let keys = "";
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 12; i++) {
      keys += `<rect x="${i * 76 + (j % 2) * 20}" y="${j * 76}" width="66" height="66" rx="8" fill="#2c2d30"/><rect x="${i * 76 + (j % 2) * 20 + 4}" y="${j * 76 + 3}" width="58" height="52" rx="6" fill="#3b3c40"/>`;
      keys += `<text x="${i * 76 + (j % 2) * 20 + 12}" y="${j * 76 + 30}" font-family="${FONT_SANS}" font-size="20" fill="#c9cbce">${"QWERTYUIOPASDFGHJKLZXCVBNM1234567890"[(j * 12 + i) % 36]}</text>`;
    }
  }
  b += `<svg class="abs" style="left:1540px;top:-40px;transform:rotate(-4deg)" width="940" height="420"><rect x="-20" y="-20" width="980" height="440" rx="20" fill="#1a1b1d"/>${keys}</svg>`;
  // 머그컵 (위에서 본 모습)
  b += `<div class="abs" style="left:1700px;top:700px;width:330px;height:330px;border-radius:50%;background:radial-gradient(circle,#2a1a0f 0 52%,#fdfdfd 55%,#e0e0dc 70%,#bdbdb8 72%,#e9e9e6 76%);box-shadow:10px 16px 20px rgba(0,0,0,.45)"></div>`;
  b += `<div class="abs" style="left:1790px;top:780px;width:80px;height:40px;border-radius:50%;background:rgba(255,255,255,.35)"></div>`;
  b += `<div class="abs" style="left:2010px;top:820px;width:120px;height:80px;border-radius:0 40px 40px 0;border:22px solid #e8e8e4;border-left:none;box-shadow:6px 8px 10px rgba(0,0,0,.3)"></div>`;
  // 커피 얼룩 고리
  b += `<div class="abs" style="left:1350px;top:300px;width:230px;height:230px;border-radius:50%;border:8px solid rgba(80,45,15,.35)"></div>`;
  // 펜
  b += `<div class="abs" style="left:900px;top:1380px;width:620px;height:30px;border-radius:15px;background:linear-gradient(180deg,#5b8fe6,#1f4aa8 60%,#10306e);transform:rotate(-18deg);box-shadow:5px 8px 8px rgba(0,0,0,.4)"></div>`;
  // 충전 케이블
  b += `<svg class="abs" style="left:0;top:0" width="${BG_W}" height="${BG_H}"><path d="M2400 1250 C2100 1150 2050 1500 1800 1450 C1550 1400 1600 1750 1500 1800" stroke="#f1f1ef" stroke-width="16" fill="none" stroke-linecap="round"/>
<path d="M2400 1246 C2100 1146 2050 1496 1800 1446" stroke="#fff" stroke-width="4" fill="none" opacity=".8"/></svg>`;
  // 포스트잇
  b += `<div class="abs" style="left:960px;top:100px;width:280px;height:260px;background:linear-gradient(180deg,#fff27a,#f3df55);box-shadow:3px 5px 8px rgba(0,0,0,.35);transform:rotate(10deg);font-family:${FONT_KO};font-size:32px;color:#222;padding:26px;line-height:1.5;font-style:italic">단말기 A/S<br>☎ 1544-0000<br>용지 주문!</div>`;
  // 동전
  for (let i = 0; i < 6; i++) {
    const x = 400 + rng.range(0, 500);
    const y = 1300 + rng.range(0, 350);
    const gold = rng.next() < 0.4;
    const r = gold ? 44 : 40;
    b += `<div class="abs" style="left:${x}px;top:${y}px;width:${2 * r}px;height:${2 * r}px;border-radius:50%;background:radial-gradient(circle at 35% 30%,${gold ? "#fff0b0,#c9982e 55%,#7a5816" : "#ffffff,#b9bcc0 55%,#6f7378"});box-shadow:3px 5px 6px rgba(0,0,0,.45);font-family:${FONT_SANS};font-size:26px;color:rgba(0,0,0,.35);text-align:center;line-height:${2 * r}px">${gold ? 10 : 100}</div>`;
  }
  return page(BG_W, BG_H, b);
}
