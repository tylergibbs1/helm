import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
const pages = new Map<string, Page>();
let activeTabId = "tab-0";
let tabCounter = 0;

export async function ensureBrowser(): Promise<BrowserContext> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: false,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    const id = `tab-${tabCounter++}`;
    pages.set(id, page);
    activeTabId = id;
  }
  return context!;
}

export async function getActivePage(): Promise<Page> {
  await ensureBrowser();
  const page = pages.get(activeTabId);
  if (!page || page.isClosed()) {
    throw new Error(`Active tab ${activeTabId} is closed or missing`);
  }
  return page;
}

export async function newTab(): Promise<{ tabId: string }> {
  const ctx = await ensureBrowser();
  const page = await ctx.newPage();
  const id = `tab-${tabCounter++}`;
  pages.set(id, page);
  activeTabId = id;
  return { tabId: id };
}

export async function closeTab(tabId?: string): Promise<void> {
  const id = tabId ?? activeTabId;
  const page = pages.get(id);
  if (page && !page.isClosed()) {
    try {
      await page.close();
    } catch {
      // Page may already be closing — ensure cleanup continues
    }
  }
  pages.delete(id);

  if (id === activeTabId) {
    const remaining = Array.from(pages.keys());
    activeTabId = remaining[remaining.length - 1] ?? "";
  }
}

export function getTabIds(): string[] {
  return Array.from(pages.keys());
}

export function setActiveTab(tabId: string): void {
  if (!pages.has(tabId)) {
    throw new Error(`Tab ${tabId} not found`);
  }
  activeTabId = tabId;
}

export async function shutdown(): Promise<void> {
  for (const [, page] of pages) {
    if (!page.isClosed()) await page.close();
  }
  pages.clear();
  if (context) await context.close();
  if (browser) await browser.close();
  browser = null;
  context = null;
}
