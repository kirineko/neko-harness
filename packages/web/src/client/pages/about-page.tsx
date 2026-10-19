import { RUNNING_VERSION } from "@neko-harness/core/application-version";
import { useState } from "react";
import { reloadForUpgrade } from "../components/composer";
import { SettingsShell } from "../components/settings-shell";
import { copyUpdateCommand, useUpdateAction } from "../components/update-notice";
import { appActions } from "../lib/bootstrap";
import { shellRow } from "../lib/shell-status";
import { useNekoState } from "../lib/store";
import { readUpgradeDraft } from "../lib/upgrade-draft";

export function AboutPage() {
	const { updates, webInfo, phase, shell } = useNekoState();
	const shellInfo = shellRow(shell);
	const action = useUpdateAction();
	const [checking, setChecking] = useState(false);
	const [message, setMessage] = useState("");
	const recovery = readUpgradeDraft();

	async function check() {
		if (checking) return;
		setChecking(true);
		setMessage("");
		try {
			const value = await appActions.checkUpdates();
			setMessage(
				value.checkState === "ok"
					? "检查完成"
					: value.checkState === "development"
						? "开发版本不检查发布更新"
						: "检查失败，请重试",
			);
		} catch {
			setMessage("检查失败，请重试");
		} finally {
			setChecking(false);
		}
	}

	const statusBadge = () => {
		if (checking) return <span className="rounded-full bg-ink-100 px-2.5 py-0.5 text-xs text-ink-600">检查中…</span>;
		if (action === "incompatible")
			return (
				<span className="rounded-full bg-sakura-100 px-2.5 py-0.5 text-xs font-semibold text-sakura-800">
					协议不兼容
				</span>
			);
		if (action === "install")
			return (
				<span className="rounded-full bg-sakura-100 px-2.5 py-0.5 text-xs font-semibold text-sakura-800">
					发现新版本
				</span>
			);
		if (action === "restart-service")
			return (
				<span className="rounded-full bg-tianyi-100 px-2.5 py-0.5 text-xs font-semibold text-tianyi-800">
					已就绪 · 待重启
				</span>
			);
		if (action === "refresh-page")
			return (
				<span className="rounded-full bg-tianyi-100 px-2.5 py-0.5 text-xs font-semibold text-tianyi-800">
					页面待更新
				</span>
			);
		if (updates?.checkState === "development")
			return <span className="rounded-full bg-ink-100 px-2.5 py-0.5 text-xs text-ink-600">开发版本</span>;
		if (updates?.checkState === "failed")
			return <span className="rounded-full bg-sakura-100 px-2.5 py-0.5 text-xs text-sakura-800">检查失败</span>;
		return (
			<span className="rounded-full bg-tianyi-50 px-2.5 py-0.5 text-xs font-medium text-tianyi-800">已是最新</span>
		);
	};

	return (
		<SettingsShell active="about">
			<div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-3">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h1 className="text-xl font-bold text-ink-900">关于与更新</h1>
					<span className="ml-auto text-xs text-ink-500">{phase === "ready" ? "已连接" : "连接中…"}</span>
				</div>
				<p className="mt-1 text-sm text-ink-500">查看 neko 系统版本状态及软件更新。</p>
			</div>

			<main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-5 pb-8">
				<section className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft">
					<h2 className="mb-4 text-base font-bold text-ink-900">版本状态</h2>
					<div className="flex flex-col divide-y divide-sakura-100">
						<div className="flex items-center justify-between py-3">
							<div>
								<span className="text-sm font-medium text-ink-800">当前版本</span>
								<span className="ml-3 font-mono text-sm text-ink-600">{RUNNING_VERSION}</span>
							</div>
							<div>{statusBadge()}</div>
						</div>

						{/* 条件目标版本：仅在存在更新或待重启差异时显式插入 */}
						{action === "install" && updates?.latestVersion && (
							<div className="mt-1 flex items-center justify-between rounded-xl bg-sakura-50/60 px-3 py-3">
								<div>
									<span className="text-sm font-semibold text-sakura-800">最新稳定版</span>
									<span className="ml-3 font-mono text-sm text-sakura-900">{updates.latestVersion}</span>
								</div>
								<span className="text-xs text-sakura-700">可运行 neko update 升级</span>
							</div>
						)}

						{action === "restart-service" && (
							<div className="mt-1 flex items-center justify-between rounded-xl bg-tianyi-50/60 px-3 py-3">
								<div>
									<span className="text-sm font-semibold text-tianyi-800">已安装新版本</span>
									<span className="ml-3 font-mono text-sm text-tianyi-900">
										{updates?.installedVersion ?? webInfo?.installedVersion ?? "新版本"}
									</span>
								</div>
								<span className="text-xs text-tianyi-700">重启 neko 进程后生效</span>
							</div>
						)}

						{action === "refresh-page" && (
							<div className="mt-1 flex items-center justify-between rounded-xl bg-tianyi-50/60 px-3 py-3">
								<div>
									<span className="text-sm font-semibold text-tianyi-800">静态服务已更新</span>
									<span className="ml-3 font-mono text-sm text-tianyi-900">{webInfo?.webVersion ?? "新版本"}</span>
								</div>
								<span className="text-xs text-tianyi-700">刷新页面后生效</span>
							</div>
						)}
					</div>

					<div className="mt-4 flex flex-wrap items-center gap-3">
						<button
							type="button"
							className="focus-neko rounded-full bg-sakura-100 px-4 py-1.5 text-sm font-semibold text-sakura-800 disabled:opacity-50"
							disabled={checking}
							onClick={() => void check()}
						>
							{checking ? "检查中…" : "检查更新"}
						</button>
						{action === "install" ? (
							<button
								type="button"
								className="focus-neko rounded-full bg-sakura-100 px-4 py-1.5 text-sm font-semibold text-sakura-800"
								onClick={() => void copyUpdateCommand().then(setMessage)}
							>
								复制 neko update
							</button>
						) : (
							<button
								type="button"
								className="focus-neko rounded-full border border-sakura-200 bg-surface px-4 py-1.5 text-sm text-ink-600 hover:bg-sakura-50"
								onClick={() => void copyUpdateCommand().then(setMessage)}
							>
								复制 neko update
							</button>
						)}
						{action === "refresh-page" && (
							<button
								type="button"
								className="focus-neko rounded-full bg-tianyi-100 px-4 py-1.5 text-sm font-semibold text-tianyi-800"
								onClick={reloadForUpgrade}
							>
								刷新页面
							</button>
						)}
					</div>
					{message && <output className="mt-3 block text-xs text-tianyi-800">{message}</output>}
				</section>

				{shellInfo && (
					<section className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft" data-shell-status>
						<h2 className="mb-3 text-base font-bold text-ink-900">命令 shell</h2>
						<div className="flex flex-wrap items-center gap-3">
							<span
								className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
									shellInfo.tone === "ok" ? "bg-tianyi-50 text-tianyi-800" : "bg-sakura-100 text-sakura-800"
								}`}
							>
								{shellInfo.label}
							</span>
							<span className="min-w-0 break-all text-sm text-ink-600">{shellInfo.detail}</span>
						</div>
					</section>
				)}

				<section className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft">
					<h2 className="mb-2 text-base font-bold text-ink-900">升级说明</h2>
					<p className="text-sm text-ink-600">
						在终端运行{" "}
						<code className="select-all rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs text-ink-800">
							neko update
						</code>
						，完成后重启 neko 即可生效。
					</p>
					{recovery?.text && (
						<details className="mt-4 border-t border-sakura-100 pt-3 text-sm">
							<summary className="focus-neko cursor-pointer font-medium text-ink-700">升级前保留的草稿</summary>
							<p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-ink-50 p-3 font-mono text-xs text-ink-600 select-text">
								{recovery.text}
							</p>
						</details>
					)}
				</section>
			</main>
		</SettingsShell>
	);
}
