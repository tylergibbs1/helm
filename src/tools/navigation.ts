import { z } from "zod";
import { getActivePage } from "../core/browser.js";
import { withRecovery, dismissOverlays } from "../core/recovery.js";
import { invalidateMarkCache } from "../core/som.js";

export const navigationTools = {
  nav_goto: {
    description:
      "Navigate to a URL and wait for the page to be ready. Auto-dismisses cookie banners and common overlays.\n" +
      "Returns: { url, title, dismissed? }\n" +
      "When to use: To open a new page. Use 'content' (default) for fast loads, 'network-idle' when the page relies on async data.\n" +
      "Pitfalls: After navigation, call `obs_observe` to discover interactive elements before clicking anything.",
    schema: z.object({
      url: z.string().describe("The URL to navigate to"),
      waitUntil: z
        .enum(["content", "network-idle"])
        .optional()
        .default("content")
        .describe(
          "'content' waits for DOM content loaded (fast), " +
            "'network-idle' waits for all network requests to settle (thorough)"
        ),
    }),
    handler: async ({ url, waitUntil }: { url: string; waitUntil: "content" | "network-idle" }) => {
      const page = await getActivePage();

      if (waitUntil === "network-idle") {
        try {
          await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
        } catch {
          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
          } catch {
            // Even domcontentloaded timed out — page may still be partially usable
          }
        }
      } else {
        await withRecovery(
          page,
          async () => {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          },
          `navigate to ${url}`
        );
      }

      invalidateMarkCache();
      const dismissed = await dismissOverlays(page);

      const title = await page.title();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              url: page.url(),
              title,
              dismissed: dismissed.length > 0 ? dismissed : undefined,
            }),
          },
        ],
      };
    },
  },

  nav_back: {
    description:
      "Navigate back in browser history.\n" +
      "Returns: { url, title }\n" +
      "When to use: To return to the previous page after following a link or navigating forward.\n" +
      "Pitfalls: Mark cache is invalidated — call `obs_observe` again after navigating back.",
    schema: z.object({}),
    handler: async () => {
      const page = await getActivePage();
      await page.goBack({ timeout: 10_000 });
      invalidateMarkCache();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ url: page.url(), title: await page.title() }),
          },
        ],
      };
    },
  },

  nav_forward: {
    description:
      "Navigate forward in browser history.\n" +
      "Returns: { url, title }\n" +
      "When to use: To go forward after going back.\n" +
      "Pitfalls: Mark cache is invalidated — call `obs_observe` again after navigating.",
    schema: z.object({}),
    handler: async () => {
      const page = await getActivePage();
      await page.goForward({ timeout: 10_000 });
      invalidateMarkCache();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ url: page.url(), title: await page.title() }),
          },
        ],
      };
    },
  },

  nav_reload: {
    description:
      "Reload the current page.\n" +
      "Returns: { url, title }\n" +
      "When to use: When the page is in a bad state, data is stale, or after a server-side action that should update the page.\n" +
      "Pitfalls: Mark cache is invalidated. Reloading may lose form data or session state on some sites.",
    schema: z.object({}),
    handler: async () => {
      const page = await getActivePage();
      await page.reload({ timeout: 15_000 });
      invalidateMarkCache();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ url: page.url(), title: await page.title() }),
          },
        ],
      };
    },
  },
};
