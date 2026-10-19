import { randomUUID } from "node:crypto";
import { ChordError, type Context, type Ctx, type Host, local, method, type Self } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { CREDENTIAL_PROVIDERS, type CredentialProviderId, isModelProvider, type NekoRuntime } from "@neko-harness/core";
import { UpdateChecker, type UpdateCheckerOptions } from "@neko-harness/core/application-updates";
import type { UpdateState } from "@neko-harness/core/application-version";
import { Type } from "typebox";
import {
	ApplicationInfoSchema,
	ContextSettingsStateSchema,
	CredentialStateSchema,
	DefaultModelStateSchema,
	DirectoryStateSchema,
	NekoApplicationInfo,
	NekoContextSettings,
	type NekoCredentialState,
	NekoCredentials,
	NekoDefaultModel,
	type NekoMarketSkill,
	NekoModels,
	NekoSearchSettings,
	NekoSessionDirectory,
	NekoSessionManagement,
	type NekoSessionSummary,
	NekoSkillMarket,
	NekoWorkspaceFiles,
	NekoWorkspaces,
	SearchSettingsStateSchema,
	WorkspaceStateSchema,
} from "./contract.ts";
import type { GatewayPrincipal } from "./principal.ts";
import { Owner, serveSessions } from "./session-host.ts";
import { activeLevelOf, createSkillMarketClient, SkillMarketError } from "./skill-market.ts";
import { browseWorkspaces } from "./workspaces.ts";

const ServerState = local("neko.server-state", {
	version: 1,
	input: Type.Object({}),
	members: {
		directory: DirectoryStateSchema,
		workspaces: WorkspaceStateSchema,
		credentials: CredentialStateSchema,
		searchSettings: SearchSettingsStateSchema,
		contextSettings: ContextSettingsStateSchema,
		defaultModel: DefaultModelStateSchema,
		refreshCredentials: method(Type.Null(), Type.Null()),
		refreshSearchSettings: method(Type.Null(), Type.Null()),
		refreshContextSettings: method(Type.Null(), Type.Null()),
		refreshDefaultModel: method(Type.Null(), Type.Null()),
	},
});
export async function createNekoServerServices(options: {
	host: Host<GatewayPrincipal>;
	runtime: NekoRuntime;
	context: Context;
	marketUrl: string;
	serverId: string;
	promptHome?: string;
	updates?: UpdateCheckerOptions;
	updateIntervalMs?: number;
}) {
	const { runtime, context, host } = options;
	const updates = new UpdateChecker(options.updates);
	await updates.local();
	const updateListeners = new Set<(value: UpdateState) => void>();
	// The Windows shell status rides along with the update state; only Windows runtimes report one.
	const info = (value: UpdateState) => {
		const shell = runtime.shellStatus();
		return { ...value, serverId: options.serverId, ...(shell === undefined ? {} : { shell }) };
	};
	let published = JSON.stringify(info(updates.state)),
		closed = false;
	const publishUpdates = () => {
		if (closed) return;
		const next = JSON.stringify(info(updates.state));
		if (next === published) return;
		published = next;
		for (const listener of updateListeners) listener(updates.state);
	};
	host.serve(NekoApplicationInfo, (_input, _principal, self) => {
		const current = self.state("info", ApplicationInfoSchema, info(updates.state));
		self.on(
			"updates",
			{
				subscribe: (fn: (value: UpdateState) => void) => {
					updateListeners.add(fn);
					return () => updateListeners.delete(fn);
				},
			},
			(value, ctx) => current.replace(ctx, info(value)),
		);
		return {
			variant: "ready",
			info: current,
			check: async () => {
				runtime.shellStatus({ refresh: true });
				await updates.check(true);
				publishUpdates();
				return info(updates.state);
			},
		};
	});
	const updateTimer = setInterval(() => {
		void updates
			.local()
			.then(() => {
				publishUpdates();
				return updates.check();
			})
			.then(publishUpdates);
	}, options.updateIntervalMs ?? 30000);
	updateTimer.unref();
	void updates.check().then(publishUpdates);

	const market = createSkillMarketClient({
		marketUrl: options.marketUrl,
		...(options.promptHome !== undefined ? { home: options.promptHome } : {}),
	});
	// Chord 的 reason 保留业务原因，前端无需解析格式化后的 message。
	const toRemote = (error: unknown): never => {
		if (error instanceof SkillMarketError) {
			const code = error.code === "skill_not_found" || error.code === "skill_not_installed" ? "gone" : "invalid";
			throw new ChordError(code, error.message, { reason: error.code });
		}
		throw error;
	};
	const withInstallState = async (
		skill: {
			name: string;
			description: string;
			category: string;
			source: string;
			license: string;
			version: string;
			sha256: string;
			sizeBytes: number;
			uploadedAt: string;
		},
		workspaceRoot: string | undefined,
	): Promise<NekoMarketSkill> => {
		const locals = await runtime.listSkillsByLevel(workspaceRoot);
		const installed = {
			project: locals.some((s) => s.name === skill.name && s.level === "project"),
			user: locals.some((s) => s.name === skill.name && s.level === "user"),
			builtin: locals.some((s) => s.name === skill.name && s.level === "builtin"),
		};
		return { ...skill, installed, activeLevel: activeLevelOf(installed) };
	};
	const list = async (): Promise<NekoSessionSummary[]> =>
		(await runtime.listConversations()).map((info) => ({
			id: String(info.id),
			workspaceRoot: info.workspaceRoot,
			lastUsedAt: info.lastUsedAt,
			title: info.title,
			firstPromptPreview: info.firstPromptPreview,
			createdAt: info.createdAt,
			lastMessageAt: info.lastMessageAt,
			model: info.model,
			status: info.status,
			awaitingAnswer: info.awaitingAnswer,
		}));

	const readStatuses = async (): Promise<NekoCredentialState["statuses"]> => {
		const enabled = new Set<string>(runtime.enabledProviders());
		return Object.fromEntries(
			await Promise.all(
				CREDENTIAL_PROVIDERS.map(async (spec) => {
					const status = await runtime.credentialStatus(spec.id as CredentialProviderId);
					return [spec.id, spec.kind === "model" ? { ...status, enabled: enabled.has(spec.id) } : status];
				}),
			),
		);
	};
	const [sessions, workspaces, statuses, search, contextSettings0, defaultModel0] = await Promise.all([
		list(),
		runtime.listWorkspaces(),
		readStatuses(),
		runtime.searchSettings(),
		runtime.contextSettings(),
		runtime.defaultModel(),
	]);
	let mutationTail = Promise.resolve();
	const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
		const result = mutationTail.catch(() => {}).then(fn);
		mutationTail = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	host.serve(
		ServerState,
		(_input, _principal, self) => {
			const directory = self.state("directory", DirectoryStateSchema, { revision: 1, sessions });
			const workspaceState = self.state("workspaces", WorkspaceStateSchema, { revision: 1, workspaces });
			const credentials = self.state("credentials", CredentialStateSchema, { revision: 1, statuses });
			const searchSettings = self.state("searchSettings", SearchSettingsStateSchema, { revision: 1, ...search });
			const contextSettings = self.state("contextSettings", ContextSettingsStateSchema, {
				revision: 1,
				...contextSettings0,
			});
			const defaultModel = self.state("defaultModel", DefaultModelStateSchema, defaultModel0);
			const refreshContextSettings = async (_input: null, ctx: Ctx<GatewayPrincipal>) => {
				const next = await runtime.contextSettings();
				const { revision, ...current } = contextSettings.value;
				if (JSON.stringify(next) !== JSON.stringify(current))
					contextSettings.replace(ctx, { revision: revision + 1, ...next });
				return null;
			};
			const refreshDefaultModel = async (_input: null, ctx: Ctx<GatewayPrincipal>) => {
				const next = await runtime.defaultModel();
				if (JSON.stringify(next) !== JSON.stringify(defaultModel.value)) defaultModel.replace(ctx, next);
				return null;
			};
			const refreshSearchSettings = async (_input: null, ctx: Ctx<GatewayPrincipal>) => {
				const next = await runtime.searchSettings();
				const current = searchSettings.value;
				if (next.selected !== current.selected)
					searchSettings.replace(ctx, { revision: current.revision + 1, ...next });
				return null;
			};
			self.on(
				"directory",
				{ subscribe: runtime.harness.subscribeCommits.bind(runtime.harness) },
				async (event, ctx) => {
					if (
						!event.changes.some(
							(change) =>
								change.type === "conversation" ||
								(change.type === "document" &&
									[
										"app.neko.session-metadata",
										"app.neko.activity",
										"app.neko.conversation",
										"app.neko.workspaces",
										"pi.agent",
									].includes(change.record.kind)),
						)
					)
						return;
					await serialize(async () => {
						const [items, roots] = await Promise.all([list(), runtime.listWorkspaces()]);
						directory.replace(ctx, { revision: directory.value.revision + 1, sessions: items });
						workspaceState.replace(ctx, { revision: workspaceState.value.revision + 1, workspaces: roots });
					});
				},
			);
			return {
				directory,
				workspaces: workspaceState,
				credentials,
				searchSettings,
				contextSettings,
				defaultModel,
				async refreshCredentials(_input: null, ctx: Ctx<GatewayPrincipal>) {
					credentials.replace(ctx, {
						revision: credentials.value.revision + 1,
						statuses: await readStatuses(),
					});
					return null;
				},
				refreshSearchSettings,
				refreshContextSettings,
				refreshDefaultModel,
			};
		},
		{ lifetime: "host" },
	);
	const shared = (self: Self<GatewayPrincipal>) => self.get(ServerState, {});
	host.serve(NekoSessionDirectory, (_input, _principal, self) => ({ variant: "ready", state: shared(self).directory }));
	host.serve(NekoWorkspaces, (_input, _principal, self) => ({
		variant: "ready",
		state: shared(self).workspaces,
		browse: (input) => browseWorkspaces(input),
		add: (input) => serialize(() => runtime.addWorkspace(input.path)),
	}));
	host.serve(NekoCredentials, (_input, _principal, self) => {
		const hub = shared(self);
		return {
			variant: "ready",
			state: hub.credentials,
			save: async (input, ctx) => {
				await runtime.saveCredential(input.provider as CredentialProviderId, input.key);
				return hub.refreshCredentials(null, ctx);
			},
			remove: async (input, ctx) => {
				await runtime.removeCredential(input.provider as CredentialProviderId);
				return hub.refreshCredentials(null, ctx);
			},
			setEnabled: (input, ctx) =>
				serialize(async () => {
					if (!isModelProvider(input.provider)) throw new ChordError("invalid", "Unknown model provider.");
					try {
						await runtime.setProviderEnabled(input.provider, input.enabled);
					} catch (error) {
						throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot change provider.");
					}
					return hub.refreshCredentials(null, ctx);
				}),
		};
	});
	host.serve(NekoSearchSettings, (_input, _principal, self) => {
		const hub = shared(self);
		return {
			variant: "ready",
			state: hub.searchSettings,
			set: (input, ctx) =>
				serialize(async () => {
					await runtime.setSearchProvider(input.provider);
					return hub.refreshSearchSettings(null, ctx);
				}),
		};
	});
	host.serve(NekoContextSettings, (_input, _principal, self) => {
		const hub = shared(self);
		return {
			variant: "ready",
			state: hub.contextSettings,
			set: (input, ctx) =>
				serialize(async () => {
					await runtime.setContextSettings(input);
					return hub.refreshContextSettings(null, ctx);
				}),
			reset: (_input, ctx) =>
				serialize(async () => {
					await runtime.resetContextSettings();
					return hub.refreshContextSettings(null, ctx);
				}),
		};
	});
	host.serve(NekoDefaultModel, (_input, _principal, self) => {
		const hub = shared(self);
		return {
			variant: "ready",
			state: hub.defaultModel,
			set: (input, ctx) =>
				serialize(async () => {
					await runtime.setDefaultModel(input);
					return hub.refreshDefaultModel(null, ctx);
				}),
			clear: (_input, ctx) =>
				serialize(async () => {
					await runtime.setDefaultModel(null);
					return hub.refreshDefaultModel(null, ctx);
				}),
		};
	});
	host.serve(NekoModels, () => ({
		variant: "ready",
		list: async () =>
			(await runtime.listSelectableModels()).map((value) => ({
				...value,
				input: [...value.input],
				supportedThinkingLevels: [...value.supportedThinkingLevels],
			})),
	}));
	host.serve(NekoWorkspaceFiles, () => ({
		variant: "ready",
		search: async (input, ctx) => {
			const roots = await runtime.listWorkspaces();
			if (!roots.some((root) => root.path === input.workspaceRoot))
				throw new ChordError("invalid", "Unknown workspace.");
			return runtime.workspaceFiles.search(input.workspaceRoot, input.query, ctx.signal);
		},
	}));
	serveSessions(host, runtime, context);
	host.serve(NekoSessionManagement, (_input, principal, self) => {
		const owner = self.get(Owner, {}, { principal });
		const summary = async (id: ConversationId) => {
			const found = (await list()).find((item) => item.id === String(id));
			if (!found) throw new ChordError("gone", "Session unavailable");
			return found;
		};
		return {
			variant: "ready",
			create: (input) => serialize(async () => summary((await runtime.createConversation(input)).id)),
			fork: (id) => serialize(async () => summary((await runtime.forkConversation(toConversationId(id))).id)),
			archive: async (id) => {
				await runtime.archiveConversation(toConversationId(id));
				return null;
			},
			attach: (id) =>
				serialize(async () => {
					if (!(await runtime.getConversation(toConversationId(id))))
						throw new ChordError("gone", `Unknown session: ${id}`);
					if (owner.owner!.active?.sessionId !== id) {
						owner.owner!.active = { sessionId: id, attachmentId: randomUUID() };
						await runtime.touchConversation(toConversationId(id));
					}
					return owner.owner!.active!;
				}),
			detach: async () => {
				owner.owner!.active = null;
				return null;
			},
		};
	});
	host.serve(NekoSkillMarket, () => ({
		variant: "ready",
		list: (input) =>
			market
				.list(input.query)
				.then((skills) => Promise.all(skills.map((skill) => withInstallState(skill, input.workspaceRoot))))
				.catch(toRemote),
		detail: (input) =>
			market
				.detail(input.name)
				.then((skill) => withInstallState(skill, input.workspaceRoot))
				.catch(toRemote),
		preview: (input) =>
			market
				.preview(input.name)
				.then((value) => ({ ...value, files: [...value.files] }))
				.catch(toRemote),
		install: (input) =>
			serialize(() =>
				market
					.install(input)
					.then((result) => ({ ...result }))
					.catch(toRemote),
			),
		uninstall: (input) =>
			serialize(async () => {
				await market.uninstall(input).catch(toRemote);
				return null;
			}),
	}));
	await host.ready();
	return {
		async dispose() {
			closed = true;
			clearInterval(updateTimer);
			updates.close();
			updateListeners.clear();
			await mutationTail;
		},
	};
}
export function toConversationId(sessionId: string): ConversationId {
	const numeric = Number(sessionId);
	if (!Number.isSafeInteger(numeric) || numeric < 1 || String(numeric) !== sessionId)
		throw new ChordError("invalid", `Invalid neko session id: ${sessionId}`);
	return numeric as ConversationId;
}
