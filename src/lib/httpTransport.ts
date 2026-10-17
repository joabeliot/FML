// The browser's `Transport` for the flow engine.
//
// `src/fml/run.ts` never calls the network itself — it takes one of these. In
// Node that's `fetch` straight out (no same-origin policy, so anything runs).
// In the browser there are two worlds, and the difference is CORS:
//
//   dev   — routed through the Vite dev-server forwarder (vite/devProxy.ts),
//           so any API is reachable while you build.
//   built — direct `fetch`. The deployed site is static, has no backend by
//           design, and therefore can only run flows against APIs that send
//           `Access-Control-Allow-Origin` for our origin. That's not a bug we
//           can fix from here: the permission belongs to the target server.
//           The fixes are (a) allow this origin on your own API, or (b) run it
//           from the CLI — `node scripts/run.ts <file.fml>`.

import type { HttpRequest, HttpResponse, Transport } from "../fml/index.ts";

const PROXY_PATH = "/__fml/proxy";

interface ProxyOk {
  ok: true;
  status: number;
  headers: Record<string, string>;
  /** The raw body, base64 — JSON can't carry bytes, and text decoding is lossy. */
  bodyBase64: string;
}
interface ProxyErr {
  ok: false;
  error: string;
}

/** True when a flow can reach any API; false when only CORS-permissive ones. */
export const canReachAnyApi: boolean = import.meta.env.DEV;

async function viaProxy(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
  const res = await fetch(PROXY_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    ...(signal ? { signal } : {}),
  });
  const payload = (await res.json()) as ProxyOk | ProxyErr;
  if (!payload.ok) throw new Error(payload.error);
  const bytes = Uint8Array.from(atob(payload.bodyBase64), (c) => c.charCodeAt(0));
  return { status: payload.status, headers: payload.headers, body: new TextDecoder().decode(bytes), bytes };
}

async function direct(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: req.body }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    // A CORS refusal reaches JS as an opaque TypeError with no detail — the
    // browser deliberately tells the page nothing. Say what it almost always
    // means rather than surfacing "Failed to fetch" and leaving them guessing.
    if (err instanceof TypeError) {
      throw new Error(
        `could not reach ${new URL(req.url).origin} — most likely CORS: the API has to send Access-Control-Allow-Origin for ${location.origin}. Run it from the CLI (node scripts/run.ts) to bypass this.`,
      );
    }
    throw err;
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers, body: new TextDecoder().decode(bytes), bytes };
}

/** The transport to hand `runFlow` from inside the app. */
export const browserTransport: Transport = (req, signal) =>
  canReachAnyApi ? viaProxy(req, signal) : direct(req, signal);
