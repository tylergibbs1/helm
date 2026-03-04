import { z } from "zod";
import { getActivePage } from "../core/browser.js";
import {
  getCDPSession,
  runtimeEvaluate,
  getPerformanceMetrics,
  startNetworkCapture,
  type NetworkCaptureHandle,
} from "../core/cdp.js";

// Store active network capture handles per page URL
let activeCapture: NetworkCaptureHandle | null = null;

export const devtoolsTools = {
  cdp_evaluate: {
    description:
      "Evaluate a JavaScript expression via Chrome DevTools Protocol (CDP Runtime.evaluate).\n" +
      "Returns: { result, error? }\n" +
      "When to use: For raw JS evaluation bypassing Playwright's sandbox — useful for accessing " +
      "browser internals, service workers, localStorage, performance timing, or expressions that need full page context. " +
      "Prefer `data_query` for structured DOM extraction and `obs_extract` for quick content reads.\n" +
      "Examples:\n" +
      "  localStorage.getItem('authToken')\n" +
      "  performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd\n" +
      "  document.querySelectorAll('*').length\n" +
      "  JSON.stringify({cookies: document.cookie, url: location.href})\n" +
      "  (function(){ /* multi-statement logic */ return result; })()\n" +
      "Pitfalls: Must be a single expression or IIFE. Results over 10KB are truncated. Avoid long-running scripts.",
    schema: z.object({
      expression: z
        .string()
        .describe("JavaScript expression to evaluate in the page context"),
    }),
    handler: async ({ expression }: { expression: string }) => {
      const MAX_EVAL_BYTES = 10_000;
      const page = await getActivePage();
      const session = await getCDPSession(page);
      const { result, exceptionDetails } = await runtimeEvaluate(session, expression);

      const output: Record<string, any> = { result };
      if (exceptionDetails) {
        output.error = exceptionDetails.text || exceptionDetails.exception?.description || "Evaluation error";
      }

      let serialized = JSON.stringify(output);
      if (serialized.length > MAX_EVAL_BYTES) {
        const truncatedResult = typeof result === "string"
          ? result.substring(0, MAX_EVAL_BYTES - 200)
          : JSON.stringify(result).substring(0, MAX_EVAL_BYTES - 200);
        serialized = JSON.stringify({
          result: truncatedResult,
          _truncated: true,
          _hint: "Result exceeded 10KB. Use more targeted expressions or filter in the expression itself.",
        });
      }

      return {
        content: [{ type: "text" as const, text: serialized }],
      };
    },
  },

  cdp_performance: {
    description:
      "Get a snapshot of browser performance metrics via CDP Performance.getMetrics.\n" +
      "Returns: { metrics: { Documents, Nodes, JSHeapUsedSize, LayoutCount, ... } }\n" +
      "When to use: For profiling page performance — memory usage, DOM size, layout thrash, etc.\n" +
      "Pitfalls: Metrics are a point-in-time snapshot. Call before and after an action to measure impact.",
    schema: z.object({}),
    handler: async () => {
      const page = await getActivePage();
      const session = await getCDPSession(page);
      const metrics = await getPerformanceMetrics(session);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ metrics }) }],
      };
    },
  },

  cdp_network_start: {
    description:
      "Start capturing network requests via CDP Network domain.\n" +
      "Returns: { status: 'capturing' }\n" +
      "When to use: Before navigating or triggering actions where you need to inspect network traffic " +
      "(API calls, resource loads, etc.). Call `cdp_network_stop` to retrieve captured requests.\n" +
      "Pitfalls: Only one capture can be active at a time. Starting a new capture stops any existing one. " +
      "Captures are capped at 1000 requests.",
    schema: z.object({}),
    handler: async () => {
      const page = await getActivePage();
      const session = await getCDPSession(page);

      // Stop any existing capture
      if (activeCapture) {
        activeCapture.stop();
        activeCapture = null;
      }

      activeCapture = await startNetworkCapture(session);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ status: "capturing" }) },
        ],
      };
    },
  },

  cdp_network_stop: {
    description:
      "Stop network capture and return captured requests.\n" +
      "Returns: { requests: [{ url, method, type, status?, statusText? }], count }\n" +
      "When to use: After navigating or performing actions to inspect what network requests were made.\n" +
      "Pitfalls: Must call `cdp_network_start` first. Optional `url_pattern` filters results by regex.",
    schema: z.object({
      url_pattern: z
        .string()
        .optional()
        .describe("Optional regex pattern to filter captured requests by URL"),
      include_headers: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, include response headers in each request (default: false to save tokens)"),
    }),
    handler: async ({ url_pattern, include_headers }: { url_pattern?: string; include_headers: boolean }) => {
      if (!activeCapture) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "No active network capture. Call `cdp_network_start` first.",
              }),
            },
          ],
          isError: true,
        };
      }

      activeCapture.stop();
      const requests = url_pattern
        ? activeCapture.getByPattern(url_pattern)
        : activeCapture.getRequests();
      activeCapture = null;

      const concise = include_headers
        ? requests
        : requests.map(({ responseHeaders, ...rest }) => rest);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ requests: concise, count: concise.length }),
          },
        ],
      };
    },
  },
};
