// A tiny local API + web page for the CLI and end-to-end tests — so they
// never depend on the internet, httpbin or jsonplaceholder being up.
//
//   POST /login       {"password":"hunter2-secret"} → 200 {token, user}; else 401
//   GET  /me          Authorization: Bearer <token> → 200 {id, name, echo:<token>}; else 401
//   GET  /items       → 200 [{id:1},{id:2}]
//   GET  /form        an HTML form (name, email) posting to /submit
//   POST /submit      an HTML page echoing what was submitted
//   GET  /openapi.json  a spec that matches the routes above (no /items)
//
// `hits` counts requests per "METHOD /path", so a test can prove a --dry run
// sent nothing.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const PASSWORD = "hunter2-secret";
export const TOKEN = "tok-SECRET-abcdef123";

export interface Fixture {
  url: string;
  hits: Map<string, number>;
  close(): Promise<void>;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

export const SPEC = {
  openapi: "3.0.3",
  paths: {
    "/login": { post: { responses: { "200": {}, "401": {} } } },
    "/me": { get: { responses: { "200": {}, "401": {} } } },
  },
};

export async function startFixture(): Promise<Fixture> {
  const hits = new Map<string, number>();
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const key = `${req.method} ${path}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(data));
    };
    const html = (markup: string) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><head><title>Fixture</title></head><body>${markup}</body></html>`);
    };

    if (key === "POST /login") {
      let pw = "";
      try {
        pw = (JSON.parse(await body(req)) as { password?: string }).password ?? "";
      } catch {
        /* not JSON */
      }
      return pw === PASSWORD ? json(200, { token: TOKEN, user: { id: 7, name: "Ada" } }) : json(401, { error: "bad password" });
    }
    if (key === "GET /me") {
      return req.headers.authorization === `Bearer ${TOKEN}`
        ? json(200, { id: 7, name: "Ada", echo: TOKEN })
        : json(401, { error: "no token" });
    }
    if (key === "GET /items") return json(200, [{ id: 1 }, { id: 2 }]);
    if (key === "GET /openapi.json") return json(200, SPEC);
    if (key === "GET /form") {
      return html(
        `<h1>Order</h1><form method="post" action="/submit">` +
          `<input name="custname"><input name="email" data-testid="email"><button type="submit">Send</button></form>`,
      );
    }
    if (key === "POST /submit") {
      const fields = new URLSearchParams(await body(req));
      return html(`<h1 data-testid="thanks">Thanks, ${fields.get("custname") ?? ""}</h1><p class="email">${fields.get("email") ?? ""}</p>`);
    }
    json(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
