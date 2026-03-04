import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

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

describe("resolver", () => {
  test("resolves button by text", async () => {
    await page.setContent(`
      <button>Sign In</button>
      <button>Cancel</button>
    `);

    const btn = page.getByRole("button", { name: "Sign In" });
    expect(await btn.count()).toBe(1);
    expect(await btn.innerText()).toBe("Sign In");
  });

  test("resolves input by label", async () => {
    await page.setContent(`
      <label for="email">Email Address</label>
      <input id="email" type="email" />
    `);

    const input = page.getByLabel("Email Address");
    expect(await input.count()).toBe(1);
  });

  test("resolves input by placeholder", async () => {
    await page.setContent(`
      <input placeholder="Search..." type="text" />
    `);

    const input = page.getByPlaceholder("Search...");
    expect(await input.count()).toBe(1);
  });
});

describe("observer", () => {
  test("collects interactive elements", async () => {
    await page.setContent(`
      <form>
        <label for="name">Name</label>
        <input id="name" type="text" />
        <label for="email">Email</label>
        <input id="email" type="email" />
        <button type="submit">Submit</button>
      </form>
    `);

    const elements = await page.evaluate(() => {
      const results: any[] = [];
      const selectors = ["button", "input", "select", "textarea"];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            results.push({
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type || "",
            });
          }
        }
      }
      return results;
    });

    expect(elements.length).toBeGreaterThanOrEqual(2);
    expect(elements.some((e: any) => e.tag === "button")).toBe(true);
    expect(elements.some((e: any) => e.tag === "input")).toBe(true);
  });
});

describe("som", () => {
  test("annotates interactive elements with marks", async () => {
    await page.setContent(`
      <div>
        <a href="/home">Home</a>
        <button>Click Me</button>
        <input type="text" placeholder="Type here" />
      </div>
    `);

    const marks = await page.evaluate(() => {
      const results: any[] = [];
      const seen = new Set<Element>();
      let id = 0;

      const selectors = ["a[href]", "button", "input"];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            results.push({ id: id++, tag: el.tagName.toLowerCase() });
          }
        }
      }
      return results;
    });

    expect(marks.length).toBe(3);
    expect(marks[0]!.tag).toBe("a");
    expect(marks[1]!.tag).toBe("button");
    expect(marks[2]!.tag).toBe("input");
  });
});
