#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`ard: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
