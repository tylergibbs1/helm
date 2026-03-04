import type { Page, Locator } from "playwright";
import type { ResolveResult, CollectedElement } from "../types.js";
import { INTERACTIVE_SELECTORS, collectElementsScript } from "../types.js";
import { getMemory } from "./memory.js";
import { computeFingerprint, matchesFingerprint } from "./fingerprint.js";

/**
 * Resolves a human-readable label to a Playwright locator.
 * Runs all strategies concurrently — first unique match wins.
 */
export async function resolve(
  page: Page,
  label: string,
  role?: string
): Promise<{ locator: Locator; result: ResolveResult }> {
  const strategies = getStrategies(page, label, role);

  // Run all strategies in parallel — first exact match wins
  const results = await Promise.allSettled(
    strategies.map(async (strategy) => {
      const locator = strategy.locate();
      const count = await locator.count();
      if (count === 1) {
        return { locator, strategy };
      }
      if (count > 1) {
        const visible = locator.first();
        if (await visible.isVisible().catch(() => false)) {
          return {
            locator: visible,
            strategy: {
              ...strategy,
              description: strategy.description + " (first visible)",
              confidence: strategy.confidence * 0.8,
            },
          };
        }
      }
      throw new Error("no match");
    })
  );

  // Pick the highest-confidence fulfilled result
  let best: { locator: Locator; strategy: Strategy } | null = null;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (!best || r.value.strategy.confidence > best.strategy.confidence) {
        best = r.value;
      }
    }
  }

  if (best) {
    return {
      locator: best.locator,
      result: {
        selector: best.strategy.description,
        confidence: best.strategy.confidence,
        method: best.strategy.method,
      },
    };
  }

  // Fallback: batched fuzzy match (single page.evaluate)
  try {
    const fuzzy = await fuzzyMatch(page, label);
    if (fuzzy) return fuzzy;
  } catch {
    // Fall through
  }

  // Check site memory for known selectors
  try {
    const memoryResult = await memoryMatch(page, label);
    if (memoryResult) return memoryResult;
  } catch {
    // Fall through
  }

  throw new Error(
    `Could not find element with label "${label}". ` +
      `Try using obs_observe() to see available elements, or obs_screenshot(overlay=true) + act_click(mark_id) as a fallback.`
  );
}

interface Strategy {
  method: ResolveResult["method"];
  confidence: number;
  description: string;
  locate: () => Locator;
}

function getStrategies(
  page: Page,
  label: string,
  role?: string
): Strategy[] {
  const strategies: Strategy[] = [];

  const roleMap: Record<string, string> = {
    button: "button",
    link: "link",
    input: "textbox",
    textarea: "textbox",
    checkbox: "checkbox",
    radio: "radio",
    select: "combobox",
    tab: "tab",
    menu: "menu",
    menuitem: "menuitem",
    dialog: "dialog",
  };

  // If specific role provided, add it at highest confidence
  if (role && roleMap[role]) {
    strategies.push({
      method: "role",
      confidence: 0.95,
      description: `getByRole('${roleMap[role]}', { name: '${label}' })`,
      locate: () =>
        page.getByRole(roleMap[role] as any, { name: label, exact: false }),
    });
  }

  // Common roles — skip the specific one if already added
  const specificAriaRole = role ? roleMap[role] : null;
  for (const [, ariaRole] of Object.entries(roleMap)) {
    if (ariaRole === specificAriaRole) continue; // deduplicate
    strategies.push({
      method: "role",
      confidence: 0.9,
      description: `getByRole('${ariaRole}', { name: '${label}' })`,
      locate: () =>
        page.getByRole(ariaRole as any, { name: label, exact: false }),
    });
  }

  // getByLabel
  strategies.push({
    method: "label",
    confidence: 0.9,
    description: `getByLabel('${label}')`,
    locate: () => page.getByLabel(label, { exact: false }),
  });

  // getByPlaceholder
  strategies.push({
    method: "placeholder",
    confidence: 0.8,
    description: `getByPlaceholder('${label}')`,
    locate: () => page.getByPlaceholder(label, { exact: false }),
  });

  // getByTitle
  strategies.push({
    method: "title",
    confidence: 0.7,
    description: `getByTitle('${label}')`,
    locate: () => page.getByTitle(label, { exact: false }),
  });

  // getByText exact
  strategies.push({
    method: "text",
    confidence: 0.75,
    description: `getByText('${label}', exact)`,
    locate: () => page.getByText(label, { exact: true }),
  });

  // getByText partial
  strategies.push({
    method: "text",
    confidence: 0.6,
    description: `getByText('${label}', partial)`,
    locate: () => page.getByText(label, { exact: false }),
  });

  return strategies;
}

/**
 * Batched fuzzy match — single page.evaluate() collects all element text,
 * then filters client-side. No sequential round-trips.
 */
async function fuzzyMatch(
  page: Page,
  label: string
): Promise<{ locator: Locator; result: ResolveResult } | null> {
  const normalized = label.toLowerCase().trim();
  const words = normalized.split(/\s+/);

  // Single evaluate: collect all interactive element text at once
  const candidates = (await page.evaluate(
    collectElementsScript(INTERACTIVE_SELECTORS),
    [...INTERACTIVE_SELECTORS]
  )) as CollectedElement[];

  // Filter client-side — no extra round-trips
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i]!;
    const combined = `${el.text} ${el.label} ${el.placeholder}`.toLowerCase();

    if (words.every((w) => combined.includes(w)) && el.rect.width > 0 && el.rect.height > 0) {
      // Build a locator that targets this specific element by index
      const selector = buildSelectorForElement(el, i);
      const locator = page.locator(selector).first();

      if (await locator.isVisible().catch(() => false)) {
        return {
          locator,
          result: {
            selector: `fuzzy match: "${combined.substring(0, 50)}"`,
            confidence: 0.5,
            method: "fuzzy",
          },
        };
      }
    }
  }

  return null;
}

/**
 * Build a CSS selector to target a specific collected element.
 */
function buildSelectorForElement(el: CollectedElement, _index: number): string {
  // Try to build a specific selector from available attributes
  if (el.label) {
    if (el.tag === "button" || el.role === "button") {
      return `${el.tag}:has-text("${el.label.substring(0, 30)}")`;
    }
    if (el.tag === "a") {
      return `a:has-text("${el.label.substring(0, 30)}")`;
    }
    if (el.tag === "input" && el.placeholder) {
      return `input[placeholder="${el.placeholder}"]`;
    }
  }
  // Fallback to nth-of-type
  return `${el.tag}:visible >> nth=0`;
}

async function memoryMatch(
  page: Page,
  label: string
): Promise<{ locator: Locator; result: ResolveResult } | null> {
  const url = page.url();
  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    return null;
  }

  const entry = getMemory(domain);
  if (!entry) return null;

  const pageMemory = entry.pages.find((p) => p.url === url);
  if (!pageMemory) return null;

  const matching = pageMemory.actions_taken.find(
    (a) =>
      a.success &&
      a.label.toLowerCase().includes(label.toLowerCase())
  );

  if (!matching) return null;

  try {
    const locator = page.locator(matching.selector);
    if ((await locator.count()) === 1) {
      // Validate fingerprint if stored — detect stale cached selectors
      if (matching.fingerprint) {
        const current = await computeFingerprint(locator);
        if (!current || !matchesFingerprint(matching.fingerprint, current)) {
          return null; // stale — re-resolve
        }
      }

      return {
        locator,
        result: {
          selector: matching.selector,
          confidence: 0.7,
          method: "memory",
        },
      };
    }
  } catch {
    // Selector no longer valid
  }

  return null;
}
