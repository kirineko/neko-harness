// Chord v2 gives every new or re-holding subscriber the current value; server listeners must reconcile, not republish.

import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { subscribeState } from "../src/client-session.ts";
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
			directory: first.directory.snapshot.value.revision,
			workspaces: first.workspaces.snapshot.value.revision,
			credentials: first.credentials.snapshot.value.revision,
		};
		const seen = { directory: [] as number[], workspaces: [] as number[], credentials: [] as number[] };
		const stops = [
			subscribeState(first.directory.snapshot, (value) => seen.directory.push(value.revision)),
			subscribeState(first.workspaces.snapshot, (value) => seen.workspaces.push(value.revision)),
			subscribeState(first.credentials.snapshot, (value) => seen.credentials.push(value.revision)),
		];
		for (let round = 0; round < 3; round++) {
			const other = await connectTestClient(target);
			expect(other.directory.snapshot.value.revision).toBe(initial.directory);
			expect(other.workspaces.snapshot.value.revision).toBe(initial.workspaces);
			expect(other.credentials.snapshot.value.revision).toBe(initial.credentials);
			await other.close();
		}
		await sleep(50);
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
