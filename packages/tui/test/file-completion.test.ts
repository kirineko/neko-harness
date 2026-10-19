import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import type { FileCandidates } from "../../core/src/file-mentions.ts";
import { WorkspaceFiles } from "../../core/src/workspace-files.ts";
import { BoundedEditor } from "../src/components/editor.ts";
import { getEditorTheme } from "../src/theme/index.ts";

let files = new WorkspaceFiles();
afterEach(async () => {
	await files.close();
	files = new WorkspaceFiles();
});

// 用小型临时工作区代替整个仓库，避免枚举耗时受 CI 磁盘速度影响。
let fixtureRoot = "";
beforeAll(async () => {
	fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "neko-file-completion-")));
	await mkdir(join(fixtureRoot, "packages/core/src"), { recursive: true });
	await writeFile(join(fixtureRoot, "packages/core/src/runtime.ts"), "export {};\n");
});
afterAll(async () => {
	await rm(fixtureRoot, { recursive: true, force: true });
});

import { fileCompletion } from "../src/file-completion.ts";

async function waitForAutocomplete(editor: BoundedEditor) {
	for (let attempt = 0; attempt < 400 && !editor.isShowingAutocomplete(); attempt++) await Bun.sleep(10);
	expect(editor.isShowingAutocomplete()).toBe(true);
}

for (const key of ["\t", "\r"]) {
	it(`continues into selected directories with ${key === "\t" ? "Tab" : "Enter"}`, async () => {
		const editor = new BoundedEditor(new TuiAltScreen({ columns: 80, rows: 24 } as Terminal), getEditorTheme());
		let submitted = false;
		editor.onSubmit = () => {
			submitted = true;
		};
		const queries: string[] = [];
		editor.setAutocompleteProvider(
			fileCompletion(
				[],
				process.cwd(),
				() => {},
				async (query) => {
					queries.push(query);
					const paths =
						query === ""
							? ["space dir/"]
							: query === "space dir/"
								? ["space dir/nested/", "space dir/a.ts"]
								: ["space dir/nested/a.ts", "space dir/nested/b.ts"];
					return {
						entries: paths.map((path) => ({
							path,
							name: path.split("/").filter(Boolean).at(-1)!,
							kind: path.endsWith("/") ? ("directory" as const) : ("file" as const),
						})),
						limited: false,
						incomplete: false,
					};
				},
			),
		);
		editor.render(80);
		editor.setText("read  afterwards");
		for (let n = 0; n < " afterwards".length; n++) editor.handleInput("\x1b[D");
		editor.handleInput("@");
		await waitForAutocomplete(editor);
		editor.handleInput(key);
		await waitForAutocomplete(editor);
		expect(editor.getText()).toBe('read @"space dir/" afterwards');
		expect(queries).toEqual(["", "space dir/"]);
		editor.handleInput(key);
		await waitForAutocomplete(editor);
		expect(editor.getText()).toBe('read @"space dir/nested/" afterwards');
		expect(queries).toEqual(["", "space dir/", "space dir/nested/"]);
		editor.handleInput(key);
		expect(editor.getText()).toBe('read @"space dir/nested/a.ts"  afterwards');
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(submitted).toBe(false);
		editor.handleInput("\x1f");
		expect(editor.getText()).toBe('read @"space dir/nested/" afterwards');
		editor.handleInput("\x1f");
		expect(editor.getText()).toBe('read @"space dir/" afterwards');
	});
}

for (const cancel of ["escape", "switch draft"]) {
	it(`does not reopen directory candidates after ${cancel}`, async () => {
		const editor = new BoundedEditor(new TuiAltScreen({ columns: 80, rows: 24 } as Terminal), getEditorTheme());
		let resolveChildren!: (value: FileCandidates) => void;
		let childSignal: AbortSignal | undefined;
		editor.setAutocompleteProvider(
			fileCompletion(
				[],
				process.cwd(),
				() => {},
				async (query, signal) => {
					if (!query)
						return { entries: [{ path: "src", name: "src", kind: "directory" }], limited: false, incomplete: false };
					childSignal = signal;
					return new Promise((resolve) => {
						resolveChildren = resolve;
					});
				},
			),
		);
		editor.handleInput("@");
		await waitForAutocomplete(editor);
		editor.handleInput("\r");
		for (let attempt = 0; attempt < 100 && !childSignal; attempt++) await Bun.sleep(10);
		expect(childSignal).toBeDefined();
		if (cancel === "escape") editor.handleInput("\x1b");
		else editor.setText("another session");
		expect(childSignal!.aborted).toBe(true);
		resolveChildren({
			entries: [
				{ path: "src/a.ts", name: "a.ts", kind: "file" },
				{ path: "src/b.ts", name: "b.ts", kind: "file" },
			],
			limited: false,
			incomplete: false,
		});
		await Bun.sleep(30);
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getText()).toBe(cancel === "escape" ? "@src/" : "another session");
	});
}

it("cancels scheduled directory continuation before it starts", async () => {
	const editor = new BoundedEditor(new TuiAltScreen({ columns: 80, rows: 24 } as Terminal), getEditorTheme());
	const queries: string[] = [];
	editor.setAutocompleteProvider(
		fileCompletion(
			[],
			process.cwd(),
			() => {},
			async (query) => {
				queries.push(query);
				return { entries: [{ path: "src", name: "src", kind: "directory" }], limited: false, incomplete: false };
			},
		),
	);
	editor.handleInput("@");
	await waitForAutocomplete(editor);
	editor.handleInput("\t");
	editor.handleInput("\x1b");
	await Bun.sleep(30);
	expect(queries).toEqual([""]);
	expect(editor.isShowingAutocomplete()).toBe(false);
	expect(editor.getText()).toBe("@src/");
});

it("uses Pi for file and directory completion without submitting", async () => {
	const provider = fileCompletion(
		[],
		fixtureRoot,
		() => {},
		(query, signal) => files.search(fixtureRoot, query, signal),
	);
	const query = "@packages/core/src/";
	const result = await provider.getSuggestions([query], 0, query.length, { signal: new AbortController().signal });
	expect(result?.items.some((i) => i.value === "@packages/core/src/runtime.ts")).toBe(true);
	const item = result!.items.find((i) => i.value === "@packages/core/src/runtime.ts")!;
	const applied = provider.applyCompletion([query], 0, query.length, item, result!.prefix);
	expect(applied.lines[0]).toBe("@packages/core/src/runtime.ts ");
	const invalid = await provider.getSuggestions(["@../"], 0, 4, { signal: new AbortController().signal });
	expect(invalid).toBeNull();
});

it("closes Pi candidates before starting the double-Escape clear sequence", async () => {
	const { TuiAltScreen, visibleWidth } = await import("@earendil-works/pi-tui");
	const { BoundedEditor } = await import("../src/components/editor.ts");
	const { getEditorTheme } = await import("../src/theme/index.ts");
	for (const width of [120, 80, 60]) {
		const editor = new BoundedEditor(
			new TuiAltScreen({ columns: width, rows: 24 } as import("@earendil-works/pi-tui").Terminal),
			getEditorTheme(),
		);
		editor.setAutocompleteProvider(
			fileCompletion(
				[],
				fixtureRoot,
				() => {},
				(query, signal) => files.search(fixtureRoot, query, signal),
			),
		);
		editor.render(width);
		editor.handleInput("@");
		for (let attempt = 0; attempt < 400 && !editor.isShowingAutocomplete(); attempt++) await Bun.sleep(25);
		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(editor.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getText()).toBe("@");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("@");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("");
	}
});
