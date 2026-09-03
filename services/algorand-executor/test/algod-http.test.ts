import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { BoundedAlgodHttpClient, parseContentLength } from "../src/algod-http.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function endpoint(handler: RequestListener): Promise<URL> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test listener.");
  return new URL(`http://127.0.0.1:${address.port}`);
}

describe("bounded Algod HTTP transport", () => {
  it("streams a chunked response and cancels before buffering beyond 16 MiB", async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let resolveClosed!: (closedEarly: boolean) => void;
    const closed = new Promise<boolean>((resolve) => { resolveClosed = resolve; });
    const baseUrl = await endpoint((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.on("close", () => { resolveClosed(!response.writableEnded); });
      let sent = 0;
      const write = () => {
        if (response.destroyed) return;
        if (sent >= 17 * 1024 * 1024) {
          response.end();
          return;
        }
        sent += chunk.byteLength;
        response.write(chunk);
        setTimeout(write, 1).unref();
      };
      write();
    });
    const client = new BoundedAlgodHttpClient(baseUrl, "", 10_000);

    await expect(client.get("/chunked")).rejects.toThrow(/size limit/u);
    await expect(closed).resolves.toBe(true);
  });

  it("accepts a bounded chunked response", async () => {
    const baseUrl = await endpoint((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from("abc"));
      response.end(Buffer.from("def"));
    });
    const client = new BoundedAlgodHttpClient(baseUrl, "", 1_000, 16);

    await expect(client.get("/bounded")).resolves.toMatchObject({ body: new Uint8Array(Buffer.from("abcdef")) });
  });

  it("rejects negative, fractional, padded, and unsafe Content-Length values", () => {
    for (const value of ["-1", "1.5", " 1", "+1", "01", "9007199254740992"]) {
      expect(() => parseContentLength(value)).toThrow(/invalid Content-Length/u);
    }
    expect(parseContentLength("0")).toBe(0);
    expect(parseContentLength("16")).toBe(16);
  });
});
