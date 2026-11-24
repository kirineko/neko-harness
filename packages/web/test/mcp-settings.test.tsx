import { JSDOM } from "jsdom";
import * as React from "react";
import { expect, it, vi } from "vitest";
import type { NekoMcpServer, NekoMcpState } from "../src/client/lib/contract.ts";
import { getState, storeActions } from "../src/client/lib/store.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// jsdom does not implement HTMLDialogElement.showModal/close natively
if (!dom.window.HTMLDialogElement.prototype.showModal) {
	dom.window.HTMLDialogElement.prototype.showModal = function showModal() {
		this.setAttribute("open", "");
	};
	dom.window.HTMLDialogElement.prototype.close = function close() {
		this.removeAttribute("open");
	};
}

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { McpSettingsPanel } = await import("../src/client/components/mcp-settings-panel.tsx");

function makeServer(overrides: Partial<NekoMcpServer> = {}): NekoMcpServer {
	return {
		name: "docs",
		transport: "stdio",
		enabled: true,
		exposure: "auto",
		config: {
			transport: "stdio",
			command: "npx",
			args: ["-y", "@example/docs"],
			env: { API_TOKEN: "plain-secret", PUBLIC_URL: "https://example.com", REF_TOKEN: "${MY_TOKEN}" },
		},
		status: "connected",
		error: null,
		stderrTail: "",
		tools: [
			{
				name: "search",
				registeredName: "mcp__docs__search",
				description: "Search documentation",
				readOnly: true,
			},
		],
		oauth: { supported: false, signedIn: false },
		...overrides,
	};
}

function makeState(overrides: Partial<NekoMcpState> = {}): NekoMcpState {
	return {
		revision: 1,
		configPath: "/home/user/.neko/mcp.json",
		configError: null,
		entryErrors: [],
		rawJson: '{\n  "mcpServers": {}\n}\n',
		servers: [makeServer()],
		signIns: [],
		...overrides,
	};
}

type Props = React.ComponentProps<typeof McpSettingsPanel>;

function makeActions(): Props["actions"] {
	const base = makeState();
	return {
		upsertServer: vi.fn(async () => base),
		removeServer: vi.fn(async () => base),
		setEnabled: vi.fn(async () => base),
		saveRawConfig: vi.fn(async () => base),
		reconnect: vi.fn(async () => base),
		beginSignIn: vi.fn(async () => ({
			status: "redirect" as const,
			id: "signin-1",
			authorizationUrl: "https://auth.example.com/authorize?state=abc",
		})),
		pasteSignIn: vi.fn(async () => base),
		cancelSignIn: vi.fn(async () => base),
		signOut: vi.fn(async () => base),
	};
}

async function mount(props: Props) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(React.createElement(McpSettingsPanel, props)));
	return {
		host,
		rerender: (next: Props) => act(async () => root.render(React.createElement(McpSettingsPanel, next))),
		unmount: () => {
			act(() => root.unmount());
			host.remove();
		},
	};
}

it("renders loading when state is null and disables controls when gateway is not ready", async () => {
	const actions = makeActions();
	const view = await mount({ state: null, ready: false, actions });
	expect(view.host.textContent).toContain("读取中");
	expect(view.host.querySelector("button")).toBeNull();

	await view.rerender({ state: makeState(), ready: false, actions });
	expect(view.host.textContent).toContain("网关未就绪");
	const checkbox = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
	expect(checkbox.disabled).toBe(true);
	await view.unmount();
});

it("renders server cards, expands tools, toggles enablement, reconnects, and masks secrets in edit modal", async () => {
	const actions = makeActions();
	const view = await mount({ state: makeState(), ready: true, actions });

	expect(view.host.textContent).toContain("docs");
	expect(view.host.textContent).toContain("已连接");
	expect(view.host.textContent).toContain("1 个工具");

	// Expand tools
	const toolsBtn = [...view.host.querySelectorAll("button")].find((b) => b.textContent?.includes("1 个工具"))!;
	await act(async () => toolsBtn.click());
	expect(view.host.textContent).toContain("Search documentation");
	expect(view.host.textContent).toContain("只读");

	// Toggle enabled
	const checkbox = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
	await act(async () => checkbox.click());
	expect(actions.setEnabled).toHaveBeenCalledWith("docs", false);

	// Reconnect
	const reconnectBtn = [...view.host.querySelectorAll("button")].find((b) => b.textContent === "重连")!;
	await act(async () => reconnectBtn.click());
	expect(actions.reconnect).toHaveBeenCalledWith("docs");

	// Open Edit modal and verify secret masking vs ${VAR}
	const editBtn = [...view.host.querySelectorAll("button")].find((b) => b.textContent === "编辑")!;
	await act(async () => editBtn.click());
	const dialog = document.querySelector("dialog")!;
	expect(dialog).not.toBeNull();
	const valueInputs = [...dialog.querySelectorAll<HTMLInputElement>('input[placeholder*="ENV_VAR"]')];
	const secretInput = valueInputs.find((i) => i.value === "plain-secret")!;
	const envTemplateInput = valueInputs.find((i) => i.value === "${MY_TOKEN}")!;
	expect(secretInput.type).toBe("password");
	expect(envTemplateInput.type).toBe("text");

	await view.unmount();
});

it("handles raw mcp.json editing, preserves draft on validation error, and supports OAuth flows", async () => {
	const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
	try {
		const actions = makeActions();
		actions.saveRawConfig = vi.fn(async () => {
			throw new Error("Invalid JSON syntax");
		});
		const remoteServer = makeServer({
			name: "cloud",
			transport: "http",
			config: { transport: "http", url: "https://mcp.example.com" },
			status: "auth_required",
			oauth: { supported: true, signedIn: false },
		});
		const view = await mount({
			state: makeState({
				servers: [remoteServer],
				signIns: [],
			}),
			ready: true,
			actions,
		});

		// Begin OAuth sign-in opens popup tab
		const signInBtn = [...view.host.querySelectorAll("button")].find((b) => b.textContent?.includes("OAuth 登录"))!;
		await act(async () => signInBtn.click());
		expect(actions.beginSignIn).toHaveBeenCalledWith("cloud");
		expect(openSpy).toHaveBeenCalledWith(
			"https://auth.example.com/authorize?state=abc",
			"_blank",
			"noopener,noreferrer",
		);

		// Render active waiting sign-in flow and paste redirect URL
		await view.rerender({
			state: makeState({
				servers: [remoteServer],
				signIns: [
					{
						id: "signin-1",
						server: "cloud",
						status: "waiting",
						authorizationUrl: "https://auth.example.com/authorize?state=abc",
						error: null,
					},
				],
			}),
			ready: true,
			actions,
		});
		const pasteInput = view.host.querySelector<HTMLInputElement>('input[type="url"]')!;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
			setter.call(pasteInput, "http://127.0.0.1:4321/callback?code=c1&state=abc");
			pasteInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		const submitUrlBtn = [...view.host.querySelectorAll("button")].find((b) => b.textContent === "提交回调 URL")!;
		await act(async () => submitUrlBtn.click());
		expect(actions.pasteSignIn).toHaveBeenCalledWith("signin-1", "http://127.0.0.1:4321/callback?code=c1&state=abc");

		// Switch to raw mcp.json tab and verify draft stays on error
		const rawTab = [...view.host.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes("mcp.json"))!;
		await act(async () => (rawTab as HTMLButtonElement).click());
		const textarea = view.host.querySelector<HTMLTextAreaElement>("#mcp-raw-json")!;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
			setter.call(textarea, "{ broken");
			textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		const saveRawBtn = [...view.host.querySelectorAll("button")].find((b) => b.textContent === "保存 mcp.json")!;
		await act(async () => saveRawBtn.click());
		expect(actions.saveRawConfig).toHaveBeenCalledWith("{ broken");
		expect(textarea.value).toBe("{ broken");
		expect(view.host.textContent).toContain("Invalid JSON syntax");

		await view.unmount();
	} finally {
		openSpy.mockRestore();
	}
});

it("hides OAuth controls on public unauthenticated HTTP servers and shows compact controls only when relevant", async () => {
	const actions = makeActions();
	const publicHttp = makeServer({
		name: "docs-public",
		transport: "http",
		config: { transport: "http", url: "https://docs.example.com/mcp" },
		status: "connected",
		oauth: { supported: true, signedIn: false },
	});
	const signedInHttp = makeServer({
		name: "cloud-signed",
		transport: "http",
		config: { transport: "http", url: "https://cloud.example.com/mcp" },
		status: "connected",
		oauth: { supported: true, signedIn: true },
	});
	const view = await mount({
		state: makeState({ servers: [publicHttp, signedInHttp] }),
		ready: true,
		actions,
	});
	const cards = [...view.host.querySelectorAll("article")];
	expect(cards[0]!.textContent).not.toContain("OAuth");
	expect(cards[1]!.textContent).toContain("OAuth 已登录");
	expect(cards[1]!.textContent).toContain("退出 OAuth 登录");
	await view.unmount();
});

it("ignores stale MCP state revisions in store", () => {
	storeActions.setMcp(makeState({ revision: 5 }));
	storeActions.setMcp(makeState({ revision: 4 }));
	expect(getState().mcp?.revision).toBe(5);
	storeActions.setMcp(null);
	expect(getState().mcp).toBeNull();
});
