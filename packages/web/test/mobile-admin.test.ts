import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { rm } from "../../../test/temp-dir.ts";
import { type NekoGateway, startGateway } from "../../gateway/src/index.ts";
import { IS_WINDOWS } from "../../gateway/test/helpers.ts";
import {
	GatewayUnsupportedError,
	handleMobileAdminRequest,
	MobileAdminAbortedError,
	type MobileAdminProxyContext,
	MobileAdminTimeoutError,
} from "../src/mobile-admin.ts";
import { type NekoWebServer, startWebServer } from "../src/server.ts";

const CSRF = "C".repeat(43);
const ALLOWED_HOSTS = ["127.0.0.1:8322", "localhost:8322", "[::1]:8322"] as const;

type Harness = {
	readonly request: IncomingMessage;
	readonly response: ServerResponse;
	readonly calls: Array<{ readonly method: string; readonly params: unknown }>;
	status(): number;
	text(): string;
	headers(): Record<string, string>;
};

function harness(input: {
	readonly method?: string;
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly remoteAddress?: string;
	readonly body?: string;
}): Harness {
	const calls: Array<{ method: string; params: unknown }> = [];
	const state = { status: 0, text: "", headers: {} as Record<string, string> };
	const response = {
		get headersSent() {
			return state.status !== 0;
		},
		writeHead(code: number, headers?: Record<string, string>) {
			state.status = code;
			if (headers !== undefined) Object.assign(state.headers, headers);
			return this;
		},
		end(chunk?: string) {
			state.text += chunk ?? "";
		},
	} as unknown as ServerResponse;
	const request = {
		method: input.method ?? "GET",
		url: input.url,
		headers: input.headers ?? {},
		socket: { remoteAddress: input.remoteAddress ?? "127.0.0.1" },
		on(event: string, handler: (chunk?: Buffer) => void) {
			if (input.body !== undefined && event === "data") handler(Buffer.from(input.body, "utf8"));
			if (event === "end") handler();
			return this;
		},
	} as unknown as IncomingMessage;
	return {
		request,
		response,
		calls,
		status: () => state.status,
		text: () => state.text,
		headers: () => state.headers,
	};
}

function context(calls: Harness["calls"], behavior?: "unsupported"): MobileAdminProxyContext {
	return {
		csrf: CSRF,
		allowedHosts: ALLOWED_HOSTS,
		caller: (method, params) => {
			calls.push({ method, params });
			if (behavior === "unsupported") return Promise.reject(new GatewayUnsupportedError());
			return Promise.resolve({ ok: true, method });
		},
	};
}

const VALID_WRITE = {
	method: "POST",
	url: "/api/mobile/enable",
	headers: {
		host: "127.0.0.1:8322",
		origin: "http://127.0.0.1:8322",
		"content-type": "application/json",
		"x-neko-csrf": CSRF,
	},
	body: JSON.stringify({ address: "192.168.1.20" }),
} as const;

describe("mobile admin proxy checks", () => {
	it("passes same-origin writes through to the caller with parsed params", async () => {
		const h = harness(VALID_WRITE);
		expect(await handleMobileAdminRequest(h.request, h.response, context(h.calls))).toBe(true);
		expect(h.status()).toBe(200);
		expect(h.calls).toEqual([{ method: "enable", params: { address: "192.168.1.20" } }]);
		expect(h.headers()["access-control-allow-origin"]).toBeUndefined();
	});

	it("answers 504 for a timed-out gateway call and 503 for one cancelled by shutdown", async () => {
		const failing = (error: Error): MobileAdminProxyContext => ({
			csrf: CSRF,
			allowedHosts: ALLOWED_HOSTS,
			caller: () => Promise.reject(error),
		});
		const timedOut = harness(VALID_WRITE);
		await handleMobileAdminRequest(
			timedOut.request,
			timedOut.response,
			failing(new MobileAdminTimeoutError("enable", 30_000)),
		);
		expect(timedOut.status()).toBe(504);
		expect(JSON.parse(timedOut.text()).code).toBe("gateway_timeout");

		const cancelled = harness(VALID_WRITE);
		await handleMobileAdminRequest(cancelled.request, cancelled.response, failing(new MobileAdminAbortedError()));
		expect(cancelled.status()).toBe(503);

		const session = harness({ method: "GET", url: "/api/mobile/session", headers: { host: "127.0.0.1:8322" } });
		await handleMobileAdminRequest(
			session.request,
			session.response,
			failing(new MobileAdminTimeoutError("state", 10_000)),
		);
		expect(session.status()).toBe(504);
	});

	it("rejects non-loopback peers even when X-Forwarded-For claims loopback", async () => {
		const calls: Harness["calls"] = [];
		const cases: ReadonlyArray<Record<string, string>> = [{}, { "x-forwarded-for": "127.0.0.1" }];
		for (const headers of cases) {
			const h = harness({ ...VALID_WRITE, remoteAddress: "10.0.0.5", headers: { ...VALID_WRITE.headers, ...headers } });
			expect(await handleMobileAdminRequest(h.request, h.response, context(calls))).toBe(true);
			expect(h.status()).toBe(403);
		}
		expect(calls).toEqual([]);
	});

	it("rejects wrong or rebinding-style Host headers before side effects", async () => {
		const calls: Harness["calls"] = [];
		for (const host of [
			"127.0.0.1:9999",
			"localhost",
			"127.0.0.1.attacker.example",
			"localhost.attacker.example:8322",
			"8322",
		]) {
			const h = harness({ ...VALID_WRITE, headers: { ...VALID_WRITE.headers, host } });
			expect(await handleMobileAdminRequest(h.request, h.response, context(calls))).toBe(true);
			expect(h.status()).toBe(403);
		}
		expect(calls).toEqual([]);
	});

	it("rejects cross-origin and cross-site fetch metadata", async () => {
		const calls: Harness["calls"] = [];
		for (const headers of [
			{ ...VALID_WRITE.headers, origin: "http://evil.example" },
			{ ...VALID_WRITE.headers, origin: "https://127.0.0.1:8322" },
			{ ...VALID_WRITE.headers, origin: "http://127.0.0.1:8322", "sec-fetch-site": "cross-site" },
			{ ...VALID_WRITE.headers, "sec-fetch-site": "same-site" },
		]) {
			const h = harness({ ...VALID_WRITE, headers });
			expect(await handleMobileAdminRequest(h.request, h.response, context(calls))).toBe(true);
			expect(h.status()).toBe(403);
		}
		expect(calls).toEqual([]);
	});

	it("rejects missing, wrong, and malformed CSRF tokens before side effects", async () => {
		const calls: Harness["calls"] = [];
		for (const headers of [
			{ host: "127.0.0.1:8322", origin: "http://127.0.0.1:8322", "content-type": "application/json" },
			{ ...VALID_WRITE.headers, "x-neko-csrf": "D".repeat(43) },
			{ ...VALID_WRITE.headers, "x-neko-csrf": "short" },
		]) {
			const h = harness({ ...VALID_WRITE, headers });
			expect(await handleMobileAdminRequest(h.request, h.response, context(calls))).toBe(true);
			expect(h.status()).toBe(403);
		}
		expect(calls).toEqual([]);
	});

	it("rejects non-JSON bodies, oversized bodies, and invalid JSON before side effects", async () => {
		const nonJson = harness({
			...VALID_WRITE,
			headers: { ...VALID_WRITE.headers, "content-type": "text/plain" },
			body: "{}",
		});
		expect(await handleMobileAdminRequest(nonJson.request, nonJson.response, context(nonJson.calls))).toBe(true);
		expect(nonJson.status()).toBe(415);

		const oversized = harness({ ...VALID_WRITE, body: `{"pad":"${"x".repeat(5000)}"}` });
		expect(await handleMobileAdminRequest(oversized.request, oversized.response, context(oversized.calls))).toBe(true);
		expect(oversized.status()).toBe(413);

		const invalid = harness({ ...VALID_WRITE, body: "{ not json" });
		expect(await handleMobileAdminRequest(invalid.request, invalid.response, context(invalid.calls))).toBe(true);
		expect(invalid.status()).toBe(400);
		expect(nonJson.calls.length + oversized.calls.length + invalid.calls.length).toBe(0);
	});

	it("answers session with a csrf token and supported flag", async () => {
		const h = harness({ url: "/api/mobile/session", headers: { host: "127.0.0.1:8322" } });
		expect(await handleMobileAdminRequest(h.request, h.response, context(h.calls))).toBe(true);
		expect(h.status()).toBe(200);
		expect(JSON.parse(h.text())).toEqual({ csrf: CSRF, supported: true });
	});

	it("maps old gateways to supported=false and 501 gateway_unsupported", async () => {
		const session = harness({ url: "/api/mobile/session", headers: { host: "127.0.0.1:8322" } });
		expect(
			await handleMobileAdminRequest(session.request, session.response, context(session.calls, "unsupported")),
		).toBe(true);
		expect(JSON.parse(session.text())).toEqual({ csrf: CSRF, supported: false });

		const state = harness({ url: "/api/mobile/state", headers: { host: "127.0.0.1:8322" } });
		expect(await handleMobileAdminRequest(state.request, state.response, context(state.calls, "unsupported"))).toBe(
			true,
		);
		expect(state.status()).toBe(501);
		expect((JSON.parse(state.text()) as { code: string }).code).toBe("gateway_unsupported");

		const write = harness(VALID_WRITE);
		expect(await handleMobileAdminRequest(write.request, write.response, context(write.calls, "unsupported"))).toBe(
			true,
		);
		expect(write.status()).toBe(501);
	});

	it("returns 404 for unknown mobile routes and ignores non-mobile paths", async () => {
		const unknown = harness({ url: "/api/mobile/whatever", headers: { host: "127.0.0.1:8322" } });
		expect(await handleMobileAdminRequest(unknown.request, unknown.response, context(unknown.calls))).toBe(true);
		expect(unknown.status()).toBe(404);

		const other = harness({ url: "/api/info" });
		expect(await handleMobileAdminRequest(other.request, other.response, context(other.calls))).toBe(false);
		expect(other.status()).toBe(0);
	});
});

async function freePort(): Promise<number> {
	const server: NetServer = createNetServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("no address assigned");
	const { port } = address;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

type RunningPair = { readonly dir: string; readonly gateway: NekoGateway; readonly web: NekoWebServer };

async function startPair(): Promise<RunningPair> {
	const dir = await mkdtemp(join(tmpdir(), "neko-web-mobile-admin-"));
	const serverId = randomUUID();
	await writeFile(join(dir, "gateway-server-id"), `${serverId}\n`, { mode: 0o600 });
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		socketPath: IS_WINDOWS ? null : join(dir, `${serverId}.sock`),
		port: 0,
		serverId,
		mobileNetwork: { wsl: null },
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
	const wsPort = Number(new URL(gateway.wsUrl ?? "ws://127.0.0.1:0").port);
	const web = await startWebServer({
		port: 0,
		staticDir: dir,
		gateway: {
			storagePath: join(dir, "neko.sqlite"),
			serverId,
			...(IS_WINDOWS ? {} : { socketPath: join(dir, `${serverId}.sock`) }),
			port: wsPort,
			spawnTimeoutMs: 5_000,
		},
	});
	return { dir, gateway, web };
}

describe("mobile admin proxy over a live gateway", () => {
	let pair: RunningPair;
	beforeEach(async () => {
		pair = await startPair();
	});
	afterEach(async () => {
		await pair.web.close();
		await pair.gateway.close();
		await rm(pair.dir, { recursive: true, force: true });
	});

	it("serves a session, proxies the full workflow, and never leaks the token", async () => {
		const sessionResponse = await fetch(`${pair.web.url}/api/mobile/session`);
		expect(sessionResponse.status).toBe(200);
		// 管理令牌在首次使用时创建。
		const token = (await readFile(join(pair.dir, "mobile", "admin-token"), "utf8")).trim();
		const info = await fetch(`${pair.web.url}/api/info`);
		expect(info.status).toBe(200);
		expect(await info.text()).not.toContain(token);
		const session = (await sessionResponse.json()) as { csrf: string; supported: boolean };
		expect(session.supported).toBe(true);
		expect(session.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(JSON.stringify(session)).not.toContain(token);

		const headers = {
			origin: pair.web.url,
			"x-neko-csrf": session.csrf,
			"content-type": "application/json",
		};
		const port = await freePort();
		const enabled = await fetch(`${pair.web.url}/api/mobile/enable`, {
			method: "POST",
			headers,
			body: JSON.stringify({ address: "127.0.0.1", port }),
		});
		expect(enabled.status).toBe(200);
		expect(await enabled.json()).toEqual({ status: "listening", address: "127.0.0.1", port });
		expect(pair.gateway.mobile.state).toEqual({ status: "listening", address: "127.0.0.1", port });

		const state = await fetch(`${pair.web.url}/api/mobile/state`);
		expect(state.status).toBe(200);
		const stateBody = (await state.json()) as {
			state: { status: string };
			certificate: { fingerprint: string } | null;
		};
		expect(stateBody.state.status).toBe("listening");
		expect(stateBody.certificate?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

		const pairing = await fetch(`${pair.web.url}/api/mobile/pairing`, { method: "POST", headers, body: "null" });
		expect(pairing.status).toBe(200);
		expect(((await pairing.json()) as { pairingText: string }).pairingText.startsWith("nekopair:1:")).toBe(true);

		const cancelled = await fetch(`${pair.web.url}/api/mobile/pairing/cancel`, {
			method: "POST",
			headers,
			body: "null",
		});
		expect(cancelled.status).toBe(200);
		const disabled = await fetch(`${pair.web.url}/api/mobile/disable`, { method: "POST", headers, body: "null" });
		expect(disabled.status).toBe(200);
		expect(((await disabled.json()) as { status: string }).status).toBe("disabled");
		expect((await fetch(`${pair.web.url}/api/mobile/state`)).status).toBe(200);

		const badCsrf = await fetch(`${pair.web.url}/api/mobile/pairing`, {
			method: "POST",
			headers: { ...headers, "x-neko-csrf": "wrong" },
			body: "null",
		});
		expect(badCsrf.status).toBe(403);
	});

	it("rejects cross-origin writes even with a valid csrf token", async () => {
		const session = (await (await fetch(`${pair.web.url}/api/mobile/session`)).json()) as { csrf: string };
		const response = await fetch(`${pair.web.url}/api/mobile/disable`, {
			method: "POST",
			headers: {
				origin: "http://evil.example",
				"x-neko-csrf": session.csrf,
				"content-type": "application/json",
			},
			body: "null",
		});
		expect(response.status).toBe(403);
		expect(pair.gateway.mobile.state.status).toBe("disabled");
	});
});
