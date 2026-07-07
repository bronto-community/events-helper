import { promises as fs } from "node:fs";
import path from "node:path";
import { get, list, put } from "@vercel/blob";

/**
 * A tiny durable key-value store for data that must outlive a single session:
 * the user's interest profile and any custom / discovered feed sources.
 *
 * Backend selection:
 *  - If BLOB_READ_WRITE_TOKEN is set, values are stored as *private* Vercel Blob
 *    objects (one JSON blob per key). Private access means the data is not
 *    reachable via a public URL, and authenticated reads are consistent right
 *    after a write. Provision a Blob store in the Vercel dashboard (Storage →
 *    Blob); the token lands in the project env as BLOB_READ_WRITE_TOKEN.
 *  - Otherwise it falls back to a local JSON file so `eve dev` works without any
 *    external service configured.
 *
 * Values are JSON-serialized blobs keyed by a stable string. Keys become blob
 * pathnames, so they may contain "/".
 */

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const usingBlob = Boolean(BLOB_TOKEN);

const LOCAL_FILE = path.join(process.cwd(), ".events-helper-store.json");

async function blobGet(key: string): Promise<string | null> {
  const result = await get(key, { access: "private", token: BLOB_TOKEN });
  if (!result || result.statusCode !== 200) return null;
  return new Response(result.stream).text();
}

async function blobSet(key: string, value: string): Promise<void> {
  await put(key, value, {
    access: "private",
    token: BLOB_TOKEN,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

async function localReadAll(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(LOCAL_FILE, "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function localGet(key: string): Promise<string | null> {
  const all = await localReadAll();
  return all[key] ?? null;
}

async function localSet(key: string, value: string): Promise<void> {
  const all = await localReadAll();
  all[key] = value;
  await fs.writeFile(LOCAL_FILE, JSON.stringify(all, null, 2), "utf8");
}

/** Read and parse a JSON value, returning `fallback` when the key is unset. */
export async function read<T>(key: string, fallback: T): Promise<T> {
  const raw = usingBlob ? await blobGet(key) : await localGet(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Serialize and persist a JSON value under `key`. */
export async function write<T>(key: string, value: T): Promise<void> {
  const raw = JSON.stringify(value);
  if (usingBlob) await blobSet(key, raw);
  else await localSet(key, raw);
}

/** List all keys under a prefix (e.g. to enumerate per-user records). */
export async function listKeys(prefix: string): Promise<string[]> {
  if (usingBlob) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, token: BLOB_TOKEN, limit: 1000 });
      for (const b of page.blobs) keys.push(b.pathname);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
  const all = await localReadAll();
  return Object.keys(all).filter((k) => k.startsWith(prefix));
}

/** Which backend is active — surfaced to the user so persistence is never a mystery. */
export const backend = usingBlob ? "vercel-blob" : "local-file";
