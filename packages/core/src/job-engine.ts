import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
	type ConversationId,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { NekoInput } from "./input.ts";
import {
	isTerminalJob,
	JOB_LIMITS,
	type JobReason,
	type JobRecord,
	type JobStatus,
	type JobStopOrigin,
	type JobSummary,
	JobsDoc,
	type JobsState,
	OutputBuffer,
	reportTail,
	summarizeJobRecord,
} from "./jobs.ts";
import { SubagentDoc } from "./subagents.ts";

type RunnerInput = { jobId: string; command: string; cwd: string; timeoutSeconds?: number };
type RunnerState = { phase: "start" } | { phase: "exec" };
type ReporterInput = { jobId: string; text: string; status: JobStatus; exitCode: number | null };

/** Commit and read access for one conversation's jobs, from a tool call or from the host. */
export type JobIo = {
	commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
	state(): Promise<JobsState | undefined>;
};

/** Doc items may be tracked proxies; commit results must be plain data. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class JobEntry {
	readonly controller = new AbortController();
	readonly buffer = new OutputBuffer();
	/** True while `start` still waits for an early exit; an exit then is part of the start result, not a report. */
	windowOpen = false;
	/** Set synchronously with the decision not to report, so `start` knows to wait for that exit. */
	suppressReport = false;
	readonly exited: Promise<void>;
	#resolve!: () => void;
	constructor() {
		this.exited = new Promise((resolve) => {
			this.#resolve = resolve;
		});
	}
	finish() {
		this.#resolve();
	}
}

/** Processes live in memory only: a restart loses them, and no job command is ever re-run. */
export class JobRegistry {
	#entries = new Map<string, JobEntry>();
	static key(conversationId: number, jobId: string) {
		return `${conversationId}:${jobId}`;
	}
	ensure(conversationId: number, jobId: string): JobEntry {
		const key = JobRegistry.key(conversationId, jobId);
		let entry = this.#entries.get(key);
		if (!entry) {
			entry = new JobEntry();
			this.#entries.set(key, entry);
		}
		return entry;
	}
	get(conversationId: number, jobId: string) {
		return this.#entries.get(JobRegistry.key(conversationId, jobId));
	}
	delete(conversationId: number, jobId: string) {
		this.#entries.delete(JobRegistry.key(conversationId, jobId));
	}
	abortAll() {
		for (const entry of this.#entries.values()) entry.controller.abort();
	}
	abortConversation(conversationId: number) {
		for (const [key, entry] of this.#entries) if (key.startsWith(`${conversationId}:`)) entry.controller.abort();
	}
}

type Outcome = { status: Exclude<JobStatus, "running">; exitCode: number | null; reason?: JobReason };
type Tail = { text: string; totalBytes: number };

const statusWord: Record<JobStatus, string> = {
	running: "running",
	exited: "exited",
	failed: "failed",
	stopped: "stopped",
	lost: "lost",
};

const describe = (job: JobRecord) => {
	const parts: string[] = [statusWord[job.status]];
	if (job.exitCode !== null) parts.push(`exit code ${job.exitCode}`);
	if (job.reason === "timeout") parts.push(`timed out after ${job.timeoutSeconds} seconds`);
	if (job.reason === "spawn-error") parts.push("could not start");
	if (job.reason === "restart") parts.push("the process was lost when the gateway restarted and was not re-run");
	return parts.join(", ");
};

function reportText(job: JobRecord, tail: string): string {
	const body = reportTail(tail);
	return [
		`[Background job ${job.jobId} "${job.title}" ${describe(job)}]`,
		`Command: ${job.command}`,
		body
			? `Last output (use the job tool's output action with jobId "${job.jobId}" for more):\n${body}`
			: "It produced no output.",
	].join("\n");
}

/** Settle in `tx`; returns the record, or `undefined` when the job was already terminal (terminal states never change). */
async function settleJob(
	tx: Tx,
	conversationId: ConversationId,
	jobId: string,
	outcome: Outcome,
	tail: Tail,
	quiet: boolean,
	reporter: ReturnType<typeof createReporter>,
): Promise<JobRecord | undefined> {
	const state = await tx.doc(JobsDoc, conversationId);
	const job = state.items.find((item) => item.jobId === jobId);
	if (!job || isTerminalJob(job.status)) return undefined;
	job.status = outcome.status;
	job.exitCode = outcome.exitCode;
	if (outcome.reason) job.reason = outcome.reason;
	job.endedAt = Date.now();
	job.tail = tail.text;
	job.totalBytes = tail.totalBytes;
	// A user stop is reported because the model may not know; the model's own stop and an archive are not.
	if (!quiet && (job.status !== "stopped" || job.stopOrigin === "user"))
		job.reporterId = await tx.createTask(
			reporter,
			{ jobId, text: reportText(job, tail.text), status: job.status, exitCode: job.exitCode },
			{ ownership: { kind: "conversation" }, conversationId, background: true },
		);
	const terminal = state.items.filter((item) => isTerminalJob(item.status));
	if (terminal.length > JOB_LIMITS.keepTerminal) {
		const drop = new Set(
			terminal
				.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
				.slice(0, terminal.length - JOB_LIMITS.keepTerminal)
				.map((item) => item.jobId),
		);
		state.items = state.items.filter((item) => !drop.has(item.jobId));
	}
	return job;
}

function createReporter() {
	return defineTask<ReporterInput, { phase: "report" }, null>({
		name: "app.neko.job-reporter",
		version: 1,
		initial: () => ({ phase: "report" }),
		phases: {
			report: async (task, runtime, ctx) => {
				const target = (await runtime.conversation(runtime.conversationId, ctx))!;
				// A repeat returns the first submission, so a job is reported at most once, restarts included.
				await target.submit(
					{
						type: "input",
						content: task.input.text,
						whenBusy: "followUp",
						requestId: `job-report:${task.input.jobId}`,
						entry: {
							kind: NekoInput.kind,
							data: {
								at: Date.now(),
								prompt: task.input.text,
								images: [],
								jobReport: { jobId: task.input.jobId, status: task.input.status, exitCode: task.input.exitCode },
							},
						},
					},
					ctx,
				);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
}

const delay = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		if (signal?.aborted) done();
		else signal?.addEventListener("abort", done, { once: true });
	});

const action = Type.Union([Type.Literal("start"), Type.Literal("output"), Type.Literal("stop"), Type.Literal("list")]);
const parameters = Type.Object({
	action,
	command: Type.Optional(
		Type.String({ description: "start: shell command to run in the session's working directory." }),
	),
	title: Type.Optional(Type.String({ description: "start: short label shown in the job list." })),
	timeout: Type.Optional(Type.Number({ description: "start: optional timeout in seconds; no default timeout." })),
	jobId: Type.Optional(Type.String({ description: "output/stop: the job id returned by start or list." })),
	since: Type.Optional(
		Type.Integer({ description: "output: resume after this offset, as returned by the previous output call." }),
	),
});

const stringField = (value: unknown, name: string) => {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`Invalid job arguments: ${name} must be a nonempty string.`);
	return value;
};

type StartArgs = { command: string; title: string; timeoutSeconds?: number };

export class JobManager {
	readonly registry = new JobRegistry();
	readonly #reporter = createReporter();
	readonly #runner = this.#createRunner();
	readonly extension: Extension;

	readonly #startWindowMs: number;

	constructor(options: { readonly startWindowMs?: number } = {}) {
		this.#startWindowMs = options.startWindowMs ?? JOB_LIMITS.startWindowMs;
		this.extension = this.#createExtension();
	}

	#closing = false;

	#createRunner() {
		const registry = this.registry;
		const reporter = this.#reporter;
		return defineTask<RunnerInput, RunnerState, { status: JobStatus }>({
			name: "app.neko.job-runner",
			version: 1,
			initial: () => ({ phase: "start" }),
			phases: {
				// The checkpoint comes before the process: after a restart the task is aborted, never resumed into exec.
				start: (_task, runtime, ctx) =>
					runtime.commit(() => ({ status: "running", checkpoint: { phase: "exec" } }), ctx),
				exec: async (task, runtime, ctx) => {
					const { jobId, command, cwd, timeoutSeconds } = task.input;
					const entry = registry.ensure(runtime.conversationId, jobId);
					let outcome: Outcome;
					try {
						const env = await runtime.env(ctx);
						if (!env) {
							outcome = { status: "failed", exitCode: null, reason: "spawn-error" };
						} else {
							const result = await env.exec(
								command,
								{
									...(cwd ? { cwd } : {}),
									...(timeoutSeconds === undefined ? {} : { timeout: timeoutSeconds }),
									onOutput: (text) => entry.buffer.append(text),
								},
								withAbortSignal(entry.controller.signal, ctx),
							);
							if (result.ok)
								outcome = {
									status: result.value.exitCode === 0 ? "exited" : "failed",
									exitCode: result.value.exitCode,
								};
							else if (result.error.code === "timeout")
								outcome = { status: "failed", exitCode: null, reason: "timeout" };
							else if (result.error.code === "aborted")
								outcome = { status: "stopped", exitCode: null, reason: "aborted" };
							else {
								// Surface why nothing ran (e.g. no Git Bash on Windows) in the job output the model reads.
								entry.buffer.append(`${result.error.message}\n`);
								outcome = { status: "failed", exitCode: null, reason: "spawn-error" };
							}
						}
						if (this.#closing) {
							// Shutdown killed the process; stay unsettled so the next open reports the job as lost.
							await new Promise<void>((resolve) => {
								if (!ctx.abortSignal || ctx.abortSignal.aborted) resolve();
								else ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
							});
							throw ctx.abortSignal?.reason ?? new Error("Job runner interrupted by shutdown");
						}
						const quiet = entry.windowOpen;
						if (quiet) entry.suppressReport = true;
						const tail = { text: entry.buffer.tail(), totalBytes: entry.buffer.totalBytes };
						await runtime.commit(async (tx) => {
							const job = await settleJob(tx, runtime.conversationId, jobId, outcome, tail, quiet, reporter);
							return {
								status: "terminal",
								outcome: { status: "completed", result: { status: job?.status ?? outcome.status } },
							};
						}, ctx);
					} finally {
						registry.delete(runtime.conversationId, jobId);
						entry.finish();
					}
				},
			},
			abort: async (task, runtime, ctx) => {
				const { jobId } = task.input;
				const entry = registry.get(runtime.conversationId, jobId);
				entry?.controller.abort();
				const restart = task.abortReason === "restart";
				const outcome: Outcome = restart
					? { status: "lost", exitCode: null, reason: "restart" }
					: { status: "stopped", exitCode: null, reason: "aborted" };
				try {
					await runtime.commit(async (tx) => {
						const known = (await tx.doc(JobsDoc, runtime.conversationId)).items.find((item) => item.jobId === jobId);
						const tail = entry
							? { text: entry.buffer.tail(), totalBytes: entry.buffer.totalBytes }
							: { text: known?.tail ?? "", totalBytes: known?.totalBytes ?? 0 };
						await settleJob(tx, runtime.conversationId, jobId, outcome, tail, false, reporter);
						return { status: "terminal", outcome: { status: "aborted" } };
					}, ctx);
				} finally {
					registry.delete(runtime.conversationId, jobId);
					entry?.finish();
				}
			},
		});
	}

	#createExtension(): Extension {
		return defineExtension({
			name: "neko-jobs",
			tasks: [this.#runner, this.#reporter],
			tools: [
				defineTool({
					name: "job",
					description:
						"Run long-lived commands (dev servers, watchers, long builds) in the background. start: command (optional title, timeout seconds) returns a jobId immediately; the command has no stdin. output: jobId (optional since offset) reads the output tail or what is new. stop: jobId terminates the whole process tree. list: show this session's jobs. When a job ends you receive a report; do not poll. At most 4 jobs run at once.",
					parameters,
					replay: "unsafe",
					execute: async (input, api, context) => {
						const args = input as Record<string, unknown>;
						if ((await api.snapshot(SubagentDoc, api.conversationId, context))?.role)
							throw new Error("Subagents cannot use jobs.");
						const io: JobIo = {
							commit: (change) => api.commit(change, context),
							state: async () => api.snapshot(JobsDoc, api.conversationId, context),
						};
						const kind = args.action;
						if (kind === "list") return this.#text(this.#listText((await io.state())?.items ?? []));
						if (kind === "output") {
							const jobId = stringField(args.jobId, "jobId");
							const since = args.since;
							if (since !== undefined && (!Number.isInteger(since) || (since as number) < 0))
								throw new Error("Invalid job arguments: since must be a non-negative integer.");
							return this.#text(await this.output(io, api.conversationId, jobId, since as number | undefined));
						}
						if (kind === "stop") {
							const jobId = stringField(args.jobId, "jobId");
							const job = await this.stop(io, api.conversationId, jobId, "model", context);
							return this.#text(`Job ${job.jobId} ${describe(job)}.`);
						}
						if (kind !== "start") throw new Error("Invalid job arguments: action must be start, output, stop or list.");
						const command = stringField(args.command, "command");
						if (Buffer.byteLength(command) > JOB_LIMITS.commandBytes)
							throw new Error("Invalid job arguments: command is too long.");
						const timeout = args.timeout;
						if (
							timeout !== undefined &&
							(typeof timeout !== "number" ||
								!Number.isFinite(timeout) ||
								timeout <= 0 ||
								timeout > JOB_LIMITS.maxTimeoutSeconds)
						)
							throw new Error("Invalid job arguments: timeout must be a positive number of seconds.");
						const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : command;
						const agent = await api.agent(context);
						return this.#text(
							await this.start(
								io,
								api.conversationId,
								agent.cwd ?? "",
								{
									command,
									title: title.slice(0, JOB_LIMITS.titleChars),
									...(timeout === undefined ? {} : { timeoutSeconds: timeout as number }),
								},
								context,
							),
						);
					},
				}),
			],
		});
	}

	#text(text: string) {
		return { output: [{ type: "text" as const, text }] };
	}

	#listText(items: JobRecord[]) {
		if (!items.length) return "No jobs.";
		return items.map((job) => `${job.jobId} [${describe(job)}] "${job.title}" — ${job.command}`).join("\n");
	}

	async start(io: JobIo, conversationId: ConversationId, cwd: string, args: StartArgs, context: Context) {
		let allocated: string | undefined;
		let entry: JobEntry | undefined;
		let created: JobRecord;
		try {
			created = await io.commit(async (tx) => {
				const state = await tx.doc(JobsDoc, conversationId);
				if (state.items.filter((item) => item.status === "running").length >= JOB_LIMITS.maxRunning)
					throw new Error(
						`Too many running jobs (limit ${JOB_LIMITS.maxRunning}). Stop one with the job tool's stop action first.`,
					);
				const jobId = `job-${state.next++}`;
				const record: JobRecord = {
					jobId,
					title: args.title,
					command: args.command,
					cwd,
					status: "running",
					startedAt: Date.now(),
					endedAt: null,
					exitCode: null,
					...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
					runnerId: 0,
				};
				// Open the window before the runner can exist, so an instant exit is never mistaken for a late one.
				allocated = jobId;
				entry = this.registry.ensure(conversationId, jobId);
				entry.windowOpen = true;
				record.runnerId = await tx.createTask(
					this.#runner,
					{
						jobId,
						command: args.command,
						cwd,
						...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
					},
					{ ownership: { kind: "conversation" }, conversationId, background: true, abandonOnRestart: true },
				);
				state.items.push(record);
				return plain(record);
			});
		} catch (error) {
			if (allocated) this.registry.delete(conversationId, allocated);
			throw error;
		}
		// Held here because the runner removes the entry from the registry once it settles.
		const live = entry!;
		await Promise.race([live.exited, delay(this.#startWindowMs, context.abortSignal)]);
		live.windowOpen = false;
		if (live.suppressReport) await live.exited;
		const job = (await io.state())?.items.find((item) => item.jobId === created.jobId) ?? created;
		const read = live.buffer.read();
		return this.#render(job, read.text, read.offset, read.dropped);
	}

	#render(job: JobRecord, text: string, offset: number, dropped: number) {
		const lines = [`Job ${job.jobId} ${describe(job)}.`, `Title: ${job.title}`, `Command: ${job.command}`];
		if (dropped > 0) lines.push(`(${dropped} bytes of earlier output were dropped)`);
		lines.push(text ? `Output (next offset ${offset}):\n${text}` : `No new output (next offset ${offset}).`);
		return lines.join("\n");
	}

	async output(io: JobIo, conversationId: ConversationId, jobId: string, since?: number) {
		const job = await this.#find(io, jobId);
		const output = this.read(conversationId, job, since);
		return this.#render(job, output.text, output.offset, output.dropped);
	}

	async readOutput(io: JobIo, conversationId: ConversationId, jobId: string, since?: number) {
		const job = await this.#find(io, jobId);
		const output = this.read(conversationId, job, since);
		return { job: summarizeJobRecord(job, output.offset), output };
	}

	async #find(io: JobIo, jobId: string) {
		const job = (await io.state())?.items.find((item) => item.jobId === jobId);
		if (!job) throw new Error(`Unknown job ${jobId}.`);
		return job;
	}

	async list(io: JobIo, conversationId: ConversationId): Promise<JobSummary[]> {
		return ((await io.state())?.items ?? []).map((job) =>
			summarizeJobRecord(job, this.registry.get(conversationId, job.jobId)?.buffer.totalBytes ?? job.totalBytes ?? 0),
		);
	}

	/** Live output while running, the persisted tail after. */
	read(conversationId: ConversationId, job: JobRecord, since?: number) {
		const entry = isTerminalJob(job.status) ? undefined : this.registry.get(conversationId, job.jobId);
		return (entry?.buffer ?? OutputBuffer.fromTail(job.tail ?? "", job.totalBytes ?? 0)).read(since);
	}

	/** Stop one job, only that run; an already ended job is returned as it is. */
	async stop(io: JobIo, conversationId: ConversationId, jobId: string, origin: JobStopOrigin, context?: Context) {
		// The live entry stays outside the commit result, which is structured-cloned.
		let live: JobEntry | undefined;
		const found = await io.commit(async (tx) => {
			live = undefined;
			const job = (await tx.doc(JobsDoc, conversationId)).items.find((item) => item.jobId === jobId);
			if (!job) throw new Error(`Unknown job ${jobId}.`);
			if (isTerminalJob(job.status)) return { job: plain(job) };
			job.stopOrigin ??= origin;
			live = this.registry.get(conversationId, jobId);
			if (live) return { job: plain(job) };
			// No process behind a running record: nothing can settle it later, so settle it here.
			const settled = await settleJob(
				tx,
				conversationId,
				jobId,
				{ status: "stopped", exitCode: null },
				{ text: job.tail ?? "", totalBytes: job.totalBytes ?? 0 },
				false,
				this.#reporter,
			);
			return { job: plain(settled ?? job) };
		});
		const entry = live as JobEntry | undefined;
		if (entry) {
			entry.controller.abort();
			await Promise.race([entry.exited, delay(10_000, context?.abortSignal)]);
			return (await io.state())?.items.find((item) => item.jobId === jobId) ?? found.job;
		}
		return found.job;
	}

	/** Stop every running job of a conversation without reporting, as an archive does. */
	async stopAll(io: JobIo, conversationId: ConversationId, origin: JobStopOrigin = "archive") {
		const running = ((await io.state())?.items ?? []).filter((item) => item.status === "running");
		for (const job of running) await this.stop(io, conversationId, job.jobId, origin);
	}

	/** The runtime is closing: kill every process but leave the records running, so the next open reports them lost. */
	shutdown() {
		this.#closing = true;
		this.registry.abortAll();
	}
}
