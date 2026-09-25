// Encrypts integration credentials (e.g. RingCentral's client secret and JWT) before they
// are stored in the database. AES-256-GCM with a key derived from the server's JWT_SECRET,
// so a database copy alone can't reveal them. If JWT_SECRET ever changes, re-enter them.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { ENV } from "./_core/env";

function key(): Buffer {
  if (!ENV.cookieSecret) throw new Error("JWT_SECRET is not set; can't store integration secrets.");
  return createHash("sha256").update(`mypcp-integrations:v1:${ENV.cookieSecret}`).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
}

export function openSecret(sealed: string): string {
  if (!sealed.startsWith("v1:")) throw new Error("Unknown secret format");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
