import {
	type Component,
	CURSOR_MARKER,
	Input,
	isKeyRelease,
	matchesKey,
	renderFakeCursor,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	CREDENTIAL_PROVIDERS,
	type CredentialProviderId,
	type CredentialProviderSpec,
	isModelProvider,
	LOCKED_PROVIDERS,
} from "@neko-harness/core";
import type { NekoCredentialState } from "@neko-harness/gateway";
import { t } from "../i18n/index.ts";
import { style, theme } from "../theme/index.ts";
import { shortcutHints } from "./shortcut-hints.ts";

const AUTO_CLOSE_MS = 800;
const newFilter = () => new Input({ prompt: "❯ ", placeholder: t("common.filterPlaceholder") });

type CredentialStatus = NekoCredentialState["statuses"][string];
type Group = "model" | "search";
/** One list row; DeepSeek has two (model and web search) that share a single credential. */
type Row = { spec: CredentialProviderSpec; group: Group };
type Entry = { header: string } | { row: Row };

const isLocked = (id: string) => (LOCKED_PROVIDERS as readonly string[]).includes(id);
const SEARCH_ALIASES = ["deepseek"];
const listRows = (): Row[] => {
	const all: Row[] = CREDENTIAL_PROVIDERS.map((spec) => ({ spec, group: spec.kind === "search" ? "search" : "model" }));
	for (const id of SEARCH_ALIASES) {
		const spec = CREDENTIAL_PROVIDERS.find((item) => item.id === id);
		if (spec) all.push({ spec, group: "search" });
	}
	return all;
};
const compact = (value: string) => value.toLowerCase().replace(/\s+/g, "");

/**
 * Two levels: a filterable provider list, then the masked key input of one provider.
 * Key input is never rendered; replacing it also discards its undo/kill buffers.
 */
export class LoginPanel implements Component {
	height = 10;
	focused = false;
	open = false;
	#level: "list" | "key" = "list";
	#filter = newFilter();
	#index = 0;
	#inputs = new Map<string, Input>();
	#state: NekoCredentialState | undefined;
	#provider: CredentialProviderId = "deepseek";
	#group: Group = "model";
	#message = "";
	#busy = false;
	#confirmingRemove = false;
	#generation = 0;
	#closeTimer: ReturnType<typeof setTimeout> | undefined;
	#unsubscribe: (() => void) | undefined;
	readonly #changed: () => void;
	readonly #closed: () => void;
	readonly #save: (provider: CredentialProviderId, key: string) => Promise<void>;
	readonly #remove: (provider: CredentialProviderId) => Promise<void>;
	readonly #toggle: (provider: CredentialProviderId, enabled: boolean) => Promise<void>;
	readonly #autoCloseMs: number;
	constructor(options: {
		changed: () => void;
		closed: () => void;
		save: (provider: CredentialProviderId, key: string) => Promise<void>;
		remove: (provider: CredentialProviderId) => Promise<void>;
		/** 切换模型 provider 启用状态；DeepSeek 在面板内本地拒绝，不会调用。 */
		toggle: (provider: CredentialProviderId, enabled: boolean) => Promise<void>;
		/** 成功后自动关闭延迟；测试可注入小值。 */
		autoCloseMs?: number;
	}) {
		this.#changed = options.changed;
		this.#closed = options.closed;
		this.#save = options.save;
		this.#remove = options.remove;
		this.#toggle = options.toggle;
		this.#autoCloseMs = options.autoCloseMs ?? AUTO_CLOSE_MS;
	}
	/** `initial` opens that provider's key input directly (used by /search); Esc then returns to its list group. */
	show(
		state: NekoCredentialState | undefined,
		subscribe: (fn: (state: NekoCredentialState) => void) => () => void,
		initial?: { provider: CredentialProviderId; group: Group },
	) {
		this.#generation++;
		this.#clearCloseTimer();
		this.open = true;
		this.#level = "list";
		this.#busy = false;
		this.#confirmingRemove = false;
		this.#message = "";
		this.#inputs.clear();
		this.#filter = newFilter();
		this.#index = 0;
		this.#provider = "deepseek";
		this.#group = "model";
		this.#state = state;
		if (initial) {
			this.#provider = initial.provider;
			this.#group = initial.group;
			this.#level = "key";
		}
		this.#unsubscribe?.();
		this.#unsubscribe = subscribe((value) => {
			if (this.open) {
				this.#state = value;
				this.#changed();
			}
		});
		this.#changed();
	}
	close() {
		this.#generation++;
		this.#clearCloseTimer();
		this.open = false;
		this.#confirmingRemove = false;
		this.#inputs.clear();
		this.#filter = newFilter();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#closed();
		this.#changed();
	}
	invalidate() {}
	get #input(): Input {
		let input = this.#inputs.get(this.#provider);
		if (!input) {
			input = new Input();
			this.#inputs.set(this.#provider, input);
		}
		return input;
	}
	get #status(): CredentialStatus | undefined {
		return this.#state?.statuses[this.#provider];
	}
	#visible(): Row[] {
		const query = compact(this.#filter.getValue());
		const all = listRows();
		if (query === "") return all;
		return all.filter(({ spec }) => compact(`${spec.name} ${spec.id} ${spec.envVar}`).includes(query));
	}
	#isEnabled(spec: CredentialProviderSpec): boolean {
		return isLocked(spec.id) || this.#state?.statuses[spec.id]?.enabled === true;
	}
	handleInput(data: string) {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (this.#level === "list") this.#handleList(data);
		else this.#handleKey(data);
		this.#changed();
	}
	#handleList(data: string) {
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		if (this.#busy) return;
		const items = this.#visible();
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const delta = matchesKey(data, "up") ? -1 : 1;
			this.#index = Math.max(0, Math.min(items.length - 1, this.#index + delta));
			this.#message = "";
		} else if (matchesKey(data, "space")) {
			const row = items[this.#index];
			if (row) void this.#toggleEnabled(row);
		} else if (matchesKey(data, "enter")) {
			const row = items[this.#index];
			if (!row) return;
			this.#provider = row.spec.id as CredentialProviderId;
			this.#group = row.group;
			this.#level = "key";
			this.#message = "";
		} else {
			const before = this.#filter.getValue();
			this.#filter.handleInput(data);
			if (this.#filter.getValue() !== before) {
				this.#index = 0;
				this.#message = "";
			}
		}
	}
	#handleKey(data: string) {
		if (matchesKey(data, "escape")) {
			// Saving, or a pending auto-close, means the panel is finished: Esc closes it instead of going back.
			if (this.#busy || this.#closeTimer !== undefined) this.close();
			else this.#backToList();
			return;
		}
		if (this.#busy) return;
		const confirming = this.#confirmingRemove;
		this.#confirmingRemove = false;
		if (confirming && !matchesKey(data, "ctrl+r")) this.#message = "";
		const input = this.#input;
		if (matchesKey(data, "enter")) void this.#apply(false);
		else if (matchesKey(data, "ctrl+r") && this.#status?.savedConfigured) {
			if (confirming) void this.#apply(true);
			else {
				this.#confirmingRemove = true;
				this.#message = t("login.pressAgain");
			}
		} else if (matchesKey(data, "tab")) this.#backToList();
		else {
			input.handleInput(data);
			if (input.getValue().length > 4096) input.setValue(input.getValue().slice(0, 4096));
		}
	}
	#backToList() {
		const index = this.#visible().findIndex((row) => row.spec.id === this.#provider && row.group === this.#group);
		if (index >= 0) this.#index = index;
		this.#level = "list";
		this.#confirmingRemove = false;
		this.#message = "";
	}
	async #toggleEnabled({ spec, group }: Row) {
		if (group === "search") {
			this.#message = isModelProvider(spec.id)
				? t("login.searchShared", { name: spec.name })
				: t("login.searchNoSwitch", { name: spec.name });
			return;
		}
		if (isLocked(spec.id)) {
			this.#message = t("login.alwaysEnabled", { name: spec.name });
			return;
		}
		if (!isModelProvider(spec.id)) return;
		const enable = !this.#isEnabled(spec);
		const generation = this.#generation;
		this.#busy = true;
		this.#message = enable ? t("login.enabling") : t("login.disabling");
		this.#changed();
		try {
			await this.#toggle(spec.id, enable);
			if (generation === this.#generation)
				this.#message = enable ? t("login.enabled", { name: spec.name }) : t("login.disabled", { name: spec.name });
		} catch (error) {
			if (generation === this.#generation)
				this.#message = error instanceof Error ? error.message : t("login.updateFailed");
		} finally {
			if (generation === this.#generation) {
				this.#busy = false;
				this.#changed();
			}
		}
	}
	#clearCloseTimer() {
		if (this.#closeTimer !== undefined) clearTimeout(this.#closeTimer);
		this.#closeTimer = undefined;
	}
	#scheduleAutoClose(generation: number) {
		this.#clearCloseTimer();
		this.#closeTimer = setTimeout(() => {
			this.#closeTimer = undefined;
			if (generation === this.#generation && this.open) this.close();
		}, this.#autoCloseMs);
	}
	async #apply(remove: boolean) {
		const key = this.#input.getValue().trim();
		if (!remove) {
			if (!key) {
				this.#message = t("login.enterKey");
				this.#changed();
				return;
			}
			if (Array.from(key).some((char) => char.charCodeAt(0) < 32)) {
				this.#message = t("login.keyControlChar");
				this.#changed();
				return;
			}
		}
		const generation = this.#generation;
		const provider = this.#provider;
		this.#busy = true;
		this.#message = remove ? t("login.removing") : t("login.saving");
		this.#changed();
		try {
			if (remove) await this.#remove(provider);
			else await this.#save(provider, key);
			if (generation === this.#generation) {
				this.#inputs.set(provider, new Input());
				this.#message = remove ? t("login.removed") : t("login.saved");
				this.#scheduleAutoClose(generation);
			}
		} catch (error) {
			if (generation === this.#generation)
				this.#message = error instanceof Error ? error.message : t("login.keyFailed");
		} finally {
			if (generation === this.#generation) {
				this.#busy = false;
				this.#changed();
			}
		}
	}
	#frame(rows: string[], help: string, width: number): string[] {
		const body = Math.max(0, this.height - 1);
		while (rows.length < body) rows.push("");
		return [...rows.slice(0, body), help].map((line) =>
			theme.panel(` ${truncateToWidth(line, Math.max(1, width - 2), "...", true)} `),
		);
	}
	render(width: number): string[] {
		return this.#level === "list" ? this.#renderList(width) : this.#renderKey(width);
	}
	#renderList(width: number): string[] {
		const w = Math.max(1, width - 2);
		const items = this.#visible();
		this.#index = Math.max(0, Math.min(this.#index, items.length - 1));
		const selected = items[this.#index];
		const rows = [theme.accent(style.bold(t("login.title")))];
		if (this.height >= 4) {
			this.#filter.focused = this.focused;
			rows.push(...this.#filter.render(w).slice(0, 1));
		}
		const showStatus = this.height >= 6;
		const entries: Entry[] = [];
		let group: string | undefined;
		for (const row of items) {
			const next = row.group === "search" ? t("login.groupSearch") : t("login.groupModel");
			if (next !== group) entries.push({ header: next });
			group = next;
			entries.push({ row });
		}
		const count = Math.max(1, this.height - rows.length - 1 - (showStatus ? 1 : 0));
		const at = entries.findIndex((entry) => "row" in entry && entry.row === selected);
		const start = Math.max(0, Math.min(at - Math.floor(count / 2), entries.length - count));
		for (const entry of entries.slice(start, start + count)) {
			if ("header" in entry) {
				rows.push(theme.dim(` ${entry.header}`));
				continue;
			}
			const { spec, group: rowGroup } = entry.row;
			const status = this.#state?.statuses[spec.id];
			const enabled = this.#isEnabled(spec);
			const modelRow = rowGroup === "model";
			const mark = modelRow ? (enabled ? "[x]" : "[ ]") : "   ";
			const right = status
				? t("login.rowStatus", {
						source: status.source,
						state: status.environmentConfigured ? t("login.envSet") : t("login.envUnset"),
					})
				: t("login.statusLoading");
			const leftWidth = Math.max(1, w - 3 - visibleWidth(right));
			const left = truncateToWidth(
				`${mark} ${spec.name}${modelRow && isLocked(spec.id) ? t("login.alwaysOn") : ""}`,
				leftWidth,
				"...",
			);
			const label = `${left}${" ".repeat(Math.max(1, leftWidth - visibleWidth(left) + 1))}${right}`;
			if (entry.row === selected) rows.push(theme.selection(`❯ ${label}`));
			else rows.push(modelRow && !enabled ? theme.dim(`  ${label}`) : `  ${label}`);
		}
		if (items.length === 0) rows.push(t("login.noMatch"));
		if (showStatus) {
			while (rows.length < this.height - 2) rows.push("");
			const hint = selected
				? selected.group === "search" && isModelProvider(selected.spec.id)
					? t("login.hintShared", { name: selected.spec.name, env: selected.spec.envVar })
					: t("login.hintEnv", { env: selected.spec.envVar })
				: "";
			rows.push(this.#message || (hint ? theme.dim(hint) : ""));
		}
		const help = this.#busy
			? shortcutHints(["Esc", t("action.close")])
			: shortcutHints(
					["↑↓", t("action.select")],
					["Space", t("action.toggle")],
					["Enter", t("action.key")],
					["Esc", t("action.close")],
				);
		return this.#frame(rows, help, width);
	}
	#renderKey(width: number): string[] {
		const state = this.#status;
		const spec = CREDENTIAL_PROVIDERS.find((item) => item.id === this.#provider) ?? CREDENTIAL_PROVIDERS[0]!;
		const source = state?.source === "keyless" ? t("login.sourceKeyless") : (state?.source ?? t("common.loading"));
		const keyLength = this.#input.getValue().length;
		// 与 Input 组件同一习语：聚焦时发射零宽硬件光标标记 + fake cursor（无硬件光标时解析为反色块）。
		// 光标恒在固定星号之后，位置不随密钥长度变化；失焦时不渲染光标。
		const marker = this.focused ? CURSOR_MARKER : "";
		const keyLabel = t("login.keyLabel");
		const paste = [...t("login.pasteKey")];
		const keyRow =
			keyLength > 0
				? `${keyLabel}********${marker}${this.focused ? renderFakeCursor(" ") : ""} ${t("login.keyLength", { count: keyLength })}`
				: `${keyLabel}${marker}${this.focused ? `${renderFakeCursor(paste[0] ?? " ")}${paste.slice(1).join("")}` : paste.join("")}`;
		const tag =
			this.#group === "search"
				? isModelProvider(spec.id)
					? t("login.tagSearchShared")
					: t("login.tagSearch")
				: this.#isEnabled(spec)
					? t("login.tagEnabled")
					: t("login.tagDisabled");
		const defaultMessage = spec.keyless
			? t("login.keylessMessage", { name: spec.name })
			: this.#group === "model" && !this.#isEnabled(spec)
				? t("login.disabledMessage")
				: t("login.savedOverrides");
		const provider = t("login.provider", { name: spec.name, tag });
		const message = this.#message || defaultMessage;
		const environment = t("login.environment", {
			env: spec.envVar,
			state: state
				? state.environmentConfigured
					? t("login.envConfigured")
					: t("login.envNotConfigured")
				: t("common.loading"),
		});
		const sourceRow = t("login.activeSource", { source });
		// 小窗口先保住提供方、密钥行与状态消息。
		const rows =
			this.height - 1 >= 6
				? [provider, environment, sourceRow, keyRow, message, spec.signupUrl]
				: [provider, keyRow, message, environment, sourceRow, spec.signupUrl];
		const help = this.#busy
			? shortcutHints(["Esc", t("action.close")])
			: this.#confirmingRemove
				? shortcutHints(["Ctrl+R", t("action.confirmRemove")], ["Esc", t("action.back")])
				: state?.savedConfigured
					? shortcutHints(
							["Enter", t("action.save")],
							["Ctrl+R", t("action.remove")],
							["Tab", t("action.providers")],
							["Esc", t("action.back")],
						)
					: shortcutHints(["Enter", t("action.save")], ["Tab", t("action.providers")], ["Esc", t("action.back")]);
		return this.#frame(rows, help, width);
	}
}
