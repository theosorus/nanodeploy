import { createServer, request } from "node:http";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";
import { destination, endToEndHeaders } from "./policy.mjs";

export function createProxy() {
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 60_000, headersTimeout: 10_000 }, async (req, res) => {
    let remote;
    req.on("error", () => remote?.destroy());
    res.on("error", () => remote?.destroy());
    try {
      const url = new URL(req.url);
      if (url.protocol !== "http:" || url.username || url.password) throw new Error("invalid proxy URL");
      const target = await destination(url.hostname, Number(url.port || 80));
      remote = request({ hostname: target.address, family: target.family, port: target.port,
        method: req.method, path: url.pathname + url.search,
        headers: { ...endToEndHeaders(req.headers), host: url.host }, agent: false }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, endToEndHeaders(answer.headers));
        answer.on("error", () => res.destroy());
        answer.pipe(res);
      });
      remote.setTimeout(30_000, () => remote.destroy());
      remote.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("upstream unavailable"); });
      req.on("aborted", () => remote.destroy());
      res.on("close", () => remote.destroy());
      req.pipe(remote);
    } catch {
      res.writeHead(403, { "content-type": "text/plain", "connection": "close" });
      res.end("destination refused");
    }
  });
  server.maxConnections = 256;
  const clients = new Map();
  server.on("connection", (socket) => {
    const address = socket.remoteAddress ?? "unknown";
    const count = clients.get(address) ?? 0;
    if (count >= 64) { socket.destroy(); return; }
    clients.set(address, count + 1);
    socket.once("close", () => {
      const remaining = (clients.get(address) ?? 1) - 1;
      if (remaining) clients.set(address, remaining); else clients.delete(address);
    });
  });
  server.on("connect", async (req, client, head) => {
    let upstream;
    client.setTimeout(60_000, () => client.destroy());
    client.on("error", () => upstream?.destroy());
    client.on("close", () => upstream?.destroy());
    try {
      const url = new URL(`http://${req.url}`);
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || Number(url.port) !== 443) throw new Error("invalid CONNECT target");
      const target = await destination(url.hostname, 443);
      if (client.destroyed) return;
      upstream = connect({ host: target.address, family: target.family, port: target.port });
      const timer = setTimeout(() => upstream.destroy(), 10_000);
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => { clearTimeout(timer); client.destroy(); });
      upstream.on("connect", () => {
        clearTimeout(timer);
        if (client.destroyed) { upstream.destroy(); return; }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createProxy().listen(3128, "0.0.0.0", () => console.log("nanodeploy egress on :3128"));
}
