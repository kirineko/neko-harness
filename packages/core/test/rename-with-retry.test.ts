import { expect, it } from "bun:test";
import { renameWithRetry } from "../src/rename-with-retry.ts";

const failing = (code: string, times: number) => {
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		rename: async () => {
			if (++calls <= times) throw Object.assign(new Error(code), { code });
		},
	};
};

it("retries transient errors with increasing delays then succeeds", async () => {
	const fake = failing("EPERM", 3);
	const delays: number[] = [];
	await renameWithRetry("a", "b", { rename: fake.rename, sleep: async (ms) => void delays.push(ms) });
	expect(fake.calls).toBe(4);
	expect(delays).toEqual([10, 20, 40]);
});

it("throws after the total delay cap on persistent transient failure", async () => {
	const fake = failing("EBUSY", Number.POSITIVE_INFINITY);
	let total = 0;
	await expect(
		renameWithRetry("a", "b", {
			rename: fake.rename,
			sleep: async (ms) => {
				total += ms;
			},
		}),
	).rejects.toMatchObject({ code: "EBUSY" });
	expect(total).toBeLessThanOrEqual(1000);
	expect(total).toBeGreaterThan(500);
});

it("does not retry other errors", async () => {
	const fake = failing("ENOENT", Number.POSITIVE_INFINITY);
	await expect(renameWithRetry("a", "b", { rename: fake.rename, sleep: async () => {} })).rejects.toMatchObject({
		code: "ENOENT",
	});
	expect(fake.calls).toBe(1);
});
