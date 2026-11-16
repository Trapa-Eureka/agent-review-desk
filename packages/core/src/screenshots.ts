import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ScreenshotMediaType } from "@ard/schema";
import { ardDirFor } from "./paths.js";

/**
 * Screenshot storage. Pictures live in `.ard/screenshots/<sha256>` (content-addressed: the same image is stored once),
 * and the event log only points at them.
 *
 * What this module guarantees, because a picture is untrusted input that a browser will later display:
 *  - the type comes from the file's first bytes (PNG, JPEG, GIF, WebP), never from a name, an extension or a claim;
 *    SVG and everything else is refused (SVG can carry script);
 *  - the file name is the hex SHA-256 of the content, and reading accepts nothing but that, so an id can never be a path;
 *  - size is capped, files are written owner-only and atomically (a half-written image is never visible).
 */

export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_RESULT = 10;
const MAX_WALK_DEPTH = 8;
const ID = /^[0-9a-f]{64}$/;

export const isImageId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

/** The image type, judged from the leading bytes, or null for anything that is not a PNG, JPEG, GIF or WebP. */
export function sniffImage(bytes: Uint8Array): ScreenshotMediaType | null {
  const b = bytes;
  const at = (i: number) => b[i] ?? -1;
  if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (b.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return "image/gif";
  if (b.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}

export function screenshotsDirFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(ardDirFor(root, env), "screenshots");
}

export interface SavedScreenshot {
  imageId: string;
  mediaType: ScreenshotMediaType;
  bytes: number;
}

export class ScreenshotError extends Error {}

/** Store an image. Throws ScreenshotError for anything that is not an acceptable image. Storing the same bytes twice is harmless. */
export function saveScreenshot(root: string, data: Uint8Array, env: NodeJS.ProcessEnv = process.env): SavedScreenshot {
  if (data.length === 0) throw new ScreenshotError("the image is empty");
  if (data.length > MAX_SCREENSHOT_BYTES) throw new ScreenshotError(`the image is larger than ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MiB`);
  const mediaType = sniffImage(data);
  if (!mediaType) throw new ScreenshotError("not a PNG, JPEG, GIF or WebP image");
  const imageId = createHash("sha256").update(data).digest("hex");
  const dir = screenshotsDirFor(root, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, imageId);
  if (!existsSync(target)) {
    const temp = join(dir, `.${imageId}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, target);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // best effort
      }
      throw error;
    }
  }
  return { imageId, mediaType, bytes: data.length };
}

export interface StoredScreenshot {
  bytes: Buffer;
  mediaType: ScreenshotMediaType;
}

/** Read a stored image by id. Anything that is not a well-formed id, or whose content does not look like an image, is "not found". */
export function readScreenshot(root: string, imageId: string, env: NodeJS.ProcessEnv = process.env): StoredScreenshot | null {
  if (!isImageId(imageId)) return null;
  const file = join(screenshotsDirFor(root, env), imageId);
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size === 0 || info.size > MAX_SCREENSHOT_BYTES) return null;
    const bytes = readFileSync(file);
    const mediaType = sniffImage(bytes);
    return mediaType ? { bytes, mediaType } : null;
  } catch {
    return null;
  }
}

export interface FoundImage {
  data: Buffer;
  mediaType: ScreenshotMediaType;
}

export interface ExtractedImages {
  images: FoundImage[];
  /** The same value with every image's data replaced by a small placeholder, safe to store as text. */
  stripped: unknown;
}

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function decodeBase64(text: string): Buffer | null {
  const compact = text.replace(/\s+/g, "");
  // Refuse before decoding anything that could not fit under the cap.
  if (compact.length === 0 || compact.length > Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 8 || !BASE64.test(compact)) return null;
  const bytes = Buffer.from(compact, "base64");
  return bytes.length > 0 && bytes.length <= MAX_SCREENSHOT_BYTES ? bytes : null;
}

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Find images inside a tool result and return them together with a copy of the result that no longer carries their data.
 * The shape of results is owned by the agent and not fully documented, so this is deliberately tolerant. It understands:
 *  - MCP content blocks:        { type: "image", data: <base64>, mimeType }
 *  - API-style blocks:           { type: "image", source: { type: "base64", media_type, data: <base64> } }
 *  - Claude Code's Read result:  { type: "image", file: { base64: <base64>, type: "image/png", originalSize, dimensions } }
 *  - a Bash result flagged as an image: { isImage: true, stdout: <base64> }
 * Whatever the block CLAIMS to be, an image is accepted only if its decoded bytes pass `sniffImage`.
 * The stripped copy is produced whether or not the images are kept, so base64 never lands in the event log.
 */
export function extractImages(value: unknown): ExtractedImages {
  const images: FoundImage[] = [];

  const placeholder = (bytes: number | null, mediaType: ScreenshotMediaType | null) => ({ type: "image", omitted: true, ...(mediaType ? { mediaType } : {}), ...(bytes !== null ? { bytes } : {}) });

  const take = (text: unknown): { bytes: number | null; mediaType: ScreenshotMediaType | null } => {
    if (typeof text !== "string") return { bytes: null, mediaType: null };
    const data = decodeBase64(text);
    if (!data) return { bytes: null, mediaType: null };
    const mediaType = sniffImage(data);
    if (mediaType && images.length < MAX_IMAGES_PER_RESULT) images.push({ data, mediaType });
    return { bytes: data.length, mediaType };
  };

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_WALK_DEPTH) return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const obj = asRecord(node);
    if (!obj) return node;

    if (obj.type === "image") {
      const source = asRecord(obj.source);
      const file = asRecord(obj.file); // Claude Code's Read tool on a picture (verified): { type: "image", file: { base64, type, ... } }
      const found = take(source ? source.data : file ? file.base64 : obj.data);
      return placeholder(found.bytes, found.mediaType);
    }
    if (obj.isImage === true && typeof obj.stdout === "string") {
      const found = take(obj.stdout);
      return { ...obj, stdout: `[image omitted${found.bytes !== null ? `: ${found.bytes} bytes` : ""}]` };
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) out[key] = walk(child, depth + 1);
    return out;
  };

  const stripped = walk(value, 0);
  return { images, stripped };
}
