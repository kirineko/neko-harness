// 移动端真机回归用的隔离 gateway（开发工具，不进入发布产物）。
// 使用脚本化 faux provider（不访问外部模型），在独立数据目录中开启移动入口，
// 登记一个工作区，并把有效配对文本持续写入 <数据目录>/pairing.txt（每 90 s 刷新）。
// 用法：node --conditions=neko-source scripts/mobile-e2e-gateway.ts --address <局域网 IPv4> [--port 8324] [--dir <目录>]
//       [--serve-pairing 8325]：仅在 127.0.0.1 提供 GET /pairing（每次生成新配对码），配合
//       `adb reverse tcp:8325 tcp:8325` 供 integration_test 读取；不监听局域网。
//
// 指令（在手机发送的消息中包含关键字）：
//   「委派」→ 主会话调用子 agent，子 agent 执行需审批的 bash（echo neko-e2e-approved）
//   「待办」→ 主会话用 todo 工具写入 3 项待办（1 完成、1 进行中、1 待办）
//   「提问」→ 主会话调用 ask_user 提出单选题（选项 PostgreSQL 为推荐、MySQL、SQLite），等待手机/桌面回答
//   「多选」→ 主会话调用 ask_user 提出多选题（需要至少选一项或填写文字）
//   「慢」  → 回答前等待 8 s（用于忙碌排队、steer、停止与断线恢复）
//   「长」  → 返回超过 8 KiB 的回答（contentRef 展开）
//   其他    → 流式回答 "pong: <原文>"

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { connectNekoGateway, startGateway } from "../packages/gateway/src/index.ts";

type Message = { role: string; content: unknown; toolName?: string };

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function textOf(message: Message | undefined): string {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

const address = arg("--address");
if (address === undefined) {
	console.error("用法：node --conditions=neko-source scripts/mobile-e2e-gateway.ts --address <局域网 IPv4>");
	process.exit(2);
}
const port = Number(arg("--port") ?? 8324);
const dir = arg("--dir") ?? join(tmpdir(), "neko-mobile-e2e");
await mkdir(join(dir, "workspace"), { recursive: true });
const workspace = await realpath(join(dir, "workspace"));

const faux = fauxProvider({ tokensPerSecond: 60 });
const respond = async (context: { messages: Message[] }, options: { signal?: AbortSignal } | undefined) => {
	const messages = context.messages;
	const last = messages.at(-1);
	const firstUser = textOf(messages.find((message) => message.role === "user"));
	if (
		messages.some((message) => message.role === "system" && textOf(message).startsWith("Summarize the first question"))
	)
		return fauxAssistantMessage("E2E 会话");
	const isChild = firstUser.startsWith("检查命令");
	if (last?.role === "toolResult") {
		if (last.toolName === "bash") return fauxAssistantMessage(`子 agent 报告：${textOf(last).trim()}`);
		if (last.toolName === "subagent") return fauxAssistantMessage("主会话总结：子 agent 已完成。");
		if (last.toolName === "todo") return fauxAssistantMessage("待办已更新。");
		if (last.toolName === "ask_user")
			return fauxAssistantMessage(`提问结束：${textOf(last).replace(/\s+/g, " ").trim()}`);
		return fauxAssistantMessage("工具完成。");
	}
	const text = textOf(last);
	if (isChild) {
		return fauxAssistantMessage([fauxToolCall("bash", { command: "echo neko-e2e-approved", timeout: 60 })], {
			stopReason: "toolUse",
		});
	}
	if (text.includes("待办")) {
		return fauxAssistantMessage(
			[
				fauxToolCall("todo", {
					action: "replace",
					items: [
						{ id: "read", text: "阅读现有实现", status: "completed" },
						{ id: "design", text: "设计迁移步骤", status: "in_progress" },
						{ id: "verify", text: "运行回归测试", status: "pending" },
					],
				}),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (text.includes("提问") || text.includes("多选")) {
		return fauxAssistantMessage(
			[
				fauxToolCall("ask_user", {
					question: text.includes("多选") ? "需要哪些数据库？" : "使用哪种数据库？",
					...(text.includes("多选") ? { multiple: true } : {}),
					options: [
						{ id: "pg", label: "PostgreSQL", recommended: true },
						{ id: "my", label: "MySQL" },
						{ id: "lite", label: "SQLite", description: "嵌入式，无需服务" },
					],
				}),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (text.includes("委派")) {
		return fauxAssistantMessage(
			[fauxToolCall("subagent", { type: "explore", title: "检查命令", task: "检查命令：运行 echo" })],
			{ stopReason: "toolUse" },
		);
	}
	if (text.includes("慢")) {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 8_000);
			options?.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		return fauxAssistantMessage(options?.signal?.aborted ? "已中断" : `慢回答完成：${text}`, {
			stopReason: options?.signal?.aborted ? "aborted" : "stop",
		});
	}
	if (text.includes("长")) {
		return fauxAssistantMessage([
			fauxText(`长回答开始\n\n${"这是一段用于验证展开全文的长内容。".repeat(600)}\n\n长回答结束`),
		]);
	}
	return fauxAssistantMessage([fauxText(`pong: ${text}`)]);
};
faux.setResponses(Array.from({ length: 2000 }, () => respond as never));

const gateway = await startGateway({
	storage: "sqlite",
	storagePath: join(dir, "neko.sqlite"),
	socketPath: join(dir, "gateway.sock"),
	port: 0,
	mobileServerName: "E2E-Mac",
	model: { provider: "faux", modelId: "faux-1" },
	providers: [faux.provider],
	onError: (error) => console.error("[gateway]", error.message),
});
const desktop = await connectNekoGateway({
	transport: "unix",
	socketPath: join(dir, "gateway.sock"),
	serverId: gateway.serverId,
});
if (!(desktop.workspaces.state.value?.workspaces ?? []).some((entry) => entry.path === workspace))
	await desktop.workspaces.add({ path: workspace });
await gateway.mobile.enable({ address, port });

const refresh = async () => {
	const { pairingText, expiresAt } = gateway.mobile.createPairing();
	await writeFile(join(dir, "pairing.txt"), pairingText, { mode: 0o600 });
	console.log(`[pairing] 已刷新，${new Date(expiresAt).toLocaleTimeString()} 过期 → ${join(dir, "pairing.txt")}`);
};
await refresh();
const timer = setInterval(() => void refresh(), 90_000);
console.log(`[ready] ${JSON.stringify({ state: gateway.mobile.state, dir, workspace, serverId: gateway.serverId })}`);

const servePort = arg("--serve-pairing");
const pairingServer =
	servePort === undefined
		? undefined
		: createServer((request, response) => {
				if (request.url !== "/pairing") {
					response.writeHead(404).end();
					return;
				}
				const { pairingText } = gateway.mobile.createPairing();
				console.log("[pairing] 经 /pairing 下发新配对码");
				response.writeHead(200, { "content-type": "text/plain" }).end(pairingText);
			}).listen(Number(servePort), "127.0.0.1");

const shutdown = async () => {
	clearInterval(timer);
	pairingServer?.close();
	await desktop.close().catch(() => undefined);
	await gateway.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
