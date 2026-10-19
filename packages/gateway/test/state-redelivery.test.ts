// Chord 1.3 gives every new or re-holding subscriber the current value; server listeners must reconcile, not republish.

import { afterEach, beforeEach, expect, it } from "bun:test";
import { cleanup, connectTestClient, makeGateway, type TestGateway } from "./helpers.ts";

let target: TestGateway;

beforeEach(async () => {
	target = await makeGateway();
});

afterEach(async () => {
	await cleanup(target);
});

it("delivers the current server state to reconnecting clients without bumping revisions", async () => {
	const first = await connectTestClient(target);
	try {
		const initial = {
			directory: first.directory.state.value.revision,
			workspaces: first.workspaces.state.value.revision,
			credentials: first.credentials.state.value.revision,
		};
		const seen = { directory: [] as number[], workspaces: [] as number[], credentials: [] as number[] };
		const stops = [
			first.directory.state.subscribe((value) => seen.directory.push(value.revision)),
			first.workspaces.state.subscribe((value) => seen.workspaces.push(value.revision)),
			first.credentials.state.subscribe((value) => seen.credentials.push(value.revision)),
		];
		for (let round = 0; round < 3; round++) {
			const other = await connectTestClient(target);
			expect(other.directory.state.value.revision).toBe(initial.directory);
			expect(other.workspaces.state.value.revision).toBe(initial.workspaces);
			expect(other.credentials.state.value.revision).toBe(initial.credentials);
			await other.close();
		}
		await Bun.sleep(50);
		expect(seen).toEqual({
			directory: [initial.directory],
			workspaces: [initial.workspaces],
			credentials: [initial.credentials],
		});
		for (const stop of stops) stop();
	} finally {
		await first.close();
	}
});
