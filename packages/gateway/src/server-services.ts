import { randomUUID } from "node:crypto";
import { ChordError, defineFacet, type Host, invalid } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
	CREDENTIAL_PROVIDERS,
	type CredentialProviderId,
	isModelProvider,
	type NekoRuntime,
	onCommits,
} from "@neko-harness/core";
import { UpdateChecker, type UpdateCheckerOptions } from "@neko-harness/core/application-updates";
import type { UpdateState } from "@neko-harness/core/application-version";
import {
	NekoApplicationInfo,
	NekoCodemodeSettings,
	type NekoCodemodeSettingsState,
	NekoContextSettings,
	type NekoContextSettingsState,
	type NekoCredentialState,
	NekoCredentials,
	NekoDefaultModel,
	type NekoDefaultModelState,
	type NekoDirectoryState,
	type NekoMarketSkill,
	NekoMcp,
	type NekoMcpState,
	NekoModels,
	NekoSearchSettings,
	type NekoSearchSettingsState,
	NekoSessionDirectory,
	NekoSessionManagement,
	type NekoSessionSummary,
	NekoSkillMarket,
	NekoWorkspaceFiles,
	NekoWorkspaces,
} from "./contract.ts";
import { createMobileAdminFactory, type MobileAdminDepsProvider, NekoMobileAdmin } from "./mobile/admin.ts";
import type { GatewayPrincipal } from "./principal.ts";
import { registerSessionServices, toConversationId } from "./session-host.ts";
import { activeLevelOf, createSkillMarketClient, SkillMarketError } from "./skill-market.ts";
import { createPrincipalAttachments, createStateHub, watchHub } from "./state-hub.ts";
import { browseWorkspaces } from "./workspaces.ts";

export { toConversationId };

export async function createNekoServerServices<
	R extends import("@earendil-works/chord/json").JsonValue = string,
>(options: {
	host: Host<GatewayPrincipal, R>;
	runtime: NekoRuntime;
	context: Context;
	marketUrl: string;
	serverId: string;
	promptHome?: string;
	updates?: UpdateCheckerOptions;
	updateIntervalMs?: number;
	mobileAdmin?: MobileAdminDepsProvider;
}) {
	const { runtime, context, host } = options;
	const updates = new UpdateChecker(options.updates);
	await updates.local();
	// The Windows shell status rides along with the update state; only Windows runtimes report one.
	const info = (value: UpdateState) => {
		const shell = runtime.shellStatus();
		return { ...value, serverId: options.serverId, ...(shell === undefined ? {} : { shell }) };
	};
	const appInfoHub = createStateHub(info(updates.state));
	let published = JSON.stringify(appInfoHub.value);
	let closed = false;
	const publishUpdates = () => {
		if (closed) return;
		const currentInfo = info(updates.state);
		const next = JSON.stringify(currentInfo);
		if (next === published) return;
		published = next;
		appInfoHub.set(currentInfo);
	};

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
	// ChordError details.reason 保留业务原因，前端无需解析格式化后的 message。
	const toRemote = (error: unknown): never => {
		if (error instanceof SkillMarketError) {
			if (error.code === "skill_not_found" || error.code === "skill_not_installed") {
				throw new ChordError({ code: "gone", message: error.message, details: { reason: error.code } });
			}
			throw invalid("args", error.message, { reason: error.code });
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
		(await runtime.listConversations()).map((item) => ({
			id: String(item.id),
			workspaceRoot: item.workspaceRoot,
			lastUsedAt: item.lastUsedAt,
			title: item.title,
			firstPromptPreview: item.firstPromptPreview,
			createdAt: item.createdAt,
			lastMessageAt: item.lastMessageAt,
			model: item.model,
			status: item.status,
			awaitingAnswer: item.awaitingAnswer,
			awaitingPlan: item.awaitingPlan,
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
	const [sessions, workspaces, statuses, search, contextSettings0, codemodeSettings0, defaultModel0] =
		await Promise.all([
			list(),
			runtime.listWorkspaces(),
			readStatuses(),
			runtime.searchSettings(),
			runtime.contextSettings(),
			runtime.codemodeSettings(),
			runtime.defaultModel(),
		]);

	const directoryHub = createStateHub<NekoDirectoryState>({ revision: 1, sessions });
	const workspacesHub = createStateHub({ revision: 1, workspaces });
	const credentialsHub = createStateHub<NekoCredentialState>({ revision: 1, statuses });
	const searchSettingsHub = createStateHub<NekoSearchSettingsState>({ revision: 1, ...search });
	const contextSettingsHub = createStateHub<NekoContextSettingsState>({ revision: 1, ...contextSettings0 });
	const codemodeSettingsHub = createStateHub<NekoCodemodeSettingsState>({ revision: 1, ...codemodeSettings0 });
	const defaultModelHub = createStateHub<NekoDefaultModelState>(defaultModel0);
	const cloneMcp = (snap: ReturnType<NekoRuntime["mcpSnapshot"]>): NekoMcpState =>
		JSON.parse(JSON.stringify(snap)) as NekoMcpState;
	const mcpHub = createStateHub<NekoMcpState>(cloneMcp(runtime.mcpSnapshot()));
	const stopMcp = runtime.onMcpChange((snap) => {
		if (!closed) mcpHub.set(cloneMcp(snap));
	});

	let mutationTail = Promise.resolve();
	const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
		const result = mutationTail.catch(() => {}).then(fn);
		mutationTail = result.then(
			() => {},
			() => {},
		);
		return result;
	};

	const refreshCredentials = async () => {
		if (closed) return null;
		credentialsHub.set({
			revision: credentialsHub.value.revision + 1,
			statuses: await readStatuses(),
		});
		return null;
	};
	const refreshSearchSettings = async () => {
		if (closed) return null;
		const next = await runtime.searchSettings();
		const current = searchSettingsHub.value;
		if (next.selected !== current.selected) {
			searchSettingsHub.set({ revision: current.revision + 1, ...next });
		}
		return null;
	};
	const refreshContextSettings = async () => {
		if (closed) return null;
		const next = await runtime.contextSettings();
		const { revision, ...current } = contextSettingsHub.value;
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			contextSettingsHub.set({ revision: revision + 1, ...next });
		}
		return null;
	};
	const refreshCodemodeSettings = async () => {
		if (closed) return null;
		const next = await runtime.codemodeSettings();
		const { revision, ...current } = codemodeSettingsHub.value;
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			codemodeSettingsHub.set({ revision: revision + 1, ...next });
		}
		return null;
	};
	const refreshDefaultModel = async () => {
		if (closed) return null;
		const next = await runtime.defaultModel();
		if (JSON.stringify(next) !== JSON.stringify(defaultModelHub.value)) {
			defaultModelHub.set(next);
		}
		return null;
	};

	const stopDirectoryCommits = onCommits(runtime.harness, (event) => {
		if (closed) return;
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
							"app.neko.workspaces-removed",
							"pi.agent",
						].includes(change.record.kind)),
			)
		)
			return;
		void serialize(async () => {
			if (closed) return;
			const [items, roots] = await Promise.all([list(), runtime.listWorkspaces()]);
			if (closed) return;
			directoryHub.set({ revision: directoryHub.value.revision + 1, sessions: items });
			workspacesHub.set({ revision: workspacesHub.value.revision + 1, workspaces: roots });
		});
	});

	const principals = createPrincipalAttachments();

	const facet = defineFacet<GatewayPrincipal>((facetHost) => {
		facetHost.serve(NekoApplicationInfo, (_input, _principal, self) => ({
			variant: "ready",
			members: {
				info: watchHub(self, appInfoHub),
				check: async () => {
					runtime.shellStatus({ refresh: true });
					await updates.check(true);
					publishUpdates();
					return info(updates.state);
				},
			},
		}));

		facetHost.serve(NekoSessionDirectory, (_input, _principal, self) => ({
			variant: "ready",
			members: { snapshot: watchHub(self, directoryHub) },
		}));

		facetHost.serve(NekoWorkspaces, (_input, _principal, self) => ({
			variant: "ready",
			members: {
				snapshot: watchHub(self, workspacesHub),
				browse: (input) => browseWorkspaces(input),
				add: (input) => serialize(() => runtime.addWorkspace(input.path)),
				remove: (input) =>
					serialize(async () => {
						await runtime.removeWorkspace(input.path);
						return null;
					}),
			},
		}));

		facetHost.serve(NekoCredentials, (_input, _principal, self) => ({
			variant: "ready",
			members: {
				snapshot: watchHub(self, credentialsHub),
				save: async (input) => {
					await runtime.saveCredential(input.provider as CredentialProviderId, input.key);
					return refreshCredentials();
				},
				remove: async (input) => {
					await runtime.removeCredential(input.provider as CredentialProviderId);
					return refreshCredentials();
				},
				setEnabled: (input) =>
					serialize(async () => {
						if (!isModelProvider(input.provider)) throw invalid("args", "Unknown model provider.");
						try {
							await runtime.setProviderEnabled(input.provider, input.enabled);
						} catch (error) {
							throw invalid("args", error instanceof Error ? error.message : "Cannot change provider.");
						}
						return refreshCredentials();
					}),
			},
		}));

		facetHost.serve(NekoSearchSettings, (_input, _principal, self) => ({
			variant: "ready",
			members: {
				snapshot: watchHub(self, searchSettingsHub),
				set: (input) =>
					serialize(async () => {
						await runtime.setSearchProvider(input.provider);
						return refreshSearchSettings();
					}),
			},
		}));

		facetHost.serve(NekoContextSettings, (_input, _principal, self) => ({
			variant: "ready",
			members: {
				snapshot: watchHub(self, contextSettingsHub),
				set: (input) =>
					serialize(async () => {
						await runtime.setContextSettings(input);
						return refreshContextSettings();
					}),
				reset: () =>
					serialize(async () => {
						await runtime.resetContextSettings();
						return refreshContextSettings();
					}),
			},
		}));

		facetHost.serve(NekoCodemodeSettings, (_input, _principal, self) => ({
			variant: "ready",
			members: {
				snapshot: watchHub(self, codemodeSettingsHub),
				set: (input) =>
					serialize(async () => {
						await runtime.setCodemodeMode(input.mode);
						return refreshCodemodeSettings();
					}),
				reset: () =>
					serialize(async () => {
						await runtime.resetCodemodeMode();
						return refreshCodemodeSettings();
					}),
			},
		}));

		const toMcpError = (error: unknown): never => {
			throw invalid("args", error instanceof Error ? error.message : String(error));
		};
		const toKeyValueRecord = (
			entries: readonly { readonly key: string; readonly value: string }[] | undefined,
		): Record<string, string> | undefined => {
			if (!entries || entries.length === 0) return undefined;
			const record: Record<string, string> = {};
			for (const entry of entries) record[entry.key] = entry.value;
			return record;
		};
		facetHost.serve(NekoMcp, (_input, _principal, self) => ({
			variant: "ready",
			members: {
				snapshot: watchHub(self, mcpHub),
				upsertServer: (input) =>
					serialize(async () => {
						const cfg =
							input.config.transport === "stdio"
								? { ...input.config, env: toKeyValueRecord(input.config.env) }
								: { ...input.config, headers: toKeyValueRecord(input.config.headers) };
						return cloneMcp(await runtime.upsertMcpServer(input.name, cfg).catch(toMcpError));
					}),
				removeServer: (input) =>
					serialize(async () => cloneMcp(await runtime.removeMcpServer(input.name).catch(toMcpError))),
				setEnabled: (input) =>
					serialize(async () =>
						cloneMcp(await runtime.setMcpServerEnabled(input.name, input.enabled).catch(toMcpError)),
					),
				saveRawConfig: (input) =>
					serialize(async () => cloneMcp(await runtime.saveMcpRawConfig(input.rawJson).catch(toMcpError))),
				reconnect: (input) =>
					serialize(async () => cloneMcp(await runtime.reconnectMcpServer(input.name).catch(toMcpError))),
				beginSignIn: (input) => runtime.beginMcpSignIn(input.server).catch(toMcpError),
				pasteSignIn: (input) => runtime.pasteMcpSignIn(input.id, input.redirectUrl).then(cloneMcp).catch(toMcpError),
				cancelSignIn: (input) => runtime.cancelMcpSignIn(input.id).then(cloneMcp).catch(toMcpError),
				signOut: (input) =>
					serialize(async () => cloneMcp(await runtime.signOutMcpServer(input.server).catch(toMcpError))),
			},
		}));

		facetHost.serve(NekoDefaultModel, (_input, _principal, self) => ({
			variant: "ready",
			members: {
				snapshot: watchHub(self, defaultModelHub),
				set: (input) =>
					serialize(async () => {
						await runtime.setDefaultModel(input);
						return refreshDefaultModel();
					}),
				clear: () =>
					serialize(async () => {
						await runtime.setDefaultModel(null);
						return refreshDefaultModel();
					}),
			},
		}));

		facetHost.serve(NekoModels, () => ({
			variant: "ready",
			members: {
				list: async () =>
					(await runtime.listSelectableModels()).map((value) => ({
						...value,
						input: [...value.input],
						supportedThinkingLevels: [...value.supportedThinkingLevels],
					})),
			},
		}));

		facetHost.serve(NekoWorkspaceFiles, () => ({
			variant: "ready",
			members: {
				search: async (input, ctx) => {
					const roots = await runtime.listWorkspaces();
					if (!roots.some((root) => root.path === input.workspaceRoot)) throw invalid("args", "Unknown workspace.");
					return runtime.workspaceFiles.search(
						input.workspaceRoot,
						input.query,
						ctx.abortSignal ?? new AbortController().signal,
					);
				},
			},
		}));

		registerSessionServices(facetHost, runtime, context, principals);

		facetHost.serve(NekoSessionManagement, (_input, principal, self) => {
			self.open(
				async () => principals.retain(principal),
				(release) => release(),
			);
			const summary = async (id: ConversationId) => {
				const found = (await list()).find((item) => item.id === String(id));
				if (!found) throw new ChordError({ code: "gone", message: "Session unavailable" });
				return found;
			};
			return {
				variant: "ready",
				members: {
					create: (input) => serialize(async () => summary((await runtime.createConversation(input)).id)),
					fork: (id) => serialize(async () => summary((await runtime.forkConversation(toConversationId(id))).id)),
					archive: async (id) => {
						await runtime.archiveConversation(toConversationId(id));
						return null;
					},
					attach: (id) =>
						serialize(async () => {
							if (!(await runtime.getConversation(toConversationId(id))))
								throw new ChordError({ code: "gone", message: `Unknown session: ${id}` });
							const current = principals.get(principal);
							if (current?.sessionId !== id) {
								const next = { sessionId: id, attachmentId: randomUUID() };
								principals.set(principal, next);
								await runtime.touchConversation(toConversationId(id));
								return next;
							}
							return current;
						}),
					detach: async () => {
						principals.set(principal, null);
						return null;
					},
				},
			};
		});

		facetHost.serve(NekoSkillMarket, () => ({
			variant: "ready",
			members: {
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
			},
		}));

		if (options.mobileAdmin !== undefined) {
			facetHost.serve(NekoMobileAdmin, createMobileAdminFactory(options.mobileAdmin));
		}
	});

	const report = await host.load([{ name: "@neko-harness/gateway", facet }], context);
	if (report.failed.length > 0) {
		closed = true;
		stopDirectoryCommits();
		stopMcp();
		clearInterval(updateTimer);
		updates.close();
		throw report.failed[0]?.error ?? new Error("Failed to load gateway facet");
	}

	return {
		async dispose() {
			closed = true;
			stopDirectoryCommits();
			stopMcp();
			clearInterval(updateTimer);
			updates.close();
			appInfoHub.clear();
			directoryHub.clear();
			workspacesHub.clear();
			credentialsHub.clear();
			searchSettingsHub.clear();
			contextSettingsHub.clear();
			codemodeSettingsHub.clear();
			defaultModelHub.clear();
			mcpHub.clear();
			await mutationTail;
		},
	};
}
