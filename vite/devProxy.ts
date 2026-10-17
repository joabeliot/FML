// Dev-only request forwarder for the flow runner.
//
// CORS is a *browser* rule: the target server decides who may read its
// responses, and nothing the page does can grant that. So an in-browser run
// can only call APIs that already allow our origin. Server-to-server has no
// such rule — hence this: the page posts a request description here, the dev
// server performs it with Node's fetch and hands the result back.
//
// **Dev only, on purpose.** `configureServer` runs in `vite dev` and nothing
// else, so the deployed static site never gains a backend (the project's
// standing guardrail). Deployed, the runner calls `fetch` directly and works
// with CORS-permissive APIs only — see src/lib/httpTransport.ts.
//
// If a hosted proxy is ever wanted, this handler is the shape of it — but note
// what it becomes the moment it leaves localhost: a service that sees every
// token and secret a run sends. That's a trust obligation, not a deploy step.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const PROXY_PATH = "/__fml/proxy";

interface ProxyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, payload: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.statusCode = 200;
  res.end(JSON.stringify(payload));
}

export function fmlDevProxy(): Plugin {
  return {
    name: "fml-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(PROXY_PATH, (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          try {
            const spec = JSON.parse(await readBody(req)) as ProxyRequest;
            const target = await fetch(spec.url, {
              method: spec.method,
              headers: spec.headers,
              ...(spec.body === undefined ? {} : { body: spec.body }),
              redirect: "follow",
            });
            const headers: Record<string, string> = {};
            target.headers.forEach((v, k) => {
              headers[k] = v;
            });
            // Always a 200 from the proxy itself — the *target's* status is
            // data, so a 404 upstream never gets confused with a broken proxy.
            // Base64, not text: a body hashed with `body.sha256` must arrive
            // byte-for-byte, and decoding binary as UTF-8 would mangle it.
            const bodyBase64 = Buffer.from(await target.arrayBuffer()).toString("base64");
            send(res, { ok: true, status: target.status, headers, bodyBase64 });
          } catch (err) {
            send(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });
    },
  };
}
