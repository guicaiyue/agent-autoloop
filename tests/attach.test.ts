// Attachments live in an object store, not in the hub: a card carries a link and a channel decides what to do with it.
// Failure modes: a signature that doesn't verify, so every upload is refused with a blank 403; bytes stored somewhere
// other than where the printed link says, so the card points at nothing; the same bytes landing on a new address every
// time, so a resent card is a new object; a refusal read as success; a file larger than a chat app takes being read into
// memory before it's refused.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LARGEST, authorization, objectKey, upload } from "../cli/attach.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-attach-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A stand-in for the object store: it records the requests and answers with whatever the test asks for. */
async function store(status = 200) {
  const seen: { method: string; url: string; headers: import("node:http").IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks) });
      response.statusCode = status;
      response.end(status === 200 ? "" : "AccessDenied");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, endpoint, close: () => server.close() };
}

const settings = (endpoint: string) => ({
  endpoint,
  bucket: "autoloop-attachments",
  accessKey: "AKIDEXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
});

const file = (name: string, bytes: Buffer | string) => {
  const at = join(dir, name);
  writeFileSync(at, bytes);
  return at;
};

test("a signature matches the example AWS documents for the same request", () => {
  // The worked example in AWS's SigV4 documentation: if this drifts, every upload is a 403 with no explanation.
  const { authorization: header } = authorization({
    method: "GET",
    url: new URL("https://example.amazonaws.com/test.txt"),
    headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    payloadHash: sha256(Buffer.alloc(0)),
    accessKey: "AKIDEXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    date: new Date("2015-08-30T12:36:00Z"),
    region: "us-east-1",
    service: "service",
  });
  assert.equal(
    header,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, " +
      "Signature=4fc1674aba671f0161401122f33e4fa60fdfd4a54dda3b1b46723fb6f8e643a6",
  );
});

test("an object goes to the address the printed link names, signed over its own bytes", async () => {
  const s3 = await store();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const at = file("shot.png", png);
  const [url] = await upload([at], settings(s3.endpoint));
  s3.close();

  const [put] = s3.seen;
  assert.equal(put.method, "PUT");
  assert.equal(put.url, new URL(url).pathname, "the object sits exactly where the link says");
  assert.match(put.url!, /^\/autoloop-attachments\/\d{4}-\d\d-\d\d\/[0-9a-f]{11}-shot\.png$/);
  assert.deepEqual(put.body, png, "what was signed is what arrived");
  assert.equal(put.headers["x-amz-content-sha256"], sha256(png));
  assert.equal(put.headers["content-type"], "image/png", "the store keeps a type a channel can go by");
  assert.match(String(put.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3/);
  assert.match(String(put.headers.authorization), /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
  assert.equal(url, `${s3.endpoint}/autoloop-attachments/${put.url!.split("/").slice(2).join("/")}`);
});

test("the link a card carries is the address a phone can open, while the bytes go straight to the store", async () => {
  const s3 = await store();
  const at = file("phone.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 5]));
  const [url] = await upload([at], { ...settings(s3.endpoint), publicUrl: "https://media.example/" });
  s3.close();
  assert.equal(s3.seen.length, 1, "one upload, to the address this network reaches");
  assert.equal(new URL(url).pathname, s3.seen[0].url, "the same object under the name a phone can open");
  assert.match(url, /^https:\/\/media\.example\/autoloop-attachments\/\d{4}-\d\d-\d\d\//);
});

test("the same bytes are put at the same address, so a resent card isn't a new object", async () => {
  const s3 = await store();
  const at = file("same.txt", "一样的");
  const [first] = await upload([at], settings(s3.endpoint));
  const [again] = await upload([at], settings(s3.endpoint));
  s3.close();
  assert.equal(first, again);
  assert.equal(objectKey("same.txt", Buffer.from("一样的")).includes("same.txt"), true);
});

test("a refused upload says so instead of printing a link to nothing", async () => {
  const s3 = await store(403);
  const at = file("denied.png", "x");
  await assert.rejects(() => upload([at], settings(s3.endpoint)), /403/);
  s3.close();
});

test("a file bigger than a chat app takes is refused before it's read", async () => {
  const s3 = await store();
  const at = join(dir, "huge.bin");
  writeFileSync(at, "");
  truncateSync(at, LARGEST + 1);
  await assert.rejects(() => upload([at], settings(s3.endpoint)), /50 MB/);
  assert.deepEqual(s3.seen, [], "nothing was read from the disk or sent");
  s3.close();
});

test("a file that isn't there is named, not swallowed", async () => {
  const s3 = await store();
  await assert.rejects(() => upload([join(dir, "missing.png")], settings(s3.endpoint)), /missing\.png/);
  s3.close();
});
