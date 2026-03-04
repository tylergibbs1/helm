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

describe("navigation e2e", () => {
  test("goto navigates and returns page info", async () => {
    await page.goto("data:text/html,<title>Test Page</title><h1>Hello</h1>");
    const title = await page.title();
    expect(title).toBe("Test Page");
  });

  test("fill and click work on a form", async () => {
    await page.setContent(`
      <form>
        <label for="username">Username</label>
        <input id="username" type="text" />
        <label for="password">Password</label>
        <input id="password" type="password" />
        <button type="submit">Sign In</button>
      </form>
      <script>
        document.querySelector('form').addEventListener('submit', (e) => {
          e.preventDefault();
          document.body.innerHTML = '<h1>Logged In</h1>';
        });
      </script>
    `);

    // Fill username
    const usernameField = page.getByLabel("Username");
    await usernameField.fill("testuser");
    expect(await usernameField.inputValue()).toBe("testuser");

    // Fill password
    const passwordField = page.getByLabel("Password");
    await passwordField.fill("testpass");
    expect(await passwordField.inputValue()).toBe("testpass");

    // Click sign in
    await page.getByRole("button", { name: "Sign In" }).click();

    // Verify navigation happened
    const heading = await page.locator("h1").innerText();
    expect(heading).toBe("Logged In");
  });

  test("extract finds text content from a page", async () => {
    await page.setContent(`
      <main>
        <h1>Order Confirmation</h1>
        <p>Your order number is: <strong>ORD-12345</strong></p>
        <p>Total: $99.99</p>
      </main>
    `);

    const mainContent = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main?.innerText || "";
    });

    expect(mainContent).toContain("ORD-12345");
    expect(mainContent).toContain("$99.99");
  });
});
