/**
 * 技能市场客户端与安装器（design D1–D4）：只读消费市场 API（list/detail/download），
 * 安装走 校验 sha256 → 内存解 zip → 临时目录 → rename 落盘，覆盖保护由 skill_exists 强制。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renameWithRetry, stripFrontmatter } from "@neko-harness/core";
import { unzipSync } from "fflate";

/** 市场条目的规范形态（服务端 metadata 可能缺字段或为历史空字符串，统一收敛）。 */
export type MarketSkill = {
	readonly name: string;
	readonly description: string;
	readonly category: string;
	readonly source: string;
	readonly license: string;
	readonly version: string;
	readonly sha256: string;
	readonly sizeBytes: number;
	readonly uploadedAt: string;
};

export type SkillScope = "user" | "project";

export type InstallResult = {
	readonly name: string;
	readonly scope: SkillScope;
	readonly path: string;
	/** 安装成功但被更高优先级同名技能遮蔽时给出该级别（install 到用户级而项目级有同名）。 */
	readonly shadowedBy?: SkillScope;
};

export type SkillMarketErrorCode =
	| "market_unavailable"
	| "market_invalid_url"
	| "skill_not_found"
	| "skill_exists"
	| "skill_not_installed"
	| "skill_invalid_package"
	| "skill_hash_mismatch"
	| "skill_too_large";

export class SkillMarketError extends Error {
	readonly code: SkillMarketErrorCode;
	constructor(code: SkillMarketErrorCode, message: string) {
		super(message);
		this.name = "SkillMarketError";
		this.code = code;
	}
}

const CATALOG_TTL_MS = 60_000;
const ZIP_CACHE_MAX = 16;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

type FetchLike = (
	url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

const userSkillsDir = (home: string): string => join(home, ".agents", "skills");
const projectSkillsDir = (workspaceRoot: string): string => join(workspaceRoot, ".agents", "skills");

/** 前端 list 的状态合并输入：各级同名技能的存在性。 */
export type LocalSkillState = {
	readonly project: boolean;
	readonly user: boolean;
	readonly builtin: boolean;
};

export const activeLevelOf = (state: LocalSkillState): SkillScope | "builtin" | null =>
	state.project ? "project" : state.user ? "user" : state.builtin ? "builtin" : null;

const normalizeEntry = (raw: unknown): MarketSkill => {
	const row = (raw ?? {}) as Record<string, unknown>;
	const metadata = row.metadata;
	const source =
		metadata !== null && typeof metadata === "object"
			? ((metadata as Record<string, unknown>).source as string | undefined)
			: undefined;
	return {
		name: String(row.name ?? ""),
		description: String(row.description ?? ""),
		category: typeof row.category === "string" && row.category !== "" ? row.category : "uncategorized",
		source: typeof source === "string" && source !== "" ? source : "unknown",
		license: String(row.license ?? ""),
		version: String(row.version ?? ""),
		sha256: String(row.sha256 ?? ""),
		sizeBytes: Number(row.size_bytes ?? 0),
		uploadedAt: String(row.uploaded_at ?? ""),
	};
};

export type SkillMarketClient = {
	/** 市场目录（60s 内存缓存）；query 走服务端过滤。 */
	list(query?: string): Promise<readonly MarketSkill[]>;
	/** 单个条目（取自目录缓存，缓存 miss 时先刷新一次）。 */
	detail(name: string): Promise<MarketSkill>;
	/** 下载并在内存解开：SKILL.md 正文（去 frontmatter）与包内文件清单。不写盘。 */
	preview(name: string): Promise<{ body: string; files: readonly string[] }>;
	install(input: {
		name: string;
		scope: SkillScope;
		workspaceRoot?: string;
		overwrite?: boolean;
	}): Promise<InstallResult>;
	uninstall(input: { name: string; scope: SkillScope; workspaceRoot?: string }): Promise<void>;
};

export type SkillMarketOptions = {
	readonly marketUrl: string;
	/** 用户级技能根（`<home>/.agents`）；默认系统 home。 */
	readonly home?: string;
	readonly fetchImpl?: FetchLike;
	/** 可注入 rename（放置新版本失败的测试）。 */
	readonly renameImpl?: (from: string, to: string) => Promise<void>;
	/** 可注入时间源（缓存 TTL 测试）。 */
	readonly now?: () => number;
};

export function createSkillMarketClient(options: SkillMarketOptions): SkillMarketClient {
	const home = options.home ?? homedir();
	const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const placeRename = options.renameImpl;
	let base: URL;
	try {
		base = new URL(options.marketUrl);
		if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("unsupported protocol");
	} catch {
		throw new SkillMarketError("market_invalid_url", `Invalid skill market URL: ${options.marketUrl}`);
	}
	base = new URL(base.toString().replace(/\/+$/, ""));

	let catalog: { at: number; skills: MarketSkill[] } | undefined;
	const zipCache = new Map<string, Uint8Array>();

	const request = async (
		path: string,
	): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }> => {
		let response: Awaited<ReturnType<FetchLike>>;
		try {
			response = await fetchImpl(new URL(path, `${base}/`).toString());
		} catch (error) {
			throw new SkillMarketError(
				"market_unavailable",
				`Skill market unreachable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return response;
	};

	const refreshCatalog = async (): Promise<MarketSkill[]> => {
		const response = await request("api/skills");
		if (!response.ok)
			throw new SkillMarketError("market_unavailable", `Skill list failed with HTTP ${response.status}`);
		const data = (await response.json()) as { skills?: unknown };
		const skills = Array.isArray(data.skills) ? data.skills.map(normalizeEntry) : [];
		catalog = { at: now(), skills };
		return skills;
	};

	const listSkills = async (): Promise<MarketSkill[]> =>
		catalog !== undefined && now() - catalog.at < CATALOG_TTL_MS ? catalog.skills : refreshCatalog();

	const detail = async (name: string): Promise<MarketSkill> => {
		let hit = (await listSkills()).find((skill) => skill.name === name);
		if (hit === undefined) hit = (await refreshCatalog()).find((skill) => skill.name === name);
		if (hit === undefined) throw new SkillMarketError("skill_not_found", `Skill not found on market: ${name}`);
		return hit;
	};

	const download = async (skill: MarketSkill): Promise<Uint8Array> => {
		const cached = zipCache.get(skill.sha256);
		if (cached !== undefined) {
			// LRU：重新置底。
			zipCache.delete(skill.sha256);
			zipCache.set(skill.sha256, cached);
			return cached;
		}
		if (skill.sizeBytes > MAX_PACKAGE_BYTES)
			throw new SkillMarketError(
				"skill_too_large",
				`Package ${skill.name} is ${skill.sizeBytes} bytes (limit ${MAX_PACKAGE_BYTES})`,
			);
		const response = await request(`api/skills/${encodeURIComponent(skill.name)}/download`);
		if (!response.ok)
			throw new SkillMarketError(
				response.status === 404 ? "skill_not_found" : "market_unavailable",
				`Download of ${skill.name} failed with HTTP ${response.status}`,
			);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_PACKAGE_BYTES)
			throw new SkillMarketError("skill_too_large", `Package ${skill.name} exceeds ${MAX_PACKAGE_BYTES} bytes`);
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== skill.sha256)
			throw new SkillMarketError(
				"skill_hash_mismatch",
				`SHA-256 mismatch for ${skill.name}: catalog says ${skill.sha256}, got ${digest}`,
			);
		zipCache.set(skill.sha256, bytes);
		while (zipCache.size > ZIP_CACHE_MAX) {
			const oldest = zipCache.keys().next().value;
			if (oldest === undefined) break;
			zipCache.delete(oldest);
		}
		return bytes;
	};

	/** 内存解 zip：拒绝路径逃逸，定位唯一 SKILL.md，返回其所在目录内的相对文件表。 */
	const unpack = (skill: MarketSkill, zip: Uint8Array): Map<string, Uint8Array> => {
		let entries: Record<string, Uint8Array>;
		try {
			entries = unzipSync(zip);
		} catch {
			throw new SkillMarketError("skill_invalid_package", `Package ${skill.name} is not a valid zip archive`);
		}
		const files = new Map<string, Uint8Array>();
		const skillMds: string[] = [];
		for (const name of Object.keys(entries)) {
			if (name.endsWith("/")) continue;
			// zip 条目一律 POSIX 分隔；拒绝反斜杠与逃逸（复刻服务端 safe_extract 语义）。
			if (name.includes("\\") || name.startsWith("/"))
				throw new SkillMarketError("skill_invalid_package", `Unsafe path in package: ${name}`);
			const segments = name.split("/");
			if (segments.some((s) => s === ".." || s === ""))
				throw new SkillMarketError("skill_invalid_package", `Unsafe path in package: ${name}`);
			if (segments[segments.length - 1] === "SKILL.md") skillMds.push(name);
			files.set(name, entries[name]!);
		}
		if (skillMds.length !== 1)
			throw new SkillMarketError(
				"skill_invalid_package",
				skillMds.length === 0
					? `Package ${skill.name} contains no SKILL.md`
					: `Package ${skill.name} contains multiple SKILL.md files`,
			);
		const root = skillMds[0]!.slice(0, -"SKILL.md".length); // 含结尾 "/"，根目录时为空串
		const inner = new Map<string, Uint8Array>();
		for (const [name, bytes] of files) {
			if (!name.startsWith(root)) continue;
			inner.set(name.slice(root.length), bytes);
		}
		return inner;
	};

	const skillsDirFor = (scope: SkillScope, workspaceRoot?: string): string => {
		if (scope === "user") return userSkillsDir(home);
		if (workspaceRoot === undefined || workspaceRoot === "")
			throw new SkillMarketError("market_unavailable", "Project-scope install needs a workspaceRoot");
		return projectSkillsDir(workspaceRoot);
	};

	// 备份目录名 `.bak-<uuid>-<技能名>`：与 .tmp-* 同在技能目录的父目录（同一文件系统），技能名用于崩溃后还原。
	const BACKUP_PREFIX = ".bak-";
	const UUID_LENGTH = 36;

	/** 惰性清扫技能目录兄弟位置遗留的 .tmp-*（崩溃窗口兜底），并处理遗留 .bak-*：目标缺失则还原，否则删除。 */
	const sweepTempDirs = async (skillsDir: string): Promise<void> => {
		const parent = dirname(skillsDir);
		let names: string[] = [];
		try {
			names = await readdir(parent);
		} catch {
			return;
		}
		await Promise.all(
			names
				.filter((n) => n.startsWith(".tmp-"))
				.map((n) => rm(join(parent, n), { recursive: true, force: true }).catch(() => {})),
		);
		for (const n of names.filter((n) => n.startsWith(BACKUP_PREFIX))) {
			const backup = join(parent, n);
			const skill = n.slice(BACKUP_PREFIX.length + UUID_LENGTH + 1);
			if (skill === "" || skill.includes("/") || skill.includes("\\") || skill === "." || skill === "..") continue;
			const target = join(skillsDir, skill);
			if ((await stat(target).catch(() => undefined)) === undefined) {
				await mkdir(skillsDir, { recursive: true }).catch(() => {});
				await renameWithRetry(backup, target).catch(() => {});
			} else {
				await rm(backup, { recursive: true, force: true }).catch(() => {});
			}
		}
	};

	const install: SkillMarketClient["install"] = async ({ name, scope, workspaceRoot, overwrite }) => {
		const skillsDir = skillsDirFor(scope, workspaceRoot);
		const target = join(skillsDir, name);
		const exists = (await stat(target).catch(() => undefined)) !== undefined;
		if (exists && overwrite !== true)
			throw new SkillMarketError("skill_exists", `Skill ${name} already exists at ${scope} level (${target})`);
		const skill = await detail(name);
		const files = unpack(skill, await download(skill));

		await sweepTempDirs(skillsDir);
		const temp = join(dirname(skillsDir), `.tmp-${randomUUID()}`);
		try {
			for (const [relative, bytes] of files) {
				const dest = join(temp, ...relative.split("/"));
				await mkdir(dirname(dest), { recursive: true });
				await writeFile(dest, bytes);
			}
			await mkdir(skillsDir, { recursive: true });
			if (exists) {
				const backup = join(dirname(skillsDir), `${BACKUP_PREFIX}${randomUUID()}-${name}`);
				await renameWithRetry(target, backup);
				try {
					await renameWithRetry(temp, target, placeRename ? { rename: placeRename } : {});
				} catch (error) {
					await renameWithRetry(backup, target).catch(() => {});
					throw error;
				}
				await rm(backup, { recursive: true, force: true }).catch(() => {});
			} else {
				await renameWithRetry(temp, target, placeRename ? { rename: placeRename } : {});
			}
		} finally {
			await rm(temp, { recursive: true, force: true }).catch(() => {});
		}

		// 遮蔽检测：装到用户级而项目级有同名 → 生效版本仍是项目级。
		let shadowedBy: SkillScope | undefined;
		if (scope === "user" && workspaceRoot !== undefined && workspaceRoot !== "") {
			const projectDir = join(projectSkillsDir(workspaceRoot), name);
			if ((await stat(projectDir).catch(() => undefined)) !== undefined) shadowedBy = "project";
		}
		return { name, scope, path: target, ...(shadowedBy !== undefined ? { shadowedBy } : {}) };
	};

	const uninstall: SkillMarketClient["uninstall"] = async ({ name, scope, workspaceRoot }) => {
		const skillsDir = skillsDirFor(scope, workspaceRoot);
		const target = join(skillsDir, name);
		if ((await stat(target).catch(() => undefined)) === undefined)
			throw new SkillMarketError("skill_not_installed", `Skill ${name} is not installed at ${scope} level`);
		await rm(target, { recursive: true, force: true });
	};

	return {
		async list(query?: string) {
			if (query !== undefined && query.trim() !== "") {
				const response = await request(`api/skills?q=${encodeURIComponent(query.trim())}`);
				if (!response.ok)
					throw new SkillMarketError("market_unavailable", `Skill search failed with HTTP ${response.status}`);
				const data = (await response.json()) as { skills?: unknown };
				return Array.isArray(data.skills) ? data.skills.map(normalizeEntry) : [];
			}
			return listSkills();
		},
		detail,
		async preview(name: string) {
			const skill = await detail(name);
			const inner = unpack(skill, await download(skill));
			const bodyBytes = inner.get("SKILL.md");
			if (bodyBytes === undefined)
				throw new SkillMarketError("skill_invalid_package", `Package ${name} lost its SKILL.md`);
			const body = stripFrontmatter(new TextDecoder().decode(bodyBytes));
			return { body, files: [...inner.keys()].sort() };
		},
		install,
		uninstall,
	};
}
