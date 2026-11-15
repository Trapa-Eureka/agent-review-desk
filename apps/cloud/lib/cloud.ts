import { createCloud, loadCloudConfig, type Cloud } from "@ard/cloud";

const KEY = Symbol.for("ard.cloud.instance");

/**
 * The one running server state (databases, providers, rate limiters), built on first use and kept for the life of the
 * process. Throws `CloudConfigError` with every problem listed if the environment is wrong: the layout shows that
 * to the operator instead of a blank error page.
 */
export function getCloud(): Cloud {
  if (process.env.ARD_UNRELEASED_CLOUD !== "1") throw new Error("The team workspace server is not available yet.");
  const holder = globalThis as unknown as Record<symbol, Cloud | undefined>;
  let cloud = holder[KEY];
  if (!cloud) {
    cloud = createCloud(loadCloudConfig(process.env), process.env);
    for (const warning of cloud.warnings) console.warn(`[ard-cloud] ${warning}`);
    holder[KEY] = cloud;
  }
  return cloud;
}

export const absolute = (cloud: Cloud, path: string): string => `${cloud.config.baseUrl}${path}`;
