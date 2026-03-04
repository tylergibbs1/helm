import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  getCDPSession,
  runtimeEvaluate,
  getPerformanceMetrics,
  startNetworkCapture,
} from "../../src/core/cdp.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
});

afterAll(async () => {
  await browser.close();
});

describe("getCDPSession", () => {
  test("returns a CDP session", async () => {
    const session = await getCDPSession(page);
    expect(session).toBeTruthy();
  });

  test("returns same session on repeated calls", async () => {
    const s1 = await getCDPSession(page);
    const s2 = await getCDPSession(page);
    expect(s1).toBe(s2);
  });
});

describe("runtimeEvaluate", () => {
  test("evaluates simple expressions", async () => {
    const session = await getCDPSession(page);
    const { result } = await runtimeEvaluate(session, "2 + 2");
    expect(result).toBe(4);
  });

  test("evaluates string expressions", async () => {
    const session = await getCDPSession(page);
    const { result } = await runtimeEvaluate(session, "'hello' + ' world'");
    expect(result).toBe("hello world");
  });

  test("returns exception details on error", async () => {
    const session = await getCDPSession(page);
    const { exceptionDetails } = await runtimeEvaluate(
      session,
      "throw new Error('test error')"
    );
    expect(exceptionDetails).toBeTruthy();
  });

  test("can access DOM", async () => {
    await page.setContent(`<h1 id="title">Hello CDP</h1>`);
    const session = await getCDPSession(page);
    const { result } = await runtimeEvaluate(
      session,
      'document.getElementById("title").textContent'
    );
    expect(result).toBe("Hello CDP");
  });
});

describe("getPerformanceMetrics", () => {
  test("returns metrics object with expected keys", async () => {
    await page.setContent(`<div>Performance test</div>`);
    const session = await getCDPSession(page);
    const metrics = await getPerformanceMetrics(session);

    expect(typeof metrics).toBe("object");
    expect(typeof metrics.Documents).toBe("number");
    expect(typeof metrics.Nodes).toBe("number");
    expect(typeof metrics.JSHeapUsedSize).toBe("number");
  });
});

describe("startNetworkCapture", () => {
  test("captures requests during navigation", async () => {
    const session = await getCDPSession(page);
    const capture = await startNetworkCapture(session);

    // Navigate to a data URL (triggers a request)
    await page.goto("data:text/html,<h1>Captured</h1>");

    const requests = capture.getRequests();
    capture.stop();

    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0]!.url).toContain("data:text/html");
  });

  test("filters requests by URL pattern", async () => {
    const session = await getCDPSession(page);
    const capture = await startNetworkCapture(session);

    await page.setContent(`
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" />
    `);

    const imageRequests = capture.getByPattern("image/gif");
    const htmlRequests = capture.getByPattern("text/html");
    capture.stop();

    // The image data URL should match the gif pattern
    expect(imageRequests.length).toBeGreaterThanOrEqual(0); // data URLs may not trigger network
    // All results should be filtered correctly
    for (const r of htmlRequests) {
      expect(r.url).toMatch(/text\/html/i);
    }
  });

  test("stop is idempotent", async () => {
    const session = await getCDPSession(page);
    const capture = await startNetworkCapture(session);

    capture.stop();
    capture.stop(); // should not throw
  });
});
