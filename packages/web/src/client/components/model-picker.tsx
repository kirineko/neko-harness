import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { NekoModelRef, NekoSelectableModel } from "@neko-harness/core";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import { type Translate, useT } from "../lib/i18n/index.ts";
import {
	describeModel,
	formatContextWindow,
	groupModels,
	isDefaultModel,
	type ProviderOption,
	providerIssue,
	providerName,
	resolveProviderId,
} from "../lib/providers";
import { useNekoState } from "../lib/store";
import { Modal } from "./primitives";
import { ProviderCombobox } from "./provider-combobox";

export function ModelPicker(props: { current: NekoModelRef | null; fallbackLabel: string }) {
	const t = useT();
	const { models, currentSessionId, view, phase, operating, defaultModel } = useNekoState();
	const [session, setSession] = useState<{ id: string } | null>(null);
	const current = models.find((m) => m.provider === props.current?.provider && m.modelId === props.current?.modelId);
	if (session && session.id !== currentSessionId) setSession(null);
	const label = current?.name ?? props.fallbackLabel;
	const isDefault = isDefaultModel(defaultModel, props.current);
	return (
		<>
			<button
				type="button"
				disabled={!props.current || phase !== "ready" || operating}
				onClick={() => currentSessionId && setSession({ id: currentSessionId })}
				className="focus-neko min-w-0 truncate rounded-full px-2 py-1 text-left text-xs text-ink-500 hover:bg-sakura-50"
				aria-label={t("picker.aria", { label, level: view?.agent.thinkingLevel ?? "" })}
			>
				{isDefault ? "★ " : ""}
				{label} · {view?.agent.thinkingLevel ?? "off"} ▾
			</button>
			{session && session.id === currentSessionId && props.current && (
				<ModelForm
					key={session.id}
					session={session.id}
					currentRef={props.current}
					current={current ?? null}
					level={view?.agent.thinkingLevel ?? "off"}
					onClose={() => setSession((active) => (active === session ? null : active))}
				/>
			)}
		</>
	);
}

function badges(model: NekoSelectableModel, t: Translate): string {
	return [
		formatContextWindow(model.contextWindow),
		model.input.includes("image") ? t("picker.badgeImage") : "",
		model.reasoning ? t("picker.badgeReasoning") : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function ModelForm(props: {
	session: string;
	currentRef: NekoModelRef;
	current: NekoSelectableModel | null;
	level: string;
	onClose: () => void;
}) {
	const t = useT();
	const { models, credentials, defaultModel } = useNekoState();
	const [selected, setSelected] = useState<NekoSelectableModel | null>(props.current);
	const [level, setLevel] = useState<ModelThinkingLevel>(props.level as ModelThinkingLevel);
	const [query, setQuery] = useState("");
	const [provider, setProvider] = useState<string | null>(props.currentRef.provider);
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	const [error, setError] = useState("");
	const allGroups = groupModels(models, "");
	const providerId = resolveProviderId(allGroups, provider ?? undefined);
	const providerOptions: ProviderOption[] = allGroups.map((group) => ({
		id: group.provider,
		name: group.name,
		detail: group.available ? t("picker.providerModels", { count: group.models.length }) : t("picker.keyMissing"),
		tone: group.available ? "on" : "warn",
	}));
	const searching = query.trim().length > 0;
	const visible = searching ? groupModels(models, query) : allGroups.filter((group) => group.provider === providerId);
	const issue = providerIssue(credentials, props.currentRef.provider);
	async function apply() {
		if (pending.current || !selected) return;
		pending.current = true;
		setBusy(true);
		setError("");
		try {
			await appActions.configure(
				{ model: { provider: selected.provider, modelId: selected.modelId }, thinkingLevel: level },
				props.session,
			);
			props.onClose();
		} catch {
			setError(t("picker.applyFailed"));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}
	/** 只影响新建会话：不调用 configure，当前会话模型不变。 */
	async function toggleDefault(model: NekoSelectableModel) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setError("");
		try {
			if (isDefaultModel(defaultModel, model)) await appActions.clearDefaultModel();
			else await appActions.setDefaultModel({ provider: model.provider, modelId: model.modelId });
		} catch {
			setError(t("picker.defaultFailed"));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}
	return (
		<Modal title={t("picker.title")} onClose={props.onClose}>
			<div className="space-y-5 p-5">
				{issue && (
					<p role="alert" className="rounded-xl bg-sakura-50 px-3 py-2 text-sm text-sakura-800">
						{issue === "disabled"
							? t("picker.issueDisabled", { provider: providerName(props.currentRef.provider) })
							: t("picker.issueKey", { provider: providerName(props.currentRef.provider) })}{" "}
						<Link
							to="/settings"
							hash={`credential-${props.currentRef.provider}`}
							className="focus-neko rounded underline"
						>
							{t("picker.goSettings")}
						</Link>
					</p>
				)}
				<div className="space-y-2">
					<div className="flex flex-col gap-2 sm:flex-row">
						<div className="min-w-0 sm:w-64 sm:shrink-0">
							<ProviderCombobox
								label={t("picker.providerLabel")}
								options={providerOptions}
								value={providerId}
								onChange={(id) => {
									setProvider(id);
									setQuery("");
								}}
							/>
						</div>
						<label className="sr-only" htmlFor="model-search">
							{t("picker.searchLabel")}
						</label>
						<input
							id="model-search"
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("picker.searchPlaceholder")}
							autoComplete="off"
							spellCheck={false}
							className="focus-neko w-full min-w-0 rounded-xl border border-sakura-200 bg-base px-3 py-2 text-sm"
						/>
					</div>
					<fieldset
						aria-label={t("picker.models")}
						className="m-0 min-w-0 max-h-[min(40vh,22rem)] space-y-1 overflow-y-auto border-0 p-0 pr-1"
					>
						{visible.map((group) => (
							<section key={group.provider} id={`models-${group.provider}`}>
								{(searching || !group.available) && (
									<div className="flex items-center gap-2 px-1 pt-1 pb-0.5 text-xs">
										{searching && <span className="truncate font-semibold text-ink-700">{group.name}</span>}
										{!group.available && (
											<span className="ml-auto shrink-0 text-sakura-800">
												{t("picker.keyMissingDot")}{" "}
												<Link
													to="/settings"
													hash={`credential-${group.provider}`}
													className="focus-neko rounded underline"
												>
													{t("picker.configure")}
												</Link>
											</span>
										)}
									</div>
								)}
								<ul className="space-y-1">
									{group.models.map((model) => {
										const chosen = selected?.provider === model.provider && selected.modelId === model.modelId;
										const fallback = isDefaultModel(defaultModel, model);
										return (
											<li key={`${model.provider}/${model.modelId}`} className="flex items-stretch gap-1">
												<button
													type="button"
													disabled={busy || !group.available}
													aria-pressed={chosen}
													title={`${model.modelId} · ${describeModel(model)}`}
													onClick={() => {
														setSelected(model);
														setLevel(model.thinkingLevelAdjustments[level]);
													}}
													className={`focus-neko flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-sm disabled:opacity-50 ${chosen ? "border-sakura-300 bg-sakura-50 text-sakura-800" : "border-sakura-100 bg-surface text-ink-700"}`}
												>
													<span className="min-w-0 truncate">
														{fallback ? "★ " : ""}
														{model.name}
														{chosen ? " ✓" : ""}
													</span>
													<span className="hidden min-w-0 flex-1 truncate text-xs text-ink-400 sm:inline">
														{model.modelId}
													</span>
													<span className="ml-auto shrink-0 text-xs text-ink-500">{badges(model, t)}</span>
												</button>
												{group.available && (
													<button
														type="button"
														disabled={busy}
														aria-pressed={fallback}
														aria-label={`${fallback ? t("picker.unsetDefault") : t("picker.setDefault")} ${model.name}`}
														title={fallback ? t("picker.unsetDefaultTitle") : t("picker.setDefaultTitle")}
														onClick={() => void toggleDefault(model)}
														className="focus-neko shrink-0 rounded-lg border border-sakura-100 px-2 text-sm text-ink-400 hover:bg-sakura-50 disabled:opacity-50"
													>
														<span aria-hidden="true">{fallback ? "★" : "☆"}</span>
													</button>
												)}
											</li>
										);
									})}
								</ul>
							</section>
						))}
						{visible.length === 0 && (
							<p className="px-1 py-3 text-sm text-ink-500">{searching ? t("picker.noMatch") : t("picker.noModels")}</p>
						)}
					</fieldset>
				</div>
				{selected && (
					<div>
						<p className="mb-2 text-sm text-ink-600">{t("picker.thinking")}</p>
						<fieldset className="flex flex-wrap gap-2" aria-label={t("picker.thinking")}>
							{selected.supportedThinkingLevels.map((item) => (
								<button
									type="button"
									key={item}
									disabled={busy}
									aria-pressed={level === item}
									onClick={() => setLevel(item)}
									className={`focus-neko rounded-full border px-4 py-2 text-sm ${item === level ? "border-tianyi-300 bg-tianyi-50 text-tianyi-800" : "border-sakura-200"}`}
								>
									{item}
								</button>
							))}
						</fieldset>
					</div>
				)}
				{defaultModel?.source === "cli" && <p className="text-xs text-tianyi-800">{t("picker.cliNote")}</p>}
				<p className="text-xs text-ink-500">{t("picker.scopeNote")}</p>
				{error && (
					<p role="alert" className="text-sm text-sakura-800">
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<button type="button" onClick={props.onClose} className="btn-outline rounded-full px-4 py-2 text-sm">
						{t("common.cancel")}
					</button>
					<button
						type="button"
						disabled={busy || !selected}
						onClick={() => void apply()}
						className="btn-primary rounded-full px-5 py-2 text-sm"
					>
						{busy ? t("picker.applying") : t("picker.apply")}
					</button>
				</div>
			</div>
		</Modal>
	);
}
