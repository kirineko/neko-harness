import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayUnsupportedError, mobileAdmin, resetMobileAdminSession } from "../src/client/lib/mobile-admin.ts";

type FetchCall = { readonly url: string; readonly init: RequestInit | undefined };

const originalFetch = globalThis.fetch;

function stubFetch(handler: (call: FetchCall) => { status: number; body: unknown }): FetchCall[] {
	const calls: FetchCall[] = [];
	globalThis.fetch = ((url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const result = handler({ url, init });
		return Promise.resolve(new Response(JSON.stringify(result.body), { status: result.status }));
	}) as typeof fetch;
	return calls;
}

beforeEach(() => resetMobileAdminSession());
afterEach(() => {
	globalThis.fetch = originalFetch;
	resetMobileAdminSession();
});

describe("mobile admin client wrapper", () => {
	it("fetches the session once and sends the csrf header on writes", async () => {
		const calls = stubFetch((call) => {
			if (call.url === "/api/mobile/session") return { status: 200, body: { csrf: "S".repeat(43), supported: true } };
			return { status: 200, body: { status: "listening", address: "192.168.1.20", port: 8323 } };
		});
		await mobileAdmin.enable({ address: "192.168.1.20", port: 8323 });
		await mobileAdmin.state();
		expect(calls.filter((call) => call.url === "/api/mobile/session")).toHaveLength(1);

		const write = calls.find((call) => call.url === "/api/mobile/enable");
		expect(write?.init?.method).toBe("POST");
		const headers = write?.init?.headers as Record<string, string>;
		expect(headers["x-neko-csrf"]).toBe("S".repeat(43));
		expect(headers["content-type"]).toBe("application/json");
		expect(JSON.parse(String(write?.init?.body))).toEqual({ address: "192.168.1.20", port: 8323 });
	});

	it("passes WSL relay fields through and surfaces gateway timeouts", async () => {
		const state = {
			state: {
				status: "listening",
				address: "192.168.31.71",
				port: 8323,
				mode: "wsl-relay",
				bindAddress: "172.24.180.5",
			},
			candidates: ["192.168.31.71"],
			port: 8323,
			certificate: null,
			devices: [],
			lastConnectedAddress: null,
			wsl: { interop: true, error: null },
		};
		stubFetch((call) => {
			if (call.url === "/api/mobile/state") return { status: 200, body: state };
			if (call.url === "/api/mobile/session") return { status: 200, body: { csrf: "S".repeat(43), supported: true } };
			return { status: 504, body: { code: "gateway_timeout", message: "mobile admin call timed out" } };
		});
		expect(await mobileAdmin.state()).toEqual(state as never);
		await expect(mobileAdmin.enable({ address: "192.168.31.71" })).rejects.toThrow("timed out");
	});

	it("maps 501 to gateway_unsupported and keeps server error messages", async () => {
		stubFetch((call) => {
			if (call.url === "/api/mobile/session") return { status: 200, body: { csrf: "S".repeat(43), supported: false } };
			return { status: 501, body: { code: "gateway_unsupported", message: "gateway is too old for mobile admin" } };
		});
		await expect(mobileAdmin.state()).rejects.toBeInstanceOf(GatewayUnsupportedError);
		await expect(mobileAdmin.createPairing()).rejects.toBeInstanceOf(GatewayUnsupportedError);

		resetMobileAdminSession();
		stubFetch((call) => {
			if (call.url === "/api/mobile/session") return { status: 200, body: { csrf: "S".repeat(43), supported: true } };
			return { status: 502, body: { code: "unavailable", message: "mobile listener failed: error" } };
		});
		await expect(mobileAdmin.disable()).rejects.toThrow("mobile listener failed: error");
	});

	it("sends null bodies for nullary writes", async () => {
		const calls = stubFetch((call) => {
			if (call.url === "/api/mobile/session") return { status: 200, body: { csrf: "S".repeat(43), supported: true } };
			return { status: 200, body: { revoked: true } };
		});
		await mobileAdmin.revoke("device-1");
		const write = calls.find((call) => call.url === "/api/mobile/revoke");
		expect(JSON.parse(String(write?.init?.body))).toEqual({ deviceId: "device-1" });
	});

	it("passes through the admin state with lastConnectedAddress", async () => {
		stubFetch((call) => {
			if (call.url === "/api/mobile/session") return { status: 200, body: { csrf: "S".repeat(43), supported: true } };
			return {
				status: 200,
				body: {
					state: { status: "listening", address: "192.168.31.71", port: 8323 },
					candidates: ["192.168.31.71", "198.18.0.1"],
					port: 8323,
					certificate: null,
					devices: [],
					lastConnectedAddress: "192.168.31.71",
				},
			};
		});
		const state = await mobileAdmin.state();
		expect(state.lastConnectedAddress).toBe("192.168.31.71");
		expect(state.candidates).toEqual(["192.168.31.71", "198.18.0.1"]);
	});
});
