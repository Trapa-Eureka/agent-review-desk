import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SCREENSHOT_BYTES, ScreenshotError, extractImages, isImageId, readScreenshot, saveScreenshot, screenshotsDirFor, sniffImage } from "./screenshots.js";

// Tiny byte strings that start like real images (only the leading bytes matter to the checks).
const png = (extra = 8) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10, 1)]);
const gif = () => Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(10, 2)]);
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP"), Buffer.alloc(8, 3)]);
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const b64 = (b: Buffer) => b.toString("base64");

function project() {
  const root = mkdtempSync(join(tmpdir(), "ard-shot-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the image type comes from the first bytes: PNG, JPEG, GIF and WebP are accepted, SVG and everything else is not", () => {
  assert.equal(sniffImage(png()), "image/png");
  assert.equal(sniffImage(jpeg()), "image/jpeg");
  assert.equal(sniffImage(gif()), "image/gif");
  assert.equal(sniffImage(webp()), "image/webp");
  for (const bad of [svg(), Buffer.from("<html><script>x</script></html>"), Buffer.from("%PDF-1.7"), Buffer.alloc(0), Buffer.from([0x89, 0x50]), Buffer.from("GIF90a"), Buffer.from("RIFF1234WAVE")]) assert.equal(sniffImage(bad), null);
});

test("saving stores the image owner-only under its SHA-256, once, and reading gives the same bytes back", () => {
  const p = project();
  try {
    const first = saveScreenshot(p.root, png(100), {});
    assert.match(first.imageId, /^[0-9a-f]{64}$/);
    assert.deepEqual([first.mediaType, first.bytes], ["image/png", 108]);
    const again = saveScreenshot(p.root, png(100), {});
    assert.equal(again.imageId, first.imageId, "the same bytes are the same image");
    const dir = screenshotsDirFor(p.root, {});
    assert.deepEqual(readdirSync(dir), [first.imageId], "stored once, and no temporary file is left behind");
    assert.equal(statSync(dir).mode & 0o077, 0, "folder is private");
    assert.equal(statSync(join(dir, first.imageId)).mode & 0o077, 0, "file is private");
    const read = readScreenshot(p.root, first.imageId, {});
    assert.equal(read?.mediaType, "image/png");
    assert.ok(read?.bytes.equals(png(100)));
  } finally {
    p.cleanup();
  }
});

test("saving refuses empty data, oversized data and anything that is not a raster image", () => {
  const p = project();
  try {
    assert.throws(() => saveScreenshot(p.root, Buffer.alloc(0), {}), ScreenshotError);
    assert.throws(() => saveScreenshot(p.root, svg(), {}), /not a PNG, JPEG, GIF or WebP/);
    assert.throws(() => saveScreenshot(p.root, Buffer.from("MZ executable"), {}), ScreenshotError);
    assert.throws(() => saveScreenshot(p.root, Buffer.concat([png(), Buffer.alloc(MAX_SCREENSHOT_BYTES)]), {}), /larger than/);
    assert.equal(readdirSync(p.root).includes(".ard"), false, "nothing was written for a refused image");
  } finally {
    p.cleanup();
  }
});

test("ATTACK: an image id can only ever be 64 hex characters, so it can never be a path", () => {
  const p = project();
  try {
    const saved = saveScreenshot(p.root, png(), {});
    writeFileSync(join(p.root, "secret.txt"), "top secret");
    for (const id of ["../../secret.txt", `../${saved.imageId}`, `${saved.imageId}/..`, `${saved.imageId}\u0000`, saved.imageId.toUpperCase(), saved.imageId.slice(1), `${saved.imageId}0`, "", "/etc/passwd", "..%2f..%2fsecret.txt"]) {
      assert.equal(isImageId(id), false, JSON.stringify(id));
      assert.equal(readScreenshot(p.root, id, {}), null, JSON.stringify(id));
    }
    assert.ok(readScreenshot(p.root, saved.imageId, {}));
  } finally {
    p.cleanup();
  }
});

test("a stored file that is not an image (planted or corrupted) is 'not found', even under a valid-looking id", () => {
  const p = project();
  try {
    const dir = screenshotsDirFor(p.root, {});
    mkdirSync(dir, { recursive: true });
    const id = "c".repeat(64);
    writeFileSync(join(dir, id), svg());
    assert.equal(readScreenshot(p.root, id, {}), null, "content that is not a raster image is never served");
    const link = "d".repeat(64);
    writeFileSync(join(p.root, "elsewhere"), png());
    symlinkSync(join(p.root, "elsewhere"), join(dir, link));
    // A symlink pointing at an image still reads as that image; what matters is that the type is re-checked on every read.
    assert.equal(readScreenshot(p.root, link, {})?.mediaType, "image/png");
    assert.equal(readScreenshot(p.root, "e".repeat(64), {}), null, "missing file");
  } finally {
    p.cleanup();
  }
});

test("extractImages understands MCP blocks, API-style blocks and a Bash image result, and strips the data from the copy", () => {
  const a = png(20);
  const b = jpeg();
  const c = webp();
  const result = {
    content: [
      { type: "text", text: "Took a screenshot" },
      { type: "image", data: b64(a), mimeType: "image/png" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(b) } },
    ],
    nested: { deeper: [{ type: "image", data: b64(c) }] },
    isError: false,
  };
  const { images, stripped } = extractImages(result);
  assert.deepEqual(images.map((i) => i.mediaType), ["image/png", "image/jpeg", "image/webp"]);
  assert.ok(images[0]!.data.equals(a));
  const text = JSON.stringify(stripped);
  for (const needle of [b64(a), b64(b), b64(c)]) assert.equal(text.includes(needle), false, "base64 must not survive");
  assert.match(text, /"omitted":true/);
  assert.match(text, /Took a screenshot/, "ordinary content is kept");

  const bash = extractImages({ isImage: true, stdout: b64(png()), stderr: "" });
  assert.equal(bash.images.length, 1);
  assert.equal(JSON.stringify(bash.stripped).includes(b64(png())), false);
});

test("the REAL result of Claude Code's Read tool on a picture ({ type, file: { base64 } }, verified on 2.1.325) is captured, and its data is stripped", () => {
  const a = png(40);
  const real = { type: "image", file: { base64: b64(a), type: "image/png", originalSize: a.length, dimensions: { originalWidth: 996, originalHeight: 473, displayWidth: 996, displayHeight: 473 } } };
  const { images, stripped } = extractImages(real);
  assert.equal(images.length, 1);
  assert.equal(images[0]!.mediaType, "image/png");
  assert.ok(images[0]!.data.equals(a));
  assert.equal(JSON.stringify(stripped).includes(b64(a)), false, "base64 must not survive");
  assert.deepEqual(stripped, { type: "image", omitted: true, mediaType: "image/png", bytes: a.length });
  // the same shape with something that is not a raster picture: not accepted (its claim of image/png does not count), still stripped
  const evil = extractImages({ type: "image", file: { base64: b64(svg()), type: "image/png" } });
  assert.equal(evil.images.length, 0);
  assert.equal(JSON.stringify(evil.stripped).includes(b64(svg())), false);
});

test("the REAL result of a Claude in Chrome screenshot (a top-level array with a base64 image block, verified on Claude Code 2.1.325) is captured", () => {
  const a = jpeg();
  const real = [
    { type: "text", text: "Successfully captured screenshot (1568x774, jpeg) - ID: ss_1" },
    { type: "text", text: "\n\nTab Context:\n- Executed on tabId: 1" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(a) } },
  ];
  const { images, stripped } = extractImages(real);
  assert.deepEqual(images.map((i) => i.mediaType), ["image/jpeg"]);
  assert.ok(images[0]!.data.equals(a));
  assert.equal(JSON.stringify(stripped).includes(b64(a)), false, "base64 must not survive");
  assert.match(JSON.stringify(stripped), /Successfully captured screenshot/, "the text blocks are kept");
});

test("ATTACK: a block that CLAIMS to be a PNG but is an SVG, HTML or garbage is not accepted as an image (but its data is still stripped)", () => {
  for (const evil of [svg(), Buffer.from("<html>x</html>"), Buffer.from("not an image at all")]) {
    const { images, stripped } = extractImages({ content: [{ type: "image", data: b64(evil), mimeType: "image/png" }] });
    assert.equal(images.length, 0);
    assert.equal(JSON.stringify(stripped).includes(b64(evil)), false);
  }
  // not base64 at all, and non-string data
  assert.equal(extractImages({ type: "image", data: "<script>alert(1)</script>" }).images.length, 0);
  assert.equal(extractImages({ type: "image", data: 42 }).images.length, 0);
  assert.equal(extractImages({ type: "image" }).images.length, 0);
});

test("extractImages is safe on odd input and keeps the number of images bounded", () => {
  for (const v of [undefined, null, 5, "text", [], {}, [[[]]]]) assert.deepEqual(extractImages(v).images, []);
  const many = { content: Array.from({ length: 25 }, (_, i) => ({ type: "image", data: b64(png(i + 1)) })) };
  assert.equal(extractImages(many).images.length, 10, "capped per tool result");
  // too large to decode: skipped, not decoded
  const huge = "A".repeat(Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 100);
  assert.equal(extractImages({ type: "image", data: huge }).images.length, 0);
  // a very deep structure does not blow the stack
  let deep: unknown = { type: "image", data: b64(png()) };
  for (let i = 0; i < 5000; i++) deep = { x: deep };
  assert.doesNotThrow(() => extractImages(deep));
});
