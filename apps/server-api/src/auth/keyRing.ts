import type { Jwk } from "@twobullets/contracts/agent";
import type { JwksKey } from "@twobullets/contracts/rest";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { signJwt } from "./jwt";

// Ed25519 signing keys (platform.md §6.7, ADR 0106). One `active` key signs; `retired` keys stay published in the JWKS
// until pruned, so tokens signed before a rotation keep verifying. The file holds private keys: mode 0600, never
// committed, never baked into an image.
//
// Rotation: `rotate` → new active key, old one retired (match processes get the new JWKS over IPC at once) →
// wait at least ACCESS_TOKEN_TTL_SEC → `prune`.

export interface StoredKey {
  readonly kid: string;
  readonly status: "active" | "retired";
  /** Epoch ms. */
  readonly createdAt: number;
  readonly retiredAt?: number;
  readonly privateKeyPem: string;
}

export interface KeyFile {
  readonly version: 1;
  readonly keys: readonly StoredKey[];
}

interface LoadedKey {
  readonly stored: StoredKey;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly jwk: JwksKey;
}

function newKid(nowMs: number): string {
  return `${new Date(nowMs).toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
}

export function generateStoredKey(nowMs: number): StoredKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { kid: newKid(nowMs), status: "active", createdAt: nowMs, privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

function load(stored: StoredKey): LoadedKey {
  const privateKey = createPrivateKey(stored.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`key ${stored.kid} is not Ed25519`);
  const publicKey = createPublicKey(privateKey);
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { stored, privateKey, publicKey, jwk: { kty: "OKP", crv: "Ed25519", x, kid: stored.kid, alg: "EdDSA", use: "sig" } };
}

export class KeyRing {
  private keys: LoadedKey[] = [];
  private active!: LoadedKey;

  constructor(file: KeyFile) {
    this.replace(file);
  }

  static generate(nowMs = Date.now()): KeyRing {
    return new KeyRing({ version: 1, keys: [generateStoredKey(nowMs)] });
  }

  /** Swaps in a new key file (SIGHUP reload); throws and keeps the old keys when the file is invalid. */
  replace(file: KeyFile): void {
    if (file?.version !== 1 || !Array.isArray(file.keys)) throw new Error("key file: expected { version: 1, keys: [...] }");
    const loaded = file.keys.map(load);
    const active = loaded.filter((k) => k.stored.status === "active");
    if (active.length !== 1) throw new Error(`key file: exactly one active key required, found ${active.length}`);
    if (new Set(loaded.map((k) => k.stored.kid)).size !== loaded.length) throw new Error("key file: duplicate kid");
    this.keys = loaded;
    this.active = active[0]!;
  }

  get activeKid(): string {
    return this.active.stored.kid;
  }

  sign(payload: object): string {
    return signJwt(payload, this.active.stored.kid, this.active.privateKey);
  }

  publicKey(kid: string): KeyObject | undefined {
    return this.keys.find((k) => k.stored.kid === kid)?.publicKey;
  }

  jwks(): { keys: JwksKey[] } {
    return { keys: this.keys.map((k) => k.jwk) };
  }

  /** The JWKS in the agent IPC shape (`AgentToMatch` `jwks`). */
  agentJwks(): Jwk[] {
    return this.keys.map((k) => ({ ...k.jwk }));
  }

  toFile(): KeyFile {
    return { version: 1, keys: this.keys.map((k) => k.stored) };
  }

  /** New active key; the previous active key is retired (still verifies). Returns the new kid. */
  rotate(nowMs = Date.now()): string {
    const next = generateStoredKey(nowMs);
    const keys = this.keys.map((k) => (k.stored.status === "active" ? { ...k.stored, status: "retired" as const, retiredAt: nowMs } : k.stored));
    this.replace({ version: 1, keys: [...keys, next] });
    return next.kid;
  }

  /** Drops retired keys retired at least `minAgeMs` ago. Returns the removed kids. */
  prune(minAgeMs: number, nowMs = Date.now()): string[] {
    const removed = this.keys.filter((k) => k.stored.status === "retired" && nowMs - (k.stored.retiredAt ?? k.stored.createdAt) >= minAgeMs);
    if (removed.length === 0) return [];
    this.replace({ version: 1, keys: this.keys.filter((k) => !removed.includes(k)).map((k) => k.stored) });
    return removed.map((k) => k.stored.kid);
  }
}

export function readKeyFile(path: string): KeyFile | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as KeyFile;
}

/** Atomic write with 0600 permissions. */
export function writeKeyFile(path: string, file: KeyFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
