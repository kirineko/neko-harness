import qrcode from "qrcode-generator";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDate, formatDateTime } from "../lib/i18n/format.ts";
import { useLanguage, useT } from "../lib/i18n/index.ts";
import { type MobileAdminState, type MobilePairing as MobilePairingInfo, mobileAdmin } from "../lib/mobile-admin";
import { useNekoState } from "../lib/store";
import { CopyButton } from "./copy-button";
import { Icon, Modal } from "./primitives";

const CERT_EXPIRY_WARN_MS = 30 * 24 * 60 * 60 * 1000;
/** 设置页打开期间刷新设备在线/入口状态的轮询间隔。 */
const ADMIN_POLL_INTERVAL_MS = 5_000;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function QrCode(props: { text: string }) {
	const t = useT();
	const qr = qrcode(0, "M");
	qr.addData(props.text, "Byte");
	qr.make();
	const count = qr.getModuleCount();
	const quiet = 2;
	const total = count + quiet * 2;
	const cells: string[] = [];
	for (let row = 0; row < count; row += 1) {
		for (let column = 0; column < count; column += 1) {
			if (qr.isDark(row, column)) cells.push(`M${column + quiet} ${row + quiet}h1v1h-1z`);
		}
	}
	return (
		<svg
			role="img"
			viewBox={`0 0 ${total} ${total}`}
			shapeRendering="crispEdges"
			className="h-44 w-44 rounded-xl bg-white p-2 text-ink-900"
		>
			<title>{t("pairing.qrTitle")}</title>
			<path d={cells.join(" ")} fill="currentColor" />
		</svg>
	);
}

export function MobilePairing() {
	const { webInfo } = useNekoState();
	const t = useT();
	const language = useLanguage();
	const [supported, setSupported] = useState<boolean | null>(null);
	const [data, setData] = useState<MobileAdminState | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [address, setAddress] = useState("");
	const [port, setPort] = useState("8323");
	const [busy, setBusy] = useState(false);
	const [pairing, setPairing] = useState<MobilePairingInfo | null>(null);
	const [remaining, setRemaining] = useState(0);
	const [confirm, setConfirm] = useState<"regenerate" | { deviceId: string; name: string } | null>(null);
	const seq = useRef(0);

	const refresh = useCallback(async () => {
		const mine = ++seq.current;
		try {
			const next = await mobileAdmin.state();
			if (mine !== seq.current) return;
			setData(next);
			setError("");
			setAddress((current) => (current === "" ? (next.candidates[0] ?? "") : current));
			setPort(String(next.port));
		} catch (refreshError) {
			if (mine === seq.current) setError(messageOf(refreshError));
		}
	}, []);

	// 静默轮询：只刷新数据不动地址/端口输入；失败保留已展示的真实状态。
	const poll = useCallback(async () => {
		if (document.hidden) return;
		const mine = ++seq.current;
		try {
			const next = await mobileAdmin.state();
			if (mine !== seq.current) return;
			setData(next);
			setError("");
		} catch {
			// 轮询失败不清空设备列表与入口状态。
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		mobileAdmin
			.session()
			.then((session) => {
				if (cancelled) return;
				setSupported(session.supported);
				if (session.supported) void refresh();
			})
			.catch((sessionError: unknown) => {
				if (!cancelled) setError(messageOf(sessionError));
			});
		return () => {
			cancelled = true;
		};
	}, [refresh]);

	// 设置页打开期间轮询在线状态；页面隐藏时暂停、重新可见时立即补一次。
	useEffect(() => {
		if (supported !== true) return;
		let timer: ReturnType<typeof setInterval> | undefined;
		const stop = () => {
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
		};
		const start = () => {
			if (timer === undefined) timer = setInterval(() => void poll(), ADMIN_POLL_INTERVAL_MS);
		};
		const onVisibilityChange = () => {
			if (document.hidden) {
				stop();
			} else {
				void poll();
				start();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		start();
		return () => {
			stop();
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [supported, poll]);

	useEffect(() => {
		if (pairing === null) return;
		const update = () => setRemaining(Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000)));
		update();
		const timer = setInterval(update, 1000);
		return () => clearInterval(timer);
	}, [pairing]);

	const listening = data?.state.status === "listening";
	const liveAddress = listening ? `${data.state.address}:${data.state.port}` : "";

	async function toggle() {
		if (data === null || busy) return;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			if (listening) {
				await mobileAdmin.disable();
				setPairing(null);
				setNotice(t("pairing.disabledNotice"));
			} else {
				const parsed = Number(port);
				if (address.trim() === "") throw new Error(t("pairing.addressRequired"));
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(t("pairing.portInvalid"));
				await mobileAdmin.enable({ address: address.trim(), port: parsed });
				setNotice(t("pairing.enabledNotice", { address: `${address.trim()}:${parsed}` }));
			}
			await refresh();
		} catch (actionError) {
			setError(messageOf(actionError));
		} finally {
			setBusy(false);
		}
	}

	async function generateQr() {
		setBusy(true);
		setError("");
		try {
			const next = await mobileAdmin.createPairing();
			setPairing(next);
			setNotice(t("pairing.qrGenerated"));
		} catch (pairingError) {
			setPairing(null);
			setError(messageOf(pairingError));
		} finally {
			setBusy(false);
		}
	}

	async function confirmRegenerate() {
		setConfirm(null);
		setBusy(true);
		setError("");
		try {
			const rotated = await mobileAdmin.regenerateCertificate();
			setPairing(null);
			setNotice(t("pairing.certRotated", { fingerprint: rotated.fingerprint.slice(0, 12) }));
			await refresh();
		} catch (rotateError) {
			setError(messageOf(rotateError));
		} finally {
			setBusy(false);
		}
	}

	async function confirmRevoke(deviceId: string) {
		setConfirm(null);
		setBusy(true);
		setError("");
		try {
			const result = await mobileAdmin.revoke(deviceId);
			setNotice(result.revoked ? t("pairing.revoked") : t("pairing.revokeMissing"));
			await refresh();
		} catch (revokeError) {
			setError(messageOf(revokeError));
		} finally {
			setBusy(false);
		}
	}

	if (supported === null) {
		return (
			<section className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft">
				<h2 className="text-base font-bold text-ink-900">{t("settings.mobile.title")}</h2>
				<p className="mt-2 text-sm text-ink-500">{t("common.loading")}</p>
			</section>
		);
	}
	if (!supported) {
		return (
			<section className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft">
				<h2 className="text-base font-bold text-ink-900">{t("settings.mobile.title")}</h2>
				<p className="mt-2 text-sm text-ink-600" role="alert">
					{t("pairing.unsupported")}
				</p>
			</section>
		);
	}

	const certificate = data?.certificate ?? null;
	const certificateWarning = certificate !== null && certificate.expiresAt - Date.now() < CERT_EXPIRY_WARN_MS;
	const wsl = data?.wsl ?? null;
	const relayed = data?.state.status === "listening" && data.state.mode === "wsl-relay";
	const stateLine =
		data === null
			? t("common.loading")
			: data.state.status === "listening"
				? t("pairing.stateOn", { address: liveAddress, relay: relayed ? t("pairing.relayed") : "" })
				: data.state.status === "error"
					? t("pairing.stateError")
					: data.state.status === "disabled"
						? t("pairing.stateOff")
						: t("credential.working");

	return (
		<section className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-base font-bold text-ink-900">{t("settings.mobile.title")}</h2>
				<span className="rounded-full bg-tianyi-50 px-3 py-1 text-xs text-tianyi-800">{stateLine}</span>
			</div>
			<p className="mb-3 text-xs text-ink-500">{t("pairing.intro")}</p>

			{wsl !== null && (
				<p className="mb-3 rounded-xl bg-tianyi-50 px-3 py-2 text-xs text-tianyi-800">{t("pairing.wslNote")}</p>
			)}
			{wsl?.error != null && (
				<p className="mb-3 rounded-xl bg-sakura-50 px-3 py-2 text-xs text-sakura-800" role="alert">
					{wsl.error}
				</p>
			)}
			{data?.state.status === "error" && (
				<p className="mb-3 rounded-xl bg-sakura-50 px-3 py-2 text-xs text-sakura-800" role="alert">
					{t("pairing.startFailed", { error: data.state.error })}
				</p>
			)}
			{error !== "" && (
				<p className="mb-3 rounded-xl bg-sakura-50 px-3 py-2 text-xs text-sakura-800" role="alert">
					{error}
				</p>
			)}

			<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
				<label className="inline-flex min-h-6 items-center gap-2 text-sm text-ink-700">
					<input
						type="checkbox"
						checked={listening === true}
						disabled={busy || data === null || (!listening && (data?.candidates.length ?? 0) === 0 && address === "")}
						onChange={() => void toggle()}
						className="focus-neko h-4 w-4 rounded border-sakura-300 accent-sakura-600"
					/>
					{t("pairing.allow")}
				</label>
				<label className="inline-flex min-h-6 items-center gap-2 text-sm text-ink-700">
					{t("pairing.address")}
					<select
						value={address}
						disabled={busy || listening === true}
						onChange={(event) => setAddress(event.target.value)}
						className="focus-neko rounded-xl border border-sakura-200 bg-base px-2 py-1.5 text-sm"
					>
						{data?.candidates.length === 0 && (
							<option value="">{wsl !== null ? t("pairing.noAddressWindows") : t("pairing.noAddress")}</option>
						)}
						{(data?.candidates ?? []).map((candidate) => (
							<option key={candidate} value={candidate}>
								{candidate === data?.lastConnectedAddress
									? t("pairing.lastConnected", { address: candidate })
									: candidate}
							</option>
						))}
					</select>
				</label>
				<label className="inline-flex min-h-6 items-center gap-2 text-sm text-ink-700" htmlFor="mobile-port">
					{t("pairing.port")}
					<input
						id="mobile-port"
						type="number"
						min={1}
						max={65535}
						value={port}
						disabled={busy || listening === true}
						onChange={(event) => setPort(event.target.value)}
						className="focus-neko w-24 rounded-xl border border-sakura-200 bg-base px-2 py-1.5 text-sm"
					/>
				</label>
			</div>
			{listening !== true && (data?.candidates.length ?? 0) === 0 && (
				<p className="mt-2 text-xs text-ink-500">
					{wsl !== null ? t("pairing.noUsableWindows") : t("pairing.noUsable")}
				</p>
			)}

			{listening === true && (
				<div className="mt-4 border-t border-sakura-100 pt-4">
					<div className="flex flex-wrap items-center gap-4">
						{pairing !== null && remaining > 0 ? (
							<div className="flex items-start gap-3">
								<QrCode text={pairing.pairingText} />
								<div className="flex flex-col items-start gap-2">
									<span className="text-xs text-ink-500">{t("pairing.qrRemaining", { seconds: remaining })}</span>
									<CopyButton text={pairing.pairingText} label={t("pairing.copyText")} />
									<button
										type="button"
										disabled={busy}
										onClick={() => void generateQr()}
										className="focus-neko rounded-full bg-sakura-100 px-4 py-1.5 text-sm font-semibold text-sakura-800 disabled:opacity-50"
									>
										{t("pairing.refreshQr")}
									</button>
								</div>
							</div>
						) : (
							<div className="flex flex-col items-start gap-2">
								{pairing !== null && remaining <= 0 && (
									<span className="text-xs text-ink-500">{t("pairing.qrExpired")}</span>
								)}
								<button
									type="button"
									disabled={busy}
									onClick={() => void generateQr()}
									className="focus-neko rounded-full bg-sakura-100 px-4 py-1.5 text-sm font-semibold text-sakura-800 disabled:opacity-50"
								>
									{t("pairing.generateQr")}
								</button>
							</div>
						)}
						<p className="max-w-64 text-xs text-ink-500">
							{t("pairing.scanHint", { relay: relayed ? t("pairing.relayFirewall") : "" })}
						</p>
					</div>
				</div>
			)}

			<div className="mt-4 border-t border-sakura-100 pt-4">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="text-sm font-semibold text-ink-800">{t("pairing.certificate")}</h3>
					{certificate !== null && (
						<span className="text-xs text-ink-500">
							{t("pairing.certInfo", {
								fingerprint: certificate.fingerprint.slice(0, 16),
								date: formatDate(certificate.expiresAt, language),
							})}
						</span>
					)}
					<button
						type="button"
						disabled={busy}
						onClick={() => setConfirm("regenerate")}
						className="focus-neko ml-auto rounded-full px-3 py-1.5 text-sm text-ink-500 disabled:opacity-50"
					>
						{t("pairing.regenerate")}
					</button>
				</div>
				{certificateWarning && (
					<p className="mt-2 text-xs text-sakura-800" role="alert">
						{t("pairing.certExpiring")}
					</p>
				)}
				<p className="mt-2 text-xs text-ink-500">{t("pairing.regenerateWarning")}</p>
			</div>

			<div className="mt-4 border-t border-sakura-100 pt-4">
				<h3 className="text-sm font-semibold text-ink-800">{t("pairing.devices")}</h3>
				{data === null || data.devices.length === 0 ? (
					<p className="mt-2 text-xs text-ink-500">{t("pairing.noDevices")}</p>
				) : (
					<ul className="mt-2 flex flex-col gap-2">
						{data.devices.map((device) => (
							<li key={device.deviceId} className="flex flex-wrap items-center gap-2 text-sm">
								<span aria-hidden="true" className="inline-flex">
									<Icon name="phone" size={15} className="text-ink-400" />
								</span>
								<span className="text-ink-800">{device.name}</span>
								<span
									className={`rounded-full px-2 py-0.5 text-xs ${device.online ? "bg-tianyi-50 text-tianyi-800" : "bg-ink-100 text-ink-500"}`}
								>
									{device.online ? t("pairing.online") : t("pairing.offline")}
								</span>
								<span className="text-xs text-ink-500">
									{t("pairing.lastSeen", { time: formatDateTime(device.lastSeenAt, language) })}
								</span>
								<button
									type="button"
									disabled={busy}
									onClick={() => setConfirm({ deviceId: device.deviceId, name: device.name })}
									className="focus-neko ml-auto rounded-full px-3 py-1.5 text-sm text-sakura-800 disabled:opacity-50"
								>
									{t("pairing.revoke")}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{webInfo?.gatewaySpawned === true && (
				<p className="mt-4 rounded-xl bg-tianyi-50 px-3 py-2 text-xs text-tianyi-800">
					{t("pairing.spawnedBefore")}
					<code className="mx-1">neko serve</code>
					{t("pairing.spawnedAfter")}
				</p>
			)}

			<output className="mt-3 block min-h-4 text-xs text-tianyi-800" aria-live="polite">
				{notice}
			</output>

			{confirm === "regenerate" && (
				<Modal title={t("pairing.regenerate")} onClose={() => setConfirm(null)}>
					<p className="text-sm text-ink-700">{t("pairing.regenerateConfirm")}</p>
					<div className="mt-4 flex justify-end gap-2">
						<button
							type="button"
							className="focus-neko rounded-full px-4 py-1.5 text-sm text-ink-500"
							onClick={() => setConfirm(null)}
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							className="focus-neko rounded-full bg-sakura-100 px-4 py-1.5 text-sm font-semibold text-sakura-800"
							onClick={() => void confirmRegenerate()}
						>
							{t("pairing.confirmRegenerate")}
						</button>
					</div>
				</Modal>
			)}
			{typeof confirm === "object" && confirm !== null && (
				<Modal title={t("pairing.revokeTitle", { name: confirm.name })} onClose={() => setConfirm(null)}>
					<p className="text-sm text-ink-700">{t("pairing.revokeConfirm")}</p>
					<div className="mt-4 flex justify-end gap-2">
						<button
							type="button"
							className="focus-neko rounded-full px-4 py-1.5 text-sm text-ink-500"
							onClick={() => setConfirm(null)}
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							className="focus-neko rounded-full bg-sakura-100 px-4 py-1.5 text-sm font-semibold text-sakura-800"
							onClick={() => void confirmRevoke(confirm.deviceId)}
						>
							{t("pairing.confirmRevoke")}
						</button>
					</div>
				</Modal>
			)}
		</section>
	);
}
