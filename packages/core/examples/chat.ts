// 真实 DeepSeek API 验证 1：简单问答。
// 运行（需要 DEEPSEEK_API_KEY）:
//   node --conditions=neko-source packages/core/examples/chat.ts
import { createNekoRuntime } from "../src/index.ts";

const question = "1+1等于几？";
const runtime = await createNekoRuntime();
try {
	const submission = await runtime.submit(question);
	const answer = await runtime.waitAnswer(submission);
	if (answer.status !== "done") {
		console.error(`unanswered: ${answer.reason}${answer.detail ? ` (${answer.detail})` : ""}`);
		process.exitCode = 1;
	} else {
		console.log(`Q: ${question}`);
		console.log(`A: ${answer.text}`);
	}
	const usage = await runtime.usage();
	console.log("usage:", JSON.stringify(usage));
} finally {
	await runtime.close();
}
