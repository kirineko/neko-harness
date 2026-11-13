import { expect, it } from "bun:test";
import { toStartupError } from "../src/gateway.ts";

const info = (socketPath: string | null) => ({ socketPath, port: 8321, host: "127.0.0.1", serverId: "id" });
const einval = () => Object.assign(new Error("listen EINVAL: invalid argument"), { code: "EINVAL" });

it("explains an over-long Unix socket path instead of surfacing a bare EINVAL", () => {
	const long = `/${"d".repeat(110)}/gateway.sock`;
	const message = toStartupError(einval(), info(long), "darwin").message;
	expect(message).toContain("Unix socket 路径过长");
	expect(message).toContain(long);
	expect(message).toContain("--storage");
	expect(message).toContain("--socket-path");
	expect(message).not.toContain("EADDRINUSE");
});

it("applies the platform limit and leaves unrelated failures untouched", () => {
	const path = `/${"d".repeat(100)}.sock`; // 106 bytes: over the macOS limit, within the Linux one
	expect(toStartupError(einval(), info(path), "darwin").message).toContain("路径过长");
	const linux = einval();
	expect(toStartupError(linux, info(path), "linux")).toBe(linux);
	const short = einval();
	expect(toStartupError(short, info("/tmp/a.sock"), "darwin")).toBe(short);
	const none = einval();
	expect(toStartupError(none, info(null), "darwin")).toBe(none);
	const busy = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
	expect(toStartupError(busy, info(`/${"d".repeat(110)}.sock`), "darwin").message).toContain("EADDRINUSE");
});
