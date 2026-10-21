import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { Container, CURSOR_MARKER, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { MODEL_PROVIDERS } from "@neko-harness/core";
import type { NekoCredentialState } from "@neko-harness/gateway";
import { StatusFooter } from "../src/components/footer.ts";
import { LoginPanel } from "../src/components/login.ts";
import { createAppLayout } from "../src/layout.ts";

type Status = NekoCredentialState["statuses"][string];
const stateWith = (overrides: Record<string, Partial<Status>> = {}, revision = 1): NekoCredentialState => {
	const statuses: Record<string, Status> = {};
	for (const spec of MODEL_PROVIDERS)
		statuses[spec.id] = {
			savedConfigured: false,
			environmentConfigured: false,
			source: "none",
			enabled: spec.id === "deepseek",
		};
	statuses.tavily = { savedConfigured: false, environmentConfigured: false, source: "keyless" };
	for (const [id, patch] of Object.entries(overrides)) statuses[id] = { ...statuses[id]!, ...patch };
	return { revision, statuses };
};
const emptyState = () => stateWith();
const savedState = () =>
	stateWith({
		deepseek: { savedConfigured: true, environmentConfigured: true, source: "saved" },
		tavily: { savedConfigured: true, source: "saved" },
	});
const options = (extra: Partial<ConstructorParameters<typeof LoginPanel>[0]> = {}) => ({
	changed: () => {},
	closed: () => {},
	save: async () => {},
	remove: async () => {},
	toggle: async () => {},
	...extra,
});
const text = (panel: LoginPanel, width = 80) => stripTerminalSequences(panel.render(width).join("\n"));
/** Opens the key level of the provider matching the filter (or the first one) with Enter. */
const openKey = (panel: LoginPanel, filter = "") => {
	if (filter) panel.handleInput(filter);
	panel.handleInput("\r");
};
const ESC = "\x1b";

it("lists model providers then a separate web search group with state and source", () => {
	const panel = new LoginPanel(options());
	panel.show(
		stateWith({
			openrouter: { enabled: true, source: "environment", environmentConfigured: true },
			openai: { savedConfigured: true, source: "saved" },
		}),
		() => () => {},
	);
	panel.height = 100;
	const out = text(panel, 100);
	expect(out).toContain("Model providers");
	expect(out).toContain("[x] DeepSeek (always on)");
	expect(out).toMatch(/\[x\] OpenRouter\s+environment · env set/);
	expect(out).toMatch(/\[ \] OpenAI\s+saved · env unset/);
	expect(out).toContain("Web search");
	expect(out).toMatch(/Tavily\s+keyless · env unset/);
	expect(out.indexOf("Web search")).toBeGreaterThan(out.indexOf("Meta"));
	expect(out.indexOf("Tavily")).toBeGreaterThan(out.indexOf("Web search"));
});

it("navigates with Up/Down, filters while typing and opens the selected provider", () => {
	const panel = new LoginPanel(options());
	panel.show(emptyState(), () => () => {});
	panel.handleInput("\x1b[B");
	expect(text(panel)).toMatch(/❯ \[ \] OpenRouter/);
	panel.handleInput("\x1b[A");
	expect(text(panel)).toMatch(/❯ \[x\] DeepSeek/);
	panel.handleInput("tavi");
	let out = text(panel);
	expect(out).toContain("Tavily");
	expect(out).not.toContain("DeepSeek");
	expect(out).not.toMatch(/Model providers\s*\n/);
	panel.handleInput("\r");
	out = text(panel);
	expect(out).toContain("Provider: Tavily");
	expect(out).toContain("TAVILY_API_KEY Not configured");
	expect(out).toContain("Active source: keyless (rate-limited)");
	// Env var names match too and the filter ignores spaces typed by the user.
	panel.show(emptyState(), () => () => {});
	panel.handleInput("hugging face");
	expect(text(panel)).toContain("Hugging Face");
	panel.show(emptyState(), () => () => {});
	panel.handleInput("OPENROUTER_API");
	expect(text(panel)).toContain("OpenRouter");
	expect(text(panel)).not.toContain("OpenAI");
	panel.handleInput("zzzz");
	expect(text(panel)).toContain("No matching providers");
	panel.handleInput("\r");
	expect(text(panel)).toContain("No matching providers");
});

it("enables a model provider with Space and follows the published state", async () => {
	const calls: Array<[string, boolean]> = [];
	let publish: (state: NekoCredentialState) => void = () => {};
	const panel = new LoginPanel(
		options({
			toggle: async (provider, enabled) => {
				calls.push([provider, enabled]);
			},
		}),
	);
	panel.show(emptyState(), (fn) => {
		publish = fn;
		return () => {};
	});
	panel.handleInput("openrouter");
	panel.handleInput(" ");
	expect(calls).toEqual([["openrouter", true]]);
	await Bun.sleep(1);
	expect(text(panel)).toContain("OpenRouter enabled. Press Enter to add a key.");
	publish(stateWith({ openrouter: { enabled: true } }, 2));
	expect(text(panel)).toMatch(/❯ \[x\] OpenRouter/);
	panel.handleInput(" ");
	expect(calls).toEqual([
		["openrouter", true],
		["openrouter", false],
	]);
	await Bun.sleep(1);
	expect(text(panel)).toContain("OpenRouter disabled.");
});

it("keeps DeepSeek enabled locally and explains web search has no switch", async () => {
	const calls: Array<[string, boolean]> = [];
	const panel = new LoginPanel(options({ toggle: async (p, e) => void calls.push([p, e]) }));
	panel.show(emptyState(), () => () => {});
	panel.handleInput(" ");
	expect(calls).toEqual([]);
	expect(text(panel)).toContain("DeepSeek is always enabled.");
	expect(text(panel)).toMatch(/\[x\] DeepSeek/);
	panel.handleInput("tavily");
	panel.handleInput(" ");
	expect(calls).toEqual([]);
	expect(text(panel)).toContain("web search credential");
});

it("shows a toggle failure and ignores a late toggle result after close", async () => {
	let fail = true;
	let release: () => void = () => {};
	const panel = new LoginPanel(
		options({
			toggle: async () => {
				if (fail) throw new Error("Could not save provider settings.");
				await new Promise<void>((r) => {
					release = r;
				});
			},
		}),
	);
	panel.show(emptyState(), () => () => {});
	panel.handleInput("openrouter");
	panel.handleInput(" ");
	await Bun.sleep(1);
	expect(text(panel)).toContain("Could not save provider settings.");
	fail = false;
	panel.handleInput(" ");
	expect(text(panel)).toContain("Enabling...");
	// Closed and reopened while the request is pending: its result must not touch the new session.
	panel.close();
	panel.show(emptyState(), () => () => {});
	release();
	await Bun.sleep(1);
	expect(text(panel)).not.toContain("enabled");
	expect(text(panel)).not.toContain("Enabling...");
	panel.handleInput(" ");
	expect(text(panel)).toContain("DeepSeek is always enabled.");
});

it("masks pasted secrets, discards undo history on close and ignores late completion", async () => {
	let release: () => void = () => {};
	let saved = "";
	let savedProvider = "";
	let closed = 0;
	const panel = new LoginPanel(
		options({
			closed: () => {
				closed++;
			},
			save: async (provider, key) => {
				saved = key;
				savedProvider = provider;
				await new Promise<void>((r) => {
					release = r;
				});
			},
		}),
	);
	const show = () => panel.show(emptyState(), () => () => {});
	show();
	openKey(panel);
	panel.handleInput("\x1b[200~test-secret\x1b[201~");
	const masked = text(panel, 60);
	expect(masked).not.toContain("test-secret");
	expect(masked).toContain("(11 characters)");
	panel.handleInput("\r");
	expect(saved).toBe("test-secret");
	expect(savedProvider).toBe("deepseek");
	panel.close();
	show();
	openKey(panel);
	release();
	await Bun.sleep(1);
	expect(text(panel, 60)).toContain("(paste key)");
	expect(text(panel, 60)).not.toContain("Saved. Used");
	panel.handleInput("\x1f");
	expect(text(panel, 60)).not.toContain("***");
	panel.close();
	expect(closed).toBe(2);
});

it("keeps typed input per provider when returning to the list with Esc or Tab", () => {
	const panel = new LoginPanel(options());
	panel.show(emptyState(), () => () => {});
	openKey(panel);
	panel.handleInput("partial");
	// Non-empty input: arrows are cursor movement, provider and content stay.
	panel.handleInput("\x1b[C");
	panel.handleInput("\x1b[D");
	expect(text(panel)).toContain("Provider: DeepSeek");
	expect(text(panel)).toContain("(7 characters)");
	// Esc goes back to the list (panel stays open) and the input is kept.
	panel.handleInput(ESC);
	expect(panel.open).toBe(true);
	expect(text(panel)).toContain("Model providers");
	expect(text(panel)).not.toContain("(7 characters)");
	panel.handleInput("tavily");
	panel.handleInput("\r");
	expect(text(panel)).toContain("Provider: Tavily");
	expect(text(panel)).toContain("(paste key)");
	panel.handleInput("tvly");
	// Tab also returns to the list; DeepSeek's draft is still there.
	panel.handleInput("\t");
	expect(text(panel)).toContain("Model providers");
	panel.handleInput("\x15");
	openKey(panel);
	expect(text(panel)).toContain("Provider: DeepSeek");
	expect(text(panel)).toContain("(7 characters)");
	// Esc in the list closes.
	panel.handleInput(ESC);
	panel.handleInput(ESC);
	expect(panel.open).toBe(false);
});

it("shows provider state in the key level and explains a disabled provider", () => {
	const panel = new LoginPanel(options());
	panel.show(stateWith({ openrouter: { environmentConfigured: true, source: "environment" } }), () => () => {});
	openKey(panel, "openrouter");
	const out = text(panel);
	expect(out).toContain("Provider: OpenRouter (disabled)");
	expect(out).toContain("OPENROUTER_API_KEY Configured");
	expect(out).toContain("Active source: environment");
	expect(out).toContain("Provider is disabled");
	expect(out).toContain("https://openrouter.ai/keys");
});

it("requires a second Ctrl+R to remove a saved key", async () => {
	const removed: string[] = [];
	const panel = new LoginPanel(
		options({
			remove: async (provider) => {
				removed.push(provider);
			},
			autoCloseMs: 5,
		}),
	);
	panel.show(savedState(), () => () => {});
	openKey(panel);
	panel.handleInput("\x12");
	expect(removed).toEqual([]);
	expect(text(panel)).toContain("Press Ctrl+R again");
	// Any other key cancels the confirmation.
	panel.handleInput("x");
	expect(removed).toEqual([]);
	expect(text(panel)).not.toContain("Press Ctrl+R again");
	panel.handleInput("\x12");
	panel.handleInput("\x12");
	expect(removed).toEqual(["deepseek"]);
	await Bun.sleep(20);
	expect(panel.open).toBe(false);
});

it("trims surrounding whitespace and tolerates embedded newlines in pasted content", async () => {
	const saved: string[] = [];
	const panel = new LoginPanel(
		options({
			save: async (_provider, key) => {
				saved.push(key);
			},
			autoCloseMs: 5,
		}),
	);
	panel.show(emptyState(), () => () => {});
	openKey(panel);
	panel.handleInput("\x1b[200~  sk-trimmed \n\x1b[201~");
	panel.handleInput("\r");
	await Bun.sleep(1);
	expect(saved).toEqual(["sk-trimmed"]);
	// The input component strips pasted control characters, so a copied key
	// with an embedded newline saves cleanly instead of being rejected.
	panel.show(emptyState(), () => () => {});
	openKey(panel);
	panel.handleInput("\x1b[200~sk-broken\nkey\x1b[201~");
	panel.handleInput("\r");
	await Bun.sleep(1);
	expect(saved).toEqual(["sk-trimmed", "sk-brokenkey"]);
});

it("saves to the selected non-DeepSeek provider", async () => {
	const saved: Array<[string, string]> = [];
	const panel = new LoginPanel(options({ save: async (p, k) => void saved.push([p, k]), autoCloseMs: 5 }));
	panel.show(stateWith({ openrouter: { enabled: true } }), () => () => {});
	openKey(panel, "openrouter");
	panel.handleInput("sk-or-1");
	panel.handleInput("\r");
	await Bun.sleep(1);
	expect(saved).toEqual([["openrouter", "sk-or-1"]]);
});

it("surfaces the server error message and auto-closes after a successful save", async () => {
	let fail = true;
	let closed = 0;
	const panel = new LoginPanel(
		options({
			closed: () => {
				closed++;
			},
			save: async () => {
				if (fail) throw new Error("Enter a valid API key.");
			},
			autoCloseMs: 5,
		}),
	);
	panel.show(emptyState(), () => () => {});
	openKey(panel);
	panel.handleInput("\x1b[200~sk-anything\x1b[201~");
	panel.handleInput("\r");
	await Bun.sleep(1);
	expect(text(panel)).toContain("Enter a valid API key.");
	expect(panel.open).toBe(true);
	fail = false;
	panel.handleInput("\x1b[200~sk-anything\x1b[201~");
	panel.handleInput("\r");
	await Bun.sleep(1);
	expect(text(panel)).toContain("Saved. Used");
	expect(panel.open).toBe(true);
	await Bun.sleep(20);
	expect(panel.open).toBe(false);
	expect(closed).toBe(1);
});

it("does not auto-close when Escape wins the race", async () => {
	let closed = 0;
	const panel = new LoginPanel(
		options({
			closed: () => {
				closed++;
			},
			autoCloseMs: 30,
		}),
	);
	panel.show(emptyState(), () => () => {});
	openKey(panel);
	panel.handleInput("\x1b[200~sk-anything\x1b[201~");
	panel.handleInput("\r");
	await Bun.sleep(1);
	expect(text(panel)).toContain("Saved. Used");
	panel.handleInput("\x1b");
	expect(closed).toBe(1);
	await Bun.sleep(60);
	expect(closed).toBe(1);
	panel.show(emptyState(), () => () => {});
	expect(panel.open).toBe(true);
	await Bun.sleep(60);
	expect(panel.open).toBe(true);
});

it("emits a hardware cursor marker at the insertion point only when focused", () => {
	const panel = new LoginPanel(options());
	panel.show(emptyState(), () => () => {});
	openKey(panel);
	// Unfocused: no cursor markers, plain placeholder.
	expect(text(panel)).toContain("(paste key)");
	expect(panel.render(80).join("\n")).not.toContain(CURSOR_MARKER);
	// Focused: marker present at the key row, key content never leaked.
	panel.focused = true;
	panel.handleInput("secret-value");
	const focused = panel.render(80).join("\n");
	expect(focused).toContain(CURSOR_MARKER);
	expect(focused).not.toContain("secret-value");
	expect(stripTerminalSequences(focused)).not.toContain(CURSOR_MARKER);
	expect(stripTerminalSequences(focused)).toContain("(12 characters)");
	// Focus returns to the editor: markers gone.
	panel.focused = false;
	expect(panel.render(80).join("\n")).not.toContain(CURSOR_MARKER);
});

it("keeps the list, protected input, actions, draft and footer visible in small windows", () => {
	for (const [width, height] of [
		[120, 40],
		[80, 24],
		[60, 16],
	] as const) {
		for (const level of ["list", "key"] as const) {
			const panel = new LoginPanel(options());
			panel.show(savedState(), () => () => {});
			if (level === "list") {
				// Move to the last row (DeepSeek in Web search): the selection must stay visible.
				for (let i = 0; i < 40; i++) panel.handleInput("\x1b[B");
			} else {
				openKey(panel);
				panel.handleInput("x".repeat(200));
			}
			const footer = new StatusFooter();
			footer.setStats({
				cwd: "workspace",
				model: "deepseek/flash",
				thinkingLevel: "high",
				usageText: "",
				busy: undefined,
			});
			const layout = createAppLayout({
				transcript: new Text("history"),
				panel,
				editor: new Text("draft", 0, 0),
				footer,
				notices: new Container(),
				panelOpen: () => panel.open,
			});
			const lines = renderLayoutFrame(layout, width, height, () => {}).lines.map(stripTerminalSequences);
			const out = lines.join("\n");
			expect(out).toContain(level === "list" ? "Enter Key" : "Enter Save");
			if (level === "list") {
				expect(out).toMatch(/❯ {3} +DeepSeek/);
				expect(out).toContain("Space Toggle");
			} else {
				expect(out).not.toContain("xxxx");
				expect(out).toContain("(200 characters)");
			}
			expect(out).toContain("draft");
			expect(out).toContain("Ready");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	}
});

it("lists DeepSeek in both the model and the web search group", () => {
	const panel = new LoginPanel(options());
	panel.show(stateWith({ deepseek: { savedConfigured: true, source: "saved" } }), () => () => {});
	panel.height = 100;
	const out = text(panel, 100);
	const rows = out.split("\n").filter((line) => line.includes("DeepSeek"));
	expect(rows).toHaveLength(2);
	expect(out.indexOf("DeepSeek (always on)")).toBeLessThan(out.indexOf("Web search"));
	const search = out.slice(out.indexOf("Web search"));
	expect(search).toMatch(/DeepSeek\s+saved/);
	expect(search).not.toContain("[x] DeepSeek");
	expect(search).not.toContain("always on");
});

it("filters DeepSeek into two rows and acts on the highlighted one", async () => {
	const saves: Array<[string, string]> = [];
	const calls: Array<[string, boolean]> = [];
	const panel = new LoginPanel(
		options({ save: async (p, k) => void saves.push([p, k]), toggle: async (p, e) => void calls.push([p, e]) }),
	);
	panel.show(emptyState(), () => () => {});
	panel.handleInput("deepseek");
	expect(
		text(panel)
			.split("\n")
			.filter((line) => line.includes("DeepSeek")),
	).toHaveLength(2);
	panel.handleInput(" ");
	expect(text(panel)).toContain("DeepSeek is always enabled.");
	panel.handleInput("\x1b[B");
	panel.handleInput(" ");
	expect(text(panel)).toContain("no enable switch here");
	expect(calls).toEqual([]);
	panel.handleInput("\r");
	expect(text(panel)).toContain("Provider: DeepSeek (web search");
	panel.handleInput("sk-search");
	panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(saves).toEqual([["deepseek", "sk-search"]]);
});

it("returns from the key level to the group it was opened from", () => {
	const panel = new LoginPanel(options());
	panel.show(emptyState(), () => () => {}, { provider: "deepseek", group: "search" });
	panel.height = 100;
	expect(text(panel)).toContain("Provider: DeepSeek (web search");
	panel.handleInput(ESC);
	expect(panel.open).toBe(true);
	expect(text(panel, 100)).toMatch(/❯\s+DeepSeek/);
	expect(text(panel, 100)).not.toMatch(/❯ \[x\] DeepSeek/);
	panel.handleInput(ESC);
	expect(panel.open).toBe(false);
});

it("shows the web search DeepSeek row as the same credential after a shared state update", () => {
	let publish!: (state: NekoCredentialState) => void;
	const panel = new LoginPanel(options());
	panel.show(emptyState(), (fn) => {
		publish = fn;
		return () => {};
	});
	panel.height = 100;
	publish(stateWith({ deepseek: { savedConfigured: true, source: "saved" } }, 2));
	const rows = text(panel, 100)
		.split("\n")
		.filter((line) => line.includes("DeepSeek"));
	expect(rows).toHaveLength(2);
	for (const row of rows) expect(row).toMatch(/saved/);
});
