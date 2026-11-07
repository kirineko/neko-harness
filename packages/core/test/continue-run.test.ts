import { expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { rm } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/runtime.ts";

/** Answers once `release()` is called; until then the request waits (and rejects when aborted). */
function gatedProvider() {
	const faux = fauxProvider();
	let open = false;
	const waiting = new Set<() => void>();
	const respond: FauxResponseFactory = (_context, options) =>
		open
			? fauxAssistantMessage([fauxText("answered")])
			: new Promise((resolve, reject) => {
					const go = () => resolve(fauxAssistantMessage([fauxText("answered")]));
					waiting.add(go);
					options?.signal?.addEventListener(
						"abort",
						() => {
							waiting.delete(go);
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
	faux.setResponses(Array.from({ length: 20 }, () => respond));
	return {
		faux,
		release() {
			open = true;
			for (const go of waiting) go();
			waiting.clear();
		},
	};
}

async function until(test: () => Promise<boolean>) {
	for (let i = 0; i < 300; i++) {
		if (await test()) return;
		await Bun.sleep(10);
	}
	throw new Error("timeout");
}

const userEntries = async (runtime: NekoRuntime) => {
	const follower = await runtime.follow();
	const count = follower.value.entries.filter((entry) => entry.model?.[0]?.role === "user").length;
	follower.dispose();
	return count;
};
const live = (runtime: NekoRuntime) => runtime.harness.snapshot(LiveDoc, runtime.root.id, runtime.context);

it("continues a stopped run on its own context without a new user message", async () => {
	const gate = gatedProvider();
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [gate.faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		// Nothing failed yet: there is nothing to continue.
		await expect(runtime.root.continueRun()).rejects.toThrow(/^CONTINUE_UNAVAILABLE:/);
		await runtime.submit("question");
		await until(async () => (await live(runtime))?.run !== undefined);
		await expect(runtime.root.continueRun()).rejects.toThrow(/^CONTINUE_BUSY:/);
		await runtime.root.abort();
		expect((await live(runtime))?.runFailure?.reason).toBe("aborted");
		const users = await userEntries(runtime);
		gate.release();
		await runtime.root.continueRun();
		await until(async () => (await live(runtime))?.run === undefined);
		expect((await live(runtime))?.runFailure).toBeUndefined();
		expect(await userEntries(runtime)).toBe(users);
		const follower = await runtime.follow();
		expect(JSON.stringify(follower.value.entries.at(-1)?.model)).toContain("answered");
		follower.dispose();
		await expect(runtime.root.continueRun()).rejects.toThrow(/^CONTINUE_UNAVAILABLE:/);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("starts only one run when two clients continue at once", async () => {
	const gate = gatedProvider();
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [gate.faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		await runtime.submit("question");
		await until(async () => (await live(runtime))?.run !== undefined);
		await runtime.root.abort();
		const results = await Promise.allSettled([runtime.root.continueRun(), runtime.root.continueRun()]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		expect(String(rejected.reason)).toContain("CONTINUE_BUSY");
		gate.release();
		await until(async () => (await live(runtime))?.run === undefined);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("ends a run at the configured turn limit and continues it on the round's results", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-turns-"));
	await writeFile(join(dir, "note.txt"), "hello");
	const faux = fauxProvider();
	const read = () => fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" });
	faux.setResponses([read(), read(), fauxAssistantMessage([fauxText("done after continue")])]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		cwd: dir,
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		maxTurns: 2,
	});
	try {
		expect((await runtime.root.conversation.agent(runtime.context)).maxTurns).toBe(2);
		const answer = await runtime.waitAnswer(await runtime.submit("read twice"));
		expect(answer).toMatchObject({ status: "unanswered", reason: "turn_limit" });
		expect((await live(runtime))?.runFailure?.reason).toBe("turn_limit");
		await runtime.root.continueRun();
		await until(async () => (await live(runtime))?.run === undefined);
		expect((await live(runtime))?.runFailure).toBeUndefined();
		const follower = await runtime.follow();
		expect(JSON.stringify(follower.value.entries.at(-1)?.model)).toContain("done after continue");
		follower.dispose();
		const created = await runtime.createConversation();
		expect((await created.conversation.agent(runtime.context)).maxTurns).toBe(2);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("rejects an invalid turn limit at startup", async () => {
	await expect(createNekoRuntime({ storage: "memory", maxTurns: 0 })).rejects.toThrow(RangeError);
});
