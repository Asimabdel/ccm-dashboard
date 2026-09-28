// Practice Fusion FHIR (read-only) — connection pieces.
//
// Practice Fusion's "System / Bulk export" apps sign in with SMART Backend Services: MyPCP signs a
// short-lived JWT with its private key and Practice Fusion checks it against the public key MyPCP
// publishes at /.well-known/jwks.json. The private key is created on the server and never leaves it
// (sealed with secretBox in appSettings). Practice Fusion's API can only be read, never written.
import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { SignJWT, importPKCS8, type JWK } from "jose";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings } from "../drizzle/schema";
import { openSecret, sealSecret } from "./secretBox";
import { WorkspaceError, audit, type WorkspaceActor } from "./workspaceDb";

const KEY_KEY = "pf_fhir_key";
const CONFIG_KEY = "pf_fhir";
const ALG = "RS384";

interface StoredKey { kid: string; publicJwk: JWK; privateEnc: string; createdAt: string }
export interface PfConfig { baseUrl: string; clientId: string; enabled: boolean }
const EMPTY_CONFIG: PfConfig = { baseUrl: "", clientId: "", enabled: false };

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}
async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

/** The signing key; created once, on first use. */
async function ensureKey(): Promise<StoredKey> {
  const existing = await readSetting<StoredKey>(KEY_KEY);
  if (existing) return existing;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = publicKey.export({ format: "jwk" }) as JWK;
  const kid = createHash("sha256").update(`${pub.n}.${pub.e}`).digest("base64url").slice(0, 32);
  const key: StoredKey = {
    kid,
    publicJwk: { kty: "RSA", n: pub.n, e: pub.e, kid, alg: ALG, use: "sig", key_ops: ["verify"] },
    privateEnc: sealSecret(privateKey.export({ format: "pem", type: "pkcs8" }).toString()),
    createdAt: new Date().toISOString(),
  };
  // Two first requests at once: keep whichever landed first.
  await (await db()).insert(appSettings).values({ key: KEY_KEY, value: key }).onDuplicateKeyUpdate({ set: { key: KEY_KEY } });
  return (await readSetting<StoredKey>(KEY_KEY))!;
}

/** Public keys only — served at /.well-known/jwks.json for Practice Fusion to verify MyPCP's sign-in. */
export async function getJwks() {
  const k = await ensureKey();
  return { keys: [k.publicJwk] };
}

/** SMART Backend Services client assertion (RS384, 5 minutes). */
export async function clientAssertion(clientId: string, tokenUrl: string): Promise<string> {
  const k = await ensureKey();
  const pk = await importPKCS8(openSecret(k.privateEnc), ALG);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: k.kid, typ: "JWT" })
    .setIssuer(clientId).setSubject(clientId).setAudience(tokenUrl)
    .setJti(randomUUID()).setIssuedAt().setExpirationTime("5m")
    .sign(pk);
}

export async function getPfConfig(): Promise<PfConfig> {
  return { ...EMPTY_CONFIG, ...((await readSetting<Partial<PfConfig>>(CONFIG_KEY)) ?? {}) };
}

export async function pfStatus(origin: string) {
  const k = await ensureKey();
  const c = await getPfConfig();
  return { jwksUrl: `${origin}/.well-known/jwks.json`, kid: k.kid, keyCreatedAt: k.createdAt, config: c };
}

export async function savePfConfig(actor: WorkspaceActor, input: { baseUrl: string; clientId: string }) {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (baseUrl && !/^https:\/\/[a-z0-9.-]+\.practicefusion\.com\//i.test(`${baseUrl}/`)) {
    throw new WorkspaceError("That doesn't look like a Practice Fusion FHIR address (it should start with https:// and be on practicefusion.com).");
  }
  const next: PfConfig = { ...(await getPfConfig()), baseUrl, clientId: input.clientId.trim() };
  await (await db()).insert(appSettings).values({ key: CONFIG_KEY, value: next, updatedByUserId: actor.id }).onDuplicateKeyUpdate({ set: { value: next, updatedByUserId: actor.id } });
  await audit(actor, "manage_access", { entityType: "integration", description: "Practice Fusion FHIR connection details saved" });
  return next;
}
