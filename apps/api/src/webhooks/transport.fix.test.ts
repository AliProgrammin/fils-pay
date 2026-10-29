/**
 * SSRF: a merchant controls the webhook URL. The real transport must never
 * connect to loopback / private / link-local addresses (by IP literal or by
 * a DNS name that resolves there), and must never follow a redirect.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createFetchTransport } from "./transport.js";
import { validateWebhookUrl } from "./create.js";

async function startServer(handler: (path: string) => { status: number; headers?: Record<string, string> }) {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const { status, headers } = handler(req.url ?? "");
    res.writeHead(status, headers);
    res.end("internal secret data");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { hits, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const send = (transport: ReturnType<typeof createFetchTransport>, url: string) =>
  transport({ url, headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 2000 });

test("default transport refuses loopback, private, link-local and metadata targets", async () => {
  const server = await startServer(() => ({ status: 200 }));
  try {
    const transport = createFetchTransport();
    for (const url of [
      `http://127.0.0.1:${server.port}/hook`,
      `http://localhost:${server.port}/hook`,
      `http://[::1]:${server.port}/hook`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/hook",
      "http://192.168.1.1/hook",
    ]) {
      const result = await send(transport, url);
      assert.equal(result.statusCode, null, `${url} must be blocked`);
      assert.equal(result.body, "");
    }
    assert.equal(server.hits.length, 0, "no request may reach the internal server");
  } finally {
    await server.close();
  }
});

test("redirects are never followed", async () => {
  const target = await startServer(() => ({ status: 200 }));
  const redirector = await startServer(() => ({
    status: 302,
    headers: { location: `http://127.0.0.1:${target.port}/internal` },
  }));
  try {
    // The explicit dev flag allows the local receiver itself; the redirect
    // must still not be followed.
    const transport = createFetchTransport({ allowPrivateNetworks: true });
    const result = await send(transport, `http://127.0.0.1:${redirector.port}/hook`);
    assert.notEqual(result.statusCode, 200);
    assert.equal(redirector.hits.length, 1);
    assert.equal(target.hits.length, 0, "the redirect target must not be called");
  } finally {
    await target.close();
    await redirector.close();
  }
});

test("production registration rejects obvious internal targets (early feedback)", () => {
  for (const url of ["https://localhost/hook", "https://127.0.0.1/hook", "https://169.254.169.254/x", "https://[::1]/x"]) {
    assert.throws(() => validateWebhookUrl(url, { nodeEnv: "production" }), /invalid_url/, url);
  }
  assert.doesNotThrow(() => validateWebhookUrl("https://merchant.example/hook", { nodeEnv: "production" }));
});

test("explicit dev flag still allows a local receiver", async () => {
  const server = await startServer(() => ({ status: 200 }));
  try {
    const result = await send(createFetchTransport({ allowPrivateNetworks: true }), `http://127.0.0.1:${server.port}/hook`);
    assert.equal(result.statusCode, 200);
  } finally {
    await server.close();
  }
});
