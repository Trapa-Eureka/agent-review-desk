import { CloudError, startDeviceLogin } from "@ard/cloud";
import { getCloud } from "../../../../../lib/cloud";
import { api, clientKey, json } from "../../../../../lib/http";

export const dynamic = "force-dynamic";

/** `ard login` starts here. No credentials needed: it only gets a code for a person to confirm in a browser. */
export function POST(request: Request) {
  return api(() => {
    const cloud = getCloud();
    const hit = cloud.logins.hit(`device-start:${clientKey(request)}`);
    if (!hit.allowed) throw new CloudError("rate_limited", "Too many login attempts. Wait a few minutes.", Math.ceil(hit.retryAfterMs / 1000));
    const start = startDeviceLogin(cloud.control, cloud.config.baseUrl);
    return json({
      device_code: start.deviceCode,
      user_code: start.userCode,
      verification_uri: start.verificationUri,
      verification_uri_complete: start.verificationUriComplete,
      expires_in: start.expiresIn,
      interval: start.interval,
    });
  });
}
