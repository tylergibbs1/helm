import type { Page } from "playwright";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;

/**
 * Execute an action with automatic error recovery.
 * Handles retries, modal dismissal, and provides clear error messages.
 */
export async function withRecovery<T>(
  page: Page,
  action: () => Promise<T>,
  description: string
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Before each attempt, try to dismiss any blocking overlays
      if (attempt > 0) {
        await dismissOverlays(page);
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
      }

      return await action();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if it's a retriable error
      if (!isRetriable(lastError)) {
        break;
      }
    }
  }

  // All retries exhausted — format a clear error message
  throw new Error(
    `Failed: ${description}\n` +
      `After ${MAX_RETRIES} attempts: ${lastError?.message || "Unknown error"}\n` +
      `Suggestion: Use obs_observe() to see current page state, or try obs_screenshot(overlay=true) + act_click(mark_id) as a fallback.`
  );
}

/**
 * Detect and dismiss common overlay patterns (cookie banners, popups, etc.).
 */
export async function dismissOverlays(page: Page): Promise<string[]> {
  const dismissed: string[] = await page.evaluate(() => {
    const results: string[] = [];

    // Common cookie banner dismiss patterns
    const cookieSelectors = [
      // Button text patterns
      'button',
      'a',
      '[role="button"]',
    ];

    const dismissTexts = [
      /accept all/i,
      /accept cookies/i,
      /accept$/i,
      /got it/i,
      /i agree/i,
      /close/i,
      /dismiss/i,
      /reject all/i,
      /decline/i,
      /no thanks/i,
      /not now/i,
      /maybe later/i,
    ];

    // Look for overlay/modal containers that might be blocking
    const overlaySelectors = [
      '[class*="cookie"]',
      '[class*="consent"]',
      '[class*="banner"]',
      '[id*="cookie"]',
      '[id*="consent"]',
      '[class*="overlay"]',
      '[class*="popup"]',
      '[class*="modal"]',
    ];

    // Try to find and click dismiss buttons within overlays
    for (const containerSel of overlaySelectors) {
      const containers = document.querySelectorAll(containerSel);
      for (const container of containers) {
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        for (const btnSel of cookieSelectors) {
          const buttons = container.querySelectorAll(btnSel);
          for (const btn of buttons) {
            const text = (btn as HTMLElement).innerText?.trim() || "";
            for (const pattern of dismissTexts) {
              if (pattern.test(text)) {
                (btn as HTMLElement).click();
                results.push(`Dismissed: "${text}"`);
                break;
              }
            }
          }
        }
      }
    }

    // Try to close any open dialogs
    const dialogs = document.querySelectorAll("dialog[open]");
    for (const dialog of dialogs) {
      const closeBtn = dialog.querySelector(
        'button[class*="close"], [aria-label="Close"], .close-button'
      );
      if (closeBtn) {
        (closeBtn as HTMLElement).click();
        results.push("Closed dialog");
      }
    }

    return results;
  });

  return dismissed;
}

function isRetriable(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("navigation") ||
    msg.includes("net::") ||
    msg.includes("target closed") ||
    msg.includes("execution context") ||
    msg.includes("frame was detached")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FormattedError {
  error: string;
  suggestion: string;
  recoverable: boolean;
}

/**
 * Map raw Playwright / runtime errors to actionable guidance.
 */
export function formatError(err: unknown, toolName?: string): FormattedError {
  const message = err instanceof Error ? err.message : String(err);
  const msg = message.toLowerCase();

  if (msg.includes("timeout")) {
    return {
      error: message,
      suggestion: "Page may still be loading. Try `page_wait_for` then retry.",
      recoverable: true,
    };
  }
  if (msg.includes("net::err_name_not_resolved")) {
    return {
      error: message,
      suggestion: "URL may be misspelled or site is down.",
      recoverable: false,
    };
  }
  if (msg.includes("net::err_connection_refused")) {
    return {
      error: message,
      suggestion: "Server not accepting connections.",
      recoverable: false,
    };
  }
  if (msg.includes("target closed")) {
    return {
      error: message,
      suggestion: "Tab was closed. Use `page_new_tab` to open a new one.",
      recoverable: false,
    };
  }
  if (msg.includes("execution context") || msg.includes("frame was detached")) {
    return {
      error: message,
      suggestion: "Page navigated away. Call `obs_observe` to see current state.",
      recoverable: true,
    };
  }
  if (msg.includes("element not found") || msg.includes("could not find element")) {
    return {
      error: message,
      suggestion: "Call `obs_observe` to see available elements, or use `obs_screenshot(overlay=true)` + `act_click(mark_id)` as fallback.",
      recoverable: true,
    };
  }
  if (msg.includes("invalid query") || msg.includes("missing select")) {
    return {
      error: message,
      suggestion: "Check SQL syntax. Run `data_analyze_page` to discover selectors first.",
      recoverable: false,
    };
  }

  return {
    error: message,
    suggestion: "Use `obs_observe` to check current page state.",
    recoverable: true,
  };
}
