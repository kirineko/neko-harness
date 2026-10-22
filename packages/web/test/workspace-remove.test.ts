import { expect, it } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, connectTestClient, makeGateway, waitFor } from "../../gateway/test/helpers.ts";
import { GatewayConnection, type GatewayEvents } from "../src/client/lib/gateway.ts";

it("removes workspaces: other, current, rejected and removed by another client", async () => {
	const target = await makeGateway();
	const dir = await realpath(target.dir);
	const b = join(dir, "B"),
		c = join(dir, "C");
	await mkdir(b);
	await mkdir(c);
	const events: GatewayEvents = {
		onPhase: () => {},
		onError: () => {},
		onDirectory: () => {},
		onWorkspaces: () => {},
		onWorkspace: () => {},
		onOperation: () => {},
		onModels: () => {},
		onSessionChange: () => {},
		onView: () => {},
	};
	const web = new GatewayConnection({
		url: target.wsUrl,
		serverId: target.serverId,
		workspaceRoot: b,
		events,
		retryBaseMs: 20,
	});
	const peer = await connectTestClient(target);
	try {
		await web.start();
		await web.addWorkspace(c);
		await web.createSession();
		const inC = web.currentSessionId!;
		await web.selectWorkspace(b);
		await web.createSession();
		const inB = web.currentSessionId!;

		// Removing another workspace keeps the current session.
		await web.removeWorkspace(c);
		expect(web.workspaceRoot).toBe(b);
		expect(web.currentSessionId).toBe(inB);
		await waitFor(() => peer.directory.state.value?.sessions.every((s) => s.id !== inC) === true, "C hidden");

		// Removing the current workspace moves to another one.
		await web.addWorkspace(c);
		await web.selectWorkspace(b);
		await web.removeWorkspace(b);
		expect(web.workspaceRoot).not.toBe(b);
		expect(web.managementReady).toBe(true);

		// Another client removes the current workspace.
		const current = web.workspaceRoot;
		const other = (peer.workspaces.state.value?.workspaces ?? []).map((w) => w.path).find((path) => path !== current)!;
		await peer.workspaces.remove({ path: current });
		await waitFor(() => web.workspaceRoot === other, "automatic switch after external removal");
		expect(web.managementReady).toBe(true);
		// A rejected removal changes nothing. Kept last: a rejected RPC is followed by teardown only (Bun's WebSocket
		// client sometimes drops the link with 1002 when more traffic follows an error frame).
		const stay = web.workspaceRoot;
		const session = web.currentSessionId;
		await expect(web.removeWorkspace(join(dir, "missing"))).rejects.toThrow("WORKSPACE_UNKNOWN:");
		expect(web.workspaceRoot).toBe(stay);
		expect(web.currentSessionId).toBe(session);
	} finally {
		web.dispose();
		await peer.close();
		await cleanup(target);
	}
}, 20000);
