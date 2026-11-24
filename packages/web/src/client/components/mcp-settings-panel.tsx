import {
	isOAuthRelevant,
	isPureEnvTemplate,
	isSensitiveFieldKey,
	MCP_EXPOSURES,
	type McpExposure,
	type McpServerStatus,
	type McpTransportKind,
} from "@neko-harness/core/mcp";
import { useEffect, useId, useRef, useState } from "react";
import type {
	NekoMcpBeginSignInResult,
	NekoMcpServer,
	NekoMcpServerConfigInput,
	NekoMcpSignIn,
	NekoMcpState,
} from "../lib/contract.ts";
import { type PlainKey, useT } from "../lib/i18n/index.ts";
import { Icon, Modal } from "./primitives";

export type McpSettingsActions = {
	upsertServer: (name: string, config: NekoMcpServerConfigInput) => Promise<NekoMcpState>;
	removeServer: (name: string) => Promise<NekoMcpState>;
	setEnabled: (name: string, enabled: boolean) => Promise<NekoMcpState>;
	saveRawConfig: (rawJson: string) => Promise<NekoMcpState>;
	reconnect: (name: string) => Promise<NekoMcpState>;
	beginSignIn: (server: string) => Promise<NekoMcpBeginSignInResult>;
	pasteSignIn: (id: string, redirectUrl: string) => Promise<NekoMcpState>;
	cancelSignIn: (id: string) => Promise<NekoMcpState>;
	signOut: (server: string) => Promise<NekoMcpState>;
};

const INPUT_CLASS =
	"focus-neko w-full min-w-0 rounded-xl border border-sakura-200 bg-base px-3.5 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 disabled:opacity-60";
const SELECT_CLASS = `${INPUT_CLASS} appearance-none pr-9 cursor-pointer disabled:cursor-not-allowed`;
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;
const PRIMARY_BTN =
	"btn-primary btn-lift focus-neko inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50";
const PRIMARY_BTN_SM =
	"btn-primary btn-lift focus-neko inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold disabled:opacity-50";
const SECONDARY_BTN =
	"focus-neko inline-flex items-center justify-center gap-1.5 rounded-full border border-sakura-200 bg-surface px-4 py-2 text-sm font-medium text-ink-700 hover:bg-sakura-50 disabled:opacity-50";
const SECONDARY_BTN_SM =
	"focus-neko inline-flex items-center justify-center gap-1.5 rounded-full border border-sakura-200 bg-surface px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-sakura-50 disabled:opacity-50";

const STATUS_META: Record<
	McpServerStatus,
	{ label: PlainKey; icon: "check" | "spinner" | "clock" | "key" | "close"; spin?: boolean; className: string }
> = {
	connected: {
		label: "mcp.status.connected",
		icon: "check",
		className: "border-tianyi-300 bg-tianyi-50 text-tianyi-900",
	},
	connecting: {
		label: "mcp.status.connecting",
		icon: "spinner",
		spin: true,
		className: "border-tianyi-200 bg-tianyi-50 text-tianyi-800",
	},
	disabled: {
		label: "mcp.status.disabled",
		icon: "clock",
		className: "border-ink-200 bg-ink-100 text-ink-600",
	},
	disconnected: {
		label: "mcp.status.disconnected",
		icon: "clock",
		className: "border-ink-200 bg-ink-100 text-ink-700",
	},
	auth_required: {
		label: "mcp.status.auth_required",
		icon: "key",
		className: "border-sakura-400 bg-sakura-50 text-sakura-900 font-semibold",
	},
	error: {
		label: "mcp.status.error",
		icon: "close",
		className: "border-2 border-sakura-500 bg-sakura-100 text-sakura-900 font-semibold",
	},
};

type KeyValueRow = { id: string; key: string; value: string; revealed: boolean };

function recordToRows(record: Record<string, string> | undefined): KeyValueRow[] {
	if (!record) return [];
	return Object.entries(record).map(([key, value], index) => ({
		id: `row-${index}-${key}`,
		key,
		value,
		revealed: false,
	}));
}

function rowsToEntries(rows: readonly KeyValueRow[]): { key: string; value: string }[] | undefined {
	const entries = rows.map((r) => ({ key: r.key.trim(), value: r.value })).filter((r) => r.key.length > 0);
	return entries.length > 0 ? entries : undefined;
}

function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type ServerFormDraft = {
	isEdit: boolean;
	name: string;
	transport: McpTransportKind;
	enabled: boolean;
	exposure: McpExposure;
	description: string;
	timeout: string;
	command: string;
	argsText: string;
	cwd: string;
	envRows: KeyValueRow[];
	url: string;
	headerRows: KeyValueRow[];
	oauthClientId: string;
	oauthClientSecret: string;
	oauthClientSecretRevealed: boolean;
	oauthScope: string;
	oauthCallbackPort: string;
	oauthCallbackUrl: string;
	oauthClientName: string;
	oauthRegistration: "" | "auto" | "dcr";
	oauthMetadataUrl: string;
};

function emptyDraft(): ServerFormDraft {
	return {
		isEdit: false,
		name: "",
		transport: "stdio",
		enabled: true,
		exposure: "auto",
		description: "",
		timeout: "",
		command: "",
		argsText: "",
		cwd: "",
		envRows: [],
		url: "",
		headerRows: [],
		oauthClientId: "",
		oauthClientSecret: "",
		oauthClientSecretRevealed: false,
		oauthScope: "",
		oauthCallbackPort: "",
		oauthCallbackUrl: "",
		oauthClientName: "",
		oauthRegistration: "",
		oauthMetadataUrl: "",
	};
}

function draftFromServer(server: NekoMcpServer): ServerFormDraft {
	const base = emptyDraft();
	const cfg = server.config;
	const shared = {
		...base,
		isEdit: true,
		name: server.name,
		transport: server.transport,
		enabled: server.enabled,
		exposure: server.exposure,
		description: cfg.description ?? "",
		timeout: cfg.timeout !== undefined ? String(cfg.timeout) : "",
	};
	if (cfg.transport === "stdio") {
		return {
			...shared,
			command: cfg.command,
			argsText: (cfg.args ?? []).join("\n"),
			cwd: cfg.cwd ?? "",
			envRows: recordToRows(cfg.env),
		};
	}
	return {
		...shared,
		url: cfg.url,
		headerRows: recordToRows(cfg.headers),
		oauthClientId: cfg.oauth?.clientId ?? "",
		oauthClientSecret: cfg.oauth?.clientSecret ?? "",
		oauthScope: cfg.oauth?.scope ?? "",
		oauthCallbackPort: cfg.oauth?.callbackPort !== undefined ? String(cfg.oauth.callbackPort) : "",
		oauthCallbackUrl: cfg.oauth?.callbackUrl ?? "",
		oauthClientName: cfg.oauth?.clientName ?? "",
		oauthRegistration: cfg.oauth?.clientRegistration ?? "",
		oauthMetadataUrl: cfg.oauth?.authServerMetadataUrl ?? "",
	};
}

function buildConfigInput(draft: ServerFormDraft): NekoMcpServerConfigInput {
	const timeoutNum = draft.timeout.trim() ? Number(draft.timeout.trim()) : undefined;
	const base = {
		enabled: draft.enabled,
		exposure: draft.exposure,
		...(draft.description.trim() ? { description: draft.description.trim() } : {}),
		...(timeoutNum !== undefined && Number.isFinite(timeoutNum) ? { timeout: timeoutNum } : {}),
	};
	if (draft.transport === "stdio") {
		const args = draft.argsText
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		const env = rowsToEntries(draft.envRows);
		return {
			transport: "stdio",
			command: draft.command.trim(),
			...(args.length > 0 ? { args } : {}),
			...(env ? { env } : {}),
			...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
			...base,
		};
	}
	const headers = rowsToEntries(draft.headerRows);
	const callbackPortNum = draft.oauthCallbackPort.trim()
		? Number.parseInt(draft.oauthCallbackPort.trim(), 10)
		: undefined;
	const oauthFields = {
		...(draft.oauthClientId.trim() ? { clientId: draft.oauthClientId.trim() } : {}),
		...(draft.oauthClientSecret.trim() ? { clientSecret: draft.oauthClientSecret } : {}),
		...(draft.oauthScope.trim() ? { scope: draft.oauthScope.trim() } : {}),
		...(callbackPortNum !== undefined && Number.isFinite(callbackPortNum) ? { callbackPort: callbackPortNum } : {}),
		...(draft.oauthCallbackUrl.trim() ? { callbackUrl: draft.oauthCallbackUrl.trim() } : {}),
		...(draft.oauthClientName.trim() ? { clientName: draft.oauthClientName.trim() } : {}),
		...(draft.oauthRegistration ? { clientRegistration: draft.oauthRegistration } : {}),
		...(draft.oauthMetadataUrl.trim() ? { authServerMetadataUrl: draft.oauthMetadataUrl.trim() } : {}),
	};
	return {
		transport: "http",
		url: draft.url.trim(),
		...(headers ? { headers } : {}),
		...(Object.keys(oauthFields).length > 0 ? { oauth: oauthFields } : {}),
		...base,
	};
}

function KeyValueEditor(props: {
	label: string;
	rows: readonly KeyValueRow[];
	disabled: boolean;
	onChange: (next: KeyValueRow[]) => void;
}) {
	const t = useT();
	const seqRef = useRef(0);
	const update = (id: string, patch: Partial<KeyValueRow>) => {
		props.onChange(props.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
	};
	return (
		<div className="space-y-2.5 rounded-xl border border-sakura-100 bg-base/60 p-3.5">
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-semibold text-ink-700">{props.label}</span>
				<button
					type="button"
					disabled={props.disabled}
					onClick={() =>
						props.onChange([...props.rows, { id: `new-${++seqRef.current}`, key: "", value: "", revealed: false }])
					}
					className={SECONDARY_BTN_SM}
				>
					<Icon name="plus" size={12} />
					{t("mcp.form.addRow")}
				</button>
			</div>
			{props.rows.length > 0 && (
				<div className="space-y-2">
					{props.rows.map((row) => {
						const secret = isSensitiveFieldKey(row.key) && !isPureEnvTemplate(row.value);
						const masked = secret && !row.revealed;
						return (
							<div key={row.id} className="flex items-center gap-2">
								<input
									type="text"
									disabled={props.disabled}
									value={row.key}
									placeholder={t("mcp.form.keyPlaceholder")}
									onChange={(e) => update(row.id, { key: e.target.value })}
									className="focus-neko w-1/3 rounded-xl border border-sakura-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900 placeholder:text-ink-400"
								/>
								<input
									type={masked ? "password" : "text"}
									disabled={props.disabled}
									value={row.value}
									placeholder={t("mcp.form.valuePlaceholder", { syntax: "$" + "{ENV_VAR}" })}
									onChange={(e) => update(row.id, { value: e.target.value })}
									className="focus-neko min-w-0 flex-1 rounded-xl border border-sakura-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900 placeholder:text-ink-400"
								/>
								{secret && (
									<button
										type="button"
										disabled={props.disabled}
										aria-label={row.revealed ? t("mcp.form.hideSecret") : t("mcp.form.showSecret")}
										title={row.revealed ? t("mcp.form.hideSecret") : t("mcp.form.showSecret")}
										onClick={() => update(row.id, { revealed: !row.revealed })}
										className="icon-btn focus-neko rounded-xl border border-sakura-200 bg-surface p-2 text-ink-600 hover:bg-sakura-50"
									>
										<Icon name="eye" size={14} />
									</button>
								)}
								<button
									type="button"
									disabled={props.disabled}
									aria-label={t("mcp.form.removeRow")}
									title={t("mcp.form.removeRow")}
									onClick={() => props.onChange(props.rows.filter((r) => r.id !== row.id))}
									className="icon-btn focus-neko rounded-xl border border-sakura-200 bg-surface p-2 text-ink-600 hover:bg-sakura-50"
								>
									<Icon name="trash" size={14} />
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

function ServerFormModal(props: {
	draft: ServerFormDraft;
	disabled: boolean;
	onSave: (name: string, config: NekoMcpServerConfigInput) => Promise<void>;
	onClose: () => void;
}) {
	const t = useT();
	const id = useId();
	const [draft, setDraft] = useState<ServerFormDraft>(props.draft);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const locked = saving || props.disabled;
	const secretMasked =
		draft.oauthClientSecret.length > 0 &&
		!isPureEnvTemplate(draft.oauthClientSecret) &&
		!draft.oauthClientSecretRevealed;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (locked) return;
		setSaving(true);
		setError("");
		try {
			await props.onSave(draft.name.trim(), buildConfigInput(draft));
			props.onClose();
		} catch (err) {
			setError(errMsg(err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal
			title={draft.isEdit ? t("mcp.form.titleEdit", { name: draft.name }) : t("mcp.form.titleAdd")}
			locked={saving}
			onClose={props.onClose}
		>
			<form onSubmit={(e) => void handleSubmit(e)} className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						<div className="sm:col-span-2">
							<label htmlFor={`${id}-name`} className="mb-1.5 block text-xs font-semibold text-ink-700">
								{t("mcp.form.name")}
							</label>
							<input
								id={`${id}-name`}
								type="text"
								required
								disabled={locked || draft.isEdit}
								value={draft.name}
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								className={MONO_INPUT_CLASS}
							/>
							<p className="mt-1.5 text-xs text-ink-400">{t("mcp.form.nameHint")}</p>
						</div>
						<div>
							<label htmlFor={`${id}-transport`} className="mb-1.5 block text-xs font-semibold text-ink-700">
								{t("mcp.form.transport")}
							</label>
							<div className="relative">
								<select
									id={`${id}-transport`}
									disabled={locked}
									value={draft.transport}
									onChange={(e) => setDraft({ ...draft, transport: e.target.value as McpTransportKind })}
									className={SELECT_CLASS}
								>
									<option value="stdio">{t("mcp.transport.stdio")}</option>
									<option value="http">{t("mcp.transport.http")}</option>
								</select>
								<span
									aria-hidden
									className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-500"
								>
									<Icon name="chevron" size={16} />
								</span>
							</div>
						</div>
					</div>

					{draft.transport === "stdio" ? (
						<div className="space-y-4">
							<div>
								<label htmlFor={`${id}-command`} className="mb-1.5 block text-xs font-semibold text-ink-700">
									{t("mcp.form.command")}
								</label>
								<input
									id={`${id}-command`}
									type="text"
									required
									disabled={locked}
									value={draft.command}
									onChange={(e) => setDraft({ ...draft, command: e.target.value })}
									className={MONO_INPUT_CLASS}
								/>
							</div>
							<div>
								<label htmlFor={`${id}-args`} className="mb-1.5 block text-xs font-semibold text-ink-700">
									{t("mcp.form.args")}
								</label>
								<textarea
									id={`${id}-args`}
									rows={3}
									disabled={locked}
									value={draft.argsText}
									onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
									className="focus-neko w-full rounded-xl border border-sakura-200 bg-base px-3.5 py-2.5 font-mono text-xs text-ink-900 disabled:opacity-60"
								/>
							</div>
							<div>
								<label htmlFor={`${id}-cwd`} className="mb-1.5 block text-xs font-semibold text-ink-700">
									{t("mcp.form.cwd")}
								</label>
								<input
									id={`${id}-cwd`}
									type="text"
									disabled={locked}
									value={draft.cwd}
									onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
									className={MONO_INPUT_CLASS}
								/>
							</div>
							<KeyValueEditor
								label={t("mcp.form.env")}
								rows={draft.envRows}
								disabled={locked}
								onChange={(envRows) => setDraft({ ...draft, envRows })}
							/>
						</div>
					) : (
						<div className="space-y-4">
							<div>
								<label htmlFor={`${id}-url`} className="mb-1.5 block text-xs font-semibold text-ink-700">
									{t("mcp.form.url")}
								</label>
								<input
									id={`${id}-url`}
									type="url"
									required
									disabled={locked}
									value={draft.url}
									onChange={(e) => setDraft({ ...draft, url: e.target.value })}
									className={MONO_INPUT_CLASS}
								/>
							</div>
							<KeyValueEditor
								label={t("mcp.form.headers")}
								rows={draft.headerRows}
								disabled={locked}
								onChange={(headerRows) => setDraft({ ...draft, headerRows })}
							/>
							<details className="rounded-xl border border-sakura-100 bg-base/60 p-4">
								<summary className="cursor-pointer text-xs font-semibold text-ink-700">
									{t("mcp.form.oauthAdvanced")}
								</summary>
								<div className="mt-4 space-y-3.5">
									<div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
										<div>
											<label htmlFor={`${id}-cid`} className="mb-1 block text-xs text-ink-600">
												{t("mcp.form.oauthClientId")}
											</label>
											<input
												id={`${id}-cid`}
												type="text"
												disabled={locked}
												value={draft.oauthClientId}
												onChange={(e) => setDraft({ ...draft, oauthClientId: e.target.value })}
												className="focus-neko w-full rounded-xl border border-sakura-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900"
											/>
										</div>
										<div>
											<label htmlFor={`${id}-csec`} className="mb-1 block text-xs text-ink-600">
												{t("mcp.form.oauthClientSecret")}
											</label>
											<div className="flex items-center gap-1.5">
												<input
													id={`${id}-csec`}
													type={secretMasked ? "password" : "text"}
													disabled={locked}
													value={draft.oauthClientSecret}
													onChange={(e) => setDraft({ ...draft, oauthClientSecret: e.target.value })}
													className="focus-neko min-w-0 flex-1 rounded-xl border border-sakura-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900"
												/>
												{draft.oauthClientSecret.length > 0 && !isPureEnvTemplate(draft.oauthClientSecret) && (
													<button
														type="button"
														disabled={locked}
														aria-label={
															draft.oauthClientSecretRevealed ? t("mcp.form.hideSecret") : t("mcp.form.showSecret")
														}
														onClick={() =>
															setDraft({ ...draft, oauthClientSecretRevealed: !draft.oauthClientSecretRevealed })
														}
														className="icon-btn focus-neko rounded-xl border border-sakura-200 bg-surface p-2 text-ink-600 hover:bg-sakura-50"
													>
														<Icon name="eye" size={14} />
													</button>
												)}
											</div>
										</div>
									</div>
									<div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
										<div>
											<label htmlFor={`${id}-scope`} className="mb-1 block text-xs text-ink-600">
												{t("mcp.form.oauthScope")}
											</label>
											<input
												id={`${id}-scope`}
												type="text"
												disabled={locked}
												value={draft.oauthScope}
												onChange={(e) => setDraft({ ...draft, oauthScope: e.target.value })}
												className="focus-neko w-full rounded-xl border border-sakura-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900"
											/>
										</div>
										<div>
											<label htmlFor={`${id}-cbport`} className="mb-1 block text-xs text-ink-600">
												{t("mcp.form.oauthCallbackPort")}
											</label>
											<input
												id={`${id}-cbport`}
												type="number"
												min={1}
												max={65535}
												disabled={locked}
												value={draft.oauthCallbackPort}
												onChange={(e) => setDraft({ ...draft, oauthCallbackPort: e.target.value })}
												className="focus-neko w-full rounded-xl border border-sakura-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900"
											/>
										</div>
									</div>
									<div>
										<label htmlFor={`${id}-cburl`} className="mb-1 block text-xs text-ink-600">
											{t("mcp.form.oauthCallbackUrl")}
										</label>
										<input
											id={`${id}-cburl`}
											type="text"
											disabled={locked}
											value={draft.oauthCallbackUrl}
											onChange={(e) => setDraft({ ...draft, oauthCallbackUrl: e.target.value })}
											className="focus-neko w-full rounded-xl border border-sakura-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900"
										/>
									</div>
									<div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
										<div>
											<label htmlFor={`${id}-cname`} className="mb-1 block text-xs text-ink-600">
												{t("mcp.form.oauthClientName")}
											</label>
											<input
												id={`${id}-cname`}
												type="text"
												disabled={locked}
												value={draft.oauthClientName}
												onChange={(e) => setDraft({ ...draft, oauthClientName: e.target.value })}
												className="focus-neko w-full rounded-xl border border-sakura-200 bg-surface px-3 py-2 text-xs text-ink-900"
											/>
										</div>
										<div>
											<label htmlFor={`${id}-reg`} className="mb-1 block text-xs text-ink-600">
												{t("mcp.form.oauthRegistration")}
											</label>
											<div className="relative">
												<select
													id={`${id}-reg`}
													disabled={locked}
													value={draft.oauthRegistration}
													onChange={(e) =>
														setDraft({ ...draft, oauthRegistration: e.target.value as "" | "auto" | "dcr" })
													}
													className="focus-neko w-full appearance-none cursor-pointer rounded-xl border border-sakura-200 bg-surface py-2 pr-8 pl-3 text-xs text-ink-900 disabled:cursor-not-allowed"
												>
													<option value="">{t("mcp.form.oauthRegistrationAuto")}</option>
													<option value="dcr">{t("mcp.form.oauthRegistrationDcr")}</option>
												</select>
												<span
													aria-hidden
													className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-ink-500"
												>
													<Icon name="chevron" size={14} />
												</span>
											</div>
										</div>
									</div>
									<div>
										<label htmlFor={`${id}-meta`} className="mb-1 block text-xs text-ink-600">
											{t("mcp.form.oauthMetadataUrl")}
										</label>
										<input
											id={`${id}-meta`}
											type="text"
											disabled={locked}
											value={draft.oauthMetadataUrl}
											onChange={(e) => setDraft({ ...draft, oauthMetadataUrl: e.target.value })}
											className="focus-neko w-full rounded-xl border border-sakura-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900"
										/>
									</div>
								</div>
							</details>
						</div>
					)}

					<div className="space-y-4 border-t border-sakura-100 pt-4">
						<div>
							<label htmlFor={`${id}-exposure`} className="mb-1.5 block text-xs font-semibold text-ink-700">
								{t("mcp.form.exposure")}
							</label>
							<div className="relative">
								<select
									id={`${id}-exposure`}
									disabled={locked}
									value={draft.exposure}
									onChange={(e) => setDraft({ ...draft, exposure: e.target.value as McpExposure })}
									className={SELECT_CLASS}
								>
									{MCP_EXPOSURES.map((exp) => (
										<option key={exp} value={exp}>
											{exp === "auto" ? t("mcp.form.exposureAuto") : t("mcp.form.exposureDirect")}
										</option>
									))}
								</select>
								<span
									aria-hidden
									className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-500"
								>
									<Icon name="chevron" size={16} />
								</span>
							</div>
						</div>

						<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
							<div className="sm:col-span-2">
								<label htmlFor={`${id}-desc`} className="mb-1.5 block text-xs font-semibold text-ink-700">
									{t("mcp.form.description")}
								</label>
								<input
									id={`${id}-desc`}
									type="text"
									disabled={locked}
									value={draft.description}
									onChange={(e) => setDraft({ ...draft, description: e.target.value })}
									className={INPUT_CLASS}
								/>
							</div>
							<div>
								<label htmlFor={`${id}-timeout`} className="mb-1.5 block text-xs font-semibold text-ink-700">
									{t("mcp.form.timeout")}
								</label>
								<input
									id={`${id}-timeout`}
									type="number"
									min={1}
									disabled={locked}
									value={draft.timeout}
									onChange={(e) => setDraft({ ...draft, timeout: e.target.value })}
									className={MONO_INPUT_CLASS}
								/>
							</div>
						</div>
					</div>

					{error && (
						<div
							role="alert"
							className="rounded-xl border border-sakura-400 bg-sakura-50 px-4 py-3 text-xs text-sakura-900"
						>
							{error}
						</div>
					)}
				</div>

				<div className="flex shrink-0 items-center justify-end gap-3 border-t border-sakura-200 bg-surface px-6 py-4">
					<button type="button" disabled={saving} onClick={props.onClose} className={SECONDARY_BTN}>
						{t("common.cancel")}
					</button>
					<button type="submit" disabled={locked} className={PRIMARY_BTN}>
						{saving ? t("mcp.form.saving") : t("mcp.form.save")}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function ServerCard(props: {
	server: NekoMcpServer;
	signIn: NekoMcpSignIn | undefined;
	disabled: boolean;
	onToggle: (enabled: boolean) => void;
	onReconnect: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onBeginSignIn: () => void;
	onPasteSignIn: (id: string, redirectUrl: string) => void;
	onCancelSignIn: (id: string) => void;
	onSignOut: () => void;
}) {
	const { server, signIn, disabled } = props;
	const t = useT();
	const pasteId = useId();
	const [toolsOpen, setToolsOpen] = useState(false);
	const [pasteUrl, setPasteUrl] = useState("");
	const status = STATUS_META[server.status];
	const oauthRelevant = isOAuthRelevant(server, signIn);
	const waitingSignIn = signIn?.status === "waiting" ? signIn : undefined;
	const failedSignInError = signIn?.status === "failed" && signIn.error ? signIn.error : null;
	const targetSummary =
		server.config.transport === "stdio"
			? [server.config.command, ...(server.config.args ?? [])].join(" ")
			: server.config.url;

	return (
		<article className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft">
			<div className="flex flex-wrap items-center gap-2.5">
				<h3 className="font-mono text-base font-bold text-ink-900">{server.name}</h3>
				<span className="rounded-full border border-ink-200 bg-ink-50 px-2.5 py-0.5 font-mono text-xs text-ink-700">
					{server.transport === "stdio" ? t("mcp.transport.stdio") : t("mcp.transport.http")}
				</span>
				<span className="rounded-full border border-ink-200 bg-ink-50 px-2.5 py-0.5 text-xs text-ink-600">
					{server.exposure === "direct" ? t("mcp.exposure.direct") : t("mcp.exposure.auto")}
				</span>
				<span
					className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${status.className}`}
				>
					<Icon name={status.icon} size={12} className={status.spin ? "animate-spin" : undefined} />
					{t(status.label)}
				</span>
				{oauthRelevant && server.oauth.signedIn && (
					<span className="inline-flex items-center gap-1 rounded-full border border-tianyi-200 bg-tianyi-50 px-2.5 py-0.5 text-xs text-tianyi-800">
						<Icon name="key" size={11} />
						{t("mcp.oauth.signedIn")}
					</span>
				)}
				<label className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-full border border-sakura-200 px-3 py-1 text-xs text-ink-700">
					<input
						type="checkbox"
						aria-label={t("mcp.enableAria", { name: server.name })}
						checked={server.enabled}
						disabled={disabled}
						onChange={(e) => props.onToggle(e.target.checked)}
					/>
					{t("credential.enable")}
				</label>
			</div>

			<p className="mt-2 truncate font-mono text-xs text-ink-500" title={targetSummary}>
				{targetSummary}
			</p>
			{server.config.description && <p className="mt-1.5 text-sm text-ink-600">{server.config.description}</p>}

			{(server.error || failedSignInError) && (
				<div
					role="alert"
					className="mt-3 rounded-xl border border-sakura-300 bg-sakura-50 px-3.5 py-2.5 text-xs text-sakura-900"
				>
					{failedSignInError ?? server.error}
				</div>
			)}

			{server.stderrTail && (
				<details className="mt-3 rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-2">
					<summary className="cursor-pointer text-xs font-medium text-ink-700">{t("mcp.stderrTitle")}</summary>
					<pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-ink-700">
						{server.stderrTail}
					</pre>
				</details>
			)}

			{waitingSignIn && (
				<div className="mt-3.5 space-y-2.5 rounded-xl border border-tianyi-200 bg-tianyi-50/60 p-3.5">
					<div className="flex flex-wrap items-center gap-2.5">
						<span className="text-xs font-semibold text-tianyi-900">{t("mcp.oauth.waiting")}</span>
						<a
							href={waitingSignIn.authorizationUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="focus-neko rounded-full border border-tianyi-300 bg-surface px-3 py-1 text-xs font-medium text-tianyi-800 hover:bg-tianyi-100"
						>
							{t("mcp.oauth.openUrl")}
						</a>
						<button
							type="button"
							disabled={disabled}
							onClick={() => props.onCancelSignIn(waitingSignIn.id)}
							className={`${SECONDARY_BTN_SM} ml-auto`}
						>
							{t("mcp.oauth.cancel")}
						</button>
					</div>
					<label htmlFor={pasteId} className="block text-xs text-ink-600">
						{t("mcp.oauth.pasteLabel")}
					</label>
					<div className="flex flex-wrap gap-2">
						<input
							id={pasteId}
							type="url"
							disabled={disabled}
							value={pasteUrl}
							placeholder={t("mcp.oauth.pastePlaceholder")}
							onChange={(e) => setPasteUrl(e.target.value)}
							className="focus-neko min-w-0 flex-1 rounded-xl border border-sakura-200 bg-surface px-3 py-1.5 font-mono text-xs text-ink-900"
						/>
						<button
							type="button"
							disabled={disabled || !pasteUrl.trim()}
							onClick={() => {
								const url = pasteUrl.trim();
								if (!url) return;
								setPasteUrl("");
								props.onPasteSignIn(waitingSignIn.id, url);
							}}
							className={PRIMARY_BTN_SM}
						>
							{t("mcp.oauth.pasteSubmit")}
						</button>
					</div>
				</div>
			)}

			<div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-sakura-100 pt-3.5">
				<button
					type="button"
					aria-expanded={toolsOpen}
					onClick={() => setToolsOpen(!toolsOpen)}
					className="focus-neko inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-base px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-100"
				>
					<span>{t("mcp.toolsCount", { count: server.tools.length })}</span>
					<span aria-hidden>{toolsOpen ? "▾" : "▸"}</span>
				</button>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					{oauthRelevant &&
						!waitingSignIn &&
						(server.oauth.signedIn ? (
							<button type="button" disabled={disabled} onClick={props.onSignOut} className={SECONDARY_BTN_SM}>
								{t("mcp.oauth.signOut")}
							</button>
						) : (
							<button
								type="button"
								disabled={disabled || !server.enabled}
								onClick={props.onBeginSignIn}
								className={PRIMARY_BTN_SM}
							>
								<Icon name="key" size={12} />
								{t("mcp.oauth.signIn")}
							</button>
						))}
					<button
						type="button"
						disabled={disabled || !server.enabled}
						onClick={props.onReconnect}
						className={SECONDARY_BTN_SM}
					>
						{t("mcp.reconnect")}
					</button>
					<button type="button" disabled={disabled} onClick={props.onEdit} className={SECONDARY_BTN_SM}>
						{t("mcp.edit")}
					</button>
					<button
						type="button"
						disabled={disabled}
						onClick={props.onDelete}
						className="focus-neko inline-flex items-center justify-center rounded-full border border-sakura-200 bg-surface px-3 py-1.5 text-xs font-medium text-sakura-800 hover:bg-sakura-50 disabled:opacity-50"
					>
						{t("mcp.delete")}
					</button>
				</div>
			</div>

			{toolsOpen && (
				<div className="mt-3 rounded-xl border border-ink-200 bg-base p-3.5">
					{server.tools.length === 0 ? (
						<p className="text-xs text-ink-500">{t("mcp.toolsEmpty")}</p>
					) : (
						<ul className="space-y-2.5">
							{server.tools.map((tool) => (
								<li key={tool.registeredName} className="text-xs">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-mono font-semibold text-ink-900">{tool.name}</span>
										{tool.readOnly && (
											<span className="rounded-full bg-tianyi-50 px-2 py-0.5 text-[11px] text-tianyi-800">
												{t("mcp.toolReadOnly")}
											</span>
										)}
									</div>
									{tool.description && <p className="mt-0.5 text-xs text-ink-500">{tool.description}</p>}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</article>
	);
}

export function McpSettingsPanel(props: { state: NekoMcpState | null; ready: boolean; actions: McpSettingsActions }) {
	const { state, ready, actions } = props;
	const t = useT();
	const [tab, setTab] = useState<"servers" | "raw">("servers");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ level: "ok" | "error"; text: string } | null>(null);
	const [formDraft, setFormDraft] = useState<ServerFormDraft | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
	const [rawDraft, setRawDraft] = useState("");
	const [rawDirty, setRawDirty] = useState(false);
	const pending = useRef(false);

	useEffect(() => {
		if (state && !rawDirty) setRawDraft(state.rawJson);
	}, [state, rawDirty]);

	const disabled = busy || !ready || !state;

	async function run(work: () => Promise<unknown>, okText?: string) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setMessage(null);
		try {
			await work();
			if (okText) setMessage({ level: "ok", text: okText });
		} catch (error) {
			setMessage({ level: "error", text: t("mcp.actionFailed", { error: errMsg(error) }) });
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}

	if (!state) return <p className="text-sm text-ink-500">{t("common.loading")}</p>;

	return (
		<div className="space-y-5">
			{!ready && (
				<output className="block rounded-xl border border-sakura-200 bg-sakura-50 px-4 py-3 text-xs text-sakura-900">
					{t("mcp.offline")}
				</output>
			)}

			{state.configError && (
				<div
					role="alert"
					className="rounded-xl border border-sakura-400 bg-sakura-50 px-4 py-3 text-xs text-sakura-900"
				>
					{t("mcp.configError", { error: state.configError })}
				</div>
			)}

			{state.entryErrors.length > 0 && (
				<div
					role="alert"
					className="rounded-xl border border-sakura-300 bg-sakura-50 px-4 py-3 text-xs text-sakura-900"
				>
					<div className="font-semibold">{t("mcp.entryErrors")}</div>
					<ul className="mt-1.5 list-disc space-y-0.5 pl-4">
						{state.entryErrors.map((err) => (
							<li key={err}>{err}</li>
						))}
					</ul>
				</div>
			)}

			<div className="space-y-2.5">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div role="tablist" className="inline-flex rounded-full border border-sakura-200 bg-surface p-1 shadow-soft">
						<button
							type="button"
							role="tab"
							aria-selected={tab === "servers"}
							onClick={() => setTab("servers")}
							className={`focus-neko rounded-full px-4 py-1.5 text-sm font-medium ${
								tab === "servers" ? "bg-sakura-100 font-semibold text-sakura-900" : "text-ink-600 hover:text-ink-900"
							}`}
						>
							{t("mcp.tabs.servers")}
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab === "raw"}
							onClick={() => setTab("raw")}
							className={`focus-neko rounded-full px-4 py-1.5 text-sm font-medium ${
								tab === "raw" ? "bg-sakura-100 font-semibold text-sakura-900" : "text-ink-600 hover:text-ink-900"
							}`}
						>
							{t("mcp.tabs.raw")}
						</button>
					</div>
					<button type="button" disabled={disabled} onClick={() => setFormDraft(emptyDraft())} className={PRIMARY_BTN}>
						<Icon name="plus" size={14} />
						{t("mcp.addServer")}
					</button>
				</div>
				<p className="truncate font-mono text-xs text-ink-400" title={state.configPath}>
					{t("mcp.configPath", { path: state.configPath })}
				</p>
			</div>

			{message && (
				<output
					aria-live="polite"
					className={`block rounded-xl border px-4 py-3 text-xs ${
						message.level === "error"
							? "border-sakura-400 bg-sakura-50 text-sakura-900"
							: "border-tianyi-200 bg-tianyi-50 text-tianyi-900"
					}`}
				>
					{message.text}
				</output>
			)}

			{tab === "servers" ? (
				state.servers.length === 0 ? (
					<div className="rounded-2xl border border-sakura-200 bg-surface p-8 text-center text-sm text-ink-500 shadow-soft">
						{t("mcp.empty")}
					</div>
				) : (
					<div className="space-y-4">
						{state.servers.map((server) => (
							<ServerCard
								key={server.name}
								server={server}
								signIn={state.signIns.find((s) => s.server === server.name)}
								disabled={disabled}
								onToggle={(enabled) => void run(() => actions.setEnabled(server.name, enabled), t("mcp.saved"))}
								onReconnect={() => void run(() => actions.reconnect(server.name), t("mcp.reconnected"))}
								onEdit={() => setFormDraft(draftFromServer(server))}
								onDelete={() => setDeleteTarget(server.name)}
								onBeginSignIn={() =>
									void run(async () => {
										const result = await actions.beginSignIn(server.name);
										if (result.status === "redirect") {
											window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
										} else {
											setMessage({ level: "ok", text: t("mcp.oauth.authorized") });
										}
									})
								}
								onPasteSignIn={(id, redirectUrl) =>
									void run(() => actions.pasteSignIn(id, redirectUrl), t("mcp.oauth.authorized"))
								}
								onCancelSignIn={(id) => void run(() => actions.cancelSignIn(id))}
								onSignOut={() => void run(() => actions.signOut(server.name), t("mcp.oauth.signedOut"))}
							/>
						))}
					</div>
				)
			) : (
				<section className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft">
					<label htmlFor="mcp-raw-json" className="block text-sm font-semibold text-ink-800">
						{t("mcp.raw.label")}
					</label>
					<p className="mt-1 text-xs text-ink-500">{t("mcp.raw.hint", { syntax: "$" + "{VAR}" })}</p>
					<textarea
						id="mcp-raw-json"
						rows={14}
						disabled={disabled}
						value={rawDraft}
						onChange={(e) => {
							setRawDraft(e.target.value);
							setRawDirty(true);
						}}
						className="focus-neko mt-3.5 w-full rounded-xl border border-sakura-200 bg-base p-3.5 font-mono text-xs text-ink-900 disabled:opacity-60"
					/>
					<div className="mt-4 flex flex-wrap items-center gap-3">
						<button
							type="button"
							disabled={disabled || !rawDirty}
							onClick={() =>
								void run(async () => {
									await actions.saveRawConfig(rawDraft);
									setRawDirty(false);
								}, t("mcp.raw.saved"))
							}
							className={PRIMARY_BTN}
						>
							{t("mcp.raw.save")}
						</button>
						<button
							type="button"
							disabled={busy || !rawDirty}
							onClick={() => {
								setRawDraft(state.rawJson);
								setRawDirty(false);
								setMessage(null);
							}}
							className={SECONDARY_BTN}
						>
							{t("mcp.raw.reset")}
						</button>
					</div>
				</section>
			)}

			{formDraft && (
				<ServerFormModal
					draft={formDraft}
					disabled={disabled}
					onSave={async (name, config) => {
						await actions.upsertServer(name, config);
						setMessage({ level: "ok", text: t("mcp.saved") });
					}}
					onClose={() => setFormDraft(null)}
				/>
			)}

			{deleteTarget && (
				<Modal
					title={t("mcp.deleteConfirmTitle", { name: deleteTarget })}
					locked={busy}
					onClose={() => setDeleteTarget(null)}
				>
					<div className="confirm-body">
						<p className="text-sm text-ink-700">{t("mcp.deleteConfirmBody")}</p>
						<div className="actions">
							<button type="button" disabled={busy} onClick={() => setDeleteTarget(null)} className={SECONDARY_BTN}>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								disabled={disabled}
								onClick={() => {
									const name = deleteTarget;
									setDeleteTarget(null);
									void run(() => actions.removeServer(name), t("mcp.deleted"));
								}}
								className="btn-danger focus-neko rounded-full px-4 py-2 text-sm"
							>
								{t("mcp.deleteConfirm")}
							</button>
						</div>
					</div>
				</Modal>
			)}
		</div>
	);
}
