import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Cursor, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { CHANGE_LIMITS, clipDiff } from "./change-limits.ts";
import { CODEMODE_NAME } from "./codemode-mode.ts";
import { NestedChangesDoc, type NestedChangesState } from "./nested-changes.ts";
import { countDiffLines, editResultDiff, synthesizedWriteDiff } from "./projection.ts";
import { SubagentsDoc } from "./subagents.ts";

export { CHANGE_LIMITS };

/** The main agent's label in `ChangeOp.agent` and `ChangedFile.agents`; subagents use their title. */
export const MAIN_AGENT = "main";

export type ChangeOp = {
	/** Entry id of the tool result; orders operations across the main agent and its subagents. */
	seq: number;
	agent: string;
	tool: "edit" | "write";
	/** Display diff; a write is all additions because the replaced content is unknown. */
	diff: string;
	added: number;
	removed: number;
	truncated: boolean;
};

export type ChangedFile = {
	/** Workspace-relative with `/`; the absolute path when `outside`. */
	path: string;
	outside?: true;
	ops: number;
	added: number;
	removed: number;
	agents: string[];
	lastSeq: number;
};

export type ChangeList = { revision: number; files: ChangedFile[]; truncated: boolean };
export type ChangeDetail = { path: string; outside?: true; ops: ChangeOp[]; truncated: boolean };
export type ChangeSummary = { revision: number; files: number; added: number; removed: number };

/** Resolve a tool path against the tool's cwd; inside the workspace it becomes relative with `/`. */
export function normalizeChangePath(raw: string, cwd: string, workspace: string): { path: string; outside: boolean } {
	const resolved = raw.startsWith("~") ? raw : resolve(cwd, raw);
	if (!raw.startsWith("~")) {
		const local = relative(workspace, resolved);
		if (local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))
			return { path: local.split(sep).join("/"), outside: false };
	}
	return { path: resolved.split(sep).join("/"), outside: true };
}

type FileAggregate = {
	path: string;
	outside: boolean;
	ops: number;
	added: number;
	removed: number;
	agents: Set<string>;
	lastSeq: number;
	items: ChangeOp[];
	truncated: boolean;
};

type Pending = { tool: "edit" | "write"; path: string; args: unknown };

/** Change index of one conversation, fed entry by entry in ascending order. */
export class ConversationChanges {
	last = 0;
	/** Successful edit/write calls seen so far, including those evicted by a bound. */
	total = 0;
	truncated = false;
	bytes = 0;
	readonly files = new Map<string, FileAggregate>();
	/** Position of every codemode call seen: its tool result's entry id once there is one, else its assistant entry. */
	readonly #scripts = new Map<string, number>();
	readonly #pending = new Map<string, Pending>();
	readonly #agent: string;
	readonly #cwd: string;
	readonly #workspace: string;

	constructor(agent: string, cwd: string, workspace: string) {
		this.#agent = agent;
		this.#cwd = cwd;
		this.#workspace = workspace;
	}

	feed(entry: EntryRecord) {
		for (const message of entry.model ?? []) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall" && block.name === CODEMODE_NAME) this.#scripts.set(block.id, entry.id);
					if (block.type !== "toolCall" || (block.name !== "edit" && block.name !== "write")) continue;
					const path = (block.arguments as { path?: unknown } | undefined)?.path;
					if (typeof path === "string" && path !== "")
						this.#pending.set(block.id, { tool: block.name, path, args: block.arguments });
				}
			} else if (message.role === "toolResult") {
				if (this.#scripts.has(message.toolCallId)) this.#scripts.set(message.toolCallId, entry.id);
				const call = this.#pending.get(message.toolCallId);
				if (!call) continue;
				this.#pending.delete(message.toolCallId);
				if (message.isError) continue;
				this.#add(call, message.details, entry.id);
			}
		}
		this.last = entry.id;
	}

	/**
	 * A copy that also holds the edits and writes of scripts whose codemode call is in this conversation's entries
	 * (a record of a call that was rewound away stays out). The cached index itself is never changed by it.
	 */
	withNested(nested: Readonly<NestedChangesState>): ConversationChanges {
		const visible = nested.items.filter((item) => this.#scripts.has(item.parentCallId));
		const copy = new ConversationChanges(this.#agent, this.#cwd, this.#workspace);
		copy.last = this.last;
		copy.total = this.total;
		copy.truncated = this.truncated || (nested.dropped && visible.length > 0);
		copy.bytes = this.bytes;
		for (const [path, file] of this.files)
			copy.files.set(path, { ...file, agents: new Set(file.agents), items: file.items.map((item) => ({ ...item })) });
		for (const item of visible)
			copy.#record(
				{ tool: item.tool, path: item.path },
				{ diff: item.diff, added: item.added, removed: item.removed, truncated: item.truncated },
				this.#scripts.get(item.parentCallId)!,
			);
		return copy;
	}

	#add(call: Pending, details: unknown, seq: number) {
		let diff = "";
		let added = 0;
		let removed = 0;
		let truncated = false;
		if (call.tool === "edit") {
			const raw = editResultDiff(details);
			if (raw !== null) {
				const clipped = clipDiff(raw);
				const counts = countDiffLines(raw);
				({ diff, truncated } = clipped);
				added = counts.added;
				removed = counts.removed;
			}
		} else {
			const synthesized = synthesizedWriteDiff(call.args);
			if (synthesized) {
				({ diff, added, removed, truncated } = synthesized);
			}
		}
		this.#record(call, { diff, added, removed, truncated }, seq);
	}

	#record(
		call: Pick<Pending, "tool" | "path">,
		shown: { diff: string; added: number; removed: number; truncated: boolean },
		seq: number,
	) {
		const { path, outside } = normalizeChangePath(call.path, this.#cwd, this.#workspace);
		const { diff, added, removed, truncated } = shown;
		this.total++;
		let file = this.files.get(path);
		if (!file) {
			file = {
				path,
				outside,
				ops: 0,
				added: 0,
				removed: 0,
				agents: new Set(),
				lastSeq: 0,
				items: [],
				truncated: false,
			};
			this.files.set(path, file);
		}
		file.ops++;
		file.added += added;
		file.removed += removed;
		file.agents.add(this.#agent);
		file.lastSeq = Math.max(file.lastSeq, seq);
		file.items.push({ seq, agent: this.#agent, tool: call.tool, diff, added, removed, truncated });
		this.bytes += Buffer.byteLength(diff, "utf8");
		if (file.items.length > CHANGE_LIMITS.opsPerFile) {
			const dropped = file.items.shift()!;
			this.bytes -= Buffer.byteLength(dropped.diff, "utf8");
			file.truncated = true;
			this.truncated = true;
		}
		this.#bound();
	}

	#bound() {
		if (this.files.size > CHANGE_LIMITS.files) {
			const oldest = [...this.files.values()].sort((a, b) => a.lastSeq - b.lastSeq)[0]!;
			this.files.delete(oldest.path);
			for (const item of oldest.items) this.bytes -= Buffer.byteLength(item.diff, "utf8");
			this.truncated = true;
		}
		if (this.bytes <= CHANGE_LIMITS.diffBytes) return;
		for (const file of [...this.files.values()].sort((a, b) => a.lastSeq - b.lastSeq)) {
			for (const item of file.items) {
				if (this.bytes <= CHANGE_LIMITS.diffBytes) return;
				this.bytes -= Buffer.byteLength(item.diff, "utf8");
				item.diff = "";
				item.truncated = true;
				file.truncated = true;
				this.truncated = true;
			}
		}
	}
}

type Member = { id: ConversationId; agent: string };

/**
 * Files agents changed through `edit`/`write`, derived from saved conversation entries (the main agent and its
 * subagents), so it needs no document of its own and agrees with whatever the entries show after a restart or fork.
 * Scans are incremental and run only when asked for; shell commands are not seen.
 */
export class ChangeTracker {
	readonly #harness: Harness;
	readonly #context: Context;
	readonly #states = new Map<number, ConversationChanges>();
	readonly #locks = new Map<number, Promise<unknown>>();

	constructor(harness: Harness, context: Context) {
		this.#harness = harness;
		this.#context = context;
	}

	/** Drop the cached index of a session and its subagents (archive). */
	async forget(rootId: ConversationId): Promise<void> {
		for (const member of await this.#members(rootId).catch(() => [{ id: rootId, agent: MAIN_AGENT }]))
			this.#states.delete(member.id);
	}

	async #members(rootId: ConversationId): Promise<Member[]> {
		const identities = (await this.#harness.snapshot(SubagentsDoc, rootId, this.#context))?.items ?? [];
		return [
			{ id: rootId, agent: MAIN_AGENT },
			...identities.map((item) => ({ id: item.childId as ConversationId, agent: item.title || item.agentId })),
		];
	}

	#serial<T>(id: number, work: () => Promise<T>): Promise<T> {
		const run = (this.#locks.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
		const tail = run.catch(() => {});
		this.#locks.set(id, tail);
		void tail.then(() => {
			if (this.#locks.get(id) === tail) this.#locks.delete(id);
		});
		return run;
	}

	async #sync(member: Member, workspace: string): Promise<ConversationChanges | undefined> {
		return this.#serial(member.id, async () => {
			const conversation = await this.#harness.conversation(member.id, this.#context);
			if (!conversation) return undefined;
			let state = this.#states.get(member.id);
			if (!state) {
				const cwd = (await conversation.agent(this.#context)).cwd ?? workspace;
				state = new ConversationChanges(member.agent, cwd, workspace);
				this.#states.set(member.id, state);
				while (this.#states.size > CHANGE_LIMITS.conversations) {
					const first = this.#states.keys().next().value;
					if (first === undefined || first === member.id) break;
					this.#states.delete(first);
				}
			}
			let cursor: Cursor | undefined;
			do {
				const page = await conversation.entries(
					{ order: "ascending", minEntryId: (state.last + 1) as EntryId },
					200,
					cursor,
					this.#context,
				);
				for (const entry of page.items) if (entry.id > state.last) state.feed(entry);
				cursor = page.next;
			} while (cursor);
			return state;
		});
	}

	async #collect(rootId: ConversationId) {
		const root = await this.#harness.conversation(rootId, this.#context);
		if (!root) return undefined;
		const workspace = (await root.agent(this.#context)).cwd ?? "";
		const merged = new Map<string, FileAggregate>();
		let revision = 0;
		let truncated = false;
		for (const member of await this.#members(rootId)) {
			const synced = await this.#sync(member, workspace);
			if (!synced) continue;
			const nested = await this.#harness.snapshot(NestedChangesDoc, member.id, this.#context);
			const state = nested && nested.items.length > 0 ? synced.withNested(nested) : synced;
			revision += synced.total + (nested?.total ?? 0);
			truncated ||= state.truncated;
			for (const file of state.files.values()) {
				const existing = merged.get(file.path);
				if (!existing) {
					// Items stay shared with the cached index; a later merge replaces the array instead of mutating it.
					merged.set(file.path, { ...file, agents: new Set(file.agents) });
					continue;
				}
				existing.ops += file.ops;
				existing.added += file.added;
				existing.removed += file.removed;
				existing.lastSeq = Math.max(existing.lastSeq, file.lastSeq);
				existing.truncated ||= file.truncated;
				for (const agent of file.agents) existing.agents.add(agent);
				existing.items = [...existing.items, ...file.items];
			}
		}
		return { revision, truncated, files: merged };
	}

	async summary(rootId: ConversationId): Promise<ChangeSummary> {
		const found = await this.#collect(rootId);
		if (!found) return { revision: 0, files: 0, added: 0, removed: 0 };
		let added = 0;
		let removed = 0;
		for (const file of found.files.values()) {
			added += file.added;
			removed += file.removed;
		}
		return { revision: found.revision, files: found.files.size, added, removed };
	}

	async list(rootId: ConversationId): Promise<ChangeList> {
		const found = await this.#collect(rootId);
		if (!found) return { revision: 0, files: [], truncated: false };
		const files = [...found.files.values()]
			.sort((a, b) => b.lastSeq - a.lastSeq)
			.slice(0, CHANGE_LIMITS.files)
			.map(
				(file): ChangedFile => ({
					path: file.path,
					...(file.outside ? { outside: true as const } : {}),
					ops: file.ops,
					added: file.added,
					removed: file.removed,
					agents: [...file.agents],
					lastSeq: file.lastSeq,
				}),
			);
		return { revision: found.revision, files, truncated: found.truncated };
	}

	async detail(rootId: ConversationId, path: string): Promise<ChangeDetail | undefined> {
		const file = (await this.#collect(rootId))?.files.get(path);
		if (!file) return undefined;
		const ops = [...file.items].sort((a, b) => a.seq - b.seq);
		return {
			path: file.path,
			...(file.outside ? { outside: true as const } : {}),
			ops,
			truncated: file.truncated || ops.length < file.ops,
		};
	}
}
