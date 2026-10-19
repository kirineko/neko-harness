import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
	ExecutionError,
	err,
	type FileListing,
	type FileWatcher,
	getOrThrow,
	type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import type { FileCandidates } from "./file-mentions.ts";
import { type WindowsShellResolver, type WindowsShellStatus, windowsShellMessage } from "./windows-shell.ts";

/** Bounds of the read-only workspace browser. */
export const BROWSE_LIMITS = { children: 1000, readBytes: 512 * 1024 };
export type DirEntry = { name: string; path: string; kind: "file" | "directory" | "symlink"; protected?: true };
export type DirChildren = { path: string; entries: DirEntry[]; limited: boolean; incomplete: boolean };
export type FileContent = {
	path: string;
	size: number;
	mtimeMs: number;
	/** `protected` files (credentials) and `binary` ones carry no content. */
	kind: "text" | "binary" | "protected";
	content?: string;
	truncated: boolean;
};

const ENV_TEMPLATE = /\.(example|sample|template)$/;
/** Credential-looking files stay visible in the tree but their content is never served. */
export function isProtectedPath(path: string): boolean {
	const name = basename(path).toLowerCase();
	if (name === ".env" || (name.startsWith(".env.") && !ENV_TEMPLATE.test(name))) return true;
	if (/\.(pem|key|p12|pfx)$/.test(name)) return true;
	return /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/.test(name) && !name.endsWith(".pub");
}

export function relativeQuery(query: string): string {
	if (
		query.length > 2048 ||
		[...query].some((c) => c.charCodeAt(0) < 32 || c === '"' || c === "\\") ||
		isAbsolute(query) ||
		query.startsWith("~") ||
		query.split("/").some((part) => part === ".." || part === ".git")
	)
		throw new Error("Use a relative path inside the workspace.");
	return query.replace(/^\.\//, "");
}
export async function workspaceTarget(root: string, path: string): Promise<string> {
	const base = await realpath(root);
	const target = await realpath(resolve(base, relativeQuery(path)));
	const local = relative(base, target);
	if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
		throw new Error("Path is outside the workspace.");
	return target;
}

export const FILE_CACHE_LIMITS = {
	keys: 8,
	entries: 200_000,
	bytes: 32 * 1024 * 1024,
	maxEntries: 50_000,
	maxBytes: 4 * 1024 * 1024,
	scanMs: 2000,
	startupMs: 5000,
	ttlMs: 30_000,
	idleMs: 300_000,
	concurrent: 2,
};
type Cached = {
	base: string;
	root: string;
	generation: number;
	used: number;
	loaded: number;
	bytes: number;
	listing?: FileListing;
	watch?: WorkspaceWatch;
	work?: Promise<FileListing>;
	controller?: AbortController;
	waiters: number;
};

/** Without a usable Git Bash on Windows, shell strings fail with a guiding error; argv commands and files still work. */
class ShellUnavailableEnv extends LocalExecutionEnv {
	readonly #message: string;
	constructor(options: ConstructorParameters<typeof LocalExecutionEnv>[0], message: string) {
		super(options);
		this.#message = message;
	}
	override async exec(
		command: string | readonly string[],
		options: Parameters<LocalExecutionEnv["exec"]>[1],
		context: Parameters<LocalExecutionEnv["exec"]>[2],
	) {
		if (typeof command === "string")
			return err<ShellExecResult, ExecutionError>(new ExecutionError("shell_unavailable", this.#message));
		return super.exec(command, options, context);
	}
}

type WorkspaceWatch = { users: Set<Cached>; controller: AbortController; work: Promise<void>; watcher?: FileWatcher };

/** One local helper and bounded directory snapshots, shared across all frontend queries. */
export class WorkspaceFiles {
	#connection?: Connection;
	#starting?: Promise<void>;
	#session?: number;
	#cache = new Map<string, Cached>();
	#disposing = new Set<Promise<void>>();
	#watches = new Map<string, WorkspaceWatch>();
	#jobs = new Set<Promise<FileListing>>();
	#closed = false;
	#closing?: Promise<void>;
	#active = 0;
	#waiting = new Set<() => void>();
	#timer: ReturnType<typeof setInterval>;
	private limits: typeof FILE_CACHE_LIMITS;
	readonly #shell: WindowsShellResolver | undefined;
	constructor(limits = FILE_CACHE_LIMITS, shell?: WindowsShellResolver) {
		this.limits = limits;
		this.#shell = shell;
		this.#timer = setInterval(
			() => {
				for (const [key, item] of this.#cache)
					if (!item.waiters && Date.now() - item.used >= this.limits.idleMs) this.#drop(key, item);
			},
			Math.min(10_000, limits.idleMs),
		);
		this.#timer.unref();
	}
	get stats() {
		const items = [...this.#cache.values()];
		return {
			keys: items.length,
			watchers: [...this.#watches.values()].filter((watch) => watch.watcher).length,
			entries: items.reduce((n, item) => n + (item.listing?.entries.length ?? 0), 0),
			bytes: items.reduce((n, item) => n + item.bytes, 0),
			active: this.#active,
			queued: this.#waiting.size,
		};
	}

	/** Windows only: the bash that commands run in, probed lazily and cached; undefined elsewhere. */
	shellStatus(options?: { readonly refresh?: boolean }): WindowsShellStatus | undefined {
		return this.#shell?.status(options);
	}

	#open(): Connection {
		if (this.#closed) throw new Error("File environment closed");
		this.#connection ??= new Connection({ command: [localDaemon()] });
		return this.#connection;
	}
	env(cwd: string) {
		const options = {
			connection: this.#open(),
			cwd,
			...(process.platform === "win32" ? { shellEnv: { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } } : {}),
		};
		const shell = this.#shell?.status();
		if (shell === undefined) return new LocalExecutionEnv(options);
		// An explicit shellPath also stops the upstream env from falling back to `where bash.exe` (which finds WSL).
		if (shell.kind === "found") return new LocalExecutionEnv({ ...options, shellPath: shell.path });
		return new ShellUnavailableEnv(options, windowsShellMessage(shell));
	}
	async #ready() {
		if (!this.#starting) {
			const connection = this.#open();
			let timer: ReturnType<typeof setTimeout>;
			const work = Promise.race([
				connection.info().then(() => connection.session()),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("File discovery startup timed out. Retry.")),
						this.limits.startupMs,
					);
				}),
			])
				.then((session) => {
					if (this.#session !== undefined && session !== this.#session)
						for (const item of this.#cache.values()) {
							item.generation++;
							item.loaded = 0;
						}
					this.#session = session;
				})
				.catch((error) => {
					if (this.#connection === connection) {
						connection.close();
						this.#connection = undefined;
						this.#session = undefined;
						this.#starting = undefined;
						for (const item of this.#cache.values()) {
							item.generation++;
							item.loaded = 0;
						}
					}
					throw error;
				})
				.finally(() => {
					clearTimeout(timer);
					if (this.#starting === work) this.#starting = undefined;
				});
			this.#starting = work;
		}
		return this.#starting;
	}
	#drop(key: string, item: Cached) {
		this.#cache.delete(key);
		item.generation++;
		item.controller?.abort();
		this.#closeWatcher(item);
	}
	#disposeWatch(watch: WorkspaceWatch) {
		watch.controller.abort();
		const closing = watch.work
			.catch(() => {})
			.then(() => watch.watcher?.close(BACKGROUND_CONTEXT))
			.then(() => {})
			.catch(() => {})
			.finally(() => this.#disposing.delete(closing));
		this.#disposing.add(closing);
	}
	#closeWatcher(item: Cached) {
		const watch = item.watch;
		item.watch = undefined;
		if (!watch) return;
		watch.users.delete(item);
		if (!watch.users.size) {
			if (this.#watches.get(item.root) === watch) this.#watches.delete(item.root);
			this.#disposeWatch(watch);
		}
	}
	async #watch(item: Cached, env: LocalExecutionEnv) {
		let watch = this.#watches.get(item.root);
		if (!watch) {
			const current: WorkspaceWatch = { users: new Set(), controller: new AbortController(), work: Promise.resolve() };
			watch = current;
			this.#watches.set(item.root, current);
			const forget = () => {
				current.controller.abort();
				if (this.#watches.get(item.root) === current) this.#watches.delete(item.root);
				for (const user of current.users) user.watch = undefined;
				current.users.clear();
			};
			current.work = (async () => {
				const targets: import("@earendil-works/pi-durable/env").WatchTarget[] = [
					{ path: item.root, recursive: true, exclude: { names: [".git"] } },
				];
				const git = resolve(item.root, ".git");
				if (
					await stat(git).then(
						() => true,
						() => false,
					)
				)
					targets.push({ path: git, recursive: true, exclude: { names: ["objects", "logs", "refs"] } });
				const result = await env.watch(
					targets,
					(change) => {
						for (const user of current.users) {
							user.generation++;
							user.loaded = 0;
						}
						if ("error" in change) {
							if (this.#watches.get(item.root) === current) this.#watches.delete(item.root);
							for (const user of [...current.users]) this.#closeWatcher(user);
						}
					},
					withAbortSignal(current.controller.signal, BACKGROUND_CONTEXT),
				);
				if (result.ok) {
					current.watcher = result.value;
					if (current.controller.signal.aborted) await result.value.close(BACKGROUND_CONTEXT);
				} else {
					forget();
				}
			})().catch(forget);
		}
		watch.users.add(item);
		item.watch = watch;
		await watch.work;
	}

	#bound() {
		for (;;) {
			const values = [...this.#cache.entries()];
			if (
				values.length <= this.limits.keys &&
				values.reduce((n, [, i]) => n + (i.listing?.entries.length ?? 0), 0) <= this.limits.entries &&
				values.reduce((n, [, i]) => n + i.bytes, 0) <= this.limits.bytes
			)
				return;
			const oldest = values.filter(([, i]) => !i.waiters && !i.work).sort((a, b) => a[1].used - b[1].used)[0];
			if (!oldest) throw new Error("File discovery busy. Retry shortly.");
			this.#drop(...oldest);
		}
	}
	async #scan(item: Cached): Promise<FileListing> {
		const controller = new AbortController();
		item.controller = controller;
		const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		while (this.#active >= this.limits.concurrent) {
			await new Promise<void>((resolve, reject) => {
				const wake = () => {
						cleanup();
						resolve();
					},
					abort = () => {
						cleanup();
						reject(new Error("File search cancelled."));
					};
				const cleanup = () => {
					this.#waiting.delete(wake);
					controller.signal.removeEventListener("abort", abort);
				};
				this.#waiting.add(wake);
				controller.signal.addEventListener("abort", abort, { once: true });
				if (controller.signal.aborted) abort();
			});
		}
		this.#active++;
		try {
			await this.#ready();
			controller.signal.throwIfAborted();
			const env = this.env(item.base);
			if (!item.watch) await this.#watch(item, env);
			const generation = item.generation;
			const result = await env.listFiles(
				".",
				{
					hidden: true,
					gitignore: true,
					maxEntries: this.limits.maxEntries,
					maxBytes: this.limits.maxBytes,
					timeoutMs: this.limits.scanMs,
				},
				context,
			);
			if (!result.ok && (result.error.code === "unknown" || result.error.code === "not_supported")) {
				this.#connection?.close();
				this.#connection = undefined;
				this.#session = undefined;
				this.#starting = undefined;
				for (const i of this.#cache.values()) {
					i.loaded = 0;
					i.generation++;
				}
			}
			const listing = getOrThrow(result);
			controller.signal.throwIfAborted();
			if (this.#closed || item.generation !== generation)
				throw new Error("Workspace changed during file search. Retry.");
			item.listing = listing;
			item.loaded = Date.now();
			item.bytes = Buffer.byteLength(JSON.stringify(listing));
			return listing;
		} finally {
			this.#active--;
			for (const wake of this.#waiting) wake();
		}
	}
	async search(root: string, query: string, signal: AbortSignal): Promise<FileCandidates> {
		signal.throwIfAborted();
		if (this.#closed) throw new Error("File environment closed");
		query = relativeQuery(query);
		const slash = query.lastIndexOf("/"),
			prefix = slash < 0 ? "" : query.slice(0, slash + 1),
			needle = query.slice(slash + 1);
		root = await realpath(root);
		const base = await workspaceTarget(root, prefix);
		if (!(await stat(base)).isDirectory()) throw new Error("Workspace directory is unavailable.");
		return this.#withListing(root, base, signal, async (listing) => {
			const pattern = new RegExp(
				[...needle].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"),
				/[A-Z]/.test(needle) ? "" : "i",
			);
			const entries: FileCandidates["entries"] = [];
			const candidates = listing.entries
				.filter(
					(candidate) =>
						candidate.kind !== "symlink" &&
						(needle || !candidate.path.includes("/")) &&
						pattern.test(basename(candidate.path)),
				)
				.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) || a.path.localeCompare(b.path));
			for (const candidate of candidates) {
				if (candidate.kind === "symlink") continue;
				const local = prefix + candidate.path;
				if ([...local].some((c) => c.charCodeAt(0) < 32 || c === '"' || c === "\\")) continue;
				try {
					await workspaceTarget(root, local);
					entries.push({ name: basename(local), path: local, kind: candidate.kind });
				} catch {
					/* disappeared or outside */
				}
				signal.throwIfAborted();
				if (entries.length > 100) break;
			}
			return { entries: entries.slice(0, 100), limited: entries.length > 100, incomplete: listing.truncated };
		});
	}
	/** Direct children of one workspace directory, from the same bounded listing that serves `search`. */
	async children(root: string, dir: string, signal: AbortSignal): Promise<DirChildren> {
		signal.throwIfAborted();
		if (this.#closed) throw new Error("File environment closed");
		const clean = dir === "" ? "" : relativeQuery(dir).replace(/\/+$/, "");
		root = await realpath(root);
		const target = await workspaceTarget(root, clean);
		if (!(await stat(target)).isDirectory()) throw new Error("Not a directory.");
		const prefix = clean === "" ? "" : `${clean}/`;
		return this.#withListing(root, root, signal, async (listing) => {
			const entries: DirEntry[] = [];
			for (const candidate of listing.entries) {
				if (!candidate.path.startsWith(prefix)) continue;
				const name = candidate.path.slice(prefix.length);
				if (name === "" || name.includes("/") || [...name].some((c) => c.charCodeAt(0) < 32 || c === '"' || c === "\\"))
					continue;
				entries.push({
					name,
					path: candidate.path,
					kind: candidate.kind === "directory" ? "directory" : candidate.kind === "symlink" ? "symlink" : "file",
					...(candidate.kind !== "directory" && isProtectedPath(name) ? { protected: true as const } : {}),
				});
			}
			entries.sort(
				(a, b) =>
					(a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) ||
					(a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
			);
			signal.throwIfAborted();
			return {
				path: clean,
				entries: entries.slice(0, BROWSE_LIMITS.children),
				limited: entries.length > BROWSE_LIMITS.children,
				incomplete: listing.truncated,
			};
		});
	}
	/** Read one text file of the workspace, at most `BROWSE_LIMITS.readBytes` from its start. */
	async read(root: string, path: string, signal: AbortSignal): Promise<FileContent> {
		signal.throwIfAborted();
		if (path === "") throw new Error("Use a relative path inside the workspace.");
		const clean = relativeQuery(path);
		root = await realpath(root);
		let target: string;
		try {
			target = await workspaceTarget(root, clean);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("File not found.");
			throw error;
		}
		const info = await stat(target);
		if (!info.isFile()) throw new Error("Not a file.");
		const base = { path: clean, size: info.size, mtimeMs: info.mtimeMs };
		if (isProtectedPath(clean) || isProtectedPath(target)) return { ...base, kind: "protected", truncated: false };
		const handle = await open(target, "r");
		try {
			const length = Math.min(info.size, BROWSE_LIMITS.readBytes);
			const buffer = Buffer.alloc(length);
			const { bytesRead } = length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, length, 0);
			signal.throwIfAborted();
			const bytes = buffer.subarray(0, bytesRead);
			const truncated = info.size > bytesRead;
			if (bytes.subarray(0, 8192).includes(0)) return { ...base, kind: "binary", truncated };
			try {
				// With a cut file the decoder holds back an incomplete trailing sequence instead of failing on it.
				const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
				return { ...base, kind: "text", content, truncated };
			} catch {
				return { ...base, kind: "binary", truncated };
			}
		} finally {
			await handle.close();
		}
	}
	async #withListing<T>(
		root: string,
		base: string,
		signal: AbortSignal,
		use: (listing: FileListing) => Promise<T>,
	): Promise<T> {
		const key = `${this.env(base).id}\0git-hidden\0${root}\0${base}`;
		let item = this.#cache.get(key);
		if (!item) {
			item = { base, root, generation: 0, used: Date.now(), loaded: 0, bytes: 0, waiters: 1 };
			this.#cache.set(key, item);
			try {
				this.#bound();
			} catch (error) {
				this.#drop(key, item);
				throw error;
			}
			item.waiters--;
		}
		item.used = Date.now();
		item.waiters++;
		try {
			if (!item.listing || Date.now() - item.loaded >= this.limits.ttlMs) {
				if (!item.work) {
					const current = item;
					current.work = this.#scan(current).finally(() => {
						this.#jobs.delete(current.work!);
						current.work = undefined;
						current.controller = undefined;
					});
					this.#jobs.add(current.work);
				}
				await cancellable(item.work!, signal);
			}
			return await use(item.listing!);
		} finally {
			item.waiters--;
			if (!item.waiters && item.work) {
				item.controller?.abort();
				if (!item.listing) this.#drop(key, item);
			}
			this.#bound();
		}
	}
	remove(root: string) {
		for (const [key, item] of this.#cache) if (item.root === root) this.#drop(key, item);
	}
	close() {
		this.#closing ??= (async () => {
			this.#closed = true;
			clearInterval(this.#timer);
			const pending = [...this.#jobs];
			for (const [key, item] of this.#cache) this.#drop(key, item);
			this.#connection?.close();
			await Promise.allSettled(pending);
			await Promise.allSettled([...this.#disposing]);
		})();
		return this.#closing;
	}
}
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => {
				cleanup();
				reject(new Error("File search cancelled."));
			},
			cleanup = () => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort, { once: true });
		work.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) abort();
	});
}
