// Attachments live in an object store, not in the hub: what a card carries is a link, and each channel decides what to do
// with it. This is the half that puts the bytes there and prints the link to paste into a receipt.
import { createHash, createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { readConfig } from "../host/config.ts";

/** What a chat app takes as one file: the Bot API stops at 50 MB, so a bigger attachment can only travel as a link. */
export const LARGEST = 50 * 1024 * 1024;

export type Attachments = {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix?: string;
  /** The address a person's phone can open. Uploading still goes to `endpoint`, which only this network reaches. */
  publicUrl?: string;
};

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** AWS SigV4, the scheme MinIO and S3 both take. `date` is passed in so the signature can be checked against a vector. */
export function authorization(options: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  date: Date;
  region?: string;
  service?: string;
}) {
  const { method, url, headers, payloadHash, accessKey, secretKey, date } = options;
  const region = options.region ?? "us-east-1";
  const service = options.service ?? "s3";
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const canonical = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Every segment is encoded on its own: a slash is a path, not a character of a name.
  const path = url.pathname.split("/").map(encodeURIComponent).join("/");
  const query = [...url.searchParams]
    .map(([name, value]) => [encodeURIComponent(name), encodeURIComponent(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const request = [
    method,
    path,
    query,
    canonical.map(([name, value]) => `${name}:${value}\n`).join(""),
    canonical.map(([name]) => name).join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(Buffer.from(request, "utf8"))].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${canonical
      .map(([name]) => name)
      .join(";")}, Signature=${signature}`,
    amzDate: stamp,
  };
}

/** Where the bytes go: the digest names them, so the same file twice is the same address and a card can be resent. */
export function objectKey(name: string, bytes: Buffer, day = new Date().toISOString().slice(0, 10)) {
  const safe =
    basename(name)
      .replace(/[^\w.-]+/g, "_")
      .slice(-60) || "file";
  return `${day}/${hex(bytes).slice(0, 11)}-${safe}`;
}

const complete = (value: Partial<Attachments> | undefined): value is Attachments =>
  !!value && (["endpoint", "bucket", "accessKey", "secretKey"] as const).every((name) => !!value[name]);

function settings(given?: Partial<Attachments>): Attachments {
  if (complete(given)) return given;
  const config = { ...(readConfig().attachments as Partial<Attachments> | undefined), ...given };
  const missing = (["endpoint", "bucket", "accessKey", "secretKey"] as const).filter((name) => !config[name]);
  if (missing.length)
    throw new Error(
      `没有对象存储的设置：config.json 里加 "attachments": { "endpoint": "http://192.168.1.4:19000", ` +
        `"bucket": "autoloop-attachments", "accessKey": "…", "secretKey": "…" }（缺 ${missing.join("、")}）`,
    );
  return config as Attachments;
}

/** Puts each file in the store and answers with the link a card would carry, in the order given. */
export async function upload(files: string[], given?: Partial<Attachments>, prefix?: string) {
  const config = settings(given);
  const base = config.endpoint.replace(/\/+$/, "");
  const urls: string[] = [];
  for (const file of files) {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      throw new Error(`没有这个文件：${file}`);
    }
    if (size > LARGEST)
      throw new Error(`${file} 有 ${Math.round(size / 1024 / 1024)} MB，超过 50 MB，发出去也只能给个链接`);
    const bytes = readFileSync(file);
    const key = [prefix ?? config.prefix, objectKey(file, bytes)].filter(Boolean).join("/");
    const url = new URL(`${base}/${config.bucket}/${key}`);
    const date = new Date();
    const headers: Record<string, string> = {
      host: url.host,
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "x-amz-content-sha256": hex(bytes),
      "x-amz-date": date
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, ""),
    };
    const { authorization: signed } = authorization({
      method: "PUT",
      url,
      headers,
      payloadHash: headers["x-amz-content-sha256"],
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      date,
    });
    headers.authorization = signed;
    const sent = await fetch(url, { method: "PUT", headers, body: bytes });
    if (!sent.ok) throw new Error(`上传 ${file} 失败：${sent.status} ${(await sent.text()).slice(0, 200)}`);
    // What goes into the card has to open on a phone, which is rarely on this network: the public address if there is one.
    const shown = config.publicUrl ? `${config.publicUrl.replace(/\/+$/, "")}/${config.bucket}/${key}` : url.toString();
    urls.push(shown);
  }
  return urls;
}
