import type { Page } from "playwright";
import type { Observation, RelevantElement, CollectedElement } from "../types.js";
import { INTERACTIVE_SELECTORS, collectElementsScript } from "../types.js";
import { getMemory } from "./memory.js";

/**
 * Produces a filtered, task-relevant observation of the current page.
 * Instead of dumping the full accessibility tree, returns only elements
 * and information relevant to the given task description.
 */
export async function observe(page: Page, task: string): Promise<Observation> {
  const url = page.url();

  // Single parallel batch: title + elements + notices
  const [title, raw, notices] = await Promise.all([
    page.title(),
    page.evaluate(collectElementsScript(INTERACTIVE_SELECTORS), [...INTERACTIVE_SELECTORS]),
    collectNotices(page),
  ]);

  const elements = (raw as CollectedElement[]).map(toRelevantElement);
  const relevant = filterByTask(elements, task);

  // Check for prior site memory
  let priorContext;
  try {
    const domain = new URL(url).hostname;
    const memory = getMemory(domain);
    if (memory) priorContext = memory;
  } catch {
    // No memory or invalid URL
  }

  return {
    page: title || url,
    url,
    relevant_elements: relevant,
    notices,
    prior_context: priorContext,
  };
}

function toRelevantElement(el: CollectedElement, i: number): RelevantElement {
  const semanticType = mapToSemanticType(el);
  return {
    id: `e${i}`,
    type: semanticType,
    label: el.label || `(unlabeled ${semanticType})`,
    value: el.value || undefined,
    filled: el.value ? true : undefined,
    enabled: el.disabled ? false : true,
    checked: ["checkbox", "radio"].includes(el.type) ? el.checked : undefined,
    options: el.options.length > 0 ? el.options : undefined,
  };
}

function mapToSemanticType(el: CollectedElement): string {
  if (el.tag === "a") return "link";
  if (el.tag === "button" || el.role === "button") return "button";
  if (el.tag === "select" || el.role === "combobox") return "dropdown";
  if (el.tag === "textarea") return "textarea";
  if (el.tag === "input") {
    switch (el.type) {
      case "checkbox": return "checkbox";
      case "radio": return "radio";
      case "submit": return "button";
      case "password": return "password";
      case "email": return "email";
      case "search": return "search";
      case "file": return "file";
      default: return "input";
    }
  }
  if (el.role === "tab") return "tab";
  if (el.role === "menuitem") return "menuitem";
  if (el.role === "checkbox") return "checkbox";
  if (el.role === "radio") return "radio";
  if (el.role === "switch") return "switch";
  return el.role || el.tag;
}

async function collectNotices(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const notices: string[] = [];

    const alerts = document.querySelectorAll(
      '[role="alert"], [role="status"], .alert, .notice, .warning, .error, .success, .info'
    );
    for (const el of alerts) {
      const text = (el as HTMLElement).innerText?.trim();
      if (text && text.length < 200) {
        notices.push(text);
      }
    }

    const dialogs = document.querySelectorAll(
      'dialog[open], [role="dialog"], .modal.show, .modal.active'
    );
    if (dialogs.length > 0) {
      const dialog = dialogs[0] as HTMLElement;
      const title =
        dialog.querySelector("h1, h2, h3, [class*='title']")?.textContent?.trim() ||
        "Dialog open";
      notices.push(`Modal/dialog present: ${title}`);
    }

    return notices;
  });
}

/**
 * Filter elements based on task relevance using keyword matching.
 */
function filterByTask(
  elements: RelevantElement[],
  task: string
): RelevantElement[] {
  if (!task || task.length < 3) {
    return elements.slice(0, 50);
  }

  const taskLower = task.toLowerCase();
  const taskWords = taskLower.split(/\s+/).filter((w) => w.length > 2);

  const scored = elements.map((el) => {
    let score = 0;
    const labelLower = el.label.toLowerCase();
    const typeLower = el.type.toLowerCase();

    for (const word of taskWords) {
      if (labelLower.includes(word)) score += 3;
      if (typeLower.includes(word)) score += 1;
    }

    if (taskLower.includes("login") || taskLower.includes("sign in")) {
      if (["password", "email", "input"].includes(el.type)) score += 2;
      if (labelLower.match(/email|user|password|sign|log/)) score += 3;
    }
    if (taskLower.includes("search")) {
      if (el.type === "search" || labelLower.includes("search")) score += 3;
    }
    if (taskLower.includes("form") || taskLower.includes("fill")) {
      if (["input", "textarea", "dropdown", "checkbox", "radio"].includes(el.type))
        score += 2;
    }
    if (taskLower.includes("navigate") || taskLower.includes("click")) {
      if (["link", "button", "tab"].includes(el.type)) score += 2;
    }

    if (el.type === "button") score += 1;

    return { el, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const relevant = scored.filter((s) => s.score > 0).map((s) => s.el);
  const baseline = scored.filter((s) => s.score === 0).map((s) => s.el);

  const maxTotal = 30;
  const result = relevant.slice(0, maxTotal);
  const remaining = maxTotal - result.length;
  if (remaining > 0) {
    result.push(...baseline.slice(0, remaining));
  }

  return result;
}
