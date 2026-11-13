/**
 * 主题预览:在真实终端中并排验收明暗主题(design D1 人工验收辅助)。
 * 运行:node --conditions=neko-source packages/tui/examples/theme-preview.ts [dark|light]
 */
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "../src/components/assistant-message.ts";
import { StatusFooter, usageText } from "../src/components/footer.ts";
import { formatNotice } from "../src/components/notice.ts";
import { type ToolCardState, ToolExecutionComponent } from "../src/components/tool-execution.ts";
import { UserMessageComponent } from "../src/components/user-message.ts";
import { WelcomeScreen } from "../src/components/welcome.ts";
import { setActiveTheme, type ThemeMode, theme } from "../src/theme/index.ts";

const WIDTH = 78;

const toolBase: ToolCardState = {
	name: "Bash",
	summary: "bun run test",
	detail: null,
	phase: "pending",
	isError: false,
	output: null,
	result: null,
	durationMs: null,
	note: null,
	diff: null,
	diffAdded: null,
	diffRemoved: null,
};

function section(title: string): void {
	console.log(`\n${stripTerminalSequences(theme.muted(`── ${title} `))}`);
}

function show(component: { render: (width: number) => string[] }): void {
	for (const line of component.render(WIDTH)) console.log(line);
}

function renderAll(): void {
	const welcome = new WelcomeScreen();
	welcome.setModelLine("deepseek-flash · Think high");
	show(welcome);

	section("user bubble / skill");
	show(new UserMessageComponent("帮我看看 `theme/slots.ts` 的槽位设计\n> 引用一行试试"));
	show(
		new UserMessageComponent("/skill:pdf 提取第三章", {
			name: "pdf",
			args: "提取第三章",
			body: "<skill />",
			location: "~/.agents/skills/pdf/SKILL.md",
		}),
	);

	section("assistant markdown + syntax highlight");
	const assistant = new AssistantMessageComponent({
		thinking: "",
		text: "改动如下:\n\n```ts\nconst theme = createTheme(palette); // 槽位委托\n```\n\n- **accent** 樱花粉\n- `model` 天依蓝",
		note: null,
	});
	show(assistant);

	section("assistant thinking (collapsed / expanded)");
	show(new AssistantMessageComponent({ thinking: "先读 palette.ts…", text: "", note: null }));
	const expanded = new AssistantMessageComponent({ thinking: "先读 palette.ts,确认 33 槽", text: "", note: null });
	expanded.setThinkingExpanded(true);
	show(expanded);

	section("tool cards (pending / running / ok / error / expanded)");
	show(new ToolExecutionComponent({ ...toolBase }));
	show(new ToolExecutionComponent({ ...toolBase, phase: "running", output: "running 51 tests…" }));
	show(new ToolExecutionComponent({ ...toolBase, phase: "done", durationMs: 2300, result: "51 pass, 0 fail" }));
	const expandedCard = new ToolExecutionComponent({
		...toolBase,
		phase: "done",
		durationMs: 2300,
		detail: '{ command: "bun run test" }',
		result: "downloading...\nrunning 51 tests\n51 pass, 0 fail",
	});
	expandedCard.setExpanded(true);
	show(expandedCard);
	show(
		new ToolExecutionComponent({
			...toolBase,
			phase: "done",
			isError: true,
			durationMs: 900,
			result: "src/theme.ts(1,1): error TS0000",
		}),
	);

	section("tool cards (edit diff collapsed / expanded)");
	show(
		new ToolExecutionComponent({
			...toolBase,
			name: "edit",
			summary: "theme/slots.ts (1 edit)",
			phase: "done",
			durationMs: 900,
			diff: ["  74 \t// diff", '- 75 \t"diffAdded",', '+ 75 \t"diffAdded", // 行底色'].join("\n"),
			diffAdded: 1,
			diffRemoved: 1,
		}),
	);
	const editCard = new ToolExecutionComponent({
		...toolBase,
		name: "edit",
		summary: "theme/slots.ts (1 edit)",
		phase: "done",
		durationMs: 900,
		diff: ["  74 \t// diff", '- 75 \t"diffAdded",', '+ 75 \t"diffAdded", // 行底色'].join("\n"),
		diffAdded: 1,
		diffRemoved: 1,
	});
	editCard.setExpanded(true);
	show(editCard);

	section("diff highlight");
	show(
		new AssistantMessageComponent({
			thinking: "",
			text: "```diff\n- oldTheme: Tokyo Night\n+ newTheme: sakura-night\n```",
			note: null,
		}),
	);

	section("notices (info / warning / error)");
	console.log(` ${formatNotice("Model changed. Open /think to choose levels.")}`);
	console.log(` ${formatNotice("Text-only model: previous images are unavailable.", "warning")}`);
	console.log(` ${formatNotice("Gateway unavailable. Restart to reconnect.", "error")}`);

	section("footer");
	const footer = new StatusFooter();
	footer.setStats({
		cwd: "/projects/neko-harness",
		model: "deepseek/deepseek-flash",
		thinkingLevel: "high",
		busy: undefined,
		usageText: usageText(12400, 3400, 800, 0.0123),
		contextUsage: { tokens: 58000, window: 64000, percent: 90.6 },
	});
	show(footer);
}

const arg = process.argv[2];
const modes: readonly ThemeMode[] = arg === "dark" || arg === "light" ? [arg] : ["dark", "light"];
for (const mode of modes) {
	setActiveTheme(mode);
	console.log(`\n=== ${mode === "dark" ? "sakura-night (dark)" : "sakura-day (light)"} ===`);
	renderAll();
}
