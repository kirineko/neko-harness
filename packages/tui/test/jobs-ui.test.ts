import { afterEach, expect, it } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { JobsClient } from "@neko-harness/gateway/client-session";
import type { WireJobOutput, WireJobSummary } from "@neko-harness/gateway/contract";
import { StatusFooter } from "../src/components/footer.ts";
import { JobReportNotice } from "../src/components/job-report.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { JOBS_EMPTY, JobDetail, jobItems, sanitizeOutput } from "../src/jobs-ui.ts";
import { setActiveTheme } from "../src/theme/index.ts";

setActiveTheme("light");

const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");

const job = (jobId: string, extra: Partial<WireJobSummary> = {}): WireJobSummary => ({
	jobId,
	title: jobId,
	command: `run ${jobId}`,
	cwd: "/work",
	status: "running",
	startedAt: Date.now() - 5000,
	endedAt: null,
	exitCode: null,
	outputBytes: 0,
	...extra,
});

type Fake = {
	client: JobsClient;
	jobs: WireJobSummary[];
	reads: (number | undefined)[];
	stops: string[];
	respond: (read: WireJobOutput) => void;
	pending: Array<(read: WireJobOutput) => void>;
};

/** Output reads wait for `respond`, so tests control response order. */
const fake = (jobs: WireJobSummary[]): Fake => {
	const state: Fake = {
		jobs,
		reads: [],
		stops: [],
		pending: [],
		respond: (read) => state.pending.shift()?.(read),
		client: {
			get supported() {
				return true;
			},
			list: () => state.jobs,
			output: (_id, since) => {
				state.reads.push(since);
				return new Promise<WireJobOutput>((resolve) => state.pending.push(resolve));
			},
			stop: async (id) => {
				state.stops.push(id);
				const target = state.jobs.find((j) => j.jobId === id)!;
				state.jobs = state.jobs.map((j) => (j === target ? { ...j, status: "stopped", endedAt: Date.now() } : j));
				return state.jobs.find((j) => j.jobId === id)!;
			},
		},
	};
	return state;
};

const read = (
	text: string,
	offset: number,
	extra: Partial<WireJobOutput> = {},
	summary = job("j1"),
): WireJobOutput => ({
	job: summary,
	text,
	offset,
	truncated: false,
	dropped: 0,
	...extra,
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

const panelOf = () => {
	let renders = 0;
	let closed = 0;
	const panel = new PickerPanel(
		() => renders++,
		() => closed++,
	);
	panel.height = 12;
	return { panel, renders: () => renders, closed: () => closed };
};

it("lists newest first with status, and shows an empty state instead of an error", async () => {
	const items = jobItems(
		[
			job("j1", { startedAt: 1000, status: "exited", exitCode: 0, endedAt: 2000 }),
			job("j2", { startedAt: 5000, title: "web" }),
		],
		9000,
	);
	expect(items.map((i) => i.value)).toEqual(["j2", "j1"]);
	expect(items[0]?.rightLabel).toBe("running · 4s");
	expect(items[1]?.rightLabel).toBe("exited · exit 0");

	const { panel } = panelOf();
	panel.emptyText = JOBS_EMPTY;
	await panel.show(
		"Jobs",
		async () => [],
		async () => {},
	);
	const text = plain(panel.render(80));
	expect(text).toContain(JOBS_EMPTY);
	expect(text).not.toContain("Error");
	panel.close();
	expect(panel.emptyText).toBeUndefined();
});

it("reads output incrementally by offset and follows new output until scrolled up", async () => {
	const f = fake([job("j1")]);
	const { panel } = panelOf();
	await panel.show(
		"Jobs",
		async () => [],
		async () => {},
	);
	const detail = new JobDetail(f.client, "j1", panel, () => {}, 30).open();
	cleanup.push(() => detail.close());
	expect(f.reads).toEqual([undefined]);
	f.respond(read(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), 200));
	await tick();
	let body = plain(detail.lines(60, 8));
	expect(body).toContain("line 29");
	expect(body).not.toContain("line 0\n");

	detail.handleKey("\x1b[A");
	const held = plain(detail.lines(60, 8));
	expect(detail.help).toContain("Bottom");
	expect(held).not.toContain("line 29");

	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(f.reads).toEqual([undefined, 200]);
	f.respond(read("\nnew tail", 209));
	await tick();
	expect(plain(detail.lines(60, 8))).toBe(held);

	detail.handleKey("\x1b[F");
	body = plain(detail.lines(60, 8));
	expect(body).toContain("new tail");
	expect(detail.help).not.toContain("Bottom");
	expect(detail.lines(60, 8).every((line) => visibleWidth(line) <= 60)).toBe(true);
});

it("shows a truncation marker and strips terminal escapes from output", async () => {
	const f = fake([job("j1")]);
	const { panel } = panelOf();
	await panel.show(
		"Jobs",
		async () => [],
		async () => {},
	);
	const detail = new JobDetail(f.client, "j1", panel, () => {}).open();
	cleanup.push(() => detail.close());
	f.respond(read("\x1b[31mred\x1b[0m\r\nok\x07", 900, { truncated: true, dropped: 800 }));
	await tick();
	const body = plain(detail.lines(60, 12));
	expect(body).toContain("800 bytes of earlier output were dropped");
	expect(body).toContain("red");
	expect(body).not.toContain("\x1b");
	expect(sanitizeOutput("a\x00b\r\nc")).toBe("ab\nc");
});

it("drops a late response after the panel closes", async () => {
	const f = fake([job("j1")]);
	const { panel, renders } = panelOf();
	await panel.show(
		"Jobs",
		async () => [],
		async () => {},
	);
	const detail = new JobDetail(f.client, "j1", panel, () => {}, 30).open();
	detail.close();
	const before = renders();
	f.respond(read("stale output", 12));
	await tick();
	expect(plain(detail.lines(60, 8))).not.toContain("stale output");
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(f.reads).toEqual([undefined]);
	expect(renders()).toBe(before);
});

it("stops a running job after Enter confirms, once, and offers no stop for ended jobs", async () => {
	const f = fake([job("j1"), job("j2", { status: "exited", exitCode: 0, endedAt: 1 })]);
	const { panel } = panelOf();
	await panel.show(
		"Jobs",
		async () => [],
		async () => {},
	);
	const running = new JobDetail(f.client, "j1", panel, () => {}).open();
	const ended = new JobDetail(f.client, "j2", panel, () => {}).open();
	cleanup.push(
		() => running.close(),
		() => ended.close(),
	);
	expect(running.help).toContain("Stop");
	expect(ended.help).not.toContain("Stop");
	expect(ended.handleKey("s")).toBe(false);

	panel.showDetail(running);
	panel.handleInput("s");
	expect(plain(panel.render(80))).toContain("Stop job j1?");
	panel.handleInput("\r");
	panel.handleInput("\r");
	await tick();
	expect(f.stops).toEqual(["j1"]);
	expect(running.help).not.toContain("Stop");
	expect(plain(panel.render(80))).not.toContain("Stop job");
});

it("left returns from the detail to the list without closing the panel", async () => {
	const f = fake([job("j1")]);
	const { panel, closed } = panelOf();
	await panel.show(
		"Jobs",
		async () => [],
		async () => {},
	);
	const detail = new JobDetail(f.client, "j1", panel, () => {}).open();
	cleanup.push(() => detail.close());
	panel.showDetail(detail);
	panel.handleInput("\x1b[D");
	expect(panel.detailOpen).toBe(false);
	expect(panel.open).toBe(true);
	expect(closed()).toBe(0);
});

it("shows the running job count in the status bar and hides it at zero", () => {
	const footer = new StatusFooter();
	const stats = {
		cwd: "/p",
		model: "m",
		thinkingLevel: null,
		busy: undefined,
		usageText: "In: 0 Out: 0 $0.00",
	};
	footer.setStats({ ...stats, jobCount: 2 });
	expect(plain(footer.render(100))).toContain("Jobs 2");
	footer.setStats({ ...stats, jobCount: 1 });
	expect(plain(footer.render(100))).toContain("Jobs 1");
	footer.setStats({ ...stats, jobCount: 0 });
	expect(plain(footer.render(100))).not.toContain("Jobs");
});

it("renders a job report as a folded system notice that expands on demand", () => {
	const text = `[Background job j1 "web" failed, exit code 1]\nCommand: npm run dev\nLast output (use the job tool's output action with jobId "j1" for more):\nboom\ntrace`;
	const notice = new JobReportNotice(text);
	const folded = plain(notice.render(80));
	expect(folded).toContain(`[Background job j1 "web" failed, exit code 1]`);
	expect(folded).toContain("+2 lines");
	expect(folded).not.toContain("boom");
	notice.setExpanded(true);
	const open = plain(notice.render(80));
	expect(open).toContain("$ npm run dev");
	expect(open).toContain("boom");
	expect(open).toContain("trace");
});

it("list key hook sees the selected job and yields to the filter once the user has typed", async () => {
	const { panel } = panelOf();
	const seen: (string | undefined)[] = [];
	panel.listKey = (data, value) => {
		if (data.toLowerCase() !== "s" || panel.search.getValue() !== "") return false;
		seen.push(value);
		return true;
	};
	await panel.show(
		"Jobs",
		async () => jobItems([job("j1"), job("j2", { startedAt: 1 })]),
		async () => {},
	);
	panel.handleInput("\x1b[B");
	panel.handleInput("s");
	expect(seen).toEqual(["j2"]);
	expect(panel.search.getValue()).toBe("");
	panel.handleInput("x");
	panel.handleInput("s");
	expect(seen).toEqual(["j2"]);
	expect(panel.search.getValue()).toBe("xs");
});
