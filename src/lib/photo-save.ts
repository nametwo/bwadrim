// 통화 중 찍은 사진을 엔지니어 기기에 저장한다 (요구사항 CALL-16).
// 웹은 사진첩에 바로 쓸 수 없다. 폰은 공유 창(아이폰 '이미지 N개 저장' → 사진 앱, 안드로이드 갤러리·드라이브 등)으로,
// PC나 공유 창이 없는 브라우저는 파일 다운로드로 저장한다. 반드시 버튼 탭(사용자 제스처) 안에서 부를 것.

export type TakenPhoto = { id: string; blob: Blob; url: string; at: number };

const KST = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** 'bwadrim_2026-09-28_14-32-05_1.jpg' (한국 시간). 한글 파일 이름은 일부 브라우저가 'download'로 바꿔 버려 영문으로 */
export function photoFileName(at: number, index: number) {
  const stamp = KST.format(new Date(at)).replace(" ", "_").replaceAll(":", "-");
  return `bwadrim_${stamp}_${index + 1}.jpg`;
}

export function photoFiles(photos: TakenPhoto[]) {
  return photos.map((p, i) => new File([p.blob], photoFileName(p.at, i), { type: "image/jpeg" }));
}

export type SaveResult = "saved" | "cancelled" | "failed";

/** 폰이면 공유 창, 아니면 다운로드. 공유 창을 그냥 닫으면 'cancelled' */
export async function savePhotos(photos: TakenPhoto[]): Promise<SaveResult> {
  if (!photos.length) return "saved";
  const files = photoFiles(photos);
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (touch && typeof navigator.canShare === "function" && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return "saved";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      // 공유 실패(권한 등) — 다운로드로
    }
  }
  try {
    for (const [i, f] of files.entries()) {
      const a = document.createElement("a");
      a.href = photos[i].url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 여러 파일을 한꺼번에 내려받으면 브라우저가 막을 수 있어 조금씩 띄운다
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 250));
    }
    return "saved";
  } catch {
    return "failed";
  }
}
