import { z } from "zod";
import type { Page, Locator } from "playwright";
import { getActivePage } from "../core/browser.js";
import { resolve } from "../core/resolver.js";
import { withRecovery, dismissOverlays } from "../core/recovery.js";
import { recordAction } from "../core/memory.js";
import type { ResolveResult } from "../types.js";

/**
 * Try multiple labels in parallel, return first successful resolve.
 */
async function resolveFirst(
  page: Page,
  labels: string[],
  role?: string
): Promise<{ locator: Locator; result: ResolveResult } | null> {
  const results = await Promise.allSettled(
    labels.map((label) => resolve(page, label, role))
  );
  let best: { locator: Locator; result: ResolveResult } | null = null;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (!best || r.value.result.confidence > best.result.confidence) {
        best = r.value;
      }
    }
  }
  return best;
}

export const compositeTools = {
  act_login: {
    description:
      "Complete a full login flow in one call: navigate, fill credentials, submit, wait for redirect.\n" +
      "Returns: { status: 'completed'|'partial_failure', url, title } or { username_found, password_found, suggestion }\n" +
      "When to use: For standard username/password login pages. Handles common login patterns automatically.\n" +
      "Pitfalls: Won't work with MFA, CAPTCHAs, or non-standard login flows. If it returns partial_failure, " +
      "use `obs_observe` then `act_fill` and `act_click` manually.",
    schema: z.object({
      url: z.string().describe("The login page URL"),
      username: z
        .string()
        .describe("The username or email to enter"),
      password: z.string().describe("The password to enter"),
    }),
    handler: async ({
      url,
      username,
      password,
    }: {
      url: string;
      username: string;
      password: string;
    }) => {
      const page = await getActivePage();

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await dismissOverlays(page);

      const usernameLabels = ["email", "username", "user", "login", "email address", "user name", "account"];
      const passwordLabels = ["password", "pass", "pwd"];

      const [usernameResult, passwordResult] = await Promise.all([
        resolveFirst(page, usernameLabels),
        resolveFirst(page, passwordLabels),
      ]);

      let usernameFound = false;
      if (usernameResult) {
        await usernameResult.locator.click({ timeout: 3_000 });
        await usernameResult.locator.fill(username);
        usernameFound = true;
      } else {
        try {
          const emailInput = page.locator('input[type="email"], input[type="text"]').first();
          if (await emailInput.isVisible()) {
            await emailInput.fill(username);
            usernameFound = true;
          }
        } catch {}
      }

      let passwordFound = false;
      if (passwordResult) {
        await passwordResult.locator.click({ timeout: 3_000 });
        await passwordResult.locator.fill(password);
        passwordFound = true;
      } else {
        try {
          const passInput = page.locator('input[type="password"]').first();
          if (await passInput.isVisible()) {
            await passInput.fill(password);
            passwordFound = true;
          }
        } catch {}
      }

      if (!usernameFound || !passwordFound) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "partial_failure",
                username_found: usernameFound,
                password_found: passwordFound,
                suggestion:
                  "Use obs_observe() to see the page elements, then act_fill() and act_click() manually.",
              }),
            },
          ],
        };
      }

      const submitLabels = ["sign in", "log in", "login", "submit", "continue", "next"];
      const submitResult = await resolveFirst(page, submitLabels, "button");

      let submitted = false;
      if (submitResult) {
        await submitResult.locator.click({ timeout: 3_000 });
        submitted = true;
      } else {
        try {
          const submitBtn = page
            .locator('button[type="submit"], input[type="submit"]')
            .first();
          if (await submitBtn.isVisible()) {
            await submitBtn.click({ timeout: 3_000 });
            submitted = true;
          }
        } catch {
          await page.keyboard.press("Enter");
          submitted = true;
        }
      }

      try {
        await page.waitForURL((url) => url.toString() !== page.url(), {
          timeout: 10_000,
        });
      } catch {
        // No redirect — might still be on same page
      }

      await page.waitForTimeout(1_000);
      const title = await page.title();

      recordAction(url, title, {
        action: "login",
        label: "login flow",
        selector: "composite",
        success: true,
        timestamp: Date.now(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "completed",
              url: page.url(),
              title,
            }),
          },
        ],
      };
    },
  },

  act_submit_form: {
    description:
      "Find and click the primary submit button on the current page.\n" +
      "Returns: { submitted: true, method?, button?, url } or { submitted: false, error }\n" +
      "When to use: After filling out a form. Looks for type=submit buttons, then common labels like Save, Continue, Next.\n" +
      "Pitfalls: If the page has multiple forms, this clicks the first visible submit button. Use `act_click` with a specific label for precision.",
    schema: z.object({}),
    handler: async () => {
      const page = await getActivePage();

      const submitLabels = [
        "submit", "save", "continue", "next", "send",
        "confirm", "done", "create", "apply", "ok",
      ];

      try {
        const submitBtn = page
          .locator('button[type="submit"], input[type="submit"]')
          .first();
        if (await submitBtn.isVisible({ timeout: 2_000 })) {
          await submitBtn.click({ timeout: 5_000 });
          await page.waitForTimeout(500);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  submitted: true,
                  method: "type=submit",
                  url: page.url(),
                }),
              },
            ],
          };
        }
      } catch {
        // Try labeled buttons
      }

      for (const label of submitLabels) {
        try {
          const { locator, result } = await resolve(page, label, "button");
          if (await locator.isVisible({ timeout: 1_000 })) {
            await locator.click({ timeout: 5_000 });
            await page.waitForTimeout(500);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    submitted: true,
                    button: label,
                    resolved_via: result.method,
                    url: page.url(),
                  }),
                },
              ],
            };
          }
        } catch {
          continue;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              submitted: false,
              error: "Could not find a submit button. Use obs_observe() to see available buttons.",
            }),
          },
        ],
      };
    },
  },

  page_wait_for: {
    description:
      "Wait until a condition is true on the page using DOM-based heuristic checks.\n" +
      "Returns: { condition_met: true|false, condition, waited_ms }\n" +
      "When to use: After clicking a button that triggers async loading, before extracting data that hasn't rendered yet.\n" +
      'Pitfalls: Condition strings are pattern-matched. Supported patterns: "spinner gone", "text appears: <text>", ' +
      '"<element> enabled", "<element> gone/hidden", "url contains: <text>", "<thing> loaded". ' +
      "Falls back to checking if the condition text appears on the page.",
    schema: z.object({
      condition: z
        .string()
        .describe(
          'Natural language description of what to wait for (e.g., "spinner gone", "results loaded", "text appears: Order confirmed")'
        ),
      timeout_ms: z
        .number()
        .optional()
        .default(10_000)
        .describe("Maximum time to wait in milliseconds"),
    }),
    handler: async ({
      condition,
      timeout_ms,
    }: {
      condition: string;
      timeout_ms: number;
    }) => {
      const page = await getActivePage();
      const condLower = condition.toLowerCase();
      const startTime = Date.now();

      const check = async (): Promise<boolean> => {
        if (
          condLower.includes("spinner") ||
          condLower.includes("loading")
        ) {
          const spinners = await page
            .locator(
              '[class*="spinner"], [class*="loading"], [class*="loader"], [role="progressbar"]'
            )
            .count();
          return spinners === 0;
        }

        const textMatch = condition.match(/text\s*(?:appears?|visible|shown?):\s*(.+)/i);
        if (textMatch?.[1]) {
          const text = textMatch[1].trim();
          return (await page.getByText(text, { exact: false }).count()) > 0;
        }

        if (condLower.includes("enabled")) {
          const enabledMatch = condition.match(/(.+?)\s+enabled/i);
          if (enabledMatch?.[1]) {
            try {
              const { locator } = await resolve(page, enabledMatch[1].trim());
              return await locator.isEnabled();
            } catch {
              return false;
            }
          }
        }

        if (condLower.includes("gone") || condLower.includes("hidden") || condLower.includes("disappear")) {
          const goneMatch = condition.match(/(.+?)\s+(?:gone|hidden|disappear)/i);
          if (goneMatch?.[1]) {
            try {
              const { locator } = await resolve(page, goneMatch[1].trim());
              return !(await locator.isVisible());
            } catch {
              return true;
            }
          }
        }

        if (condLower.includes("url")) {
          const urlMatch = condition.match(/url\s*(?:contains?|includes?|has):\s*(.+)/i);
          if (urlMatch?.[1]) {
            return page.url().includes(urlMatch[1].trim());
          }
        }

        if (condLower.includes("loaded") || condLower.includes("ready")) {
          return page.evaluate(() => {
            return document.readyState === "complete";
          });
        }

        return (await page.getByText(condition, { exact: false }).count()) > 0;
      };

      const pollInterval = 500;
      while (Date.now() - startTime < timeout_ms) {
        if (await check()) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  condition_met: true,
                  condition,
                  waited_ms: Date.now() - startTime,
                }),
              },
            ],
          };
        }
        await page.waitForTimeout(pollInterval);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              condition_met: false,
              condition,
              waited_ms: timeout_ms,
              suggestion: "Condition was not met within timeout. Use obs_observe() to check the current page state.",
            }),
          },
        ],
      };
    },
  },
};
