// 真机配对开发脚本（经 design D5 的 neko.mobile-admin；日常使用请走 Web 设置页，本脚本保留为开发工具）。
// 连接一个已运行的 gateway，经 neko.mobile-admin 启用移动入口并打印配对文本与 ASCII 二维码。
// 用法：node --conditions=neko-source scripts/mobile-dev-pair.ts --address <局域网 IPv4> [--port 8323] [--data-dir <数据目录>]

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import qrcode from "qrcode-generator";
import { DEFAULT_STORAGE_PATH } from "../packages/core/src/runtime.ts";
import { assertGatewayIdentity } from "../packages/gateway/src/client-session.ts";
import { createClientHost } from "../packages/gateway/src/link.ts";
import { NekoMobileAdmin } from "../packages/gateway/src/mobile/admin.ts";
import { MobileStore } from "../packages/gateway/src/mobile/store.ts";
import { readGatewayPortFile } from "../packages/gateway/src/port-file.ts";
import { createUnixLink } from "../packages/gateway/src/unix-link.ts";
import { createWsLink } from "../packages/gateway/src/ws-listener.ts";

const SERVER_ID_FILE = "gateway-server-id";

type ScriptOptions = {
	readonly address: string | undefined;
	readonly port: number | undefined;
	readonly dataDir: string;
	readonly serverId: string | undefined;
	readonly socketPath: string | undefined;
	readonly wsUrl: string | undefined;
	readonly help: boolean;
};

function parseArgs(argv: readonly string[]): ScriptOptions {
	let address: string | undefined;
	let port: number | undefined;
	let dataDir = dirname(DEFAULT_STORAGE_PATH);
	let serverId: string | undefined;
	let socketPath: string | undefined;
	let wsUrl: string | undefined;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = argv[index + 1];
		switch (arg) {
			case "--help":
			case "-h":
				help = true;
				break;
			case "--address":
				address = requireValue(arg, next);
				index += 1;
				break;
			case "--port":
				port = Number(requireValue(arg, next));
				index += 1;
				break;
			case "--data-dir":
				dataDir = requireValue(arg, next);
				index += 1;
				break;
			case "--server-id":
				serverId = requireValue(arg, next);
				index += 1;
				break;
			case "--socket":
				socketPath = requireValue(arg, next);
				index += 1;
				break;
			case "--ws":
				wsUrl = requireValue(arg, next);
				index += 1;
				break;
			default:
				throw new Error(`未知参数：${arg ?? ""}（--help 查看用法）`);
		}
	}
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535))
		throw new Error(`--port 必须是 1-65535 的整数，收到 ${port}`);
	return { address, port, dataDir, serverId, socketPath, wsUrl, help };
}

function requireValue(flag: string | undefined, value: string | undefined): string {
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} 需要一个值`);
	return value;
}

function printUsage(): void {
	console.log(`用法：node --conditions=neko-source scripts/mobile-dev-pair.ts --address <局域网 IPv4> [选项]

选项：
  --address <ipv4>   要监听的网卡地址（必填，例如 192.168.1.20）
  --port <n>         移动入口端口（默认 8323）
  --data-dir <path>  gateway 数据目录（默认 ${dirname(DEFAULT_STORAGE_PATH)}）
  --server-id <id>   覆盖 serverId（默认读取数据目录身份文件）
  --socket <path>    覆盖 Unix socket 路径（POSIX）
  --ws <url>         覆盖本机 WS 地址（Windows 默认读端口文件）`);
}

export function renderPairingQr(pairingText: string): string {
	const qr = qrcode(0, "M");
	qr.addData(pairingText, "Byte");
	qr.make();
	const quiet = 2;
	const count = qr.getModuleCount();
	const dark = "██";
	const light = "  ";
	const lines: string[] = [];
	for (let row = -quiet; row < count + quiet; row += 1) {
		let line = "";
		for (let column = -quiet; column < count + quiet; column += 1) {
			const filled = row >= 0 && row < count && column >= 0 && column < count && qr.isDark(row, column);
			line += filled ? dark : light;
		}
		lines.push(line);
	}
	return lines.join("\n");
}

async function readServerId(dataDir: string): Promise<string> {
	try {
		const existing = (await readFile(join(dataDir, SERVER_ID_FILE), "utf8")).trim();
		if (existing !== "") return existing;
	} catch {
		// 落在下方统一提示。
	}
	throw new Error(
		`数据目录 ${dataDir} 中还没有 gateway 身份文件（${SERVER_ID_FILE}）。请先正常运行一次电脑端（如 pnpm neko serve），再执行本脚本。`,
	);
}

async function connectGatewayLink(options: ScriptOptions & { readonly serverId: string }) {
	if (options.wsUrl !== undefined) return createWsLink(options.wsUrl);
	if (options.socketPath !== undefined) return createUnixLink(options.socketPath);
	if (process.platform === "win32") {
		const discovered = await readGatewayPortFile(options.dataDir, options.serverId);
		if (discovered === undefined)
			throw new Error(
				`未发现 ${options.serverId}.port 端口文件；请先启动 gateway（neko serve / neko web）或用 --ws 指定地址。`,
			);
		return createWsLink(discovered);
	}
	const socketPath = join(options.dataDir, `${options.serverId}.sock`);
	try {
		return await createUnixLink(socketPath);
	} catch {
		throw new Error(
			`无法连接 gateway Unix socket：${socketPath}\n请先启动电脑端（如 pnpm neko serve），且不要在本脚本内重复启动第二个实例。`,
		);
	}
}

export async function main(argv: readonly string[]): Promise<void> {
	const options = parseArgs(argv);
	if (options.help) {
		printUsage();
		return;
	}
	if (options.address === undefined) {
		printUsage();
		throw new Error("缺少 --address：请指定手机可访问的本机局域网 IPv4（如 192.168.1.20）。");
	}

	const serverId = options.serverId ?? (await readServerId(options.dataDir));
	// 与 gateway 共用同一 admin-token 文件：缺失时在本机安全生成（0600，32 字节随机），绝不打印。
	const token = await (await MobileStore.open(options.dataDir)).ensureAdminToken();
	const link = await connectGatewayLink({ ...options, serverId });
	const host = createClientHost(link);
	try {
		await assertGatewayIdentity(host, serverId);
		const admin = await host.get(NekoMobileAdmin, { token });
		try {
			const state = await admin.enable({ address: options.address, port: options.port });
			const { pairingText, expiresAt } = await admin.createPairing(null);
			console.log(`移动入口已监听：https://${state.address}:${state.port}`);
			console.log(`配对信息将在 ${new Date(expiresAt).toLocaleString()} 过期，刷新请重跑本脚本。`);
			console.log();
			console.log("配对文本（可复制）：");
			console.log(pairingText);
			console.log();
			console.log(renderPairingQr(pairingText));
		} finally {
			admin.release();
		}
	} finally {
		await host.close().catch(() => undefined);
		link.close("done");
	}
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
