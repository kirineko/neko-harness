import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { handleOpenRequest } from "../src/open-api.ts";
import { OpenError, type OpenService, type OpenTargetId } from "../src/open-target.ts";

const CSRF = "C".repeat(43);
const HOSTS = ["127.0.0.1:8322", "localhost:8322", "[::1]:8322"] as const;
const CONTEXT = { csrf: CSRF, allowedHosts: HOSTS };

function call(input: {
	readonly method?: string;
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly remoteAddress?: string;
	readonly body?: string;
}) {
	const state = { status: 0, text: "" };
	const response = {
		writeHead(code: number) {
			state.status = code;
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
	return { request, response, state };
}

const fakeService = (opened: Array<{ target: OpenTargetId; dir: string }>, failure?: OpenError): OpenService => ({
	targets: () => [
		{ id: "vscode", label: "VS Code", available: true },
		{ id: "file-manager", label: "Finder", available: true },
	],
	open: async (target, dir) => {
		if (failure !== undefined) throw failure;
		opened.push({ target, dir });
	},
});

const goodHeaders = {
	host: "127.0.0.1:8322",
	origin: "http://127.0.0.1:8322",
	"content-type": "application/json",
	"x-neko-csrf": CSRF,
};

describe("open api", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "neko-open-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const post = (body: unknown, overrides: Partial<Parameters<typeof call>[0]> = {}) =>
		call({
			method: "POST",
			url: "/api/open",
			headers: goodHeaders,
			body: typeof body === "string" ? body : JSON.stringify(body),
			...overrides,
		});

	it("ignores other paths", async () => {
		const h = call({ url: "/api/info" });
		expect(await handleOpenRequest(h.request, h.response, CONTEXT, fakeService([]))).toBe(false);
	});

	it("serves the csrf token and targets to a local same-origin page", async () => {
		const h = call({ url: "/api/local/session", headers: { host: "localhost:8322", "sec-fetch-site": "same-origin" } });
		expect(await handleOpenRequest(h.request, h.response, CONTEXT, fakeService([]))).toBe(true);
		expect(h.state.status).toBe(200);
		expect(JSON.parse(h.state.text)).toMatchObject({ csrf: CSRF, targets: [{ id: "vscode" }, { id: "file-manager" }] });
	});

	it("rejects non-loopback peers, foreign hosts, cross-site origins and bad csrf tokens without launching", async () => {
		const opened: Array<{ target: OpenTargetId; dir: string }> = [];
		const service = fakeService(opened);
		const body = { target: "vscode", path: dir };
		const cases = [
			post(body, { remoteAddress: "192.168.1.9" }),
			post(body, { headers: { ...goodHeaders, host: "192.168.1.5:8322" } }),
			post(body, { headers: { ...goodHeaders, origin: "http://evil.example" } }),
			post(body, { headers: { ...goodHeaders, "sec-fetch-site": "cross-site" } }),
			post(body, { headers: { ...goodHeaders, "x-neko-csrf": "wrong" } }),
			call({ url: "/api/local/session", headers: { host: "127.0.0.1:8322" }, remoteAddress: "10.0.0.2" }),
		];
		for (const h of cases) {
			expect(await handleOpenRequest(h.request, h.response, CONTEXT, service)).toBe(true);
			expect(h.state.status).toBe(403);
		}
		expect(opened).toEqual([]);
	});

	it("rejects bad bodies, unknown targets and invalid paths with 4xx", async () => {
		const file = join(dir, "f.txt");
		await writeFile(file, "x");
		const opened: Array<{ target: OpenTargetId; dir: string }> = [];
		const check = async (h: ReturnType<typeof call>, status: number) => {
			await handleOpenRequest(h.request, h.response, CONTEXT, fakeService(opened));
			expect(h.state.status).toBe(status);
		};
		await check(post("{nope"), 400);
		await check(post({ target: "emacs", path: dir }), 400);
		await check(post({ target: "vscode", path: "relative/dir" }), 400);
		await check(post({ target: "vscode", path: join(dir, "missing") }), 400);
		await check(post({ target: "vscode", path: file }), 400);
		await check(post({ target: "vscode", path: `${dir}\n` }), 400);
		await check(post({ target: "vscode" }), 400);
		await check(
			post({ target: "vscode", path: dir }, { headers: { ...goodHeaders, "content-type": "text/plain" } }),
			415,
		);
		await check(post("x".repeat(5000)), 413);
		expect(opened).toEqual([]);
	});

	it("opens an existing directory, resolving symlinks, and passes special characters through", async () => {
		const leaf = process.platform === "win32" ? "a b 'c' & $d" : 'a b "c" & $d';
		const special = join(dir, leaf);
		await mkdir(special, { recursive: true });
		await writeFile(join(special, ".keep"), "");
		const link = join(dir, "link");
		await symlink(special, link, process.platform === "win32" ? "junction" : "dir");
		const opened: Array<{ target: OpenTargetId; dir: string }> = [];
		for (const path of [special, link]) {
			const h = post({ target: "file-manager", path });
			await handleOpenRequest(h.request, h.response, CONTEXT, fakeService(opened));
			expect(h.state.status).toBe(200);
		}
		expect(opened.map((o) => o.target)).toEqual(["file-manager", "file-manager"]);
		expect(new Set(opened.map((o) => o.dir)).size).toBe(1);
		expect(opened[0]?.dir.endsWith(leaf)).toBe(true);
	});

	it("maps unavailable targets to 409 and launch failures to 502", async () => {
		const h1 = post({ target: "vscode", path: dir });
		await handleOpenRequest(
			h1.request,
			h1.response,
			CONTEXT,
			fakeService([], new OpenError("unavailable", "未找到 VS Code")),
		);
		expect(h1.state.status).toBe(409);
		expect(JSON.parse(h1.state.text)).toMatchObject({ code: "unavailable", message: "未找到 VS Code" });
		const h2 = post({ target: "vscode", path: dir });
		await handleOpenRequest(
			h2.request,
			h2.response,
			CONTEXT,
			fakeService([], new OpenError("launch_failed", "启动超时")),
		);
		expect(h2.state.status).toBe(502);
	});
});
