import { expect, it } from "vitest";
import { readUpgradeDraft, saveUpgradeDraft } from "../src/client/lib/upgrade-draft.ts";

it("validates scoped text-only recovery and fails when storage cannot save", () => {
	let value: string | null = null;
	const storage = {
		getItem: () => value,
		setItem: (_key: string, next: string) => {
			value = next;
		},
	};
	const draft = {
		version: 1 as const,
		serverId: "server",
		workspace: "workspace",
		session: "1",
		text: "draft",
		requestId: "request",
	};
	saveUpgradeDraft(draft, storage);
	expect(readUpgradeDraft(storage)).toEqual(draft);
	value = '{"version":1,"text":"bad"}';
	expect(readUpgradeDraft(storage)).toBeNull();
	value = "invalid";
	expect(readUpgradeDraft(storage)).toBeNull();
	expect(() => saveUpgradeDraft(draft, { getItem: () => null, setItem: () => {} })).toThrow("Draft not saved");
});
