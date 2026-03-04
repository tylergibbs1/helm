import type { Page, CDPSession } from "playwright";

const sessionCache = new WeakMap<Page, CDPSession>();

/**
 * Get or create a CDP session for the given page.
 * Cached via WeakMap so we reuse sessions across calls.
 */
export async function getCDPSession(page: Page): Promise<CDPSession> {
  let session = sessionCache.get(page);
  if (session) {
    try {
      // Verify session is still alive
      await session.send("Runtime.evaluate", { expression: "1" });
      return session;
    } catch {
      sessionCache.delete(page);
    }
  }

  session = await page.context().newCDPSession(page);
  sessionCache.set(page, session);
  return session;
}

/**
 * Evaluate a JS expression via CDP Runtime.evaluate.
 */
export async function runtimeEvaluate(
  session: CDPSession,
  expression: string
): Promise<{ result: any; exceptionDetails?: any }> {
  const response = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return {
    result: response.result?.value,
    exceptionDetails: response.exceptionDetails,
  };
}

/**
 * Get browser performance metrics via CDP Performance.getMetrics.
 */
export async function getPerformanceMetrics(
  session: CDPSession
): Promise<Record<string, number>> {
  await session.send("Performance.enable");
  const { metrics } = await session.send("Performance.getMetrics");
  await session.send("Performance.disable");

  const result: Record<string, number> = {};
  for (const m of metrics) {
    result[m.name] = m.value;
  }
  return result;
}

// ============================================================================
// Network Capture
// ============================================================================

interface CapturedRequest {
  url: string;
  method: string;
  type: string;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  timestamp: number;
}

export interface NetworkCaptureHandle {
  stop: () => void;
  getRequests: () => CapturedRequest[];
  getByPattern: (urlPattern: string) => CapturedRequest[];
}

const MAX_CAPTURED_REQUESTS = 1000;

/**
 * Start capturing network requests via CDP Network domain.
 * Returns a handle to stop capture and retrieve requests.
 */
export async function startNetworkCapture(
  session: CDPSession
): Promise<NetworkCaptureHandle> {
  const requests: CapturedRequest[] = [];
  const requestMap = new Map<string, CapturedRequest>();

  const onRequest = (params: any) => {
    const req: CapturedRequest = {
      url: params.request.url,
      method: params.request.method,
      type: params.type || "Other",
      timestamp: params.timestamp,
    };
    requestMap.set(params.requestId, req);
    requests.push(req);

    // Cap at MAX_CAPTURED_REQUESTS — evict oldest
    if (requests.length > MAX_CAPTURED_REQUESTS) {
      const removed = requests.shift()!;
      // Clean up requestMap for the evicted entry
      for (const [id, r] of requestMap) {
        if (r === removed) {
          requestMap.delete(id);
          break;
        }
      }
    }
  };

  const onResponse = (params: any) => {
    const req = requestMap.get(params.requestId);
    if (req) {
      req.status = params.response.status;
      req.statusText = params.response.statusText;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(params.response.headers || {})) {
        headers[k] = String(v);
      }
      req.responseHeaders = headers;
    }
  };

  session.on("Network.requestWillBeSent", onRequest);
  session.on("Network.responseReceived", onResponse);

  await session.send("Network.enable");

  let stopped = false;

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      session.off("Network.requestWillBeSent", onRequest);
      session.off("Network.responseReceived", onResponse);
      session.send("Network.disable").catch(() => {});
    },
    getRequests: () => [...requests],
    getByPattern: (urlPattern: string) => {
      const regex = new RegExp(urlPattern, "i");
      return requests.filter((r) => regex.test(r.url));
    },
  };
}
