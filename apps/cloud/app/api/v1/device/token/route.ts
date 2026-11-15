import { pollDeviceLogin } from "@ard/cloud";
import { getCloud } from "../../../../../lib/cloud";
import { api, json, readJson } from "../../../../../lib/http";

export const dynamic = "force-dynamic";

const ERRORS = { pending: "authorization_pending", slow_down: "slow_down", denied: "access_denied", expired: "expired_token", invalid: "invalid_grant" } as const;

/** `ard login` polls here until the person has approved. Error names follow RFC 8628. */
export function POST(request: Request) {
  return api(async () => {
    const cloud = getCloud();
    const body = await readJson(request, 2048);
    const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
    const result = pollDeviceLogin(cloud.control, deviceCode, cloud.control.time());
    if (result.status === "approved") return json({ access_token: result.token, token_type: "Bearer", email: result.user.email });
    return json({ error: ERRORS[result.status] }, 400);
  });
}
