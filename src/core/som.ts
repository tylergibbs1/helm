import type { Page } from "playwright";
import type { SomMark, SomResult, CollectedElement } from "../types.js";
import { INTERACTIVE_SELECTORS, collectElementsScript } from "../types.js";

/** Cached marks with timestamp for TTL-based invalidation. */
let cachedMarks: { marks: SomMark[]; url: string; timestamp: number } | null = null;
const CACHE_TTL_MS = 10_000;

function getCachedMarks(url: string): SomMark[] | null {
  if (
    cachedMarks &&
    cachedMarks.url === url &&
    Date.now() - cachedMarks.timestamp < CACHE_TTL_MS
  ) {
    return cachedMarks.marks;
  }
  return null;
}

function setCachedMarks(marks: SomMark[], url: string): void {
  cachedMarks = { marks, url, timestamp: Date.now() };
}

export function invalidateMarkCache(): void {
  cachedMarks = null;
}

/**
 * Collect marks from the shared element collector.
 * Filters to viewport-visible elements and assigns sequential IDs.
 */
async function collectMarks(page: Page): Promise<SomMark[]> {
  const raw = (await page.evaluate(
    collectElementsScript(INTERACTIVE_SELECTORS),
    [...INTERACTIVE_SELECTORS]
  )) as CollectedElement[];

  // Filter to viewport-visible elements
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const viewportWidth = await page.evaluate(() => window.innerWidth);

  return raw
    .filter(
      (el) =>
        el.rect.y + el.rect.height > 0 &&
        el.rect.y < viewportHeight + 100 &&
        el.rect.x + el.rect.width > 0 &&
        el.rect.x < viewportWidth + 100
    )
    .map((el, id): SomMark => ({
      id,
      rect: el.rect,
      tag: el.tag,
      label: el.label.substring(0, 40),
      role: el.role !== el.tag ? el.role : undefined,
    }));
}

/**
 * Set-of-Mark annotator.
 * Draws numbered bounding boxes over every interactive element on the page,
 * takes a screenshot of the annotated page, and returns both the image and mark metadata.
 */
export async function annotate(page: Page): Promise<SomResult> {
  const marks = await collectMarks(page);
  setCachedMarks(marks, page.url());

  // Draw overlay boxes on the page
  await page.evaluate((marks) => {
    const existing = document.getElementById("__helm_som_overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "__helm_som_overlay";
    overlay.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;";

    const colors = [
      "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
      "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
      "#BB8FCE", "#85C1E9", "#F1948A", "#82E0AA",
    ];

    for (const mark of marks) {
      const color = colors[mark.id % colors.length]!;

      const box = document.createElement("div");
      box.style.cssText = `
        position:fixed;
        left:${mark.rect.x}px;
        top:${mark.rect.y}px;
        width:${mark.rect.width}px;
        height:${mark.rect.height}px;
        border:2px solid ${color};
        background:${color}22;
        pointer-events:none;
      `;

      const num = document.createElement("div");
      num.textContent = String(mark.id);
      num.style.cssText = `
        position:fixed;
        left:${mark.rect.x - 2}px;
        top:${mark.rect.y - 18}px;
        background:${color};
        color:#000;
        font:bold 12px monospace;
        padding:1px 4px;
        border-radius:2px;
        pointer-events:none;
        line-height:16px;
      `;

      overlay.appendChild(box);
      overlay.appendChild(num);
    }

    document.body.appendChild(overlay);
  }, marks);

  // Take screenshot with overlay, use JPEG for smaller size
  const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });

  // Remove overlay
  await page.evaluate(() => {
    const overlay = document.getElementById("__helm_som_overlay");
    if (overlay) overlay.remove();
  });

  return { screenshot: Buffer.from(screenshot), marks };
}

/**
 * Click the element corresponding to a Set-of-Mark ID.
 * Uses cached marks if available, otherwise re-collects.
 */
export async function clickMark(page: Page, markId: number): Promise<void> {
  let marks = getCachedMarks(page.url());
  if (!marks) {
    marks = await collectMarks(page);
    setCachedMarks(marks, page.url());
  }

  const mark = marks.find((m) => m.id === markId);
  if (!mark) {
    // Cache might be stale — force re-collect
    marks = await collectMarks(page);
    setCachedMarks(marks, page.url());
    const fresh = marks.find((m) => m.id === markId);
    if (!fresh) {
      throw new Error(
        `Mark ${markId} not found. Available marks: ${marks.map((m) => m.id).join(", ")}`
      );
    }
    const x = fresh.rect.x + fresh.rect.width / 2;
    const y = fresh.rect.y + fresh.rect.height / 2;
    await page.mouse.click(x, y);
    return;
  }

  const x = mark.rect.x + mark.rect.width / 2;
  const y = mark.rect.y + mark.rect.height / 2;
  await page.mouse.click(x, y);
}
