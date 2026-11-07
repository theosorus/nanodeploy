import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { request } from "node:http";
import { connect } from "node:net";
import { publicAddress, destination, endToEndHeaders } from "../../egress/policy.mjs";
import { createProxy } from "../../egress/proxy.mjs";

const server = createProxy();
let port: number;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(resolve); }));

test("egress refuses loopback, LAN, metadata, mapped addresses and non-public IPv6", () => {
  for (const ip of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.1", "192.168.1.1", "100.100.100.200",
    "168.63.129.16", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) {
    assert.equal(publicAddress(ip), false, ip);
  }
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(publicAddress(ip), true, ip);
});

test("mixed DNS answers and private ports fail closed, and accepted addresses are pinned", async () => {
  await assert.rejects(destination("rebinding.invalid", 443, async () => [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }]), /private/);
  await assert.rejects(destination("public.invalid", 2375, async () => [{ address: "1.1.1.1", family: 4 }]), /HTTP/);
  let calls = 0;
  const target = await destination("public.invalid", 443, async () => { calls++; return [{ address: "1.1.1.1", family: 4 }]; });
  assert.equal(calls, 1);
  assert.deepEqual(target, { address: "1.1.1.1", family: 4, port: 443 });
});

test("HTTP proxy requests cannot reach local addresses through alternative URL spellings", async () => {
  for (const path of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://[::ffff:127.0.0.1]/", "file:///etc/passwd", "http://localhost/"]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 403, path);
  }
});

test("CONNECT cannot turn the proxy into an SSH or private-network tunnel", async () => {
  for (const target of ["127.0.0.1:443", "[::1]:443", "1.1.1.1:22", "169.254.169.254:443"]) {
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      socket.on("error", reject);
      socket.once("data", (data) => { resolve(data.toString()); socket.destroy(); });
    });
    assert.match(answer, /^HTTP\/1.1 403/, target);
  }
});

test("proxy credentials and dynamically nominated hop headers never reach the destination", () => {
  assert.deepEqual(endToEndHeaders({ connection: "x-secret", "x-secret": "hidden", "proxy-authorization": "hidden",
    authorization: "app-api-token", host: "example.com" }), { authorization: "app-api-token", host: "example.com" });
});
