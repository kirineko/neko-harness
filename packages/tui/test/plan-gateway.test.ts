import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { planClient } from "@neko-harness/gateway/client-session";
import { cleanup, connectTestClient, makeGateway, waitFor } from "../../gateway/test/helpers.ts";
import { PlanDock } from "../src/plan-dock.ts";
import { setActiveTheme } from "../src/theme/index.ts";
import { sessionPickerItems } from "../src/workspace.ts";

setActiveTheme("light");

const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");
const submitPlan = (title: string, steps: string[]) =>
	fauxAssistantMessage([fauxToolCall("submit_plan", { title, steps, note: "Keep it small." } as never)], {
		stopReason: "toolUse",
	});

/** A dock wired like the TUI: it follows the attached chat view and decides through the real gateway. */
async function attach(target: Awaited<ReturnType<typeof makeGateway>>, autoOpen = false) {
	const client = await connectTestClient(target);
	const chat = await client.attach(String(target.gateway.runtime.root.id));
	const notices: string[] = [];
	const dock = new PlanDock({ changed: () => {}, notify: (message) => notices.push(message) });
	dock.bind("root", planClient(chat));
	const sync = () => {
		dock.update(chat.view.value?.plan);
		if (autoOpen) dock.autoOpen(true);
	};
	const stop = chat.view.subscribe(sync);
	sync();
	return { client, chat, dock, notices, stop };
}

it("plans, approves through the panel and then executes with write tools back", async () => {
	const target = await makeGateway();
	const out = join(target.dir, "executed.txt");
	target.faux.setResponses([
		submitPlan("Create the marker", ["Write the marker file", "Report back"]),
		fauxAssistantMessage([fauxToolCall("write", { path: out, content: "done" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("executed the plan")]),
	]);
	const { client, chat, dock, notices, stop } = await attach(target);
	try {
		expect(dock.supported).toBe(true);
		expect(dock.mode).toBe("normal");
		expect(dock.awaiting).toBe(false);
		await planClient(chat).setMode("plan");
		await waitFor(() => dock.mode === "plan", "plan mode reaches the dock");

		await chat.submit({ content: "create the marker file" });
		await waitFor(() => dock.awaiting && chat.view.value?.busy === false, "the plan waits for approval");
		expect(existsSync(out)).toBe(false);
		const waiting = chat.view.value?.items.find((i) => i.type === "tool" && i.name === "submit_plan");
		expect(waiting).toMatchObject({ interaction: { kind: "submit_plan", title: "Create the marker" } });
		await waitFor(() => client.directory.state.value.sessions[0]?.awaitingPlan === true, "awaiting flag");
		const sessions = client.directory.state.value.sessions;
		const workspace = sessions[0]!.workspaceRoot;
		const blocked = sessionPickerItems(sessions, workspace, "other")[0]!;
		expect(blocked.description).toContain("Awaiting approval");

		expect(dock.openPanel()).toBe(true);
		const panel = plain(dock.render(100));
		expect(panel).toContain("Create the marker");
		expect(panel).toContain("1. Write the marker file");
		expect(panel).toContain("Keep it small.");

		dock.handleInput("a");
		await waitFor(() => existsSync(out) && chat.view.value?.busy === false, "execution wrote the file");
		expect(readFileSync(out, "utf8")).toBe("done");
		expect(dock.open).toBe(false);
		expect(notices).toEqual(["Plan approved. Executing."]);
		expect(chat.view.value?.plan?.mode).toBe("normal");
		expect(dock.mode).toBe("normal");
		expect(dock.awaiting).toBe(false);
		const decision = chat.view.value?.items.find((i) => i.type === "system" && i.planDecision);
		expect(decision).toMatchObject({ planDecision: { kind: "approve" }, text: expect.stringContaining("approved") });
		const write = chat.view.value?.items.find((i) => i.type === "tool" && i.name === "write");
		expect(write).toMatchObject({ isError: false });
		await waitFor(() => client.directory.state.value.sessions[0]?.awaitingPlan === false, "flag cleared");
	} finally {
		stop();
		await client.close();
		await cleanup(target);
	}
}, 40_000);

it("asks for changes through the panel, stays in plan mode and shows the revised plan", async () => {
	const target = await makeGateway();
	target.faux.setResponses([
		submitPlan("First draft", ["Do everything"]),
		submitPlan("Second draft", ["Do the first half", "Do the second half"]),
	]);
	const { client, chat, dock, notices, stop } = await attach(target);
	try {
		await planClient(chat).setMode("plan");
		await chat.submit({ content: "do the thing" });
		await waitFor(() => dock.awaiting && chat.view.value?.busy === false, "the first plan");
		dock.openPanel();
		expect(plain(dock.render(100))).toContain("First draft");

		dock.handleInput("r");
		for (const char of "Split it in two") dock.handleInput(char);
		dock.handleInput("\r");
		await waitFor(
			() => chat.view.value?.plan?.current?.title === "Second draft" && chat.view.value?.busy === false,
			"the revised plan",
		);
		expect(notices.at(0)).toContain("Changes requested");
		expect(dock.open).toBe(false);
		expect(chat.view.value?.plan?.mode).toBe("plan");
		expect(dock.mode).toBe("plan");
		expect(dock.awaiting).toBe(true);
		const decision = chat.view.value?.items.find((i) => i.type === "system" && i.planDecision);
		expect(decision).toMatchObject({
			planDecision: { kind: "revise" },
			text: expect.stringContaining("Split it in two"),
		});

		dock.openPanel();
		const panel = plain(dock.render(100));
		expect(panel).toContain("Second draft");
		expect(panel).toContain("2. Do the second half");
		expect(panel).not.toContain("First draft");
	} finally {
		stop();
		await client.close();
		await cleanup(target);
	}
}, 40_000);

it("shows the winner when another client decides first", async () => {
	const target = await makeGateway();
	target.faux.setResponses([submitPlan("Contested", ["Step"]), fauxAssistantMessage([fauxText("ok")])]);
	const first = await attach(target);
	const other = await connectTestClient(target);
	try {
		const otherChat = await other.attach(String(target.gateway.runtime.root.id));
		await planClient(first.chat).setMode("plan");
		await first.chat.submit({ content: "go" });
		await waitFor(() => first.dock.awaiting && first.chat.view.value?.busy === false, "the plan");
		first.dock.openPanel();
		const version = first.chat.view.value!.plan!.current!.version;
		await otherChat.planRespond({ version, decision: { kind: "revise", feedback: "from elsewhere" } });
		await waitFor(() => plain(first.dock.render(100)).includes("Changes were already requested"), "the real result");
		expect(plain(first.dock.render(100))).toContain("from elsewhere");
		first.dock.handleInput("a");
		expect(first.dock.open).toBe(true);
		expect(first.chat.view.value?.plan?.mode).toBe("plan");
	} finally {
		first.stop();
		await first.client.close();
		await other.close();
		await cleanup(target);
	}
}, 40_000);

it("refuses to switch mode while running, with the PLAN_BUSY text for the notice", async () => {
	const target = await makeGateway();
	target.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_user", { question: "Wait?" } as never)], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const { client, chat, dock, stop } = await attach(target);
	try {
		await chat.submit({ content: "go" });
		await waitFor(() => chat.view.value?.busy === true, "running");
		await expect(planClient(chat).setMode("plan")).rejects.toThrow(/PLAN_BUSY/);
		expect(dock.mode).toBe("normal");
		await chat.abort(null);
		await waitFor(() => chat.view.value?.busy === false, "stopped");
	} finally {
		stop();
		await client.close();
		await cleanup(target);
	}
}, 40_000);

it("cancels the waiting plan and leaves plan mode through the panel", async () => {
	const target = await makeGateway();
	target.faux.setResponses([submitPlan("Not wanted", ["Step"])]);
	const { client, chat, dock, notices, stop } = await attach(target);
	try {
		await planClient(chat).setMode("plan");
		await chat.submit({ content: "plan it" });
		await waitFor(() => dock.awaiting && chat.view.value?.busy === false, "the plan waits");
		const version = chat.view.value!.plan!.current!.version;
		dock.openPanel();
		dock.handleInput("x");
		await waitFor(() => !dock.open && dock.mode === "normal", "plan mode left");
		expect(notices).toEqual(["Plan cancelled. Plan mode off."]);
		expect(dock.awaiting).toBe(false);
		expect(chat.view.value?.plan?.mode).toBe("normal");
		expect((await planClient(chat).get(version))?.status).toBe("cancelled");
		await waitFor(() => client.directory.state.value.sessions[0]?.awaitingPlan === false, "flag cleared");
	} finally {
		stop();
		await client.close();
		await cleanup(target);
	}
}, 40_000);

it("opens the panel by itself when the plan arrives, so the user can act without typing /plan", async () => {
	const target = await makeGateway();
	target.faux.setResponses([submitPlan("Auto open", ["Step"])]);
	const { client, chat, dock, stop } = await attach(target, true);
	try {
		await planClient(chat).setMode("plan");
		await chat.submit({ content: "plan it" });
		await waitFor(() => dock.open && dock.awaiting, "the panel opens on its own");
		dock.handleInput("a");
		await waitFor(() => !dock.open && dock.mode === "normal", "approved straight from the auto-opened panel");
	} finally {
		stop();
		await client.close();
		await cleanup(target);
	}
}, 40_000);
