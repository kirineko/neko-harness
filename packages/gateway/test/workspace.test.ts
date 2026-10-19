import { expect, it } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, connectTestClient, connectTestWsClient, makeGateway, waitFor } from "./helpers.ts";

it("shares workspace metadata over Unix/WS and touches only distinct activations and inputs", async () => {
	const target = await makeGateway();
	const unix = await connectTestClient(target);
	const ws = await connectTestWsClient(target);
	try {
		const b = join(await realpath(target.dir), "project-b");
		await mkdir(b);
		const created = await unix.management.create({ cwd: b });
		expect(created.workspaceRoot).toBe(b);
		await waitFor(
			() => ws.directory.state.value?.sessions.some((s) => s.id === created.id) === true,
			"directory broadcast",
		);
		const first = await unix.attach(created.id);
		const second = await ws.attach(created.id);
		expect(first.view.value?.cwd).toBe(b);
		expect(second.view.value?.cwd).toBe(b);
		const lastUsed = () => unix.directory.state.value!.sessions.find((s) => s.id === created.id)!.lastUsedAt;
		// Each client's attach touches the session and the directory pushes arrive asynchronously; take the baseline once the value is quiet.
		await waitFor(() => lastUsed() > created.lastUsedAt, "activation");
		await new Promise((resolve) => setTimeout(resolve, 150));
		const active = lastUsed();
		const refreshed = await unix.attach(created.id);
		expect(lastUsed()).toBe(active);
		await refreshed.submit({ content: "hi" });
		await waitFor(() => lastUsed() > active, "input activity");
		const accepted = lastUsed();
		await waitFor(() => second.view.value?.items.some((i) => i.type === "assistant") === true, "answer");
		expect(lastUsed()).toBe(accepted);
		const fork = await ws.management.fork(created.id);
		expect(fork.workspaceRoot).toBe(b);
		expect(unix.directory.state.value!.sessions.find((s) => s.id === "1")!.workspaceRoot).not.toBe(b);
	} finally {
		await unix.close();
		await ws.close();
		await cleanup(target);
	}
});
