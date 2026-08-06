/**
 * Shared PKCE and loopback plumbing for the OAuth logins in the action layer. The browser
 * sends the authorization code to a short-lived server on 127.0.0.1, so no code and no token
 * ever travels through a hosted redirect.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { LocalActionError } from "./macos";

export type PkcePair = {
  verifier: string;
  challenge: string;
  state: string;
};

function base64Url(value: Buffer) {
  return value.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(48));
  return {
    verifier,
    challenge: base64Url(createHash("sha256").update(verifier).digest()),
    state: base64Url(randomBytes(16)),
  };
}

export function safeEquals(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function callbackPage(title: string, message: string) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title>`
    + "<style>body{background:#090508;color:#f6e9f1;font-family:-apple-system,system-ui,sans-serif;"
    + "display:flex;align-items:center;justify-content:center;height:100vh;margin:0}"
    + "main{text-align:center;max-width:32rem;padding:2rem}h1{font-size:1.25rem;letter-spacing:.08em;text-transform:uppercase}"
    + "p{opacity:.75;line-height:1.6}</style></head>"
    + `<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

/**
 * Listens on the loopback port until the provider redirects back. Everything other than
 * `/callback` is refused, so a stray request cannot drive the exchange.
 */
export async function startCallbackServer(port: number, handle: (url: URL) => Promise<string>) {
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname !== "/callback") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }
    void handle(requestUrl).then((page) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(page);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  }).catch(() => {
    throw new LocalActionError(
      `Der Anmeldeport ${port} ist belegt. Schließe das andere Programm und versuche es erneut.`,
      503,
    );
  });

  return server;
}
