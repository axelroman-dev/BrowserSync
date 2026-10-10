import net from "node:net";
import type { Request, Response } from "express";
import { config } from "../config.js";

// The development account (db/devSeed.ts) has public default credentials,
// so it only works when the extension talks to this server on the same
// machine: http://localhost:3000 or similar. Applies to that email whether
// or not DEV_SEED is on, so a seeded account left in a database that later
// gets exposed still can't be used from outside.
//
// "Local" means all of:
// - the TCP peer is loopback or a private address. The real socket address,
//   not req.ip: with "trust proxy" set, req.ip comes from X-Forwarded-For,
//   which a client can write itself. Private ranges are allowed because a
//   docker-compose port mapping makes requests arrive from the bridge
//   gateway (172.x), not 127.0.0.1.
// - the Host header (the server URL the extension was given) is localhost,
//   *.localhost or a loopback IP. Again the raw header, not req.hostname,
//   which honors X-Forwarded-Host.
// - no forwarding headers: a reverse proxy or tunnel in front (Nginx,
//   cloudflared) means the request came from somewhere else.

const localPeers = new net.BlockList();
localPeers.addSubnet("127.0.0.0", 8, "ipv4");
localPeers.addSubnet("10.0.0.0", 8, "ipv4");
localPeers.addSubnet("172.16.0.0", 12, "ipv4");
localPeers.addSubnet("192.168.0.0", 16, "ipv4");
localPeers.addAddress("::1", "ipv6");
localPeers.addSubnet("fc00::", 7, "ipv6");

const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip"];

function isLocalPeer(address: string | undefined) {
  if (!address) return false;
  // IPv4 clients on a dual-stack socket show up as ::ffff:a.b.c.d.
  const ipv4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (net.isIPv4(ipv4)) return localPeers.check(ipv4, "ipv4");
  return net.isIPv6(address) && localPeers.check(address, "ipv6");
}

function isLocalHost(hostHeader: string | undefined) {
  if (!hostHeader) return false;
  // Strip the port: "localhost:3000", "[::1]:3000", "127.0.0.1:3000".
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (net.isIPv4(host)) return host.startsWith("127.");
  return host === "::1";
}

export function isLocalRequest(req: Request) {
  return (
    isLocalPeer(req.socket.remoteAddress) &&
    isLocalHost(req.headers.host) &&
    FORWARDING_HEADERS.every((header) => req.headers[header] === undefined)
  );
}

export function isDevAccountEmail(email: string) {
  return email.trim().toLowerCase() === config.devSeed.email;
}

// Set at startup by db/devSeed.ts, so requireAuth can check access tokens
// without a database lookup.
let devAccountId: string | null = null;

export function setDevAccountId(id: string | null) {
  devAccountId = id;
}

export function isDevAccountId(userId: string) {
  return devAccountId !== null && userId === devAccountId;
}

/** Sends the refusal for the development account used from a non-local server URL. */
export function rejectDevAccount(res: Response) {
  res.status(403).json({
    error: "dev_account_local_only",
    message: `${config.devSeed.email} is a development account and only works with a local server URL (e.g. http://localhost:3000).`,
  });
}
