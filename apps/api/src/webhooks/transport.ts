import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** Addresses a webhook must never reach: loopback, private, CGNAT,
 *  link-local (incl. cloud metadata 169.254.169.254), multicast, reserved. */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family === 6) return BLOCKED.check(address, "ipv6");
  return true;
}

/** dns.lookup wrapper used as the socket's `lookup`: the address is checked
 *  at connect time, on the exact IP the socket uses, so a DNS answer that
 *  changes between a check and the connect (rebinding) cannot slip through. */
function guardedLookup(hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void): void {
  lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    const blocked = addresses.find((a) => isBlockedAddress(a.address));
    if (blocked || addresses.length === 0) {
      return callback(new Error(`webhook target ${hostname} resolves to a blocked address`));
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

/** Only this much of a response is read; the delivery log keeps 2000 chars. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface FetchTransportOptions {
  /** Dev/test only: allow loopback/private targets (a local receiver).
   *  Wired from config.webhookAllowPrivateTargets, which is never true in
   *  production. */
  allowPrivateNetworks?: boolean;
}

/** Real transport, used by index.ts's production wiring. Plain node:http(s)
 *  so that (a) redirects are never followed (a 3xx is just a non-2xx
 *  failure), (b) every connect goes through guardedLookup (SSRF), and (c) the
 *  response read is bounded. The timeout covers the whole exchange. */
export function createFetchTransport(options: FetchTransportOptions = {}): WebhookTransport {
  return (req: WebhookTransportRequest): Promise<WebhookTransportResponse> =>
    new Promise((resolve) => {
      const fail = (message: string): void => resolve({ statusCode: null, body: "", errorMessage: message });
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return fail("invalid_url");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return fail("invalid_url");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      // Node skips `lookup` for IP literals, so check those directly.
      if (!options.allowPrivateNetworks && isIP(host) && isBlockedAddress(host)) {
        return fail(`webhook target ${host} is a blocked address`);
      }

      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "POST",
        headers: { ...req.headers, "Content-Length": Buffer.byteLength(req.body) },
        ...(options.allowPrivateNetworks ? {} : { lookup: guardedLookup as never }),
      });
      const timer = setTimeout(() => request.destroy(new Error("timeout")), req.timeoutMs);
      request.on("error", (err) => {
        clearTimeout(timer);
        fail(err.message);
      });
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = (): void => {
          clearTimeout(timer);
          resolve({ statusCode: response.statusCode ?? null, body: Buffer.concat(chunks).toString("utf8") });
        };
        response.on("data", (chunk: Buffer) => {
          if (size >= MAX_RESPONSE_BYTES) return;
          chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size));
          size += chunk.length;
          if (size >= MAX_RESPONSE_BYTES) {
            response.destroy();
            finish();
          }
        });
        response.on("end", finish);
        response.on("error", (err) => {
          clearTimeout(timer);
          fail(err.message);
        });
      });
      request.end(req.body);
    });
}
