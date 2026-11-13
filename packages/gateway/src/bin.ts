#!/usr/bin/env node

import { silenceSqliteWarning } from "@neko-harness/core/runtime-warnings";

// Published gateway entry. Bundled dependencies load before any entry code, so the warning filter has to be
// installed here, ahead of the real entry.
silenceSqliteWarning();
// A computed specifier keeps the gateway bundle out of this launcher.
await import(new URL(process.env.NEKO_RELEASE_BUILD === "1" ? "./gateway-main.js" : "./main.ts", import.meta.url).href);
