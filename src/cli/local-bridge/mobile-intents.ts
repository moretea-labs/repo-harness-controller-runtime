import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Request } from "express";

export type MobileIntentScope =
  | "plugins:read"
  | "jobs:read"
  | "plugin:*:*"
  | `plugin:${string}:*`
  | `plugin:${string}:${string}`;

export interface MobileIntentDevice {
  deviceId: string;
  name: string;
  scopes: string[];
  tokenHash: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  lastSeenAt?: string;
  rateLimitPerMinute: number;
  rateWindowStartedAt?: string;
  rateWindowCount?: number;
  nonces: Record<string, string>;
}

export interface MobileIntentDevicePublic {
  deviceId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  lastSeenAt?: string;
  rateLimitPerMinute: number;
}

interface MobileIntentStore {
  schemaVersion: 1;
  updatedAt: string;
  devices: MobileIntentDevice[];
}

export interface CreatedMobileIntentDevice {
  device: MobileIntentDevicePublic;
  token: string;
  tokenType: "bearer";
  instructions: {
    headers: Record<string, string>;
    endpointPath: "/mobile/intent";
    timestampSkewSeconds: number;
    nonceTtlSeconds: number;
    signaturePayload: "<timestamp>.<nonce>.<raw-json-body>";
  };
}

export interface MobileIntentPrincipal {
  device: MobileIntentDevicePublic;
  deviceId: string;
  scopes: string[];
}

export interface MobileIntentVerification {
  principal: MobileIntentPrincipal;
  signatureVerified: boolean;
}

const CONFIG_PATH = ".repo-harness/mobile-intents.json";
const NONCE_TTL_MS = 10 * 60_000;
const TIMESTAMP_SKEW_MS = 5 * 60_000;
const DEFAULT_RATE_LIMIT = 60;

function now(): string {
  return new Date().toISOString();
}

function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_PATH);
}

function readStore(repoRoot: string): MobileIntentStore {
  const path = configPath(repoRoot);
  if (!existsSync(path)) {
    return { schemaVersion: 1, updatedAt: now(), devices: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<MobileIntentStore>;
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now(),
      devices: Array.isArray(parsed.devices)
        ? parsed.devices.flatMap((entry) => normalizeStoredDevice(entry)).filter(Boolean) as MobileIntentDevice[]
        : [],
    };
  } catch (_error) {
    return { schemaVersion: 1, updatedAt: now(), devices: [] };
  }
}

function writeStore(repoRoot: string, store: MobileIntentStore): MobileIntentStore {
  const path = configPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const next = { ...store, updatedAt: now() };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

function normalizeStoredDevice(value: unknown): MobileIntentDevice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const deviceId = stringValue(raw.deviceId);
  const name = stringValue(raw.name);
  const tokenHash = stringValue(raw.tokenHash);
  if (!deviceId || !name || !tokenHash) return undefined;
  return {
    deviceId,
    name,
    tokenHash,
    scopes: normalizeScopes(raw.scopes),
    createdAt: stringValue(raw.createdAt) ?? now(),
    updatedAt: stringValue(raw.updatedAt) ?? now(),
    revokedAt: stringValue(raw.revokedAt),
    lastSeenAt: stringValue(raw.lastSeenAt),
    rateLimitPerMinute: boundedPositiveInteger(raw.rateLimitPerMinute, DEFAULT_RATE_LIMIT, 1, 600),
    rateWindowStartedAt: stringValue(raw.rateWindowStartedAt),
    rateWindowCount: boundedPositiveInteger(raw.rateWindowCount, 0, 0, 1_000_000),
    nonces: normalizeNonces(raw.nonces),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedPositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(number, max));
}

function normalizeScopes(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const scopes = raw.map((entry) => String(entry).trim()).filter(Boolean);
  const deduped = [...new Set(scopes)];
  return deduped.length > 0 ? deduped : ["plugins:read", "jobs:read"];
}

function normalizeNonces(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const retained: Record<string, string> = {};
  for (const [nonce, seenAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof seenAt === "string" && nonce.length <= 128) retained[nonce] = seenAt;
  }
  return retained;
}

function publicDevice(device: MobileIntentDevice): MobileIntentDevicePublic {
  return {
    deviceId: device.deviceId,
    name: device.name,
    scopes: [...device.scopes],
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    revokedAt: device.revokedAt,
    lastSeenAt: device.lastSeenAt,
    rateLimitPerMinute: device.rateLimitPerMinute,
  };
}

function safeId(value: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return token || `device-${randomBytes(3).toString("hex")}`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf-8");
  const rightBuffer = Buffer.from(right, "utf-8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function tokenFromRequest(request: Request): string | undefined {
  const bearer = request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || request.header("x-repo-harness-mobile-token")?.trim();
}

function rawBodyFromRequest(request: Request): Buffer {
  const maybe = (request as Request & { rawBody?: Buffer }).rawBody;
  return Buffer.isBuffer(maybe) ? maybe : Buffer.from(JSON.stringify(request.body ?? {}), "utf-8");
}

function pruneNonces(device: MobileIntentDevice, referenceTime = Date.now()): void {
  for (const [nonce, seenAt] of Object.entries(device.nonces)) {
    const at = Date.parse(seenAt);
    if (!Number.isFinite(at) || referenceTime - at > NONCE_TTL_MS) delete device.nonces[nonce];
  }
}

function assertFreshTimestamp(timestamp: string | undefined): void {
  if (!timestamp) throw new Error("MOBILE_INTENT_TIMESTAMP_REQUIRED: set x-repo-harness-timestamp");
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new Error("MOBILE_INTENT_TIMESTAMP_INVALID: timestamp must be ISO-8601");
  if (Math.abs(Date.now() - parsed) > TIMESTAMP_SKEW_MS) {
    throw new Error("MOBILE_INTENT_TIMESTAMP_STALE: timestamp is outside the allowed replay window");
  }
}

function assertNonce(device: MobileIntentDevice, nonce: string | undefined): void {
  if (!nonce) throw new Error("MOBILE_INTENT_NONCE_REQUIRED: set x-repo-harness-nonce");
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(nonce)) throw new Error("MOBILE_INTENT_NONCE_INVALID: nonce must be 8-128 safe characters");
  pruneNonces(device);
  if (device.nonces[nonce]) throw new Error("MOBILE_INTENT_REPLAY_DETECTED: nonce was already used");
  device.nonces[nonce] = now();
}

function assertRateLimit(device: MobileIntentDevice): void {
  const current = Date.now();
  const windowStart = Date.parse(device.rateWindowStartedAt ?? "");
  if (!Number.isFinite(windowStart) || current - windowStart >= 60_000) {
    device.rateWindowStartedAt = now();
    device.rateWindowCount = 0;
  }
  device.rateWindowCount = (device.rateWindowCount ?? 0) + 1;
  if (device.rateWindowCount > device.rateLimitPerMinute) {
    throw new Error("MOBILE_INTENT_RATE_LIMITED: device exceeded its per-minute request budget");
  }
}

function verifySignature(request: Request, token: string): { provided: boolean; verified: boolean } {
  const signature = request.header("x-repo-harness-signature")?.trim();
  if (!signature) return { provided: false, verified: false };
  const timestamp = request.header("x-repo-harness-timestamp")?.trim() ?? "";
  const nonce = request.header("x-repo-harness-nonce")?.trim() ?? "";
  const raw = rawBodyFromRequest(request).toString("utf-8");
  const payload = `${timestamp}.${nonce}.${raw}`;
  const hex = createHmac("sha256", token).update(payload).digest("hex");
  const base64url = createHmac("sha256", token).update(payload).digest("base64url");
  return {
    provided: true,
    verified: safeEqual(signature, hex) || safeEqual(signature, base64url) || safeEqual(signature, `sha256=${hex}`),
  };
}

export function listMobileIntentDevices(repoRoot: string): { devices: MobileIntentDevicePublic[] } {
  const store = readStore(repoRoot);
  return { devices: store.devices.map(publicDevice).sort((left, right) => right.createdAt.localeCompare(left.createdAt)) };
}

export function createMobileIntentDevice(
  repoRoot: string,
  input: { name?: string; scopes?: unknown; rateLimitPerMinute?: unknown; deviceId?: string },
): CreatedMobileIntentDevice {
  const store = readStore(repoRoot);
  const baseName = stringValue(input.name) ?? "iPhone Shortcuts";
  const baseId = safeId(stringValue(input.deviceId) ?? baseName);
  let deviceId = baseId;
  for (let index = 2; store.devices.some((entry) => entry.deviceId === deviceId); index += 1) {
    deviceId = `${baseId}-${index}`;
  }
  const token = `rhmi_${randomBytes(32).toString("base64url")}`;
  const at = now();
  const device: MobileIntentDevice = {
    deviceId,
    name: baseName,
    scopes: normalizeScopes(input.scopes),
    tokenHash: tokenHash(token),
    createdAt: at,
    updatedAt: at,
    rateLimitPerMinute: boundedPositiveInteger(input.rateLimitPerMinute, DEFAULT_RATE_LIMIT, 1, 600),
    nonces: {},
  };
  store.devices.push(device);
  writeStore(repoRoot, store);
  return {
    device: publicDevice(device),
    token,
    tokenType: "bearer",
    instructions: {
      headers: {
        authorization: `Bearer ${token}`,
        "x-repo-harness-device-id": deviceId,
        "x-repo-harness-timestamp": "<ISO-8601 timestamp>",
        "x-repo-harness-nonce": "<unique random nonce>",
        "x-repo-harness-signature": "<optional HMAC-SHA256 hex or base64url>",
      },
      endpointPath: "/mobile/intent",
      timestampSkewSeconds: Math.trunc(TIMESTAMP_SKEW_MS / 1000),
      nonceTtlSeconds: Math.trunc(NONCE_TTL_MS / 1000),
      signaturePayload: "<timestamp>.<nonce>.<raw-json-body>",
    },
  };
}

export function revokeMobileIntentDevice(repoRoot: string, deviceId: string): { device: MobileIntentDevicePublic } {
  const store = readStore(repoRoot);
  const device = store.devices.find((entry) => entry.deviceId === deviceId);
  if (!device) throw new Error(`MOBILE_INTENT_DEVICE_NOT_FOUND: ${deviceId}`);
  device.revokedAt = device.revokedAt ?? now();
  device.updatedAt = now();
  writeStore(repoRoot, store);
  return { device: publicDevice(device) };
}

export function verifyMobileIntentRequest(repoRoot: string, request: Request): MobileIntentVerification {
  const deviceId = request.header("x-repo-harness-device-id")?.trim();
  if (!deviceId) throw new Error("MOBILE_INTENT_DEVICE_REQUIRED: set x-repo-harness-device-id");
  const token = tokenFromRequest(request);
  if (!token) throw new Error("MOBILE_INTENT_TOKEN_REQUIRED: provide a bearer token or x-repo-harness-mobile-token");
  assertFreshTimestamp(request.header("x-repo-harness-timestamp")?.trim());

  const store = readStore(repoRoot);
  const device = store.devices.find((entry) => entry.deviceId === deviceId);
  if (!device) throw new Error(`MOBILE_INTENT_DEVICE_NOT_FOUND: ${deviceId}`);
  if (device.revokedAt) throw new Error(`MOBILE_INTENT_DEVICE_REVOKED: ${deviceId}`);
  if (!safeEqual(device.tokenHash, tokenHash(token))) throw new Error("MOBILE_INTENT_TOKEN_INVALID: token does not match device");

  assertNonce(device, request.header("x-repo-harness-nonce")?.trim());
  assertRateLimit(device);
  const signature = verifySignature(request, token);
  if (signature.provided && !signature.verified) throw new Error("MOBILE_INTENT_SIGNATURE_INVALID: x-repo-harness-signature did not match request body");
  device.lastSeenAt = now();
  device.updatedAt = now();
  writeStore(repoRoot, store);
  return {
    principal: {
      device: publicDevice(device),
      deviceId: device.deviceId,
      scopes: [...device.scopes],
    },
    signatureVerified: signature.verified,
  };
}

export function mobileIntentHasScope(scopes: string[], required: string): boolean {
  if (scopes.includes("plugin:*:*")) return true;
  if (required === "plugins:read" || required === "jobs:read") return scopes.includes(required);
  const [kind, pluginId, actionId] = required.split(":");
  if (kind !== "plugin" || !pluginId || !actionId) return scopes.includes(required);
  return scopes.includes(required) || scopes.includes(`plugin:${pluginId}:*`);
}
