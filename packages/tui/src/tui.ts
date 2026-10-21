import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	Container,
	Loader,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	type Text,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import type {
	ChatItem,
	ChatView,
	CredentialProviderId,
	NekoModelRef,
	StreamingToolCall,
	StreamingView,
} from "@neko-harness/core";
import { normalizeWorkspace } from "@neko-harness/core";
import { installedVersion } from "@neko-harness/core/application-updates";
import { compactInstructions, downloadImage, type ImageFile, uploadImage } from "@neko-harness/core/image-transfer";
import { promptHistory } from "@neko-harness/core/input-history";
import { sessionName } from "@neko-harness/core/session-display";
import {
	JOBS_UNSUPPORTED,
	jobsClient,
	PLAN_UNSUPPORTED,
	planClient,
	QUESTIONS_UNSUPPORTED,
	questionsClient,
	queueClient,
} from "@neko-harness/gateway/client-session";
import type { NekoChat } from "@neko-harness/gateway/contract";
import { ApprovalDock } from "./approval-dock.ts";
import { copyLastAnswer } from "./clipboard-write.ts";
import { compactionStatus } from "./compaction-status.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BoundedEditor } from "./components/editor.ts";
import { StatusFooter, usageText } from "./components/footer.ts";
import { HistoryImage, ImageTranscript } from "./components/history-image.ts";
import { JobReportNotice } from "./components/job-report.ts";
import { LoginPanel } from "./components/login.ts";
import { formatNotice, type NoticeLevel } from "./components/notice.ts";
import { PickerPanel } from "./components/picker.ts";
import { ThemedText, ThemedTruncatedText, ThemedWrappedText } from "./components/themed-text.ts";
import { type ToolCardState, ToolExecutionComponent, ToolSpinnerTicker } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { WelcomeScreen } from "./components/welcome.ts";
import { openContextPanel } from "./context-ui.ts";
import { detectColorFgBgMode, followTerminalTheme } from "./detect-theme.ts";
import { type ExportArgs, exportToFile, parseExportArgs } from "./export-command.ts";
import { fileCompletion } from "./file-completion.ts";
import { modelDisplayName } from "./format.ts";
import { connectToGateway, type NekoTuiGateway, resolveDataDir } from "./gateway.ts";
import { HelpDetail } from "./help-ui.ts";
import { localizeCoreText, localizeError, localizeStatus } from "./i18n/core-text.ts";
import { type Language, onLanguageChange, setLanguage, t } from "./i18n/index.ts";
import { clipboard, clipboardShortcutKey, imagePaths, isClipboardShortcut, readImageFile } from "./image-input.ts";
import { createInputRouter } from "./input-router.ts";
import { confirmStop, JobDetail, jobItems, jobsEmpty } from "./jobs-ui.ts";
import { commands } from "./labels.ts";
import { saveLanguage } from "./language-settings.ts";
import { openLanguagePanel } from "./language-ui.ts";
import { createAppLayout, usableSize } from "./layout.ts";
import { plainText } from "./plain-text.ts";
import { PlanDock } from "./plan-dock.ts";
import { isProviderRejection, modelKey, openModelPanel, providerSendBlock } from "./provider-ui.ts";
import { canAutoOpen, QuestionDock } from "./question-dock.ts";
import { QueueRow, queueKeyAction, restoreText, steerNotice, withdrawNotice } from "./queue-ui.ts";
import { openSearchPanel } from "./search-ui.ts";
import { createShellNotifier } from "./shell-notice.ts";
import { openSkillMarket } from "./skill-market-ui.ts";
import { SubagentDetail, subagentItems } from "./subagents-ui.ts";
import {
	getActiveThemeMode,
	getEditorTheme,
	loadAllHighlightLanguages,
	setActiveTheme,
	type ThemeMode,
	type ThemePreference,
	theme,
} from "./theme/index.ts";
import { showTodos, todoProgressText } from "./todos-ui.ts";
import { openVersion, versionNotice } from "./version-ui.ts";
import { recentlyVisited, sessionPickerItems } from "./workspace.ts";

export type NekoTuiOptions = {
	/** 新会话工具的工作目录；默认 process.cwd()。 */
	readonly cwd?: string;
	/** gateway Unix socket 路径；默认按配置/数据目录解析。 */
	readonly socketPath?: string;
	/** 存储文件路径：解析默认 socket + 透传给拉起的 gateway。 */
	readonly storagePath?: string;
	/** 模型；默认内置 DeepSeek 模型（透传给拉起的 gateway）。 */
	readonly model?: NekoModelRef;
	/** 主题：light / dark / auto（默认 auto，按终端背景自动选择）。 */
	readonly theme?: ThemePreference;
	/** 界面语言（已按 --lang > NEKO_LANG > 保存值 > zh 解析）；省略则沿用当前进程语言。 */
	readonly language?: Language;
	/** 数据目录：`/language` 把选择写入其中的 tui.json；省略则按存储路径与配置解析。 */
	readonly dataDir?: string;
};

const EXIT_COMMANDS = new Set(["/exit", "/quit"]);
const SESSIONS_COMMANDS = new Set(["/sessions", "/session"]);
const NEW_SESSION_VALUE = "__new__";
/** /think 接受的 thinking level（pi-ai ModelThinkingLevel）。 */

type ItemEntry =
	| { readonly kind: "user"; readonly component: UserMessageComponent }
	| { readonly kind: "assistant"; readonly component: AssistantMessageComponent }
	| { readonly kind: "tool"; readonly component: ToolExecutionComponent }
	| { readonly kind: "system"; readonly component: Text }
	| { readonly kind: "job-report"; readonly component: JobReportNotice };

/**
 * neko 终端界面：gateway 客户端（design D3/D4），底部输入框 + 消息区（流式渲染）+
 * 工具卡片 + 状态栏。数据来自 neko.chat 的 ChatView 投影订阅；会话目录/管理经
 * neko.session-directory / neko.session-management。
 */
class NekoTuiApp {
	readonly #commands = commands();
	#languageStop?: () => void;
	#refreshVersion: (() => void) | undefined;
	readonly #gateway: NekoTuiGateway;
	readonly #options: NekoTuiOptions;
	readonly #ui: TuiAltScreen;
	readonly #imageTranscript = new ImageTranscript(() => this.#transcript);
	readonly #notices = new Container();
	readonly #versionNotice = new Container();
	#versionStop?: () => void;
	#shellStop?: () => void;
	#versionTimer?: ReturnType<typeof setInterval>;
	readonly #terminal = new ProcessTerminal();
	readonly #panel: PickerPanel;
	readonly #approval: ApprovalDock;
	readonly #question: QuestionDock;
	readonly #plan: PlanDock;
	readonly #login: LoginPanel;
	#thinkingModel: string | undefined;
	#imageWarningModel: string | undefined;
	#sessionPanelTimer: ReturnType<typeof setInterval> | undefined;
	#sessionOperation = false;
	#noticeTimer: ReturnType<typeof setTimeout> | undefined;
	#compactionTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #editor: BoundedEditor;
	#historyItems: ChatView["items"] | undefined;
	readonly #footer = new StatusFooter();
	/** 空会话欢迎屏(design D10):转录为空且不忙碌时挂载,首条消息到达即移除。 */
	readonly #welcome = new WelcomeScreen();
	#welcomeAttached = false;
	/** 忙碌行(design D7):accent spinner + muted 状态文案,仅忙碌时可见。 */
	readonly #busyLoader: Loader;
	/** 运行中工具卡的动画驱动:仅在有运行中工具时运转(design D6)。 */
	readonly #toolSpinner = new ToolSpinnerTicker(() => this.#onToolSpinnerTick());

	#chat: NekoChat | undefined;
	#agentsPanel = false;
	#jobsPanel = false;
	#queueBusy = false;
	/** Skills of the attached session; completion entries are built per language when the list is synced. */
	#skills: { name: string; description: string }[] = [];
	#commandCaps = "";
	#switching = false;
	readonly #queueRow = new QueueRow();
	#searchStop: (() => void) | undefined;
	#contextStop: (() => void) | undefined;
	#modelStop: (() => void) | undefined;
	#agentDetails = new Map<string, SubagentDetail>();
	#sessionId = "";
	#viewUnsubscribe: (() => void) | undefined;
	#directoryUnsubscribe: (() => void) | undefined;

	/** 已渲染条目 key 序列（前缀比较检测重建）。 */
	#renderedKeys: string[] = [];
	#items = new Map<string, ItemEntry>();
	#imageKeys = new Set<string>();
	#imageComponents = new Map<string, HistoryImage>();
	#toolCards = new Map<string, ToolExecutionComponent>();
	#streamingComp: AssistantMessageComponent | undefined;
	#transcript: ScrollView | undefined;
	#busyText: string | undefined;
	#imageCounter = 0;
	#clipboardPending = false;
	#draftEpoch = 0;
	#imageDrafts = new Map<string, Map<string, Promise<ImageFile>>>();
	#texts = new Map<string, string>();
	#sending = new Set<string>();
	#retryRequests = new Map<string, { text: string; id: string }>();

	#lastView: ChatView | undefined;
	#applying = false;
	#applyQueued = false;
	#terminalSchemeUnsubscribe: (() => void) | undefined;
	#themePreference: ThemePreference;
	#exited: Promise<void>;
	#resolveExit: () => void = () => {};
	#exitStarted = false;

	constructor(gateway: NekoTuiGateway, options: NekoTuiOptions, themePreference: ThemePreference) {
		this.#gateway = gateway;
		this.#options = options;
		this.#themePreference = themePreference;
		// 首帧前的临时主题：auto 先用 COLORFGBG（无则浅色），OSC 11 应答后再修正。
		setActiveTheme(themePreference === "auto" ? (detectColorFgBgMode() ?? "light") : themePreference);
		this.#ui = new TuiAltScreen(this.#terminal);
		this.#footer.onOpenAgents = () => this.#showAgents();
		this.#approval = new ApprovalDock(
			(id) => this.#gateway.client.subagent(id),
			() => this.#ui.requestRender(),
		);
		this.#busyLoader = new Loader(this.#ui, theme.accent, theme.muted);
		this.#editor = new BoundedEditor(this.#ui, getEditorTheme(), { paddingX: 1, autocompleteMaxVisible: 3 });
		this.#question = new QuestionDock({
			changed: () => this.#ui.requestRender(),
			notify: (message, level) => this.addNotice(message, level),
			aside: () => (this.#approval.visible ? t("approval.aside") : undefined),
			opened: (open) => {
				this.#ui.setFocus(open ? this.#question : this.#editor);
				if (open) this.#queueRow.clear();
				if (this.#lastView) this.#syncFooter(this.#lastView);
				this.#ui.requestRender();
			},
		});
		this.#plan = new PlanDock({
			changed: () => this.#ui.requestRender(),
			notify: (message, level) => this.addNotice(message, level),
			aside: () => (this.#approval.visible ? t("approval.aside") : undefined),
			opened: (open) => {
				this.#ui.setFocus(open ? this.#plan : this.#editor);
				if (open) this.#queueRow.clear();
				if (this.#lastView) this.#syncFooter(this.#lastView);
				this.#ui.requestRender();
			},
		});
		this.#panel = new PickerPanel(
			() => this.#ui.requestRender(),
			() => {
				this.#thinkingModel = undefined;
				this.#agentsPanel = false;
				this.#jobsPanel = false;
				this.#searchStop?.();
				this.#searchStop = undefined;
				this.#contextStop?.();
				this.#contextStop = undefined;
				this.#modelStop?.();
				this.#modelStop = undefined;
				clearInterval(this.#sessionPanelTimer);
				this.#sessionPanelTimer = undefined;
				this.#ui.setFocus(this.#question.open ? this.#question : this.#plan.open ? this.#plan : this.#editor);
			},
		);
		// Pi consumes viewport paging before focused-component keys; route its public
		// scrolling entry point to the visible detail (agents, skill previews or help).
		const scrollMain = this.#ui.scrollBy.bind(this.#ui);
		this.#ui.scrollBy = (lines) => {
			if (this.#question.open) {
				this.#question.scroll(lines);
				return;
			}
			if (this.#plan.open) {
				this.#plan.scroll(lines);
				return;
			}
			if (this.#approval.focused) {
				this.#approval.scroll(lines);
				return;
			}
			if (this.#panel.open) {
				// The hidden main ScrollView has no viewport; use the visible panel's page.
				this.#panel.scrollDetail(Math.sign(lines) * Math.max(1, this.#panel.height - 3));
				return;
			}
			scrollMain(lines);
		};
		this.#login = new LoginPanel({
			changed: () => this.#ui.requestRender(),
			closed: () => this.#ui.setFocus(this.#editor),
			save: async (provider, key) => {
				await this.#gateway.client.credentials.save({ provider, key });
			},
			remove: async (provider) => {
				await this.#gateway.client.credentials.remove({ provider });
			},
			toggle: async (provider, enabled) => {
				await this.#gateway.client.credentials.setEnabled({ provider, enabled });
			},
		});
		const complete = fileCompletion(
			this.#commands,
			options.cwd ?? process.cwd(),
			(text) => this.addNotice(text),
			(query, signal) =>
				this.#gateway.client.host.root(
					(ctx) =>
						this.#gateway.client.workspaceFiles.search(
							{ workspaceRoot: this.#lastView?.cwd ?? options.cwd ?? process.cwd(), query },
							ctx,
						),
					{ signal },
				),
		);
		const original = complete.applyCompletion.bind(complete);
		complete.applyCompletion = (lines, line, col, item, prefix) => {
			const result = original(lines, line, col, item, prefix);
			const paths = imagePaths(item.value.replace(/^@/, ""));
			if (paths?.length === 1) {
				queueMicrotask(() => {
					const before = this.#editor.getText();
					const session = this.#sessionId;
					void this.addImagePaths(paths)
						.then((refs) => {
							if (session === this.#sessionId && this.#editor.getText() === before)
								this.#editor.setText(before.replace(item.value, refs));
							this.#ui.requestRender();
						})
						.catch((e) => this.addNotice(messageOf(e), "error"));
				});
			}
			return result;
		};
		this.#editor.setAutocompleteProvider(complete);
		this.#editor.isImageReference = (ref) => this.#imageDrafts.get(this.#sessionId)?.has(ref) ?? false;
		this.#editor.onClearDraft = () => {
			this.#draftEpoch++;
			this.#texts.delete(this.#sessionId);
			this.#retryRequests.delete(this.#sessionId);
		};
		this.#editor.onSubmit = (text) => {
			this.submit(text);
		};
		this.#exited = new Promise<void>((resolve) => {
			this.#resolveExit = resolve;
		});
		this.#ui.addInputListener(
			createInputRouter({
				size: () => this.#terminal,
				editor: this.#editor,
				approval: this.#approval,
				question: this.#question,
				plan: this.#plan,
				overlayOpen: () => this.#panel.open || this.#login.open,
				busy: () => this.#busyText !== undefined,
				compactionActive: () => !!this.#lastView?.compaction?.active.length,
				// 会话浮层打开时把 Escape 留给浮层（SelectList 取消）。
				compactionStoppable: () =>
					!!this.#lastView?.compaction?.active.some((c) => c.reason === "manual" || c.blocking),
				sessionOperation: () => this.#sessionOperation,
				queueKey: (data) => this.#queueKey(data),
				hasSubagents: () => !!this.#lastView?.subagents?.length,
				showAgents: () => this.#showAgents(),
				toggleQuestion: () => this.#toggleQuestion(),
				togglePlan: () => this.#togglePlan(),
				clipboardKey: (data) => {
					if (!matchesKey(data, clipboardShortcutKey())) return false;
					if (isClipboardShortcut(data)) void this.pasteClipboard();
					return true;
				},
				pasteImages: (data) => {
					if (
						!(
							(data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) ||
							(data.length > 3 && /^["']?[~/]/.test(data))
						)
					)
						return false;
					const paths = imagePaths(data.startsWith("\x1b[200~") ? data.slice(6, -6) : data);
					if (!paths) return false;
					const session = this.#sessionId;
					void this.addImagePaths(paths)
						.then((refs) => {
							if (session === this.#sessionId) this.#editor.insertTextAtCursor(refs);
							this.#ui.requestRender();
						})
						.catch((e) => this.addNotice(messageOf(e), "error"));
					return true;
				},
				openSessions: () => this.openSessionsOverlay(),
				abort: () => this.abort(),
				exit: () => this.exit(),
			}),
		);
	}

	async run(initialSessionId: string): Promise<void> {
		this.#gateway.client.link.onClose(() => {
			if (this.#exitStarted) return;
			this.#chat = undefined;
			this.#question.setOnline(false);
			this.#plan.setOnline(false);
			if (this.#lastView) this.applyView({ ...this.#lastView, busy: false, status: null, streaming: null });
			this.addNotice(t("gateway.unavailable"), "error");
		});
		const picker = this.#panel,
			login = this.#login;
		const content = new Container();
		content.addChild(this.#imageTranscript);
		this.#transcript = new ScrollView(content, { follow: "end", primary: true, overscroll: "chain" });
		const notices = new Container();
		notices.addChild(this.#notices);
		notices.addChild(this.#versionNotice);
		this.#ui.setLayoutRoot(
			createAppLayout({
				transcript: this.#transcript,
				panel: {
					get height() {
						return picker.height;
					},
					set height(value: number) {
						picker.height = value;
						login.height = value;
					},
					render: (width: number) => {
						const active = this.#login.open ? this.#login : this.#panel;
						return active.render(width);
					},
					handleMouse: (event) => (this.#login.open ? undefined : this.#panel.handleMouse(event)),
					invalidate: () => {},
				},
				approval: this.#approval,
				// The open question panel owns the keys; a waiting approval folds into a hint inside it.
				approvalVisible: () => this.#approval.visible && !this.#question.open && !this.#plan.open,
				question: this.#question,
				questionVisible: () => this.#question.visible,
				plan: this.#plan,
				planVisible: () => this.#plan.open,
				editor: this.#editor,
				footer: this.#footer,
				notices,
				busy: this.#busyLoader,
				busyVisible: () => this.#busyText !== undefined,
				queue: this.#queueRow,
				queueVisible: () => this.#queueRow.visible,
				panelOpen: () => this.#panel.open || this.#login.open,
			}),
		);
		this.#ui.setFocus(this.#editor);

		this.#directoryUnsubscribe = this.#gateway.client.directory.state.subscribe(() => {
			if (this.#sessionPanelTimer) this.#panel.update(this.sessionItems());
			this.#ui.requestRender();
		});
		const refreshVersion = async () => {
			const installed = await installedVersion();
			if (this.#exitStarted) return;
			const notice = versionNotice(this.#gateway.client.application.info.value, installed);
			this.#versionNotice.clear();
			if (notice) this.#versionNotice.addChild(new ThemedTruncatedText(() => formatNotice(notice, "info"), 1, 0));
			this.#ui.requestRender();
		};
		this.#refreshVersion = () => void refreshVersion();
		this.#languageStop = onLanguageChange(() => this.#onLanguageChanged());
		this.#versionStop = this.#gateway.client.application.info.subscribe(() => void refreshVersion());
		const notifyShell = createShellNotifier((text) => this.addNotice(text, "warning", { wrap: true, ttlMs: 20_000 }));
		const checkShell = () => notifyShell(this.#gateway.client.application.info.value?.shell);
		this.#shellStop = this.#gateway.client.application.info.subscribe(checkShell);
		this.#versionTimer = setInterval(() => void refreshVersion(), 30000);
		void refreshVersion();
		await this.switchSession(initialSessionId);
		this.#ui.start();
		this.#ui.requestRender(true);
		checkShell();
		// 首帧后注册剩余高亮语言(不阻塞启动;失败容忍)。
		void loadAllHighlightLanguages();
		this.#startThemeDetection();
		await this.#exited;
		this.#versionStop?.();
		this.#shellStop?.();
		this.#languageStop?.();
		clearInterval(this.#versionTimer);
		this.#viewUnsubscribe?.();
		this.#directoryUnsubscribe?.();
		this.#toolSpinner.stop();
		this.#busyLoader.stop();
		clearInterval(this.#sessionPanelTimer);
		this.#terminalSchemeUnsubscribe?.();
		this.#closeOverlay();
		clearTimeout(this.#noticeTimer);
		clearTimeout(this.#compactionTimer);
		this.#ui.stop();
	}

	// —— 提交与运行控制 ——

	/**
	 * Enter 提交。空闲：正常提交；忙碌：steer（插入当前工具轮之后）。
	 * 斜杠命令：/exit、/quit、/sessions、/model、/think <level>、/fork、/archive。
	 */
	submit(text: string): void {
		const trimmed = text.trim();
		if (trimmed === "") return;
		if (trimmed === "/help") {
			if (!this.#panel.open && !this.#login.open) {
				void this.#panel.show(
					t("help.title"),
					async () => [],
					async () => {},
				);
				this.#panel.showDetail(new HelpDetail());
				this.#ui.setFocus(this.#panel);
			}
			return;
		}
		if (trimmed === "/agents") {
			this.#showAgents();
			return;
		}
		if (trimmed === "/jobs") {
			this.#showJobs();
			return;
		}
		if (trimmed === "/todos") {
			this.#showTodos();
			return;
		}
		if (trimmed === "/question") {
			this.#toggleQuestion();
			return;
		}
		if (trimmed === "/plan" || trimmed.startsWith("/plan ")) {
			if (trimmed === "/plan") this.#togglePlan(text);
			else this.addNotice(t("plan.usage"), "warning");
			return;
		}
		if (trimmed === "/search") {
			this.#showSearch();
			return;
		}
		if (trimmed === "/context") {
			this.#showContext();
			return;
		}
		if (trimmed === "/language") {
			void this.openLanguageOverlay();
			return;
		}
		const instructions = compactInstructions(trimmed);
		if (instructions !== null) {
			const chat = this.#chat;
			const session = this.#sessionId;
			if (chat)
				void chat.compact({ instructions }).catch((e) => {
					if (session === this.#sessionId) {
						this.#editor.setText(text);
						this.addNotice(messageOf(e), isProviderRejection(rawMessageOf(e)) ? "warning" : "error");
					}
				});
			return;
		}
		if (EXIT_COMMANDS.has(trimmed)) {
			this.exit();
			return;
		}
		if (SESSIONS_COMMANDS.has(trimmed)) {
			this.openSessionsOverlay();
			return;
		}
		if (trimmed === "/login") {
			this.#showLogin();
			return;
		}
		if (trimmed.startsWith("/login ")) {
			this.addNotice(t("login.useLogin"), "warning");
			return;
		}
		if (trimmed === "/model") {
			void this.openModelOverlay();
			return;
		}
		if (trimmed === "/theme") {
			void this.openThemeOverlay();
			return;
		}
		if (trimmed === "/new") {
			void this.#manage(() => this.createSession());
			return;
		}
		if (trimmed === "/version") {
			if (!this.#exitStarted && !this.#panel.open && !this.#login.open) {
				void openVersion(
					this.#panel,
					async () => ({
						state: this.#gateway.client.application.info.value,
						installed: await installedVersion(),
					}),
					() => this.#gateway.client.application.check(null),
				);
				this.#ui.setFocus(this.#panel);
			}
			return;
		}
		if (trimmed === "/skills") {
			void this.openSkillsOverlay();
			return;
		}
		if (trimmed.startsWith("/think")) {
			void this.configureThinking(trimmed.slice("/think".length).trim());
			return;
		}
		if (trimmed === "/fork") {
			void this.#manage(() => this.forkSession());
			return;
		}
		if (trimmed === "/archive") {
			void this.#manage(() => this.archiveSession());
			return;
		}
		if (trimmed === "/copy") {
			void this.#copyLastAnswer();
			return;
		}
		if (trimmed === "/export" || trimmed.startsWith("/export ")) {
			void this.#exportSession(trimmed.slice("/export".length));
			return;
		}
		const chat = this.#chat;
		if (chat === undefined) return;
		const blocked = providerSendBlock(this.#lastView?.agent.model, this.#gateway.client.credentials.state.value);
		if (blocked) {
			this.#editor.setText(text);
			this.addNotice(blocked, "warning");
			return;
		}
		void this.sendImages(text);
	}
	private async addImagePaths(paths: string[]): Promise<string> {
		return paths
			.map((path) =>
				this.addImage(
					readImageFile(path, this.#options.cwd ?? process.cwd()),
					path.split(/[\\/]/).at(-1) ?? t("image.defaultName"),
				),
			)
			.join(" ");
	}
	private addImage(file: Promise<ImageFile>, name: string): string {
		const ref = `[Image ${++this.#imageCounter}: ${name.replace(/[\]\r\n]/g, "")}]`;
		let images = this.#imageDrafts.get(this.#sessionId);
		if (!images) {
			images = new Map();
			this.#imageDrafts.set(this.#sessionId, images);
		}
		images.set(ref, file);
		void file.catch(() => {});
		return ref;
	}
	private async pasteClipboard(): Promise<void> {
		if (this.#clipboardPending) return;
		this.#clipboardPending = true;
		const epoch = this.#draftEpoch;
		const session = this.#sessionId;
		try {
			const data = await clipboard();
			if (
				epoch !== this.#draftEpoch ||
				session !== this.#sessionId ||
				this.#exitStarted ||
				this.#login.open ||
				this.#panel.open
			)
				return;
			const text = data.image
				? this.addImage(Promise.resolve(data.image), data.image.name)
				: data.paths
					? await this.addImagePaths(data.paths)
					: (data.text ?? "");
			this.#editor.insertTextAtCursor(text);
			this.#ui.requestRender();
		} catch (e) {
			this.addNotice(t("clipboard.unavailable", { message: rawMessageOf(e) }), "warning");
		} finally {
			this.#clipboardPending = false;
		}
	}
	private async sendImages(text: string): Promise<void> {
		const chat = this.#chat;
		const session = this.#sessionId;
		if (!chat || this.#sending.has(session)) return;
		this.#sending.add(session);
		this.#editor.setText(text);
		const refs = [...(this.#imageDrafts.get(session) ?? [])]
			.filter(([ref]) => text.includes(ref))
			.sort((a, b) => text.indexOf(a[0]) - text.indexOf(b[0]));
		const ids: string[] = [];
		const before = text;
		const modelRef = this.#lastView?.agent.model;
		const old = this.#retryRequests.get(session);
		const requestId = old?.text === text ? old.id : crypto.randomUUID();
		this.#retryRequests.set(session, { text, id: requestId });
		try {
			const models = await this.#gateway.client.models.list(null);
			const model = models.find((m) => m.provider === modelRef?.provider && m.modelId === modelRef?.modelId);
			if (refs.length && !model?.input.includes("image")) throw new Error(t("image.unsupported"));
			if (refs.length > 4) throw new Error(t("image.tooMany"));
			let content = text;
			for (const [ref, promise] of refs) {
				const file = await promise;
				ids.push(
					await uploadImage(file, {
						begin: (i) => chat.beginImage(i),
						append: (i) => chat.appendImage(i),
						finish: (id) => chat.finishImage(id),
						release: (id) => chat.releaseImage(id),
					}),
				);
				content = content.replaceAll(ref, "");
			}
			await chat.submit({ content: content.trim(), images: ids, requestId });
			if (session === this.#sessionId && this.#editor.getText() === before) this.#editor.setText("");
			if (this.#texts.get(session) === before) this.#texts.delete(session);
			const remaining = session === this.#sessionId ? this.#editor.getText() : (this.#texts.get(session) ?? "");
			for (const [ref] of refs) if (!remaining.includes(ref)) this.#imageDrafts.get(session)?.delete(ref);
			this.#retryRequests.delete(session);
		} catch (e) {
			if (session === this.#sessionId) {
				const message = rawMessageOf(e);
				this.addNotice(localizeError(message), isProviderRejection(message) ? "warning" : "error");
			}
		} finally {
			for (const id of ids) await chat.releaseImage(id).catch(() => {});
			this.#sending.delete(session);
			this.#ui.requestRender();
		}
	}

	/** /copy：最后一条回答（不含 thinking）写入剪贴板；只取已提交条目，忙碌时同样可用。 */
	async #copyLastAnswer(): Promise<void> {
		const outcome = await copyLastAnswer(this.#lastView?.items ?? [], {
			osc52: (sequence) => this.#terminal.write(sequence),
		});
		this.addNotice(outcome.message, outcome.level);
	}

	/** /export：发起时快照转录与 chat 句柄，写入文件；期间切换会话不影响导出内容。 */
	async #exportSession(argumentText: string): Promise<void> {
		const view = this.#lastView;
		const chat = this.#chat;
		const sessionId = this.#sessionId;
		if (view === undefined || chat === undefined) {
			this.addNotice(t("export.noSession"), "warning");
			return;
		}
		let args: ExportArgs;
		try {
			args = parseExportArgs(argumentText);
		} catch (error) {
			this.addNotice(messageOf(error), "warning", { wrap: true });
			return;
		}
		const summary = this.#gateway.client.directory.state.value.sessions.find((s) => s.id === sessionId);
		const title = summary ? sessionName(summary, "") : "";
		this.addNotice(t("export.exporting"));
		try {
			const { path, skippedImages } = await exportToFile({
				...args,
				cwd: this.#options.cwd ?? process.cwd(),
				source: { sessionId, title, model: view.model, cwd: view.cwd, exportedAt: new Date(), items: view.items },
				loadImage: (image) =>
					downloadImage((offset) =>
						chat.getImage({ entryId: image.entryId, contentIndex: image.contentIndex, offset }),
					),
			});
			const other = sessionId !== this.#sessionId ? t("export.otherSession", { name: title || sessionId }) : "";
			const skipped = skippedImages > 0 ? t("export.skippedImages", { count: skippedImages }) : "";
			this.addNotice(t("export.done", { other, path, skipped }), "info", { wrap: true, ttlMs: 20000 });
		} catch (error) {
			this.addNotice(t("export.failed", { message: rawMessageOf(error) }), "error", { wrap: true, ttlMs: 20000 });
		}
	}

	abort(): void {
		const chat = this.#chat;
		if (chat === undefined) return;
		chat.abort(null).catch((error: unknown) => this.addNotice(messageOf(error), "error"));
	}

	exit(): void {
		if (this.#exitStarted) return;
		this.#exitStarted = true;
		this.#approval.close();
		this.#question.dispose();
		this.#plan.dispose();
		for (const detail of this.#agentDetails.values()) detail.close();
		this.#resolveExit();
	}

	// —— 会话管理 ——

	/** 切换 attach 的会话：重建转录（提交后的状态为准，重连即取最新快照）。 */
	async switchSession(id: string): Promise<void> {
		this.#approval.close();
		this.#question.bind(id, undefined);
		this.#plan.bind(id, undefined);
		this.#chat = undefined;
		this.#queueRow.setItems([]);
		if (this.#jobsPanel && this.#panel.open) this.#panel.close();
		if (this.#sessionId) this.#texts.set(this.#sessionId, this.#editor.getText());
		this.#viewUnsubscribe?.();
		this.#viewUnsubscribe = undefined;
		for (const detail of this.#agentDetails.values()) detail.close();
		this.#agentDetails.clear();
		const handle = await this.#gateway.client.attach(id);
		this.#chat = handle;
		this.#sessionId = id;
		this.#question.bind(id, questionsClient(handle));
		this.#plan.bind(id, planClient(handle));
		void this.#refreshSkills(handle);
		this.#editor.setText(this.#texts.get(id) ?? "");
		this.#editor.setHistory([]);
		this.#historyItems = undefined;
		this.#resetTranscript();
		const view = handle.view;
		// A question already waiting here may open once the sessions picker that led here has closed.
		this.#switching = true;
		try {
			this.applyView(view.value);
		} finally {
			this.#switching = false;
		}
		setImmediate(() => this.#autoOpenQuestion());
		this.#viewUnsubscribe = view.subscribe(() => {
			this.scheduleApply();
		});
		this.#syncEditorBorder();
		this.#ui.requestRender(true);
	}

	/** 拉取当前会话的技能列表进补全命令表（数组与 fileCompletion 共享，原地更新即生效）。 */
	async #refreshSkills(handle: NekoChat): Promise<void> {
		this.#skills = [];
		this.#syncCommands(this.#lastView);
		try {
			const skills = await handle.skills(null);
			if (handle !== this.#chat) return;
			this.#skills = skills.map((skill) => ({ name: skill.name, description: skill.description }));
			this.#syncCommands(this.#lastView);
		} catch {
			/* completion keeps the static commands */
		}
	}

	/** Completion list: the static commands, minus those the gateway cannot serve, plus the session's skills. */
	#syncCommands(view: ChatView | undefined): void {
		const hidden = view ? hiddenCommands(view) : new Set<string>();
		this.#commandCaps = [...hidden].join(",");
		this.#commands.splice(
			0,
			this.#commands.length,
			...commands().filter((c) => !hidden.has(c.name)),
			...this.#skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				argumentHint: t("command.skillArgs"),
			})),
		);
	}

	async #manage(operation: () => Promise<void>): Promise<void> {
		if (this.#sessionOperation) return;
		this.#sessionOperation = true;
		try {
			await operation();
		} catch (error) {
			this.addNotice(t("session.operationFailed", { message: messageOf(error) }), "error");
		} finally {
			this.#sessionOperation = false;
		}
	}
	async createSession(): Promise<void> {
		const created = await this.#gateway.client.management.create({
			...(this.#options.cwd !== undefined ? { cwd: this.#options.cwd } : {}),
		});
		await this.switchSession(created.id);
	}

	async forkSession(): Promise<void> {
		const forked = await this.#gateway.client.management.fork(this.#sessionId);
		await this.switchSession(forked.id);
	}

	async archiveSession(): Promise<void> {
		const current = this.#sessionId;
		await this.#gateway.client.management.archive(current);
		const next = recentlyVisited(this.#gateway.client.directory.state.value.sessions, this.#options.cwd!).find(
			(s) => s.id !== current,
		);
		if (next) await this.switchSession(next.id);
		else await this.createSession();
	}

	// —— 会话浮层 ——

	private sessionItems() {
		return [
			{ value: NEW_SESSION_VALUE, label: t("session.new"), description: this.#options.cwd },
			...sessionPickerItems(this.#gateway.client.directory.state.value.sessions, this.#options.cwd!, this.#sessionId),
		];
	}
	openSessionsOverlay(): void {
		if (this.#exitStarted || this.#panel.open || this.#login.open) return;
		void this.#panel.show(
			t("session.title", { cwd: this.#options.cwd ?? "" }),
			async () => this.sessionItems(),
			async (value) => {
				if (value === NEW_SESSION_VALUE) await this.createSession();
				else if (value !== this.#sessionId) await this.switchSession(value);
			},
		);
		this.#sessionPanelTimer = setInterval(() => this.#panel.update(this.sessionItems()), 60_000);
		this.#ui.setFocus(this.#panel);
	}

	/** 技能市场面板：浏览/详情/预览/两级安装与卸载（gateway neko.skill-market）。 */
	async openSkillsOverlay(): Promise<void> {
		if (this.#exitStarted || this.#panel.open || this.#login.open) return;
		const workspace = this.#options.cwd ?? process.cwd();
		const ready = openSkillMarket(this.#panel, this.#gateway.client, workspace);
		this.#ui.setFocus(this.#panel);
		await ready;
	}

	async openModelOverlay(): Promise<void> {
		if (this.#exitStarted || this.#panel.open || this.#login.open) return;
		const chat = this.#chat;
		const current = this.#lastView?.agent.model;
		this.#modelStop = openModelPanel(
			this.#panel,
			this.#gateway.client,
			current,
			async (selected) => {
				await chat?.configure({ model: { provider: selected.provider, modelId: selected.modelId } });
			},
			(message) => this.addNotice(message, "error"),
		);
		this.#ui.setFocus(this.#panel);
	}

	/** /language 浮层：中文 / English，即选即生效并保存为默认。 */
	async openLanguageOverlay(): Promise<void> {
		if (this.#exitStarted || this.#panel.open || this.#login.open) return;
		const ready = openLanguagePanel(this.#panel, (language) => this.#chooseLanguage(language));
		this.#ui.setFocus(this.#panel);
		await ready;
	}

	/** 选定语言：先在进程内生效（保存失败也不回退），再写入 tui.json；只有这里写保存值。 */
	#chooseLanguage(language: Language): void {
		setLanguage(language);
		const dir = this.#options.dataDir;
		if (dir === undefined) return;
		const result = saveLanguage(dir, language);
		if (result.ok) this.addNotice(t("language.set", { name: t(`language.name.${language}`) }));
		else this.addNotice(t("language.saveFailed", { message: result.error.message }), "warning", { wrap: true });
	}

	/** 语言切换后重建命令列表并按新语言重绘；草稿、附件、排队项、滚动位置与运行中的会话都不动。 */
	#onLanguageChanged(): void {
		if (this.#exitStarted) return;
		this.#syncCommands(this.#lastView);
		this.#refreshVersion?.();
		if (this.#lastView !== undefined) this.applyView(this.#lastView);
		this.#ui.invalidate();
		this.#ui.requestRender();
	}

	/** /theme 浮层:进程内主题偏好(auto 跟随终端 / 明确明暗),即选即生效。 */
	async openThemeOverlay(): Promise<void> {
		if (this.#exitStarted || this.#panel.open || this.#login.open) return;
		const options: Array<{ value: ThemePreference; label: string; description: string }> = [
			{ value: "auto", label: t("theme.auto"), description: t("theme.autoDescription") },
			{ value: "light", label: t("theme.light"), description: t("theme.lightDescription") },
			{ value: "dark", label: t("theme.dark"), description: t("theme.darkDescription") },
		];
		const ready = this.#panel.show(
			t("theme.title"),
			async () =>
				options.map((option) => ({
					value: option.value,
					label: `${option.label}${option.value === this.#themePreference ? t("common.currentSuffix") : ""}`,
					description: option.description,
				})),
			async (value) => {
				this.#setThemePreference(value as ThemePreference);
			},
		);
		this.#ui.setFocus(this.#panel);
		await ready;
	}

	/** 进程内主题偏好:auto 恢复跟随终端;明确明暗则取消订阅并立即套用。 */
	#setThemePreference(preference: ThemePreference): void {
		if (preference === this.#themePreference) return;
		this.#themePreference = preference;
		if (preference === "auto") {
			this.#startThemeDetection();
			return;
		}
		this.#terminalSchemeUnsubscribe?.();
		this.#terminalSchemeUnsubscribe = undefined;
		this.#ui.setTerminalColorSchemeNotifications(false);
		this.#applyThemeMode(preference);
	}

	async configureThinking(raw: string): Promise<void> {
		if (this.#panel.open || this.#login.open) return;
		const chat = this.#chat;
		const ref = this.#lastView?.agent.model;
		if (!chat || !ref) return;
		try {
			const model = (await this.#gateway.client.models.list(null)).find(
				(m) => m.provider === ref.provider && m.modelId === ref.modelId,
			);
			if (chat !== this.#chat || this.#exitStarted || this.#panel.open || this.#login.open) return;
			if (!model) {
				this.addNotice(t("think.modelUnavailable"), "warning");
				return;
			}
			if (raw) {
				const level = model.supportedThinkingLevels.find((value) => value === raw);
				if (!level) {
					this.addNotice(t("think.available", { levels: model.supportedThinkingLevels.join(" / ") }), "warning");
					return;
				}
				await chat.configure({ thinkingLevel: level });
			} else {
				this.#thinkingModel = keyOf(model);
				void this.#panel.show(
					t("think.title"),
					async () =>
						model.supportedThinkingLevels.map((level) => ({
							value: level,
							label: `${level}${level === this.#lastView?.agent.thinkingLevel ? t("common.currentSuffix") : ""}`,
						})),
					async (value) => {
						await chat.configure({ thinkingLevel: value as ModelThinkingLevel });
					},
				);
				this.#ui.setFocus(this.#panel);
			}
		} catch {
			this.addNotice(t("think.failed"), "error");
		}
	}

	#showAgents(taskId?: number): void {
		if (this.#panel.open || this.#login.open) return;
		this.#agentsPanel = true;
		this.#panel.pointerSelection = true;
		this.#panel.agentNavigation = true;
		void this.#panel.show(
			t("agents.title"),
			async () => subagentItems(this.#lastView?.subagents ?? [], this.#lastView?.agents),
			async (value) => this.#agentDetail(value),
		);
		this.#ui.setFocus(this.#panel);
		if (taskId !== undefined) this.#panel.showDetail(this.#agentDetail(taskId));
	}
	/** `/todos`: read-only list of the model's todos; an old gateway gets a notice instead. */
	#showTodos(): void {
		if (this.#exitStarted || this.#panel.open || this.#login.open) return;
		const opened = showTodos(this.#panel, () => this.#lastView?.todos, {
			offline: () => this.#chat === undefined,
			notify: (message, level) => this.addNotice(message, level),
		});
		if (opened) this.#ui.setFocus(this.#panel);
	}
	/** `/question` and Ctrl+O: open the assistant's question; the panel itself closes on Esc or Ctrl+O. */
	#toggleQuestion(): void {
		if (this.#exitStarted) return;
		if (this.#question.open) {
			this.#question.closePanel();
			return;
		}
		if (!this.#question.supported) {
			this.addNotice(QUESTIONS_UNSUPPORTED, "warning");
			return;
		}
		if (!this.#question.openPanel()) this.addNotice(t("question.none"));
	}
	/**
	 * A new question opens by itself only when nothing else holds the keys: empty editor without completion, no
	 * picker/login/approval, no queue selection. Otherwise the prompt bar is all that appears.
	 */
	#autoOpenQuestion(): void {
		if (this.#exitStarted || this.#switching) return;
		const allowed = () =>
			canAutoOpen({
				online: this.#chat !== undefined,
				usable: usableSize(this.#terminal.columns, this.#terminal.rows),
				editorText: this.#editor.getText(),
				autocomplete: this.#editor.isShowingAutocomplete(),
				overlayOpen: this.#panel.open || this.#login.open,
				approvalFocused: this.#approval.focused,
				sessionOperation: this.#sessionOperation,
				queueSelecting: this.#queueRow.selecting,
				planOpen: this.#plan.open,
			});
		this.#question.autoOpen(allowed());
		// A waiting plan opens under the same rules; a question that just opened already holds the keys.
		this.#plan.autoOpen(allowed() && !this.#question.open);
	}
	/**
	 * `/plan` and Shift+Tab: with nothing waiting this toggles plan mode, with a plan awaiting approval it opens the
	 * plan panel. `draft` is the typed command; a refused toggle (e.g. while running) puts it back in the editor.
	 */
	#togglePlan(draft?: string): void {
		if (this.#exitStarted) return;
		const keep = () => {
			if (draft !== undefined && this.#editor.getText() === "") this.#editor.setText(draft);
		};
		const chat = this.#chat;
		if (chat === undefined) {
			this.addNotice(t("gateway.unavailable"), "error");
			keep();
			return;
		}
		const client = planClient(chat);
		if (!client.supported) {
			this.addNotice(PLAN_UNSUPPORTED, "warning", { wrap: true });
			keep();
			return;
		}
		if (this.#plan.awaiting) {
			this.#plan.openPanel();
			return;
		}
		const next = client.view()?.mode === "plan" ? "normal" : "plan";
		const session = this.#sessionId;
		void client
			.setMode(next)
			.then(() => {
				if (session === this.#sessionId) this.addNotice(next === "plan" ? t("plan.modeOn") : t("plan.modeOff"));
			})
			.catch((error) => {
				if (session !== this.#sessionId) return;
				this.addNotice(messageOf(error), "warning", { wrap: true });
				keep();
			});
	}
	#showJobs(): void {
		if (this.#panel.open || this.#login.open) return;
		const chat = this.#chat;
		if (chat === undefined) return;
		const jobs = jobsClient(chat);
		if (!jobs.supported) {
			this.addNotice(JOBS_UNSUPPORTED, "warning");
			return;
		}
		const changed = () => this.#ui.requestRender();
		this.#jobsPanel = true;
		this.#panel.pointerSelection = true;
		this.#panel.emptyText = jobsEmpty();
		this.#panel.listKey = (data, value) => {
			if (matchesKey(data, "left")) {
				this.#panel.close();
				return true;
			}
			if (data.toLowerCase() !== "s" || this.#panel.search.getValue() !== "" || value === undefined) return false;
			if (jobs.list().find((job) => job.jobId === value)?.status !== "running") return false;
			confirmStop(this.#panel, jobs, value, (message) => this.addNotice(message, "error"), changed);
			return true;
		};
		void this.#panel.show(
			t("jobs.title"),
			async () => jobItems(jobs.list()),
			async (value) => new JobDetail(jobs, value, this.#panel, changed).open(),
		);
		this.#ui.setFocus(this.#panel);
	}
	/** Alt+Up selects the queued messages above the editor; Enter steers, Esc withdraws, other keys leave. */
	#queueKey(data: string): { consume: true } | undefined {
		const row = this.#queueRow;
		if (this.#queueBusy && row.selecting) return { consume: true };
		const action = queueKeyAction(row, data, this.#editor.isShowingAutocomplete());
		if (action === undefined) return undefined;
		if (action === "steer" || action === "withdraw") return this.#queueAct(action);
		if (action === "select") row.select();
		else if (action === "up") row.move(-1);
		else if (action === "down") row.move(1);
		else {
			row.clear();
			this.#ui.requestRender();
			return undefined;
		}
		this.#ui.requestRender();
		return { consume: true };
	}
	#queueAct(action: "steer" | "withdraw"): { consume: true } {
		const chat = this.#chat;
		const item = this.#queueRow.current;
		if (!chat || !item) return { consume: true };
		if (action === "steer" && item.mode === "steer") {
			this.addNotice(t("queue.alreadySteers"), "info");
			return { consume: true };
		}
		const queue = queueClient(chat);
		const session = this.#sessionId;
		this.#queueBusy = true;
		const restore = (outcome: { result: string; text?: string | undefined }) => {
			if (outcome.result === "withdrawn") this.#editor.setText(restoreText(this.#editor.getText(), outcome.text ?? ""));
		};
		const run =
			action === "steer"
				? queue.steer(item.id).then((outcome) => {
						if (session !== this.#sessionId) return;
						restore(outcome);
						const notice = steerNotice(outcome);
						this.addNotice(notice.message, notice.level);
					})
				: queue.withdraw(item.id).then((outcome) => {
						if (session !== this.#sessionId) return;
						restore(outcome);
						const notice = withdrawNotice(outcome);
						this.addNotice(notice.message, notice.level);
					});
		void run
			.catch((error) => this.addNotice(messageOf(error), "error"))
			.finally(() => {
				this.#queueBusy = false;
				this.#ui.requestRender();
			});
		return { consume: true };
	}
	#showLogin(initial?: { provider: CredentialProviderId; group: "model" | "search" }): void {
		if (this.#panel.open || this.#login.open) return;
		const service = this.#gateway.client.credentials;
		this.#login.show(
			service.state.value,
			(fn) =>
				service.state.subscribe((value) => {
					if (value) fn(value);
				}),
			initial,
		);
		this.#ui.setFocus(this.#login);
	}
	#showSearch(): void {
		if (this.#exitStarted || this.#panel.open || this.#login.open) return;
		this.#searchStop = openSearchPanel(
			this.#panel,
			this.#gateway.client,
			(message) => this.addNotice(message),
			(provider) => this.#showLogin({ provider, group: "search" }),
		);
		this.#ui.setFocus(this.#panel);
	}
	#showContext(): void {
		if (this.#exitStarted || this.#panel.open || this.#login.open) return;
		this.#contextStop = openContextPanel(this.#panel, this.#gateway.client, (message) => this.addNotice(message));
		this.#ui.setFocus(this.#panel);
	}
	#agentDetail(target: string | number) {
		const round = typeof target === "number" ? this.#lastView?.subagents?.find((r) => r.taskId === target) : undefined;
		const id = typeof target === "string" ? target : (round?.agentId ?? `agent-${round?.childId}`);
		let detail = this.#agentDetails.get(id);
		if (!detail) {
			detail = new SubagentDetail(this.#gateway.client, id, this.#panel, () => this.#ui.requestRender());
			this.#agentDetails.set(id, detail);
		}
		detail.identity = this.#lastView?.agents?.find((a) => a.agentId === id);
		detail.entry = this.#lastView?.subagents?.find(
			(r) => r.taskId === (detail!.identity?.activeRoundId ?? detail!.identity?.lastRoundId),
		);
		detail.open();
		if (typeof target === "number") detail.locate(target);
		return detail;
	}
	#closeOverlay(): void {
		if (this.#panel.open) this.#panel.close();
		if (this.#login.open) this.#login.close();
		this.#ui.setFocus(this.#editor);
	}

	// —— 视图渲染 ——

	/**
	 * 底部通知行(design D6):info `i`(muted)/ warning `!` / error `✗`,5s 自动消失。
	 */
	addNotice(text: string, level: NoticeLevel = "info", options: { wrap?: boolean; ttlMs?: number } = {}): void {
		clearTimeout(this.#noticeTimer);
		this.#noticeTimer = setTimeout(() => {
			this.#notices.clear();
			this.#ui.requestRender();
		}, options.ttlMs ?? 5000);
		this.#notices.clear();
		const content = () => formatNotice(text, level);
		// 需要完整可读的通知（如导出路径）换行显示，其余保持单行截断。
		this.#notices.addChild(options.wrap ? new ThemedWrappedText(content) : new ThemedTruncatedText(content, 1, 0));

		this.#ui.requestRender();
	}

	/** 同一 tick 内的多次推送合并为一次渲染。 */
	scheduleApply(): void {
		if (this.#applying) {
			this.#applyQueued = true;
			return;
		}
		this.#applying = true;
		setImmediate(() => {
			this.#applying = false;
			if (this.#exitStarted) return;
			const again = this.#applyQueued;
			this.#applyQueued = false;
			const view = this.#chat?.view.value;
			if (view !== undefined) this.applyView(view);
			if (again) this.scheduleApply();
		});
	}

	applyView(view: ChatView): void {
		this.#lastView = view;
		if (this.#historyItems !== view.items) {
			this.#historyItems = view.items;
			this.#editor.setHistory(promptHistory(view.items));
		}
		if (this.#chat) this.#approval.update(view.subagents ?? []);
		else this.#approval.close();
		if (this.#agentsPanel) this.#panel.update(subagentItems(view.subagents ?? [], view.agents));
		if (this.#jobsPanel) this.#panel.update(jobItems(view.jobs ?? []));
		this.#queueRow.setItems(view.queued ?? []);
		this.#question.update(view.questions);
		this.#plan.update(view.plan);
		if (this.#commandCaps !== [...hiddenCommands(view)].join(",")) this.#syncCommands(view);
		for (const identity of view.agents ?? []) {
			const detail = this.#agentDetails.get(identity.agentId);
			if (detail) {
				detail.identity = identity;
				detail.entry = view.subagents?.find((r) => r.taskId === (identity.activeRoundId ?? identity.lastRoundId));
			}
		}
		const imageModel = `${this.#sessionId}:${view.agent.model?.provider}/${view.agent.model?.modelId}`;
		if (
			this.#imageWarningModel !== imageModel &&
			view.items.some((i) => (i.type === "user" || i.type === "tool") && i.images?.length)
		) {
			this.#imageWarningModel = imageModel;
			void this.#gateway.client.models
				.list(null)
				.then((models) => {
					const model = models.find(
						(m) => m.provider === view.agent.model?.provider && m.modelId === view.agent.model?.modelId,
					);
					if (this.#imageWarningModel === imageModel && model && !model.input.includes("image"))
						this.addNotice(t("image.textOnlyModel"), "warning");
				})
				.catch(() => {});
		}
		clearTimeout(this.#compactionTimer);
		const latest = view.compaction?.latest;
		if (
			latest &&
			latest.phase !== "waiting-to-apply" &&
			latest.phase !== "summarizing" &&
			Date.now() - latest.at < 10000
		) {
			this.#compactionTimer = setTimeout(
				() => {
					if (!this.#exitStarted && this.#lastView) this.applyView(this.#lastView);
				},
				Math.max(1, 10000 - (Date.now() - latest.at)),
			);
		}
		if (this.#thinkingModel && this.#thinkingModel !== `${view.agent.model?.provider}/${view.agent.model?.modelId}`) {
			this.#panel.close();
			this.addNotice(t("think.modelChanged"));
		}
		this.#syncItems(view);
		const waiting = this.#question.pendingCount > 0;
		for (const card of this.#toolCards.values()) {
			card.setWaiting(waiting && card.name === "ask_user");
			if (card.planVersion !== undefined) card.setPlan(view.plan?.current ?? undefined);
		}
		for (const child of view.subagents ?? []) {
			const card = this.#toolCards.get(child.callId);
			if (card) card.onOpen = () => this.#showAgents(child.taskId);
		}
		this.#syncStreaming(view.streaming);
		this.#syncBusy(view);
		this.#syncFooter(view);
		this.#syncWelcome(view);
		if (this.#transcript !== undefined && this.#streamingComp !== undefined) this.#transcript.scrollToEnd();
		this.#ui.requestRender();
		this.#autoOpenQuestion();
	}

	#syncItems(view: ChatView): void {
		const items = view.items;
		const keys = items.map((item) => item.key);
		const rendered = this.#renderedKeys;
		if (rendered.length > keys.length || rendered.some((key, index) => key !== keys[index])) {
			this.#resetTranscript();
		}
		// 流式工具调用按 callId 覆盖条目里的静态相位（pi.live 的运行输出）。
		const streamByCall = new Map<string, StreamingToolCall>();
		for (const call of view.streaming?.toolCalls ?? []) streamByCall.set(call.callId, call);
		for (const item of items) {
			const existing = this.#items.get(item.key);
			if (existing !== undefined) {
				this.#updateItem(existing, item, item.type === "tool" ? streamByCall.get(item.callId) : undefined);
			} else {
				this.#appendItem(item);
			}
			if (item.type === "tool" || item.type === "user")
				for (const image of item.images ?? [])
					this.#imageComponents.get(`${image.entryId}:${image.contentIndex}`)?.updateInfo(image);
			if ((item.type === "tool" || item.type === "user") && item.images?.length && !this.#imageKeys.has(item.key)) {
				this.#imageKeys.add(item.key);
				this.#appendImages(item.images);
			}
			if (item.type === "tool") streamByCall.delete(item.callId);
		}
		// 条目还没提交的工具调用（assistant entry 未落库）：暂存卡片，条目到达后由条目路径接管。
		for (const call of streamByCall.values()) {
			this.#toolCard(call).sync(streamingCardState(call));
		}
		let anyRunning = false;
		for (const card of this.#toolCards.values()) if (card.isRunning) anyRunning = true;
		if (anyRunning) this.#toolSpinner.start();
		else this.#toolSpinner.stop();
		this.#renderedKeys = keys;
	}

	#onToolSpinnerTick(): void {
		if (this.#exitStarted) return;
		for (const card of this.#toolCards.values()) if (card.isRunning) card.rebuild();
		this.#ui.requestRender();
	}

	#appendImages(images: readonly import("@neko-harness/core").ChatImage[]): void {
		const chat = this.#chat;
		const session = this.#sessionId;
		if (!chat) return;
		for (const image of images) {
			const component = new HistoryImage(
				image,
				() =>
					downloadImage((offset) =>
						chat.getImage({ entryId: image.entryId, contentIndex: image.contentIndex, offset }),
					),
				() => {
					if (session === this.#sessionId) this.#ui.requestRender();
				},
			);
			this.#imageComponents.set(`${image.entryId}:${image.contentIndex}`, component);
			this.#imageTranscript.addChild(component);
		}
	}

	#appendItem(item: ChatItem): void {
		if (item.type === "user") {
			const component = new UserMessageComponent(item.text, item.skill, item.defaultImagePrompt);
			this.#imageTranscript.addItem(component);
			this.#items.set(item.key, { kind: "user", component });
			return;
		}
		if (item.type === "assistant") {
			const component = new AssistantMessageComponent(assistantContent(item), false);
			this.#imageTranscript.addItem(component);
			this.#items.set(item.key, { kind: "assistant", component });
			return;
		}
		if (item.type === "tool") {
			const component = this.#toolCard({
				callId: item.callId,
				name: item.name,
				summary: item.summary,
				detail: item.detail,
				phase: item.phase,
				output: item.output,
				diff: item.diff,
				diffAdded: item.diffAdded,
				diffRemoved: item.diffRemoved,
				diffTruncated: item.diffTruncated,
			});
			component.sync(item);
			this.#items.set(item.key, { kind: "tool", component });
			return;
		}
		if (item.jobId !== undefined) {
			const component = new JobReportNotice(item.text);
			this.#imageTranscript.addItem(component);
			this.#items.set(item.key, { kind: "job-report", component });
			return;
		}
		const component = new ThemedText(systemText(item), theme.dim, 1, 0);
		this.#imageTranscript.addItem(component);
		this.#items.set(item.key, { kind: "system", component });
	}

	#updateItem(entry: ItemEntry, item: ChatItem, streamCall: StreamingToolCall | undefined): void {
		if (entry.kind === "user" && item.type === "user") {
			entry.component.setText(item.text);
			return;
		}
		if (entry.kind === "assistant" && item.type === "assistant") {
			entry.component.updateContent(assistantContent(item), false);
			return;
		}
		if (entry.kind === "tool" && item.type === "tool") {
			entry.component.sync(mergeStream(item, streamCall));
			return;
		}
		if ((entry.kind === "system" || entry.kind === "job-report") && item.type === "system") {
			entry.component.setText(systemText(item));
		}
	}

	/** 工具卡片（按 callId 复用）：流式暂存与最终条目共享同一组件。 */
	#toolCard(call: {
		readonly callId: string;
		readonly name: string;
		readonly summary: string;
		readonly detail: string | null;
		readonly phase: "pending" | "running" | "done";
		readonly output: string | null;
		readonly diff: string | null;
		readonly diffAdded: number | null;
		readonly diffRemoved: number | null;
		readonly diffTruncated?: boolean;
	}): ToolExecutionComponent {
		const existing = this.#toolCards.get(call.callId);
		if (existing !== undefined) return existing;
		const component = new ToolExecutionComponent(streamingCardState(call));
		this.#imageTranscript.addItem(component);
		this.#toolCards.set(call.callId, component);
		this.#items.set(`t${call.callId}`, { kind: "tool", component });
		return component;
	}

	#syncStreaming(streaming: StreamingView | null): void {
		if (streaming === null) {
			if (this.#streamingComp !== undefined) {
				this.#imageTranscript.removeItem(this.#streamingComp);
				this.#streamingComp = undefined;
			}
			return;
		}
		if (this.#streamingComp === undefined) {
			this.#streamingComp = new AssistantMessageComponent();
			this.#imageTranscript.addItem(this.#streamingComp);
		}
		this.#streamingComp.updateContent({ thinking: streaming.thinking, text: streaming.text, note: null }, true);
	}

	#syncBusy(view: ChatView): void {
		const active =
			view.subagents?.filter((d) => d.historyThrough === undefined && (d.status === "running" || d.status === "queued"))
				.length ?? 0;
		this.#busyText =
			view.busy && this.#question.pendingCount > 0
				? t("busy.waitingAnswer")
				: active
					? t("busy.agentsRunning", { count: active })
					: view.busy
						? localizeStatus(view.status ?? "Thinking...")
						: undefined;
		if (this.#busyText !== undefined) {
			this.#busyLoader.setMessage(this.#busyText);
			this.#busyLoader.start();
		} else {
			this.#busyLoader.stop();
		}
		this.#syncEditorBorder();
	}

	#syncEditorBorder(): void {
		this.#editor.borderColor = this.#busyText !== undefined ? theme.accent : theme.borderMuted;
	}

	/** 欢迎屏:仅当转录无任何条目、无流式块且不忙碌时显示;模型行随配置更新。 */
	#syncWelcome(view: ChatView): void {
		const empty = view.items.length === 0 && view.streaming === null && !view.busy;
		if (empty) {
			const modelShort = modelDisplayName(view.model);
			this.#welcome.setModelLine(
				view.agent.thinkingLevel !== null ? `${modelShort} · Think ${view.agent.thinkingLevel}` : modelShort,
			);
			if (!this.#welcomeAttached) {
				this.#imageTranscript.addChild(this.#welcome);
				this.#welcomeAttached = true;
			}
		} else if (this.#welcomeAttached) {
			this.#imageTranscript.removeChild(this.#welcome);
			this.#welcomeAttached = false;
		}
	}

	#syncFooter(view: ChatView): void {
		const usage = view.taskUsage ?? view.usage;
		const todoProgress = todoProgressText(view.todos);
		const compaction = compactionStatus(view.compaction);
		this.#footer.setStats({
			subagentCount: view.agents?.length ?? 0,
			jobCount: view.jobs?.filter((job) => job.status === "running").length ?? 0,
			approvalCount: view.subagents?.reduce((n, d) => n + (d.approvalCount ?? 0), 0) ?? 0,
			questionCount: this.#question.pendingCount,
			questionOpen: this.#question.open,
			planMode: view.plan?.mode === "plan",
			planAwaiting: view.plan?.current?.status === "awaiting_approval",
			planOpen: this.#plan.open,
			...(todoProgress !== undefined ? { todoProgress } : {}),
			model: view.model,
			thinkingLevel: view.agent.thinkingLevel,
			busy: this.#busyText,
			canAbort: view.compaction?.active.some((c) => c.reason === "manual" || c.blocking),
			...(compaction !== undefined ? { compaction: compaction.text, compactionTone: compaction.tone } : {}),
			contextUsage: view.contextUsage,
			usageText: usageText(usage.input, usage.output, usage.cacheRead, usage.cost),
			cwd: view.cwd,
		});
	}

	#resetTranscript(): void {
		this.#toolSpinner.stop();
		this.#welcomeAttached = false;
		this.#imageTranscript.clear();
		this.#imageKeys.clear();
		this.#imageComponents.clear();
		this.#items.clear();
		this.#toolCards.clear();
		this.#streamingComp = undefined;
		this.#renderedKeys = [];
		this.#busyText = undefined;
	}

	// —— 主题 ——

	/** auto：首帧后异步查询终端背景（不阻塞启动），并跟随终端后续的主题变化通知。 */
	#startThemeDetection(): void {
		if (this.#themePreference !== "auto" || this.#terminalSchemeUnsubscribe !== undefined) return;
		this.#terminalSchemeUnsubscribe = followTerminalTheme(this.#ui, (mode) => {
			if (!this.#exitStarted && this.#themePreference === "auto") this.#applyThemeMode(mode);
		});
	}

	#applyThemeMode(mode: ThemeMode): void {
		if (this.#exitStarted || mode === getActiveThemeMode()) return;
		setActiveTheme(mode);
		this.#ui.invalidate();
		if (this.#lastView !== undefined) {
			this.#syncBusy(this.#lastView);
			this.#syncFooter(this.#lastView);
		}
		this.#ui.requestRender(true);
	}
}

/** A plan decision carries the user's feedback, possibly from another client: shown as plain text. */
function systemText(item: Extract<ChatItem, { type: "system" }>): string {
	return item.planDecision ? plainText(item.text) : localizeCoreText(item.text);
}

function assistantContent(item: Extract<ChatItem, { type: "assistant" }>): {
	readonly thinking: string;
	readonly text: string;
	readonly note: string | null;
} {
	return { thinking: item.thinking, text: item.text, note: item.note };
}

/** 条目状态合流式槽位：执行中的工具以 pi.live 的相位与部分输出为准。 */
function mergeStream(
	item: Extract<ChatItem, { type: "tool" }>,
	streamCall: StreamingToolCall | undefined,
): ToolCardState {
	if (streamCall !== undefined && streamCall.phase !== "done") {
		return { ...item, phase: streamCall.phase, output: streamCall.output };
	}
	return item;
}

function streamingCardState(call: {
	readonly name: string;
	readonly summary: string;
	readonly detail: string | null;
	readonly phase: "pending" | "running" | "done";
	readonly output: string | null;
	readonly diff: string | null;
	readonly diffAdded: number | null;
	readonly diffRemoved: number | null;
	readonly diffTruncated?: boolean;
}): ToolCardState {
	return {
		name: call.name,
		summary: call.summary,
		detail: call.detail,
		phase: call.phase,
		isError: false,
		output: call.output,
		result: null,
		durationMs: null,
		note: null,
		diff: call.diff,
		diffAdded: call.diffAdded,
		diffRemoved: call.diffRemoved,
		diffTruncated: call.diffTruncated,
	};
}

function rawMessageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Error text for display: core's `CODE:` messages are shown in the interface language. */
function messageOf(error: unknown): string {
	return localizeError(rawMessageOf(error));
}

/** Commands a gateway without the matching optional capability cannot serve; they stay out of completion. */
function hiddenCommands(view: ChatView): Set<string> {
	const hidden = new Set<string>();
	if (view.todos === undefined) hidden.add("todos");
	if (view.questions === undefined) hidden.add("question");
	if (view.plan === undefined) hidden.add("plan");
	return hidden;
}

const keyOf = modelKey;

/** 打开 neko 终端界面；用户退出（/exit 或 Ctrl+C）后 resolve。 */
export async function runTui(options: NekoTuiOptions = {}): Promise<void> {
	options = { ...options, cwd: normalizeWorkspace(options.cwd) };
	if (options.language !== undefined) setLanguage(options.language);
	if (options.dataDir === undefined) {
		try {
			options = {
				...options,
				dataDir: resolveDataDir({
					...(options.storagePath !== undefined ? { storagePath: options.storagePath } : {}),
					configDir: options.cwd,
				}),
			};
		} catch {
			// 配置读取失败会在下面的 connectToGateway 中报告。
		}
	}
	const gateway = await connectToGateway({
		...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
		...(options.storagePath !== undefined ? { storagePath: options.storagePath } : {}),
		...(options.model !== undefined ? { model: options.model } : {}),
		configDir: options.cwd,
	});
	try {
		const initial = await initialSessionId(gateway, options.cwd!);
		const app = new NekoTuiApp(gateway, options, options.theme ?? "auto");
		await app.run(initial);
	} finally {
		await gateway.close();
	}
}

/** 初始会话：目录里最早创建的（root 最小 id）；目录为空则新建。 */
export async function initialSessionId(gateway: NekoTuiGateway, cwd: string): Promise<string> {
	const sessions = gateway.client.directory.state.value.sessions;
	const first = recentlyVisited(sessions, cwd)[0];
	if (first !== undefined) return first.id;
	return (await gateway.client.management.create({ ...(cwd !== undefined ? { cwd } : {}) })).id;
}
