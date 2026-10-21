/**
 * TUI 技能市场面板（/skills）：分组列表 → 详情 → 预览/确认，逐层 Esc 回退。
 * 全部操作经 gateway 的 neko.skill-market 服务；安装/卸载结果提示下一次发送生效。
 */
import { ChordError } from "@earendil-works/chord";
import { Markdown, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { NekoGatewayClient, NekoMarketSkill } from "@neko-harness/gateway";
import type { PickerDetail, PickerItem, PickerPanel } from "./components/picker.ts";
import { shortcutHints as hint } from "./components/shortcut-hints.ts";
import { t } from "./i18n/index.ts";
import { getActiveThemeMode, getMarkdownTheme, style, theme } from "./theme/index.ts";

const scopeLabel = (scope: "user" | "project"): string =>
	scope === "user" ? t("skill.scope.user") : t("skill.scope.project");

const formatSize = (bytes: number): string =>
	bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;

const marketErrorCode = (error: unknown): string | null =>
	error instanceof ChordError ? (error.reason ?? null) : null;

const stateMarks = (skill: NekoMarketSkill): string =>
	`${skill.installed.user ? "[u]" : ""}${skill.installed.project ? "[p]" : ""}${skill.installed.builtin ? "[b]" : ""}`;

const toItems = (skills: readonly NekoMarketSkill[]): PickerItem[] => {
	const groups = new Map<string, NekoMarketSkill[]>();
	for (const skill of skills) {
		const list = groups.get(skill.category) ?? [];
		list.push(skill);
		groups.set(skill.category, list);
	}
	const items: PickerItem[] = [];
	for (const [category, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
		items.push({ value: `header:${category}`, label: `${category} (${members.length})`, header: true });
		for (const skill of members) {
			items.push({
				value: skill.name,
				label: skill.name,
				description: skill.description,
				searchText: `${skill.source} ${skill.category}`,
				rightLabel: `${skill.source} ${skill.version} ${stateMarks(skill)}`.trim(),
			});
		}
	}
	return items;
};

class SkillDetailView implements PickerDetail {
	#skill: NekoMarketSkill | null = null;
	#error = "";
	#notice = "";
	#busy = false;
	#confirm: { prompt: () => string; run: () => Promise<void> } | null = null;

	readonly #name: string;
	readonly #client: NekoGatewayClient;
	readonly #workspaceRoot: string;
	readonly #panel: PickerPanel;
	readonly #openPreview: (name: string) => void;

	constructor(
		name: string,
		client: NekoGatewayClient,
		workspaceRoot: string,
		panel: PickerPanel,
		openPreview: (name: string) => void,
	) {
		this.#name = name;
		this.#client = client;
		this.#workspaceRoot = workspaceRoot;
		this.#panel = panel;
		this.#openPreview = openPreview;
		void this.refresh();
	}

	get help(): string {
		if (this.#confirm) return hint(["y", t("action.confirm")], ["n", t("action.cancel")]);
		const skill = this.#skill;
		const builtinOnly = skill?.installed.builtin === true && !skill.installed.user && !skill.installed.project;
		return builtinOnly
			? hint(["v", t("action.preview")], ["Esc", t("action.back")])
			: hint(
					["u", t("action.installUser")],
					["p", t("action.installProject")],
					["d", t("action.remove")],
					["v", t("action.preview")],
					["Esc", t("action.back")],
				);
	}

	private async refresh(): Promise<void> {
		try {
			this.#skill = await this.#client.skillMarket.detail({ name: this.#name, workspaceRoot: this.#workspaceRoot });
			this.#error = "";
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
		this.#panel.changed();
	}

	handleKey(data: string): boolean {
		if (this.#confirm) {
			if (matchesKey(data, "y")) {
				const pending = this.#confirm;
				this.#confirm = null;
				void this.run(pending.run);
			} else if (matchesKey(data, "n")) {
				this.#confirm = null;
			}
			return true;
		}
		if (this.#busy || this.#skill === null) return true;
		const skill = this.#skill;
		const builtinOnly = skill.installed.builtin && !skill.installed.user && !skill.installed.project;
		if (matchesKey(data, "v")) {
			this.#openPreview(this.#name);
			return true;
		}
		if (builtinOnly) return true;
		if (matchesKey(data, "u")) this.askInstall("user", skill);
		else if (matchesKey(data, "p")) this.askInstall("project", skill);
		else if (matchesKey(data, "d")) this.askUninstall(skill);
		else return false;
		return true;
	}

	private askInstall(scope: "user" | "project", skill: NekoMarketSkill): void {
		const exists = scope === "user" ? skill.installed.user : skill.installed.project;
		const shadowed = scope === "user" && skill.installed.project;
		if (exists) {
			this.#confirm = {
				prompt: () =>
					t("skill.confirmOverwrite", { name: skill.name, scope: scopeLabel(scope), version: skill.version }),
				run: () => this.install(scope, true),
			};
		} else if (shadowed) {
			this.#confirm = {
				prompt: () => t("skill.confirmShadowed", { name: skill.name }),
				run: () => this.install(scope, false),
			};
		} else {
			void this.run(() => this.install(scope, false));
		}
	}

	private askUninstall(skill: NekoMarketSkill): void {
		const scope = skill.installed.project ? "project" : skill.installed.user ? "user" : null;
		if (scope === null) {
			this.#notice = t("skill.notInstalled");
			return;
		}
		this.#confirm = {
			prompt: () => t("skill.confirmUninstall", { name: skill.name, scope: scopeLabel(scope) }),
			run: async () => {
				await this.#client.skillMarket.uninstall({ name: this.#name, scope, workspaceRoot: this.#workspaceRoot });
				this.#notice = t("skill.uninstalled", { scope: scopeLabel(scope) });
			},
		};
	}

	private async install(scope: "user" | "project", overwrite: boolean): Promise<void> {
		try {
			const result = await this.#client.skillMarket.install({
				name: this.#name,
				scope,
				workspaceRoot: this.#workspaceRoot,
				overwrite,
			});
			this.#notice =
				result.shadowedBy === "project"
					? t("skill.installedShadowed")
					: t("skill.installed", { scope: scopeLabel(scope) });
		} catch (error) {
			// 竞态（列表陈旧、刚被其他端装上）：转成内联覆盖确认，按原作用域重试。
			if (marketErrorCode(error) === "skill_exists") {
				this.#confirm = {
					prompt: () => t("skill.confirmExists", { name: this.#name, scope: scopeLabel(scope) }),
					run: () => this.install(scope, true),
				};
				return;
			}
			throw error;
		}
	}

	private async run(action: () => Promise<void>): Promise<void> {
		this.#busy = true;
		this.#notice = "";
		this.#panel.changed();
		try {
			await action();
		} catch (error) {
			this.#notice = t("skill.failed", { message: error instanceof Error ? error.message : String(error) });
		} finally {
			this.#busy = false;
			await this.refresh();
		}
	}

	lines(width: number, _height: number): readonly string[] {
		if (this.#confirm) {
			return [theme.accent(t("action.confirm")), "", ...wrapTextWithAnsi(this.#confirm.prompt(), width), ""];
		}
		const skill = this.#skill;
		if (skill === null)
			return [
				this.#error !== "" ? theme.error(t("common.error", { message: this.#error })) : theme.dim(t("common.loading")),
			];
		const mark = (on: boolean, label: string) => (on ? theme.ok(`${label} ✓`) : theme.dim(`${label} —`));
		const state = [
			mark(skill.installed.project, t("skill.mark.project")),
			mark(skill.installed.user, t("skill.mark.user")),
			mark(skill.installed.builtin, t("skill.mark.builtin")),
		].join("  ");
		const rows = [
			`${style.bold(skill.name)}  ${theme.dim(skill.version)}`,
			theme.dim(
				`${skill.source} · ${skill.category} · ${formatSize(skill.sizeBytes)} · sha256 ${skill.sha256.slice(0, 10)}…`,
			),
			`${theme.dim(t("skill.installedLabel"))} ${state}${skill.activeLevel ? theme.dim(`  ${t("skill.active", { level: skill.activeLevel })}`) : ""}`,
			"",
			...wrapTextWithAnsi(skill.description, width),
		];
		if (this.#busy) rows.push("", theme.dim(t("skill.working")));
		if (this.#notice !== "") rows.push("", theme.accent(this.#notice));
		return rows;
	}
}

export class SkillPreviewView implements PickerDetail {
	#header: string | null = null;
	#renderTheme = getActiveThemeMode();
	#markdown: Markdown | null = null;
	#error = "";
	#offset = 0;
	#maxOffset = 0;
	#pageSize = 1;

	readonly #panel: PickerPanel;

	get help(): string {
		return hint(["↑↓/Wheel", t("action.scroll")], ["PgUp/PgDn", t("action.page")], ["Esc", t("action.back")]);
	}

	constructor(name: string, client: NekoGatewayClient, panel: PickerPanel) {
		this.#panel = panel;
		void client.skillMarket
			.preview({ name })
			.then((preview) => {
				// SKILL.md 正文走 Markdown 渲染（标题/列表/代码块有样式），文件清单保持等宽。
				this.#header = preview.files.join("  ");
				this.#markdown = new Markdown(preview.body, 0, 0, getMarkdownTheme());
				this.#panel.changed();
			})
			.catch((error: unknown) => {
				this.#error = error instanceof Error ? error.message : String(error);
				this.#panel.changed();
			});
	}

	scroll(delta: number): void {
		this.#offset = Math.max(0, Math.min(this.#maxOffset, this.#offset + delta));
	}
	handleKey(data: string): boolean {
		if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.#pageSize);
		else if (matchesKey(data, "pageDown")) this.scroll(this.#pageSize);
		else return false;
		return true;
	}

	lines(width: number, height: number): readonly string[] {
		if (this.#markdown === null || this.#header === null)
			return [
				this.#error !== ""
					? theme.error(t("common.error", { message: this.#error }))
					: theme.dim(t("skill.loadingPreview")),
			];
		if (this.#renderTheme !== getActiveThemeMode()) {
			this.#renderTheme = getActiveThemeMode();
			this.#markdown.invalidate();
		}
		const flat = [`${theme.dim(t("skill.files"))} ${this.#header}`, "", ...this.#markdown.render(width)];
		this.#pageSize = Math.max(1, height - 1);
		this.#maxOffset = Math.max(0, flat.length - height);
		this.#offset = Math.min(this.#offset, this.#maxOffset);
		return flat.slice(this.#offset, this.#offset + height);
	}
}

/** 打开市场面板：加载列表 → Enter 进详情（u/p/d/v 键位）。 */
export async function openSkillMarket(
	panel: PickerPanel,
	client: NekoGatewayClient,
	workspaceRoot: string,
): Promise<void> {
	const openPreview = (name: string) => panel.showDetail(new SkillPreviewView(name, client, panel));
	await panel.show(
		t("skill.marketTitle"),
		async () => toItems(await client.skillMarket.list({ workspaceRoot })),
		async (name) => new SkillDetailView(name, client, workspaceRoot, panel, openPreview),
	);
}
