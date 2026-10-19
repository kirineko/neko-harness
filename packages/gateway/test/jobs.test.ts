import { expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { JOBS_UNSUPPORTED, jobsClient } from "../src/client-session.ts";
import type { NekoChat } from "../src/contract.ts";
import { ChatViewSchema } from "../src/contract.ts";
import { cleanup, connectTestClient, makeGateway, type TestGateway, waitFor } from "./helpers.ts";

const start = (command: string, title?: string) =>
	fauxAssistantMessage([fauxToolCall("job", { action: "start", command, ...(title ? { title } : {}) })], {
		stopReason: "toolUse",
	});
const text = (value: string) => fauxAssistantMessage([fauxText(value)]);

async function startJob(target: TestGateway, command: string, title = "job") {
	target.faux.setResponses([start(command, title), text("started"), text("noted")]);
	const client = await connectTestClient(target);
	const chat = await client.attach(String(target.gateway.runtime.root.id));
	await chat.submit({ content: "go" });
	await waitFor(
		() => chat.view.value?.items.some((item) => item.type === "assistant" && item.text === "started") ?? false,
		"turn finished after the start window",
	);
	expect(chat.view.value?.jobs?.[0]?.status).toBe("running");
	return { client, chat };
}

it("always sends a bounded job summary list without output", async () => {
	const target = await makeGateway();
	const client = await connectTestClient(target);
	try {
		const idle = await client.attach(String(target.gateway.runtime.root.id));
		expect(idle.view.value?.jobs).toEqual([]);
		await client.detach();
	} finally {
		await client.close();
	}
	const { client: second, chat } = await startJob(
		target,
		`echo SECRET-OUTPUT; ${"x".repeat(3000)}; sleep 300`,
		"server",
	);
	try {
		const [job] = chat.view.value!.jobs!;
		expect(job).toMatchObject({ jobId: "job-1", title: "server", status: "running", exitCode: null });
		expect(job!.command.length).toBeLessThanOrEqual(1001);
		expect(JSON.stringify(chat.view.value!.jobs)).not.toContain("SECRET-OUTPUT\n");
		expect(Value.Check(ChatViewSchema, chat.view.value)).toBe(true);
		// A view from a gateway without jobs is still valid, and unknown extra fields do not break validation.
		const { jobs: _jobs, ...withoutJobs } = chat.view.value!;
		expect(Value.Check(ChatViewSchema, withoutJobs)).toBe(true);
		expect(Value.Check(ChatViewSchema, { ...chat.view.value, futureField: 1 })).toBe(true);
		await chat.jobStop({ jobId: "job-1" });
	} finally {
		await second.close();
		await cleanup(target);
	}
}, 30000);

it("reads output in bounded pages and resumes from the offset after reconnecting", async () => {
	const target = await makeGateway();
	const { client, chat } = await startJob(target, "head -c 200000 /dev/zero | tr '\\0' a; echo END; sleep 300");
	try {
		const first = await chat.jobOutput({ jobId: "job-1" });
		expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(64 * 1024);
		expect(first.offset).toBeGreaterThan(0);
		expect(first.truncated).toBe(true);
		expect(first.dropped).toBeGreaterThan(0);

		await client.close();
		const again = await connectTestClient(target);
		try {
			const reattached = await again.attach(String(target.gateway.runtime.root.id));
			expect(reattached.view.value?.jobs?.[0]).toMatchObject({ jobId: "job-1", status: "running" });
			const rest = await reattached.jobOutput({ jobId: "job-1", since: first.offset });
			expect(rest.text).toBe("");
			expect(rest.offset).toBe(first.offset);
			await reattached.jobStop({ jobId: "job-1" });
		} finally {
			await again.close();
		}
	} finally {
		await client.close().catch(() => {});
		await cleanup(target);
	}
}, 30000);

it("stops a job once for concurrent clients, rejects unknown ids and returns the terminal state when it already ended", async () => {
	const target = await makeGateway();
	const { client, chat } = await startJob(target, "sleep 300");
	const other = await connectTestClient(target);
	try {
		const second = await other.attach(String(target.gateway.runtime.root.id));
		await waitFor(() => second.view.value?.jobs?.[0]?.status === "running", "second client sees job");
		const results = await Promise.all([chat.jobStop({ jobId: "job-1" }), second.jobStop({ jobId: "job-1" })]);
		expect(results.map((job) => job.status)).toEqual(["stopped", "stopped"]);
		await waitFor(
			() => chat.view.value?.jobs?.[0]?.status === "stopped" && second.view.value?.jobs?.[0]?.status === "stopped",
			"both clients show stopped",
		);
		expect(chat.view.value!.jobs![0]!.endedAt).toBe(second.view.value!.jobs![0]!.endedAt);
		expect((await chat.jobStop({ jobId: "job-1" })).status).toBe("stopped");
		await expect(chat.jobStop({ jobId: "job-404" })).rejects.toThrow();
		await expect(chat.jobOutput({ jobId: "job-404" })).rejects.toThrow();
		// A user stop is reported back to the model as a system notice.
		await waitFor(
			() => chat.view.value?.items.some((item) => item.type === "system" && item.jobId === "job-1") ?? false,
			"job report item",
		);
	} finally {
		await other.close();
		await client.close();
		await cleanup(target);
	}
}, 30000);

it("does not let one session read or stop another session's job", async () => {
	const target = await makeGateway();
	const { client, chat } = await startJob(target, "sleep 300");
	try {
		const session = await target.gateway.runtime.createConversation();
		const foreign = await client.attach(String(session.id));
		expect(foreign.view.value?.jobs).toEqual([]);
		await expect(foreign.jobOutput({ jobId: "job-1" })).rejects.toThrow();
		await expect(foreign.jobStop({ jobId: "job-1" })).rejects.toThrow();
		expect((await target.gateway.runtime.root.jobs())[0]!.status).toBe("running");
		// The earlier handle no longer reaches its session after switching.
		await expect(chat.jobStop({ jobId: "job-1" })).rejects.toThrow();
		expect((await target.gateway.runtime.root.jobs())[0]!.status).toBe("running");
		await target.gateway.runtime.root.stopJob("job-1");
	} finally {
		await client.close();
		await cleanup(target);
	}
}, 30000);

it("degrades on a gateway without job support instead of failing", async () => {
	const calls: string[] = [];
	const old = {
		view: { value: { items: [] } },
		jobOutput: async () => void calls.push("output"),
		jobStop: async () => void calls.push("stop"),
	} as unknown as NekoChat;
	const client = jobsClient(old);
	expect(client.supported).toBe(false);
	expect(client.list()).toEqual([]);
	await expect(client.output("job-1")).rejects.toThrow(JOBS_UNSUPPORTED);
	await expect(client.stop("job-1")).rejects.toThrow(JOBS_UNSUPPORTED);
	expect(calls).toEqual([]);
});
