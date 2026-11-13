import { afterEach, beforeEach, expect, it } from "vitest";
import {
	chooseTarget,
	fetchOpenSession,
	OPEN_TARGET_KEY,
	type OpenTargetInfo,
	OpenWorkspaceError,
	openWorkspace,
	readStoredTarget,
	writeStoredTarget,
} from "../src/client/lib/open-workspace.ts";

const targets: OpenTargetInfo[] = [
	{ id: "vscode", label: "VS Code", available: true },
	{ id: "file-manager", label: "Finder", available: true },
];

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
const stubFetch = (handler: (input: string, init?: RequestInit) => Response | Promise<Response>) => {
	globalThis.fetch = ((input: string, init?: RequestInit) => Promise.resolve(handler(input, init))) as typeof fetch;
};

const memory = () => {
	const map = new Map<string, string>();
	return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};

beforeEach(() => {
	globalThis.fetch = realFetch;
});

it("defaults to VS Code, remembers the last target and falls back when it is unavailable", () => {
	expect(chooseTarget(targets, undefined)?.id).toBe("vscode");
	expect(chooseTarget(targets, "file-manager")?.id).toBe("file-manager");
	const noCode = [{ ...targets[0]!, available: false }, targets[1]!];
	expect(chooseTarget(noCode, "vscode")?.id).toBe("file-manager");
	expect(
		chooseTarget(
			noCode.map((t) => ({ ...t, available: false })),
			"vscode",
		),
	).toBeUndefined();
});

it("persists the chosen target and ignores invalid stored values", () => {
	const storage = memory();
	expect(readStoredTarget(storage)).toBeUndefined();
	writeStoredTarget("file-manager", storage);
	expect(storage.getItem(OPEN_TARGET_KEY)).toBe("file-manager");
	expect(readStoredTarget(storage)).toBe("file-manager");
	storage.setItem(OPEN_TARGET_KEY, "emacs");
	expect(readStoredTarget(storage)).toBeUndefined();
	expect(
		readStoredTarget({
			getItem: () => {
				throw new Error("denied");
			},
		}),
	).toBeUndefined();
});

it("hides the entry (null session) on a non-local, old or failing server", async () => {
	stubFetch(() => new Response("{}", { status: 403 }));
	expect(await fetchOpenSession()).toBeNull();
	stubFetch(() => new Response("<html>", { status: 200 }));
	expect(await fetchOpenSession()).toBeNull();
	stubFetch(() => new Response(JSON.stringify({ csrf: "x", targets: [{ id: "bogus" }] }), { status: 200 }));
	expect(await fetchOpenSession()).toBeNull();
	globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
	expect(await fetchOpenSession()).toBeNull();
	stubFetch(() => new Response(JSON.stringify({ csrf: "tok", targets }), { status: 200 }));
	expect(await fetchOpenSession()).toEqual({ csrf: "tok", targets });
});

it("posts the target and path with the csrf token", async () => {
	let seen: { url: string; init?: RequestInit } | undefined;
	stubFetch((url, init) => {
		seen = { url, init };
		return new Response('{"opened":true}', { status: 200 });
	});
	await openWorkspace("tok", "vscode", "/w/proj");
	expect(seen?.url).toBe("/api/open");
	expect(seen?.init?.method).toBe("POST");
	expect((seen?.init?.headers as Record<string, string>)["x-neko-csrf"]).toBe("tok");
	expect(JSON.parse(String(seen?.init?.body))).toEqual({ target: "vscode", path: "/w/proj" });
});

it("maps failures to Chinese messages", async () => {
	const fail = async (status: number, body: unknown) => {
		stubFetch(() => new Response(JSON.stringify(body), { status }));
		return openWorkspace("tok", "vscode", "/w").catch((e: unknown) => e);
	};
	const forbidden = await fail(403, { code: "forbidden", message: "x" });
	expect(forbidden).toBeInstanceOf(OpenWorkspaceError);
	expect((forbidden as Error).message).toContain("刷新页面");
	expect(((await fail(400, { code: "invalid_path", message: "x" })) as Error).message).toBe(
		"工作区目录不存在或不可访问",
	);
	expect(((await fail(409, { code: "unavailable", message: "未找到 VS Code" })) as Error).message).toBe(
		"未找到 VS Code",
	);
	expect(((await fail(500, "oops")) as Error).message).toBe("请求失败（500）");
});
