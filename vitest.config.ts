import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources, exactly like `node --conditions=neko-source`.
// Setting conditions replaces Vite's server defaults, so they are listed again after ours.
const conditions = ["neko-source", "module", "node", "development|production"];

export default defineConfig({
	resolve: { conditions },
	ssr: { resolve: { conditions } },
	test: {
		include: ["packages/*/test/**/*.test.{ts,tsx}"],
		environment: "node",
		setupFiles: ["./test/setup.ts"],
		// Many tests rely on process-level state (signals, cwd, child processes), which threads would share.
		pool: "forks",
		// test/temp-dir.ts collects garbage to release SQLite handles before retrying a removal on Windows.
		execArgv: ["--expose-gc"],
		// Node cannot listen on a Unix socket path beyond the OS limit (104 bytes on macOS), and gateway sockets live in
		// the tests' temporary data directories. macOS's per-user tmpdir is ~50 bytes on its own, so use /tmp on POSIX.
		env: process.platform === "win32" ? {} : { TMPDIR: "/tmp" },
	},
});
