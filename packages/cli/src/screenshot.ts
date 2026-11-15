import { statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ScreenshotEvent } from "@ard/schema";
import { MAX_SCREENSHOT_BYTES, appendEvent, baseFields, eventsPathFor, findProjectRoot, openProject, safeText, saveScreenshot } from "@ard/core";

export interface ScreenshotOptions {
  file: string;
  /** Session to attach to. Default: the most recently active session of this project. */
  session?: string;
  caption?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ScreenshotResult {
  event: ScreenshotEvent;
  /** Where the image is stored. */
  stored: string;
}

const MAX_CAPTION = 300;

/**
 * `ard screenshot <file>`: attach a picture to a session by hand. Works for any agent and does not depend on what the
 * agent's hooks happen to carry. The picture goes through the same checks as any other (type from its bytes, size
 * cap) and stays on this machine.
 */
export function runScreenshot(options: ScreenshotOptions): ScreenshotResult {
  const path = resolve(options.cwd, options.file);
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new Error(`cannot read ${options.file}`);
  }
  if (!info.isFile()) throw new Error(`${options.file} is not a file`);
  if (info.size > MAX_SCREENSHOT_BYTES) throw new Error(`${options.file} is larger than ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MiB`);

  const root = findProjectRoot(options.cwd);
  const { repo } = openProject(root, options.env);
  let session;
  try {
    session = options.session ? repo.getSession(options.session) : repo.listSessions(1)[0] ?? null;
  } finally {
    repo.close();
  }
  if (!session) {
    throw new Error(options.session ? `no session "${options.session}" in this project` : "this project has no recorded session yet; start the agent first, or pass --session <id>");
  }

  const saved = saveScreenshot(root, readFileSync(path), options.env);
  const event: ScreenshotEvent = {
    ...baseFields({ sessionId: session.id, agent: session.agent, cwd: session.cwd, ...(session.wrapperSessionId ? { wrapperSessionId: session.wrapperSessionId } : {}) }),
    type: "screenshot",
    imageId: saved.imageId,
    mediaType: saved.mediaType,
    bytes: saved.bytes,
    source: "manual",
  };
  const caption = options.caption?.trim();
  if (caption) event.caption = safeText(caption, MAX_CAPTION).text;
  appendEvent(eventsPathFor(root, options.env), event);
  return { event, stored: `${root}/.ard/screenshots/${saved.imageId}` };
}
