import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { extractStructured } from "../../src/core/extractor.js";

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

describe("extractStructured — list mode", () => {
  test("extracts product list with name and price", async () => {
    await page.setContent(`
      <div class="product-list">
        <div class="product-card">
          <h3 class="product-title">Widget A</h3>
          <span class="product-price">$19.99</span>
          <a class="product-link" href="/widget-a">View</a>
        </div>
        <div class="product-card">
          <h3 class="product-title">Widget B</h3>
          <span class="product-price">$29.99</span>
          <a class="product-link" href="/widget-b">View</a>
        </div>
        <div class="product-card">
          <h3 class="product-title">Widget C</h3>
          <span class="product-price">$39.99</span>
          <a class="product-link" href="/widget-c">View</a>
        </div>
      </div>
    `);

    const result = await extractStructured(page, {
      fields: [
        { name: "title", description: "product name", type: "text" },
        { name: "price", description: "product price", type: "price" },
      ],
      mode: "auto",
      max_items: 50,
    });

    expect(result.mode).toBe("list");
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.item_count).toBe(3);
    expect(result.container_selector).toBeTruthy();
    expect(result.field_mapping.length).toBe(2);
  });

  test("respects max_items", async () => {
    await page.setContent(`
      <div class="items">
        <div class="item-card"><span class="item-name">Item 1</span></div>
        <div class="item-card"><span class="item-name">Item 2</span></div>
        <div class="item-card"><span class="item-name">Item 3</span></div>
        <div class="item-card"><span class="item-name">Item 4</span></div>
        <div class="item-card"><span class="item-name">Item 5</span></div>
      </div>
    `);

    const result = await extractStructured(page, {
      fields: [{ name: "name", description: "item name", type: "text" }],
      mode: "list",
      container_selector: ".item-card",
      max_items: 2,
    });

    expect(result.mode).toBe("list");
    expect(result.item_count).toBeLessThanOrEqual(2);
  });

  test("uses explicit container_selector", async () => {
    await page.setContent(`
      <table>
        <tbody>
          <tr class="data-row"><td>Alice</td><td>30</td></tr>
          <tr class="data-row"><td>Bob</td><td>25</td></tr>
          <tr class="data-row"><td>Charlie</td><td>35</td></tr>
        </tbody>
      </table>
    `);

    const result = await extractStructured(page, {
      fields: [
        { name: "name", description: "person name", type: "text" },
        { name: "age", description: "person age", type: "number" },
      ],
      container_selector: "tr.data-row",
      mode: "list",
      max_items: 50,
    });

    expect(result.mode).toBe("list");
    expect(result.item_count).toBe(3);
  });
});

describe("extractStructured — single mode", () => {
  test("extracts single item fields from a detail page", async () => {
    await page.setContent(`
      <main>
        <h1>Wireless Mouse Pro</h1>
        <p class="description">Ergonomic wireless mouse with 6 buttons</p>
        <span class="price">$49.99</span>
        <time datetime="2024-01-15">January 15, 2024</time>
      </main>
    `);

    const result = await extractStructured(page, {
      fields: [
        { name: "title", description: "product name", type: "text" },
        { name: "price", description: "product price", type: "price" },
      ],
      mode: "single",
      max_items: 1,
    });

    expect(result.mode).toBe("single");
    expect(result.item_count).toBe(1);
    expect(typeof result.data).toBe("object");
    expect(Array.isArray(result.data)).toBe(false);

    const data = result.data as Record<string, any>;
    // Price should be parsed as number
    expect(data.price).toBe(49.99);
  });

  test("returns null for fields that cannot be matched", async () => {
    await page.setContent(`<p>Just a paragraph</p>`);

    const result = await extractStructured(page, {
      fields: [
        { name: "sku", description: "product SKU number", type: "text" },
      ],
      mode: "single",
      max_items: 1,
    });

    expect(result.mode).toBe("single");
    // Confidence should be low when fields aren't found
    const data = result.data as Record<string, any>;
    // The field should exist in output even if null
    expect("sku" in data).toBe(true);
  });
});

describe("extractStructured — auto mode", () => {
  test("auto detects list on a page with repeated items", async () => {
    await page.setContent(`
      <ul class="search-results">
        <li class="result-item"><a class="result-title" href="/1">Result One</a><span class="result-desc">Description one</span></li>
        <li class="result-item"><a class="result-title" href="/2">Result Two</a><span class="result-desc">Description two</span></li>
        <li class="result-item"><a class="result-title" href="/3">Result Three</a><span class="result-desc">Description three</span></li>
      </ul>
    `);

    const result = await extractStructured(page, {
      fields: [
        { name: "title", description: "result title", type: "text" },
      ],
      mode: "auto",
      max_items: 50,
    });

    expect(result.mode).toBe("list");
    expect(result.item_count).toBeGreaterThanOrEqual(2);
  });

  test("auto falls back to single on a non-repeating page", async () => {
    await page.setContent(`
      <article>
        <h1>A Unique Article</h1>
        <p>This is a one-of-a-kind page with no repeating elements.</p>
        <footer>Published: 2024-03-01</footer>
      </article>
    `);

    const result = await extractStructured(page, {
      fields: [
        { name: "headline", description: "article headline", type: "text" },
      ],
      mode: "auto",
      max_items: 50,
    });

    expect(result.mode).toBe("single");
  });
});
