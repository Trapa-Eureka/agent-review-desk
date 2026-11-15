"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server components on a timer so new sessions and approval requests appear without a reload. */
export default function AutoRefresh({ intervalMs = 2000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
