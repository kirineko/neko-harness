import { spawn } from "node:child_process";
import type { Watchable } from "@earendil-works/chord/watch";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isOAuthRelevant, type McpServerStatus } from "@neko-harness/core/mcp";
import {
	type NekoMcpBeginSignInResult,
	type NekoMcpServer,
	type NekoMcpState,
	safeValue,
	subscribeState,
} from "@neko-harness/gateway";
import type { PickerDetail, PickerItem, PickerPanel } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { type PlainKey, t } from "./i18n/index.ts";
import { plainLine, plainText } from "./plain-text.ts";
import { theme } from "./theme/index.ts";

export type McpClient = {
	readonly mcp: {
		readonly snapshot: Watchable<NekoMcpState>;
		setEnabled(input: { name: string; enabled: boolean }): Promise<NekoMcpState>;
		reconnect(input: { name: string }): Promise<NekoMcpState>;
		beginSignIn(input: { server: string }): Promise<NekoMcpBeginSignInResult>;
		pasteSignIn(input: { id: string; redirectUrl: string }): Promise<NekoMcpState>;
		cancelSignIn(input: { id: string }): Promise<NekoMcpState>;
		signOut(input: { server: string }): Promise<NekoMcpState>;
	};
};

export type NoticeFn = (message: string, level?: "info" | "warning" | "error", options?: { wrap?: boolean }) => void;

const STATUS_KEYS: Record<McpServerStatus, PlainKey> = {
	disabled: "mcp.status.disabled",
	connecting: "mcp.status.connecting",
	connected: "mcp.status.connected",
	disconnected: "mcp.status.disconnected",
	auth_required: "mcp.status.auth_required",
	error: "mcp.status.error",
};

function statusLabel(status: McpServerStatus): string {
	return t(STATUS_KEYS[status]);
}

function targetOf(server: NekoMcpServer): string {
	return server.config.transport === "stdio"
		? [server.config.command, ...(server.config.args ?? [])].join(" ")
		: server.config.url;
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Best-effort browser opener for OAuth authorization URLs; never throws. */
export function openExternalUrl(url: string): void {
	try {
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		/* headless or restricted environment: caller already displays URL */
	}
}

export function mcpItems(state: NekoMcpState | undefined): PickerItem[] {
	if (!state) return [];
	return state.servers.map((server) => {
		const signIn = state.signIns.find((flow) => flow.server === server.name);
		const waiting = signIn?.status === "waiting";
		const oauthRelevant = isOAuthRelevant(server, signIn);
		const oauthTag = oauthRelevant ? (server.oauth.signedIn ? " · OAuth ✓" : " · OAuth") : "";
		const desc = server.error
			? plainLine(server.error, 120)
			: waiting
				? t("mcp.oauth.waiting")
				: plainLine(server.config.description || targetOf(server), 120);
		return {
			value: server.name,
			label: `${server.name} [${server.transport}]`,
			rightLabel: `${statusLabel(server.status)} · ${t("mcp.toolsCount", { count: server.tools.length })}${oauthTag}`,
			description: desc,
		};
	});
}

class McpServerDetail implements PickerDetail {
	#offset = 0;
	#max = 0;
	#page = 1;
	readonly #name: string;
	readonly #client: McpClient;
	readonly #notify: NoticeFn;
	readonly #openUrl: (url: string) => void;
	readonly #changed: () => void;
	#busy = false;

	constructor(name: string, client: McpClient, notify: NoticeFn, openUrl: (url: string) => void, changed: () => void) {
		this.#name = name;
		this.#client = client;
		this.#notify = notify;
		this.#openUrl = openUrl;
		this.#changed = changed;
	}

	#snapshot(): NekoMcpState | undefined {
		return safeValue(this.#client.mcp.snapshot);
	}

	#server(): NekoMcpServer | undefined {
		return this.#snapshot()?.servers.find((s) => s.name === this.#name);
	}

	get help(): string {
		const snap = this.#snapshot();
		const server = this.#server();
		const signIn = snap?.signIns.find((flow) => flow.server === this.#name);
		const waiting = signIn?.status === "waiting" ? signIn : undefined;
		const hints: [string, string][] = [
			["E", t("mcp.action.toggle")],
			["R", t("mcp.action.reconnect")],
		];
		if (waiting) hints.push(["X", t("mcp.action.cancelSignIn")]);
		else if (server && isOAuthRelevant(server, signIn)) {
			hints.push(server.oauth.signedIn ? ["O", t("mcp.action.signOut")] : ["L", t("mcp.action.signIn")]);
		}
		hints.push(["↑↓", t("action.scroll")], ["Esc", t("action.back")]);
		return shortcutHints(...hints);
	}

	scroll(delta: number): void {
		this.#offset = Math.max(0, Math.min(this.#max, this.#offset + delta));
	}

	#run(work: () => Promise<void>): void {
		if (this.#busy) return;
		this.#busy = true;
		void work()
			.catch((error) => this.#notify(t("common.error", { message: errText(error) }), "error", { wrap: true }))
			.finally(() => {
				this.#busy = false;
				this.#changed();
			});
	}

	handleKey(data: string): boolean {
		if (matchesKey(data, "up")) {
			this.scroll(-1);
			return true;
		}
		if (matchesKey(data, "down")) {
			this.scroll(1);
			return true;
		}
		if (matchesKey(data, "pageUp")) {
			this.scroll(-this.#page);
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			this.scroll(this.#page);
			return true;
		}
		const snap = this.#snapshot();
		const server = this.#server();
		if (!snap || !server) return false;
		const key = data.toLowerCase();
		if (key === "e") {
			const next = !server.enabled;
			this.#run(async () => {
				await this.#client.mcp.setEnabled({ name: server.name, enabled: next });
				this.#notify(t(next ? "mcp.enabled" : "mcp.disabled", { name: server.name }));
			});
			return true;
		}
		if (key === "r") {
			if (!server.enabled) return true;
			this.#run(async () => {
				await this.#client.mcp.reconnect({ name: server.name });
				this.#notify(t("mcp.reconnected", { name: server.name }));
			});
			return true;
		}
		if (key === "l") {
			if (!server.oauth.supported) {
				this.#notify(t("mcp.oauth.unsupported", { name: server.name }), "warning");
				return true;
			}
			this.#run(async () => {
				const res = await this.#client.mcp.beginSignIn({ server: server.name });
				if (res.status === "authorized") {
					this.#notify(t("mcp.oauth.authorized", { name: server.name }));
				} else {
					this.#openUrl(res.authorizationUrl);
					this.#notify(t("mcp.oauth.openPrompt", { name: server.name, url: res.authorizationUrl }), "info", {
						wrap: true,
					});
				}
			});
			return true;
		}
		if (key === "o") {
			if (!server.oauth.supported || !server.oauth.signedIn) return true;
			this.#run(async () => {
				await this.#client.mcp.signOut({ server: server.name });
				this.#notify(t("mcp.oauth.signedOut", { name: server.name }));
			});
			return true;
		}
		if (key === "x") {
			const waiting = snap.signIns.find((flow) => flow.server === server.name && flow.status === "waiting");
			if (!waiting) return true;
			this.#run(async () => {
				await this.#client.mcp.cancelSignIn({ id: waiting.id });
				this.#notify(t("mcp.oauth.cancelled"));
			});
			return true;
		}
		return false;
	}

	lines(width: number, height: number): readonly string[] {
		const snap = this.#snapshot();
		const server = this.#server();
		if (!snap || !server) return [theme.dim(t("mcp.unavailable"))];
		const raw: string[] = [
			`${theme.accent(server.name)}  ${theme.dim(`[${server.transport}]`)}`,
			t("mcp.detail.status", { status: statusLabel(server.status) }),
			t("mcp.detail.exposure", { exposure: server.exposure }),
			t("mcp.detail.target", { target: plainLine(targetOf(server), 300) }),
			theme.dim(t("mcp.configPath", { path: snap.configPath })),
		];
		const signIn = snap.signIns.find((flow) => flow.server === server.name);
		if (isOAuthRelevant(server, signIn)) {
			if (signIn?.status === "waiting") {
				raw.push(theme.warning(t("mcp.oauth.waiting")));
				raw.push(theme.dim(signIn.authorizationUrl));
			} else {
				raw.push(server.oauth.signedIn ? theme.ok(t("mcp.oauth.signedIn")) : theme.dim(t("mcp.oauth.notSignedIn")));
			}
		}
		if (server.error) {
			raw.push("", theme.error(t("mcp.detail.error", { error: plainText(server.error) })));
		}
		if (server.stderrTail) {
			raw.push("", theme.dim(t("mcp.detail.stderr")), ...plainText(server.stderrTail).split("\n").slice(-12));
		}
		raw.push("", theme.accent(t("mcp.detail.tools", { count: server.tools.length })));
		if (server.tools.length === 0) {
			raw.push(theme.dim(t("mcp.detail.noTools")));
		} else {
			for (const tool of server.tools) {
				const ro = tool.readOnly ? ` ${theme.dim(t("mcp.detail.readOnly"))}` : "";
				raw.push(`• ${plainLine(tool.name, 80)}${ro}`);
				if (tool.description) raw.push(`  ${theme.dim(plainLine(tool.description, 200))}`);
			}
		}
		const wrapped = raw.flatMap((line) => wrapTextWithAnsi(line, width));
		this.#max = Math.max(0, wrapped.length - height);
		this.#page = Math.max(1, height - 1);
		this.#offset = Math.min(this.#offset, this.#max);
		return wrapped.slice(this.#offset, this.#offset + height);
	}
}

/** Opens the /mcp panel and keeps it synced with the gateway; returns a stop function. */
export function openMcpPanel(
	panel: PickerPanel,
	client: McpClient,
	notify: NoticeFn,
	openUrl: (url: string) => void = openExternalUrl,
): () => void {
	const current = () => safeValue(client.mcp.snapshot);
	const refresh = () => {
		const snap = current();
		panel.emptyText = !snap
			? t("mcp.unavailable")
			: snap.configError
				? t("mcp.configError", { error: snap.configError })
				: t("mcp.empty", { path: snap.configPath });
		panel.update(mcpItems(snap));
	};
	const stop = subscribeState(client.mcp.snapshot, refresh);
	panel.help = shortcutHints(
		["Enter", t("action.open")],
		["E", t("mcp.action.toggle")],
		["R", t("mcp.action.reconnect")],
		["L", t("mcp.action.signIn")],
		["O", t("mcp.action.signOut")],
		["Esc", t("action.close")],
	);
	let busy = false;
	const runAction = (work: () => Promise<void>) => {
		if (busy) return;
		busy = true;
		void work()
			.catch((error) => notify(t("common.error", { message: errText(error) }), "error", { wrap: true }))
			.finally(() => {
				busy = false;
				panel.changed();
			});
	};
	panel.listKey = (data, value) => {
		if (panel.search.getValue() !== "" || !value) return false;
		const snap = current();
		const server = snap?.servers.find((s) => s.name === value);
		if (!snap || !server) return false;
		const key = data.toLowerCase();
		if (key === "e") {
			const next = !server.enabled;
			runAction(async () => {
				await client.mcp.setEnabled({ name: server.name, enabled: next });
				notify(t(next ? "mcp.enabled" : "mcp.disabled", { name: server.name }));
			});
			return true;
		}
		if (key === "r") {
			if (!server.enabled) return true;
			runAction(async () => {
				await client.mcp.reconnect({ name: server.name });
				notify(t("mcp.reconnected", { name: server.name }));
			});
			return true;
		}
		if (key === "l") {
			if (!server.oauth.supported) {
				notify(t("mcp.oauth.unsupported", { name: server.name }), "warning");
				return true;
			}
			runAction(async () => {
				const res = await client.mcp.beginSignIn({ server: server.name });
				if (res.status === "authorized") notify(t("mcp.oauth.authorized", { name: server.name }));
				else {
					openUrl(res.authorizationUrl);
					notify(t("mcp.oauth.openPrompt", { name: server.name, url: res.authorizationUrl }), "info", { wrap: true });
				}
			});
			return true;
		}
		if (key === "o") {
			if (!server.oauth.supported || !server.oauth.signedIn) return true;
			runAction(async () => {
				await client.mcp.signOut({ server: server.name });
				notify(t("mcp.oauth.signedOut", { name: server.name }));
			});
			return true;
		}
		return false;
	};

	const snap0 = current();
	panel.emptyText = !snap0
		? t("mcp.unavailable")
		: snap0.configError
			? t("mcp.configError", { error: snap0.configError })
			: t("mcp.empty", { path: snap0.configPath });
	void panel.show(
		t("mcp.title"),
		async () => mcpItems(current()),
		async (value) => new McpServerDetail(value, client, notify, openUrl, () => panel.changed()),
	);
	return stop;
}

/** Handles `/mcp paste <url>` and `/mcp cancel` subcommands without opening the panel. */
export async function runMcpSubcommand(rawArgs: string, client: McpClient, notify: NoticeFn): Promise<void> {
	const trimmed = rawArgs.trim();
	const snap = safeValue(client.mcp.snapshot);
	if (!snap) {
		notify(t("mcp.unavailable"), "warning");
		return;
	}
	if (trimmed === "paste" || trimmed.startsWith("paste ")) {
		const url = trimmed.slice("paste".length).trim();
		if (!url) {
			notify(t("mcp.oauth.pasteUsage"), "warning");
			return;
		}
		const waiting = snap.signIns.find((flow) => flow.status === "waiting");
		if (!waiting) {
			notify(t("mcp.oauth.noWaiting"), "warning");
			return;
		}
		try {
			await client.mcp.pasteSignIn({ id: waiting.id, redirectUrl: url });
			notify(t("mcp.oauth.pasteDone"));
		} catch (error) {
			notify(t("common.error", { message: errText(error) }), "error", { wrap: true });
		}
		return;
	}
	if (trimmed === "cancel") {
		const waiting = snap.signIns.find((flow) => flow.status === "waiting");
		if (!waiting) {
			notify(t("mcp.oauth.noWaiting"), "warning");
			return;
		}
		try {
			await client.mcp.cancelSignIn({ id: waiting.id });
			notify(t("mcp.oauth.cancelled"));
		} catch (error) {
			notify(t("common.error", { message: errText(error) }), "error", { wrap: true });
		}
		return;
	}
	notify(t("mcp.usage"), "warning");
}
