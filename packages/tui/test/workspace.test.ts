import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import type { NekoTuiGateway } from "../src/gateway.ts";
import { initialSessionId } from "../src/tui.ts";
import { workspaceSessions } from "../src/workspace.ts";

it("filters by exact workspace and orders recent sessions deterministically", () => {
	expect(
		workspaceSessions(
			[
				{
					id: "1",
					workspaceRoot: "/a",
					lastUsedAt: 5,
					createdAt: 5,
					lastMessageAt: null,
					title: "",
					firstPromptPreview: "",
					model: null,
					status: "idle",
				},
				{
					id: "2",
					workspaceRoot: "/b",
					lastUsedAt: 10,
					createdAt: 10,
					lastMessageAt: null,
					title: "",
					firstPromptPreview: "",
					model: null,
					status: "idle",
				},
				{
					id: "3",
					workspaceRoot: "/a",
					lastUsedAt: 5,
					createdAt: 5,
					lastMessageAt: null,
					title: "",
					firstPromptPreview: "",
					model: null,
					status: "idle",
				},
				{
					id: "4",
					workspaceRoot: "/a/sub",
					lastUsedAt: 20,
					createdAt: 20,
					lastMessageAt: null,
					title: "",
					firstPromptPreview: "",
					model: null,
					status: "idle",
				},
			],
			"/a",
		).map((s) => s.id),
	).toEqual(["3", "1"]);
});
it("creates in the caller workspace only when no session matches", async () => {
	let cwd: string | undefined;
	const gateway = {
		client: {
			directory: {
				state: {
					value: {
						sessions: [
							{
								id: "1",
								workspaceRoot: "/a",
								lastUsedAt: 5,
								createdAt: 5,
								lastMessageAt: null,
								title: "",
								firstPromptPreview: "",
								model: null,
								status: "idle",
							},
						],
					},
				},
			},
			management: {
				create: async (options: { cwd?: string }) => {
					cwd = options.cwd;
					return { id: "2" };
				},
			},
		},
	} as unknown as NekoTuiGateway;
	expect(await initialSessionId(gateway, "/a")).toBe("1");
	expect(cwd).toBeUndefined();
	expect(await initialSessionId(gateway, "/b")).toBe("2");
	expect(cwd).toBe("/b");
});
