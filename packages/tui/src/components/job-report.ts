import { Container, MouseRegion, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { splitJobReport } from "@neko-harness/core/job-summary";
import { t } from "../i18n/index.ts";
import { sanitizeOutput } from "../jobs-ui.ts";
import { theme } from "../theme/index.ts";

const MAX_LINES = 40;

/**
 * System notice for a background job report: the status line stays visible, the output tail is folded
 * (click to expand). Rendered from the raw report on every pass so theme changes never leave stale colors.
 */
export class JobReportNotice extends Container {
	#raw: string;
	#expanded = false;
	readonly #text = new Text("", 1, 0);
	constructor(text: string) {
		super();
		this.#raw = text;
		this.addChild(new MouseRegion(this.#text, (event: TuiMouseEvent) => this.#onClick(event)));
	}
	setText(text: string): void {
		this.#raw = text;
	}
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
	}
	#onClick(event: TuiMouseEvent): { handled: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.#expanded = !this.#expanded;
		return { handled: true };
	}
	override render(width: number): string[] {
		const { head, command, output } = splitJobReport(this.#raw);
		let text = theme.dim(sanitizeOutput(head));
		if (output === undefined) {
			if (command !== undefined) text += theme.dim(`\n$ ${sanitizeOutput(command)}`);
		} else {
			const lines = sanitizeOutput(output).split("\n");
			if (this.#expanded) {
				if (command !== undefined) text += theme.dim(`\n$ ${sanitizeOutput(command)}`);
				text += `\n${theme.toolOutput(lines.slice(-MAX_LINES).join("\n"))}`;
				if (lines.length > MAX_LINES)
					text += theme.dim(`\n${t("job.earlierOmitted", { count: lines.length - MAX_LINES })}`);
			} else text += theme.dim(`  ${t("tool.lines", { count: lines.length })}`);
		}
		this.#text.setText(text);
		return super.render(width);
	}
}
