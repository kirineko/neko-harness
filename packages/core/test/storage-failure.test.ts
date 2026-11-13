import { setTimeout as sleep } from "node:timers/promises";
import { MemoryStorage, SessionFailed, StorageRequestError } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { createNekoRuntime } from "../src/runtime.ts";

for (const method of ["commit", "scanEntries"] as const) {
	it(`ends waits and watches after a fatal storage ${method} failure`, async () => {
		const faux = fauxProvider();
		const reports: unknown[] = [];
		const runtime = await createNekoRuntime({
			storage: "memory",
			providers: [faux.provider],
			model: { provider: "faux", modelId: "faux-1" },
			onReport: (e) => reports.push(e),
		});
		const watch = await runtime.watch();
		const error = new Error("injected disk failure");
		const spy = vi.spyOn(MemoryStorage.prototype, method).mockImplementation(async () => {
			throw error;
		});
		try {
			const operation =
				method === "commit" ? runtime.submit("fail") : runtime.conversation.entries({}, 1, undefined, runtime.context);
			await expect(operation).rejects.toBe(error);
			expect((await runtime.closed).kind).toBe("failed");
			expect((await watch.closed).kind).toBe("failed");
			await expect(runtime.submit("later")).rejects.toBeInstanceOf(SessionFailed);
			expect(reports).toContain(error);
		} finally {
			spy.mockRestore();
			await runtime.close();
		}
	});
}
it("keeps an invalid independent read non-fatal but fails an invalid storage commit", async () => {
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [fauxProvider().provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	const error = new StorageRequestError("invalid request");
	const read = vi.spyOn(MemoryStorage.prototype, "scanEntries").mockImplementation(async () => {
		throw error;
	});
	try {
		await expect(runtime.conversation.entries({}, 1, undefined, runtime.context)).rejects.toBe(error);
	} finally {
		read.mockRestore();
	}
	expect(await runtime.listConversations()).toHaveLength(1);
	const commit = vi.spyOn(MemoryStorage.prototype, "commit").mockImplementation(async () => {
		throw error;
	});
	try {
		await expect(runtime.submit("fail commit")).rejects.toBe(error);
		expect((await runtime.closed).kind).toBe("failed");
	} finally {
		commit.mockRestore();
		await runtime.close();
	}
});

it("rejects an already pending submission wait and cleans up idempotently", async () => {
	const faux = fauxProvider();
	let started = false;
	faux.setResponses([
		async (_context, options) => {
			started = true;
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return (await import("@earendil-works/pi-ai")).fauxAssistantMessage([], { stopReason: "aborted" });
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		onReport() {},
	});
	const submission = await runtime.submit("pending");
	const pending = submission.wait(runtime.context).catch((error) => error);
	for (let n = 0; n < 100 && !started; n++) await sleep(1);
	expect(started).toBe(true);
	const spy = vi.spyOn(MemoryStorage.prototype, "scanEntries").mockImplementation(async () => {
		throw new Error("disk failure while waiting");
	});
	try {
		await expect(runtime.conversation.entries({}, 1, undefined, runtime.context)).rejects.toThrow("disk failure");
		expect(await pending).toBeInstanceOf(SessionFailed);
		expect((await runtime.closed).kind).toBe("failed");
	} finally {
		spy.mockRestore();
		await Promise.all([runtime.close(), runtime.close()]);
	}
});
