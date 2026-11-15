import { getCloud } from "../../../../lib/cloud";
import { api, bearerPrincipal, json } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** `ard logout`: the token used for this request stops working immediately. */
export function POST(request: Request) {
  return api(() => {
    const cloud = getCloud();
    bearerPrincipal(request, cloud);
    const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    cloud.control.revokeApiTokenByPlaintext(token);
    return json({ ok: true });
  });
}
