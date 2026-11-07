import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Keep the families separate: Node treats IPv4 addresses as IPv4-mapped IPv6
// internally, so blocking ::ffff:0:0/96 in the IPv4 list would block all IPv4.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["168.63.129.16", 32],
]) blockedV4.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blockedV6.addSubnet(ip, bits, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const cached = new Map();
const pending = new Map();

async function resolve(host) {
  const saved = cached.get(host);
  if (saved && saved.until > Date.now()) return saved.addresses;
  if (pending.has(host)) return pending.get(host);
  if (pending.size >= 32) throw new Error("DNS resolver busy");
  const job = lookup(host, { all: true, verbatim: true }).then((addresses) => {
    if (cached.size >= 2000) cached.delete(cached.keys().next().value);
    cached.set(host, { addresses, until: Date.now() + 60_000 });
    return addresses;
  }).finally(() => pending.delete(host));
  pending.set(host, job);
  return job;
}

export function publicAddress(address) {
  const family = isIP(address);
  try {
    if (family === 4) return !blockedV4.check(address, "ipv4");
    if (family === 6) return globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
  } catch { /* invalid or scoped address */ }
  return false;
}

export async function destination(hostname, port, resolver = lookup) {
  if (port !== 80 && port !== 443) throw new Error("only public HTTP and HTTPS destinations are allowed");
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host.length > 253) throw new Error("invalid host");
  const addresses = resolver === lookup ? await resolve(host) : await resolver(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error("private destination refused");
  // Connect to this exact numeric address. Never resolve again after checking
  // it, and reject mixed public/private answers to close DNS rebinding paths.
  const chosen = addresses.find(({ family }) => family === 4) ?? addresses[0];
  return { address: chosen.address, family: chosen.family, port };
}

const hop = ["connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"];
export function endToEndHeaders(headers) {
  const clean = { ...headers };
  const listed = String(headers.connection ?? "").toLowerCase().split(",").map((h) => h.trim());
  for (const name of [...hop, ...listed]) delete clean[name];
  return clean;
}
