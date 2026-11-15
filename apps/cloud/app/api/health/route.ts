import { getCloud } from "../../../lib/cloud";
import { json } from "../../../lib/http";

export const dynamic = "force-dynamic";

/** For load balancers and uptime checks. Reveals nothing about configuration. */
export function GET() {
  try {
    getCloud().control.db.prepare("SELECT 1").get();
    return json({ ok: true });
  } catch {
    return json({ ok: false }, 503);
  }
}
