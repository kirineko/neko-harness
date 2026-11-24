import "./support/lang-en.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { NekoMcpServer, NekoMcpState } from "@neko-harness/gateway";
import { expect, it } from "vitest";
import { PickerPanel } from "../src/components/picker.ts";
import { ToolExecutionComponent } from "../src/components/tool-execution.ts";
import { helpLines } from "../src/help-ui.ts";
import { commands } from "../src/labels.ts";
import { mcpItems, openMcpPanel, runMcpSubcommand } from "../src/mcp-ui.ts";
import { setActiveTheme } from "../src/theme/index.ts";
import { createFakeWatchable } from "./support/fake-watchable.ts";

setActiveTheme("light");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (panel: PickerPanel) => panel.render(100).map(stripTerminalSequences).join("\n");

function makeServer(overrides: Partial<NekoMcpServer> = {}): NekoMcpServer {
	return {
		name: "docs",
		transport: "stdio",
		enabled: true,
		exposure: "auto",
		config: { transport: "stdio", command: "npx", args: ["-y", "docs"] },
		status: "connected",
		error: null,
		stderrTail: "",
		tools: [{ name: "search", registeredName: "mcp__docs__search", description: "Search docs", readOnly: true }],
		oauth: { supported: false, signedIn: false },
		...overrides,
	};
}

function makeState(overrides: Partial<NekoMcpState> = {}): NekoMcpState {
	return {
		revision: 1,
		configPath: "/tmp/mcp.json",
		configError: null,
		entryErrors: [],
		rawJson: "{}",
		servers: [makeServer()],
		signIns: [],
		...overrides,
	};
}

function fakeClient(initial: NekoMcpState) {
	const snapshot = createFakeWatchable(initial);
	const calls: unknown[] = [];
	const client = {
		mcp: {
			snapshot: snapshot.watchable,
			setEnabled: async (input: { name: string; enabled: boolean }) => {
				calls.push({ op: "setEnabled", ...input });
				return snapshot.watchable.value;
			},
			reconnect: async (input: { name: string }) => {
				calls.push({ op: "reconnect", ...input });
				return snapshot.watchable.value;
			},
			beginSignIn: async (input: { server: string }) => {
				calls.push({ op: "beginSignIn", ...input });
				return { status: "redirect" as const, id: "flow-1", authorizationUrl: "https://auth.example/go" };
			},
			pasteSignIn: async (input: { id: string; redirectUrl: string }) => {
				calls.push({ op: "pasteSignIn", ...input });
				return snapshot.watchable.value;
			},
			cancelSignIn: async (input: { id: string }) => {
				calls.push({ op: "cancelSignIn", ...input });
				return snapshot.watchable.value;
			},
			signOut: async (input: { server: string }) => {
				calls.push({ op: "signOut", ...input });
				return snapshot.watchable.value;
			},
		},
	};
	return {
		client: client as never,
		calls,
		setValue: (v: NekoMcpState | undefined) => snapshot.setValue(v),
		publish: (v: NekoMcpState) => snapshot.publish(v),
	};
}

const panelFor = () =>
	new PickerPanel(
		() => {},
		() => {},
	);

it("registers /mcp command, help section, and maps MCP items", () => {
	expect(commands().map((c) => c.name)).toContain("mcp");
	expect(helpLines().map(stripTerminalSequences).join("\n")).toContain("/mcp paste <url>");
	const items = mcpItems(makeState());
	expect(items).toHaveLength(1);
	expect(items[0]!.label).toContain("docs");
	expect(items[0]!.rightLabel).toContain("Connected");
	expect(items[0]!.rightLabel).toContain("1 tools");
	expect(mcpItems(undefined)).toEqual([]);
});

it("disables actions before snapshot arrives and supports toggle, reconnect, OAuth sign-in, paste, and sign-out", async () => {
	const missingFake = fakeClient(makeState());
	missingFake.setValue(undefined);
	const missingPanel = panelFor();
	const stopMissing = openMcpPanel(missingPanel, missingFake.client, () => {});
	await tick();
	expect(text(missingPanel)).toContain("MCP state is unavailable");
	missingPanel.handleInput("e");
	expect(missingFake.calls).toEqual([]);
	stopMissing();

	const fake = fakeClient(
		makeState({
			servers: [
				makeServer({
					name: "cloud",
					transport: "http",
					config: { transport: "http", url: "https://mcp.example.com" },
					status: "auth_required",
					oauth: { supported: true, signedIn: false },
				}),
			],
		}),
	);
	const panel = panelFor();
	const notices: string[] = [];
	const opened: string[] = [];
	const stop = openMcpPanel(
		panel,
		fake.client,
		(msg) => notices.push(msg),
		(url) => opened.push(url),
	);
	await tick();
	expect(text(panel)).toContain("cloud");
	expect(text(panel)).toContain("Auth required");

	// Toggle enabled
	panel.handleInput("e");
	await tick();
	expect(fake.calls).toContainEqual({ op: "setEnabled", name: "cloud", enabled: false });

	// Reconnect
	panel.handleInput("r");
	await tick();
	expect(fake.calls).toContainEqual({ op: "reconnect", name: "cloud" });

	// OAuth sign-in
	panel.handleInput("l");
	await tick();
	expect(fake.calls).toContainEqual({ op: "beginSignIn", server: "cloud" });
	expect(opened).toEqual(["https://auth.example/go"]);
	expect(notices.some((n) => n.includes("/mcp paste <url>"))).toBe(true);

	// Subcommand `/mcp paste <url>`
	fake.publish(
		makeState({
			servers: [
				makeServer({
					name: "cloud",
					transport: "http",
					config: { transport: "http", url: "https://mcp.example.com" },
					status: "connected",
					oauth: { supported: true, signedIn: true },
				}),
			],
			signIns: [
				{
					id: "flow-1",
					server: "cloud",
					status: "waiting",
					authorizationUrl: "https://auth.example/go",
					error: null,
				},
			],
		}),
	);
	await runMcpSubcommand("paste http://127.0.0.1:4321/cb?code=1&state=2", fake.client, (m) => notices.push(m));
	expect(fake.calls).toContainEqual({
		op: "pasteSignIn",
		id: "flow-1",
		redirectUrl: "http://127.0.0.1:4321/cb?code=1&state=2",
	});

	// OAuth sign-out
	panel.handleInput("o");
	await tick();
	expect(fake.calls).toContainEqual({ op: "signOut", server: "cloud" });

	stop();
});

it("formats mcp__* and tool_search tool cards cleanly in TUI", () => {
	const mcpCard = new ToolExecutionComponent({
		name: "mcp__github__list_issues",
		summary: 'github / list_issues: {"repo":"neko"}',
		detail: '{"repo":"neko"}',
		phase: "done",
		isError: false,
		output: null,
		result: "2 issues",
		durationMs: 120,
		note: null,
		diff: null,
		diffAdded: null,
		diffRemoved: null,
	});
	const mcpText = mcpCard.render(100).map(stripTerminalSequences).join("\n");
	expect(mcpText).toContain("MCP · github / list_issues");
	expect(mcpText).toContain('{"repo":"neko"}');

	const searchCard = new ToolExecutionComponent({
		name: "tool_search",
		summary: "github issues",
		detail: '{"query":"github issues"}',
		phase: "done",
		isError: false,
		output: null,
		result: "Loaded 1 tool",
		durationMs: 50,
		note: null,
		diff: null,
		diffAdded: null,
		diffRemoved: null,
	});
	const searchText = searchCard.render(100).map(stripTerminalSequences).join("\n");
	expect(searchText).toContain("tool_search");
	expect(searchText).toContain("github issues");
});
