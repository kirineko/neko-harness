import { expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "../../../test/temp-dir.ts";
import { browseWorkspaces } from "../src/workspaces.ts";
import { cleanup, connectTestClient, connectTestWsClient, IS_WINDOWS, makeGateway, waitFor } from "./helpers.ts";

it("normalizes leading-slash drive paths before browsing", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "neko-browse-norm-")));
	try {
		await mkdir(join(dir, "sub"));
		if (IS_WINDOWS) {
			// "D:\..." → "/D:\..." / "//D:/..." 均归一化为同一目录。
			const mangled = `/${dir.replace(/^([A-Za-z]:)/, "$1")}`;
			for (const candidate of [mangled, `/${dir}`, `//${dir.replaceAll("\\", "/")}`]) {
				const page = await browseWorkspaces({ path: candidate });
				expect(page.path).toBe(dir);
				expect(page.entries.some((entry) => entry.name === "sub")).toBe(true);
			}
		} else {
			// POSIX 路径不可能命中盘符形态：原样浏览。
			const page = await browseWorkspaces({ path: dir });
			expect(page.path).toBe(dir);
			await expect(browseWorkspaces({ path: "/etc" })).resolves.toBeDefined();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("lists drive letters at the virtual root on Windows, real root elsewhere", async () => {
	const page = await browseWorkspaces({ path: "/" });
	expect(page.parent).toBeNull();
	if (IS_WINDOWS) {
		// 虚拟盘符层：条目形如 C: / C:\，且包含当前盘。
		expect(page.entries.length).toBeGreaterThan(0);
		expect(page.entries.every((entry) => /^[A-Z]:$/.test(entry.name) && /^[A-Z]:\\$/.test(entry.path))).toBe(true);
		const currentDrive = `${process.cwd()[0]}:`;
		expect(page.entries.some((entry) => entry.name === currentDrive)).toBe(true);
		// 盘符条目可继续下钻。
		const driveRoot = page.entries[0]!.path;
		const inner = await browseWorkspaces({ path: driveRoot });
		expect(inner.path).toBe(driveRoot);
	} else {
		// POSIX 的 "/" 仍是真实根目录。
		expect(page.path).toBe("/");
		expect(page.entries.some((entry) => entry.name === "tmp" || entry.name === "private")).toBe(true);
	}
});

// 依赖 POSIX 主机语义：symlink 无需特权、chmod(0) 产生访问错误、存在 / 根目录。
it.skipIf(IS_WINDOWS)(
	"browses host folders with query-bound pagination and explicit inaccessible entries",
	async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "neko-browse-")));
		try {
			await Promise.all(
				Array.from({ length: 105 }, (_, i) => mkdir(join(dir, `folder-${String(i).padStart(3, "0")}`))),
			);
			await mkdir(join(dir, ".hidden"));
			await writeFile(join(dir, "file"), "x");
			await symlink(join(dir, "folder-000"), join(dir, "alias"));
			await symlink(join(dir, "absent"), join(dir, "broken"));
			await mkdir(join(dir, "denied"));
			await chmod(join(dir, "denied"), 0);
			const first = await browseWorkspaces({ path: dir });
			const second = await browseWorkspaces({ path: dir, cursor: first.next! });
			expect(first.entries.length).toBe(100);
			expect([...first.entries, ...second.entries].length).toBe(108);
			expect(first.entries.find((e) => e.name === "broken")?.error).toBeDefined();
			expect(first.entries.find((e) => e.name === "denied")?.error).toBeDefined();
			expect((await browseWorkspaces({ path: dir, query: "hidden", showHidden: true })).entries.length).toBe(1);
			await expect(browseWorkspaces({ path: dir, query: "changed", cursor: first.next! })).rejects.toThrow("分页");
			await expect(browseWorkspaces({ path: join(dir, "file") })).rejects.toThrow();
			await expect(browseWorkspaces({ path: join(dir, "absent") })).rejects.toThrow();
			await expect(browseWorkspaces({ path: join(dir, "denied") })).rejects.toThrow();
			expect((await browseWorkspaces({ path: "/" })).parent).toBeNull();
			expect((await browseWorkspaces({ path: join(dir, "alias") })).path).toBe(join(dir, "folder-000"));
		} finally {
			await chmod(join(dir, "denied"), 0o700).catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	},
);
it("shares independent workspace additions over Unix and WS and keeps them after archive", async () => {
	const target = await makeGateway();
	const unix = await connectTestClient(target);
	const ws = await connectTestWsClient(target);
	try {
		const dir = await realpath(target.dir);
		await unix.workspaces.add({ path: dir });
		await waitFor(
			() => ws.workspaces.state.value?.workspaces.some((w) => w.path === dir) === true,
			"workspace broadcast",
		);
		const session = await ws.management.create({ cwd: dir });
		expect(session.workspaceRoot).toBe(dir);
		await ws.management.archive(session.id);
		expect(unix.workspaces.state.value?.workspaces.some((w) => w.path === dir)).toBe(true);
		expect((await ws.workspaces.browse({ path: dir })).path).toBe(dir);
	} finally {
		await unix.close();
		await ws.close();
		await cleanup(target);
	}
});

it("removes a workspace for every client, hides its sessions and rejects invalid removals", async () => {
	const target = await makeGateway();
	const unix = await connectTestClient(target);
	const ws = await connectTestWsClient(target);
	try {
		const root = await realpath(target.dir);
		const other = join(root, "other");
		await mkdir(other);
		await unix.workspaces.add({ path: root });
		await unix.workspaces.add({ path: other });
		const session = await ws.management.create({ cwd: other });
		await waitFor(
			() => unix.directory.state.value?.sessions.some((s) => s.id === session.id) === true,
			"session listed",
		);

		await expect(unix.workspaces.remove({ path: join(root, "missing") })).rejects.toThrow("WORKSPACE_UNKNOWN:");
		await unix.workspaces.remove({ path: other });
		await waitFor(
			() => ws.workspaces.state.value?.workspaces.some((w) => w.path === other) === false,
			"removal broadcast",
		);
		await waitFor(
			() => unix.directory.state.value?.sessions.every((s) => s.id !== session.id) === true,
			"session hidden",
		);
		await expect(ws.workspaces.remove({ path: other })).rejects.toThrow("WORKSPACE_UNKNOWN:");

		const remaining = ws.workspaces.state.value?.workspaces.map((w) => w.path) ?? [];
		expect(remaining.length).toBeGreaterThan(0);
		for (const path of remaining.slice(1)) await ws.workspaces.remove({ path });
		await waitFor(() => ws.workspaces.state.value?.workspaces.length === 1, "only one workspace left");
		await expect(ws.workspaces.remove({ path: remaining[0]! })).rejects.toThrow("WORKSPACE_LAST:");
		expect(ws.workspaces.state.value?.workspaces.map((w) => w.path)).toEqual([remaining[0]!]);

		await unix.workspaces.add({ path: other });
		await waitFor(
			() => ws.directory.state.value?.sessions.some((s) => s.id === session.id) === true,
			"session restored",
		);
	} finally {
		await unix.close();
		await ws.close();
		await cleanup(target);
	}
});

it("serializes concurrent remove and add of the same workspace", async () => {
	const target = await makeGateway();
	const unix = await connectTestClient(target);
	const ws = await connectTestWsClient(target);
	try {
		const root = await realpath(target.dir);
		const other = join(root, "other");
		await mkdir(other);
		await unix.workspaces.add({ path: other });
		await Promise.allSettled([unix.workspaces.remove({ path: other }), ws.workspaces.add({ path: other })]);
		const paths = (unix.workspaces.state.value?.workspaces ?? []).map((w) => w.path);
		expect(paths.filter((path) => path === other).length).toBeLessThanOrEqual(1);
		await waitFor(
			() =>
				JSON.stringify(ws.workspaces.state.value?.workspaces.map((w) => w.path)) ===
				JSON.stringify(unix.workspaces.state.value?.workspaces.map((w) => w.path)),
			"clients agree",
		);
	} finally {
		await unix.close();
		await ws.close();
		await cleanup(target);
	}
});
