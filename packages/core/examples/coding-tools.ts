// 真实 DeepSeek API 验证 2：工具调用。让模型在 /tmp/neko-test 下创建 hello.txt 并读回内容，
// 通过会话视图（pi.live 工具槽与工具结果条目）打印工具调用轨迹，最后核对磁盘上的真实文件内容。
// 运行（需要 DEEPSEEK_API_KEY）:
//   bun --conditions=neko-source packages/core/examples/coding-tools.ts
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LiveState, ToolResultEntry } from "@earendil-works/pi-durable";
import { createNekoRuntime } from "../src/index.ts";

const dir = "/tmp/neko-test";
const file = join(dir, "hello.txt");
await mkdir(dir, { recursive: true });

const runtime = await createNekoRuntime({ cwd: dir });
try {
	// Pi 1.5 renders state, not events: tool slots in `pi.live.tools`, results as appended entries.
	const watch = await runtime.watch();
	const started = new Set<string>();
	const printed = new Set<number>();
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		const live = call.value.docs["pi.live"] as LiveState | undefined;
		for (const slot of live?.tools ?? []) {
			if (started.has(slot.callId)) continue;
			started.add(slot.callId);
			console.log(`tool start  ${slot.name}`);
		}
		for (const entry of call.value.entries) {
			if (printed.has(entry.id) || !ToolResultEntry.is(entry)) continue;
			printed.add(entry.id);
			const result = entry.model?.[0];
			if (result?.role !== "toolResult") continue;
			const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
			const clipped = text.length > 300 ? `${text.slice(0, 300)}…` : text;
			console.log(`tool end    ${result.toolName}: ${JSON.stringify(clipped)}`);
		}
	});

	const prompt = "在 /tmp/neko-test 目录下创建 hello.txt，内容为 hello neko，然后用工具读回来告诉我文件内容。";
	console.log(`Q: ${prompt}`);
	const answer = await runtime.waitAnswer(await runtime.submit(prompt));
	if (answer.status !== "done") {
		console.error(`unanswered: ${answer.reason}${answer.detail ? ` (${answer.detail})` : ""}`);
		process.exitCode = 1;
	} else {
		console.log(`A: ${answer.text}`);
	}
	await watch.stop();
} finally {
	await runtime.close();
}

const onDisk = await readFile(file, "utf8").catch(() => undefined);
console.log(`file on disk: ${JSON.stringify(onDisk)}`);
if (onDisk?.trim() !== "hello neko") {
	console.error("verification failed: file content mismatch");
	process.exitCode = 1;
}
