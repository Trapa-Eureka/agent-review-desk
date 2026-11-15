/**
 * Is this state-changing request one that OUR OWN pages made? (CSRF defence, on top of SameSite cookies.)
 *
 * Browsers set `Sec-Fetch-Site` themselves and a web page cannot forge it, so it is the primary signal:
 *   same-origin  -> our own page            -> allowed
 *   none         -> the person typed it / used a bookmark -> allowed
 *   same-site / cross-site -> another page  -> refused
 *
 * `Origin` alone is NOT enough. With `Referrer-Policy: no-referrer` (which we send), browsers put `Origin: null` on
 * same-site form posts, so an exact-match rule on Origin locks out the site's own forms. Origin is the fallback for
 * clients that do not send Sec-Fetch-Site (non-browser tools): it must then match exactly.
 */
export function isSameOriginRequest(headers: { get(name: string): string | null }, expectedOrigin: string): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = headers.get("origin");
  return origin !== null && origin === expectedOrigin;
}
