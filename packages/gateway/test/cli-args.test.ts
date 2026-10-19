import { describe, expect, it } from "bun:test";
import { parseGatewayArgs } from "../src/cli-args.ts";

describe("parseGatewayArgs", () => {
	it("parses --no-socket as disabling the Unix transport", () => {
		expect(parseGatewayArgs(["--no-socket"]).socketPath).toBeNull();
	});

	it("keeps socketPath undefined when no socket flag is given", () => {
		expect(parseGatewayArgs([]).socketPath).toBeUndefined();
	});

	it("later --socket-path overrides --no-socket", () => {
		expect(parseGatewayArgs(["--no-socket", "--socket-path", "/tmp/x.sock"]).socketPath).toBe("/tmp/x.sock");
	});

	it("maps --port 0/null to disabled (distinct from API port 0 = random)", () => {
		expect(parseGatewayArgs(["--port", "0"]).port).toBeNull();
		expect(parseGatewayArgs(["--port", "null"]).port).toBeNull();
		expect(parseGatewayArgs(["--port", "8321"]).port).toBe(8321);
	});

	it("parses --stop-on-stdin as a boolean flag", () => {
		expect(parseGatewayArgs(["--stop-on-stdin"]).stopOnStdin).toBe(true);
		expect(parseGatewayArgs([]).stopOnStdin).toBeUndefined();
	});

	it("rejects unknown options and missing values", () => {
		expect(() => parseGatewayArgs(["--bogus"])).toThrow("未知选项");
		expect(() => parseGatewayArgs(["--socket-path"])).toThrow("--socket-path 需要参数");
	});
});
