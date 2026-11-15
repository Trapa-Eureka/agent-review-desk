"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * The one-time link carries the access token in its query string. Once the page has loaded (and the server
 * has turned it into a cookie) remove it from the address bar, so it does not sit in the visible URL, a
 * bookmark, a screenshot or a screen share.
 *
 * It must go through Next's router: the periodic `router.refresh()` re-applies the URL the router believes
 * it is on, so editing `window.history` directly would be undone two seconds later.
 */
export default function StripToken() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  useEffect(() => {
    if (!params.has("token")) return;
    const rest = new URLSearchParams(params.toString());
    rest.delete("token");
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  return null;
}
