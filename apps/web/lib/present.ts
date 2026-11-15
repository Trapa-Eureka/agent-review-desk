/** Small formatting helpers for the pages. */

export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour12: false });
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { hour12: false, dateStyle: "medium", timeStyle: "medium" });
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** A path with the user's home folder shortened, so long absolute paths stay readable. */
export function tidyPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}
