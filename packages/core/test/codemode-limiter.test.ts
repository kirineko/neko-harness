import { expect, it } from "bun:test";
import { SANDBOX_BUSY, WorkerLimiter } from "../src/codemode.ts";

const gate = () => {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
};

it("lets a call that starts a worker keep its slot until the worker exits, not until the call ends", async () => {
	const limiter = new WorkerLimiter({ maxWorkers: 1, waitMs: 1000 });
	let release!: () => void;
	await limiter.run(undefined, async () => {
		release = limiter.acquireWorker();
	});
	expect(limiter.running).toBe(1);
	let second = false;
	const waiting = limiter.run(undefined, async () => {
		second = true;
	});
	await Bun.sleep(20);
	expect(second).toBe(false);
	expect(limiter.waiting).toBe(1);
	release();
	release();
	await waiting;
	expect(second).toBe(true);
	expect(limiter.running).toBe(0);
});

it("releases a reservation when a call never starts a worker", async () => {
	const limiter = new WorkerLimiter({ maxWorkers: 1, waitMs: 1000 });
	await limiter.run(undefined, async () => {});
	await limiter.run(undefined, async () => {});
	expect(limiter.running).toBe(0);
	expect(limiter.waiting).toBe(0);
});

it("serves waiters first-in first-out and never exceeds the cap", async () => {
	const limiter = new WorkerLimiter({ maxWorkers: 2, waitMs: 1000 });
	const order: number[] = [];
	let active = 0;
	let peak = 0;
	const gates = [gate(), gate(), gate(), gate()];
	const runs = gates.map((g, index) =>
		limiter.run(undefined, async () => {
			const release = limiter.acquireWorker();
			active += 1;
			peak = Math.max(peak, active);
			order.push(index);
			await g.promise;
			active -= 1;
			release();
		}),
	);
	await Bun.sleep(20);
	expect(order).toEqual([0, 1]);
	gates[0]!.open();
	await Bun.sleep(20);
	expect(order).toEqual([0, 1, 2]);
	for (const g of gates) g.open();
	await Promise.all(runs);
	expect(order).toEqual([0, 1, 2, 3]);
	expect(peak).toBe(2);
});

it("fails a waiter with a busy error after the wait limit, without disturbing the others", async () => {
	const limiter = new WorkerLimiter({ maxWorkers: 1, waitMs: 50 });
	const holder = gate();
	const first = limiter.run(undefined, async () => {
		const release = limiter.acquireWorker();
		await holder.promise;
		release();
	});
	await expect(limiter.run(undefined, async () => {})).rejects.toThrow(SANDBOX_BUSY);
	expect(limiter.waiting).toBe(0);
	holder.open();
	await first;
});

it("stops waiting when the call is aborted", async () => {
	const limiter = new WorkerLimiter({ maxWorkers: 1, waitMs: 5000 });
	const holder = gate();
	const first = limiter.run(undefined, async () => {
		const release = limiter.acquireWorker();
		await holder.promise;
		release();
	});
	const controller = new AbortController();
	const waiting = limiter.run(controller.signal, async () => {});
	await Bun.sleep(10);
	controller.abort(new Error("stopped"));
	await expect(waiting).rejects.toThrow("stopped");
	expect(limiter.waiting).toBe(0);
	await expect(limiter.run(AbortSignal.abort(new Error("already")), async () => {})).rejects.toThrow("already");
	holder.open();
	await first;
	await limiter.run(undefined, async () => {});
});

it("refuses a worker outright when the cap is full and no call reserved it", () => {
	const limiter = new WorkerLimiter({ maxWorkers: 1, waitMs: 10 });
	const release = limiter.acquireWorker();
	expect(() => limiter.acquireWorker()).toThrow(SANDBOX_BUSY);
	release();
	limiter.acquireWorker()();
});
