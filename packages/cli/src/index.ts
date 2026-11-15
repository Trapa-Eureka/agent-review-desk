#!/usr/bin/env node
import { SCHEMA_VERSION } from "@ard/schema";

// Phase 1: implement `ard init` / `ard hook` / `ard run -- <agent>`
const [command] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  console.log(`ard (agent-review-desk) — schema v${SCHEMA_VERSION}\n\nUsage: ard <command>\n(commands will be added in Phase 1)`);
} else {
  console.error(`Command not implemented yet: ${command}`);
  process.exitCode = 1;
}
