// neko TUI 入口：bun --conditions=neko-source packages/tui/src/main.ts [选项]
import { parseArgs, usage } from "./cli-options.ts";
import { runTui } from "./tui.ts";

try {
	const { help, language, ...options } = parseArgs(process.argv.slice(2));
	if (help) {
		console.log(usage(language));
		process.exit(0);
	}
	await runTui({ ...options, language });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
