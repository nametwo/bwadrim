import { test } from "@playwright/test";
import { fakeCamera, loadGt, openLoopback, waitEngFrame } from "./helpers";

const CLIP = "repetitive_router-lan3_pan_480x640";
test.use({ launchOptions: fakeCamera(CLIP), viewport: { width: 860, height: 960 }, deviceScaleFactor: 1 });
const gt = loadGt(CLIP);

test("explore repetitive", async ({ page }) => {
  test.setTimeout(60_000);
  await openLoopback(page);
  const tap = await waitEngFrame(page, gt, (f) => f.i >= 4 && f.i <= 10);
  await page.mouse.click(tap.x, tap.y);
  const t0 = Date.now();
  const seen: string[] = [];
  while (Date.now() - t0 < 12_000) {
    const s = await page.evaluate(() => {
      const lab = (window as any).__lab; // eslint-disable-line @typescript-eslint/no-explicit-any
      const e = lab.eng.getSnapshot();
      const c = lab.cust.getSnapshot();
      return `eng ${e.update?.state}/${e.update?.reason ?? "-"} tr=${e.trackable} rr=${e.referenceReason} cust=${e.customerState}/${e.customerReason} | cust ${c.update?.state}/${c.update?.reason ?? "-"} card=${c.showCard} ui=${!!document.querySelector("[data-testid=cust-card]")} retap=${!!document.querySelector("[data-testid=eng-retap]")} toast=${document.querySelector("[data-testid=eng-toast]")?.textContent ?? "-"}`;
    });
    if (seen.at(-1) !== s) {
      seen.push(s);
      console.log(((Date.now() - t0) / 1000).toFixed(2), s);
    }
    await page.waitForTimeout(50);
  }
});
