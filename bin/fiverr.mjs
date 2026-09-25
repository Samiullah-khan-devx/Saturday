#!/usr/bin/env node
// Backwards-compat shim — renamed to `saturday`.
process.stderr.write("Note: `fiverr` was renamed to `saturday`. Forwarding…\n");
await import("./saturday.mjs");
