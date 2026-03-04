import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { computeFingerprint, matchesFingerprint } from "../../src/core/fingerprint.js";

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

describe("computeFingerprint", () => {
  test("returns fingerprint for a simple button", async () => {
    await page.setContent(`
      <div>
        <button id="submit-btn" class="primary" type="submit">Sign In</button>
      </div>
    `);

    const locator = page.locator("#submit-btn");
    const fp = await computeFingerprint(locator);

    expect(fp).not.toBeNull();
    expect(fp!.tag).toBe("button");
    expect(fp!.ownText).toBe("Sign In");
    expect(fp!.parentTag).toBe("div");
    expect(fp!.hash).toBeTruthy();
    expect(fp!.attributes).toContain("id=submit-btn");
    expect(fp!.attributes).toContain("class=primary");
  });

  test("captures sibling context", async () => {
    await page.setContent(`
      <ul>
        <li>First item</li>
        <li id="target">Middle item</li>
        <li>Last item</li>
      </ul>
    `);

    const locator = page.locator("#target");
    const fp = await computeFingerprint(locator);

    expect(fp).not.toBeNull();
    expect(fp!.siblingText).toContain("First item");
    expect(fp!.siblingText).toContain("Last item");
  });

  test("returns null for non-existent locator", async () => {
    await page.setContent(`<div>Hello</div>`);
    const locator = page.locator("#does-not-exist");
    const fp = await computeFingerprint(locator);
    expect(fp).toBeNull();
  });
});

describe("matchesFingerprint", () => {
  test("matches identical elements", async () => {
    await page.setContent(`
      <button id="btn" class="primary">Click Me</button>
    `);

    const locator = page.locator("#btn");
    const fp1 = await computeFingerprint(locator);
    const fp2 = await computeFingerprint(locator);

    expect(fp1).not.toBeNull();
    expect(fp2).not.toBeNull();
    expect(matchesFingerprint(fp1!, fp2!)).toBe(true);
  });

  test("detects changed text content", async () => {
    await page.setContent(`
      <button id="btn">Original Text</button>
    `);

    const locator = page.locator("#btn");
    const fp1 = await computeFingerprint(locator);

    // Change the button text
    await page.evaluate(() => {
      document.getElementById("btn")!.textContent = "Changed Text";
    });

    const fp2 = await computeFingerprint(locator);

    expect(fp1).not.toBeNull();
    expect(fp2).not.toBeNull();
    expect(matchesFingerprint(fp1!, fp2!)).toBe(false);
  });

  test("detects changed attributes", async () => {
    await page.setContent(`
      <button id="btn" class="primary">Click</button>
    `);

    const locator = page.locator("#btn");
    const fp1 = await computeFingerprint(locator);

    // Change class
    await page.evaluate(() => {
      document.getElementById("btn")!.className = "danger";
    });

    const fp2 = await computeFingerprint(locator);

    expect(fp1).not.toBeNull();
    expect(fp2).not.toBeNull();
    expect(matchesFingerprint(fp1!, fp2!)).toBe(false);
  });

  test("detects changed sibling context", async () => {
    await page.setContent(`
      <div>
        <span>Neighbor A</span>
        <button id="btn">Click</button>
        <span>Neighbor B</span>
      </div>
    `);

    const locator = page.locator("#btn");
    const fp1 = await computeFingerprint(locator);

    // Change sibling text
    await page.evaluate(() => {
      const btn = document.getElementById("btn")!;
      btn.previousElementSibling!.textContent = "Different Neighbor";
    });

    const fp2 = await computeFingerprint(locator);

    expect(fp1).not.toBeNull();
    expect(fp2).not.toBeNull();
    expect(matchesFingerprint(fp1!, fp2!)).toBe(false);
  });
});
