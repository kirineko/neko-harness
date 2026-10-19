import { expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { questionsClient } from "@neko-harness/gateway/client-session";
import { cleanup, connectTestClient, makeGateway, waitFor } from "../../gateway/test/helpers.ts";
import { QuestionDock } from "../src/question-dock.ts";
import { setActiveTheme } from "../src/theme/index.ts";
import { TodosDetail, todoProgressText } from "../src/todos-ui.ts";
import { sessionPickerItems } from "../src/workspace.ts";

setActiveTheme("light");

const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");
const options = [
	{ id: "pg", label: "PostgreSQL", recommended: true },
	{ id: "my", label: "MySQL" },
];
const ask = (question: string) =>
	fauxAssistantMessage([fauxToolCall("ask_user", { question, options } as never)], { stopReason: "toolUse" });

/** A dock wired like the TUI: it follows the attached chat view and answers through the real gateway. */
async function attach(target: Awaited<ReturnType<typeof makeGateway>>) {
	const client = await connectTestClient(target);
	const chat = await client.attach(String(target.gateway.runtime.root.id));
	const notices: string[] = [];
	const dock = new QuestionDock({ changed: () => {}, notify: (message) => notices.push(message) });
	dock.bind("root", questionsClient(chat));
	const sync = () => dock.update(chat.view.value?.questions);
	const stop = chat.view.subscribe(sync);
	sync();
	return { client, chat, dock, notices, stop };
}

it("answers a real question end to end through the dock and keeps the directory and history in step", async () => {
	const target = await makeGateway();
	target.faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("todo", { action: "replace", items: [{ id: "a", text: "Pick storage", status: "in_progress" }] })],
			{ stopReason: "toolUse" },
		),
		ask("Which database?"),
		fauxAssistantMessage([fauxText("storage decided")]),
	]);
	const { client, chat, dock, notices, stop } = await attach(target);
	try {
		await chat.submit({ content: "set up storage" });
		await waitFor(() => dock.visible, "the question reaches the dock");
		expect(dock.pendingCount).toBe(1);
		expect(plain(dock.render(100))).toContain("等待回答");
		expect(dock.autoOpen(true)).toBe(true);
		await waitFor(() => plain(dock.render(100)).includes("PostgreSQL"), "the full question loads");
		const panel = plain(dock.render(100));
		expect(panel).toContain("Which database?");
		expect(panel).toContain("[推荐] PostgreSQL");
		expect(panel).not.toContain("(●)");

		// The directory marks the blocked session and the transcript card follows the structured state.
		await waitFor(() => client.directory.state.value.sessions[0]?.awaitingAnswer === true, "awaiting flag");
		const workspace = client.directory.state.value.sessions[0]!.workspaceRoot;
		const id = client.directory.state.value.sessions[0]!.id;
		const blocked = sessionPickerItems(client.directory.state.value.sessions, workspace, "other")[0]!;
		expect(blocked.description).toContain("等待回答");
		expect(blocked.description).not.toContain("Running");
		const card = chat.view.value?.items.find((i) => i.type === "tool" && i.name === "ask_user");
		expect(card).toMatchObject({ interaction: { kind: "ask_user", status: "pending" } });

		// The todo list is readable from the same view.
		expect(todoProgressText(chat.view.value?.todos)).toBe("Todos 0/1");
		expect(plain(new TodosDetail(() => chat.view.value?.todos).lines(60, 8))).toContain("Pick storage");

		// The cursor starts on the recommended option; Space picks it, Enter submits.
		dock.handleInput(" ");
		dock.handleInput("\r");
		await waitFor(() => !dock.visible && chat.view.value?.busy === false, "answered and the run finished");
		expect(notices).toEqual(["Answered: PostgreSQL"]);
		const answered = chat.view.value?.items.find((i) => i.type === "tool" && i.name === "ask_user");
		expect(answered).toMatchObject({ interaction: { kind: "ask_user", status: "answered", labels: ["PostgreSQL"] } });
		await waitFor(() => client.directory.state.value.sessions[0]?.awaitingAnswer === false, "flag cleared");
		expect(sessionPickerItems(client.directory.state.value.sessions, workspace, id)[0]!.description).toContain("Idle");
	} finally {
		stop();
		await client.close();
		await cleanup(target);
	}
}, 40_000);

it("shows the winner when another client answers first, and a cancelled question when the run is stopped", async () => {
	const target = await makeGateway();
	target.faux.setResponses([ask("First?"), fauxAssistantMessage([fauxText("done")]), ask("Second?")]);
	const first = await attach(target);
	const other = await connectTestClient(target);
	try {
		const otherChat = await other.attach(String(target.gateway.runtime.root.id));
		await first.chat.submit({ content: "go" });
		await waitFor(() => first.dock.visible, "the first question");
		first.dock.openPanel();
		await waitFor(() => plain(first.dock.render(100)).includes("MySQL"), "the full question loads");
		first.dock.handleInput("\x1b[B");
		first.dock.handleInput(" ");
		await waitFor(() => !!otherChat.view.value?.questions?.pending[0], "the other client sees it");
		const summary = otherChat.view.value!.questions!.pending[0]!;
		await otherChat.questionRespond({
			id: summary.id,
			version: summary.version,
			response: { kind: "answer", optionIds: ["my"], text: "from elsewhere" },
		});
		await waitFor(() => plain(first.dock.render(100)).includes("Already answered"), "the real result shows");
		expect(plain(first.dock.render(100))).toContain("Already answered: MySQL, from elsewhere");
		first.dock.handleInput("\r");
		expect(first.chat.view.value?.questions?.pending).toEqual([]);
		first.dock.handleInput("\x1b");
		await waitFor(() => first.chat.view.value?.busy === false, "the first run ends");

		await first.chat.submit({ content: "again" });
		await waitFor(() => first.dock.visible && first.dock.pendingCount === 1, "the second question");
		first.dock.openPanel();
		await waitFor(() => plain(first.dock.render(100)).includes("Second?"), "the second question loads");
		await first.chat.abort(null);
		await waitFor(() => plain(first.dock.render(100)).includes("Cancelled"), "the cancellation shows");
		first.dock.handleInput("\r");
		first.dock.handleInput(" ");
		expect(first.dock.open).toBe(true);
		first.dock.handleInput("\x1b");
		expect(first.dock.visible).toBe(false);
	} finally {
		first.stop();
		await first.client.close();
		await other.close();
		await cleanup(target);
	}
}, 60_000);
