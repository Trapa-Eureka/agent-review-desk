/**
 * The address our own reverse proxy saw: `hops` entries from the RIGHT of X-Forwarded-For. Each proxy appends the
 * address of whoever connected to it, so everything LEFT of our proxy's entry was written by the client and means nothing.
 * Fewer entries than hops (or none) means the header did not come through our proxy: answer "direct".
 */
export function forwardedClient(header: string | null, hops: number): string {
  const parts = (header ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!Number.isInteger(hops) || hops < 1 || parts.length < hops) return "direct";
  return parts[parts.length - hops] ?? "direct";
}
