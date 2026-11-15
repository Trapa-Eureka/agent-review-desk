"use client";

import { useEffect, useState } from "react";

declare global {
  interface Window {
    Paddle?: {
      Environment: { set(environment: "sandbox" | "production"): void };
      Initialize(options: { token: string }): void;
    };
  }
}

/**
 * Paddle's "default payment link" lands here with `?_ptxn=<transaction>`. Paddle.js, once initialized, sees that
 * parameter and opens the checkout for that transaction by itself. Only a client-side token is used here: it is
 * public by design. An API key must never appear on a page.
 */
export default function PaddleCheckout({ token, environment }: { token: string; environment: "sandbox" | "production" }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const script = document.createElement("script");
    // Paddle requires loading it from its own CDN, never a copy.
    script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
    script.async = true;
    script.onload = () => {
      try {
        if (environment === "sandbox") window.Paddle?.Environment.set("sandbox");
        window.Paddle?.Initialize({ token });
        setState("ready");
      } catch {
        setState("failed");
      }
    };
    script.onerror = () => setState("failed");
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, [token, environment]);

  return (
    <p className={state === "failed" ? "flash error" : "muted"} role="status">
      {state === "loading" ? "Loading the secure checkout…" : state === "ready" ? "Your checkout opens in a moment. If nothing appears, check that pop-ups and scripts from paddle.com are not blocked." : "The checkout could not be loaded. Try again, or contact support."}
    </p>
  );
}
