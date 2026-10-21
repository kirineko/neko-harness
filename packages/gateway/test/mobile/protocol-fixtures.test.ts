import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { asJsonRpcRequest, MOBILE_API_V1_METHODS, MOBILE_API_V1_NOTIFICATIONS } from "../../src/mobile/protocol.ts";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/mobile-api-v1");

type Fixture = {
	readonly description: string;
	readonly message?: unknown;
	readonly messages?: readonly unknown[];
};

async function loadFixture(name: string): Promise<Fixture> {
	return JSON.parse(await readFile(join(FIXTURE_DIR, name), "utf8")) as Fixture;
}

function assertEnvelope(message: unknown): Record<string, unknown> {
	expect(typeof message).toBe("object");
	expect(message).not.toBeNull();
	const record = message as Record<string, unknown>;
	expect(record.jsonrpc).toBe("2.0");
	return record;
}

function check(schema: unknown, value: unknown): void {
	expect(Check(schema as TSchema, value)).toBe(true);
}

const requestFixtures: ReadonlyArray<readonly [string, string]> = [
	["hello-request.json", "server.hello"],
	["sessions-list-request.json", "sessions.list"],
	["sessions-create-request.json", "sessions.create"],
	["chat-attach-request.json", "chat.attach"],
	["chat-history-request.json", "chat.history"],
	["chat-content-request.json", "chat.content"],
	["chat-submit-request.json", "chat.submit"],
	["chat-submission-status-request.json", "chat.submissionStatus"],
	["chat-abort-request.json", "chat.abort"],
	["chat-withdraw-request.json", "chat.withdraw"],
	["chat-steer-request.json", "chat.steer"],
	["chat-detach-request.json", "chat.detach"],
	["approvals-list-request.json", "approvals.list"],
	["approvals-get-request.json", "approvals.get"],
	["approvals-decide-request.json", "approvals.decide"],
	["todos-get-request.json", "todos.get"],
	["questions-list-request.json", "questions.list"],
	["questions-get-request.json", "questions.get"],
	["questions-respond-request.json", "questions.respond"],
	["plan-get-request.json", "plan.get"],
	["plan-respond-request.json", "plan.respond"],
	["plan-exit-request.json", "plan.exit"],
	["subagents-open-request.json", "subagents.open"],
	["subagents-history-request.json", "subagents.history"],
	["subagents-close-request.json", "subagents.close"],
	["subagents-stop-request.json", "subagents.stop"],
	["media-read-request.json", "media.read"],
];

const resultFixtures: ReadonlyArray<readonly [string, string]> = [
	["hello-result.json", "server.hello"],
	["workspaces-list-result.json", "workspaces.list"],
	["sessions-list-result.json", "sessions.list"],
	["sessions-create-result.json", "sessions.create"],
	["chat-attach-result.json", "chat.attach"],
	["chat-history-result.json", "chat.history"],
	["chat-content-result.json", "chat.content"],
	["chat-submit-result.json", "chat.submit"],
	["chat-submission-status-result.json", "chat.submissionStatus"],
	["chat-submission-status-unknown-result.json", "chat.submissionStatus"],
	["chat-abort-result.json", "chat.abort"],
	["chat-withdraw-result.json", "chat.withdraw"],
	["chat-steer-result.json", "chat.steer"],
	["approvals-list-result.json", "approvals.list"],
	["approvals-get-result.json", "approvals.get"],
	["approvals-decide-result.json", "approvals.decide"],
	["todos-get-result.json", "todos.get"],
	["questions-list-result.json", "questions.list"],
	["questions-get-result.json", "questions.get"],
	["questions-respond-result.json", "questions.respond"],
	["plan-get-result.json", "plan.get"],
	["plan-respond-result.json", "plan.respond"],
	["plan-exit-result.json", "plan.exit"],
	["subagents-open-result.json", "subagents.open"],
	["subagents-history-result.json", "subagents.history"],
	["subagents-stop-result.json", "subagents.stop"],
	["media-read-result.json", "media.read"],
];

const notificationFixtures: ReadonlyArray<readonly [string, string]> = [
	["workspaces-changed-notification.json", "workspaces.changed"],
	["sessions-changed-notification.json", "sessions.changed"],
	["chat-patch-notification.json", "chat.patch"],
	["chat-reset-notification.json", "chat.reset"],
	["approvals-changed-notification.json", "approvals.changed"],
	["todos-changed-notification.json", "todos.changed"],
	["questions-changed-notification.json", "questions.changed"],
	["plan-changed-notification.json", "plan.changed"],
	["subagents-patch-notification.json", "subagents.patch"],
	["subagents-reset-notification.json", "subagents.reset"],
];

describe("mobile-api-v1 fixtures", () => {
	it("has a fixture file for every declared method and notification", () => {
		const nullary = new Set(["workspaces.list"]);
		for (const method of Object.keys(MOBILE_API_V1_METHODS)) {
			if (nullary.has(method)) continue;
			expect(requestFixtures.some(([, name]) => name === method)).toBe(true);
		}
		for (const notification of Object.keys(MOBILE_API_V1_NOTIFICATIONS)) {
			expect(notificationFixtures.some(([, name]) => name === notification)).toBe(true);
		}
	});

	it("validates request fixtures against the protocol schemas", async () => {
		for (const [file, method] of requestFixtures) {
			const fixture = await loadFixture(file);
			const message = assertEnvelope(fixture.message);
			expect(fixture.description.length).toBeGreaterThan(0);
			expect(asJsonRpcRequest(message)?.method).toBe(method);
			const spec = MOBILE_API_V1_METHODS[method];
			expect(spec).toBeDefined();
			check(spec?.params, message.params);
		}
	});

	it("validates result fixtures against the protocol schemas", async () => {
		for (const [file, method] of resultFixtures) {
			const fixture = await loadFixture(file);
			const message = assertEnvelope(fixture.message);
			expect(["string", "number"]).toContain(typeof message.id);
			expect(message.error).toBeUndefined();
			const spec = MOBILE_API_V1_METHODS[method];
			check(spec?.result, message.result);
		}
	});

	it("validates notification fixtures against the protocol schemas", async () => {
		for (const [file, notification] of notificationFixtures) {
			const fixture = await loadFixture(file);
			const message = assertEnvelope(fixture.message);
			expect(message.method).toBe(notification);
			expect(message.id).toBeUndefined();
			check(MOBILE_API_V1_NOTIFICATIONS[notification], message.params);
		}
	});

	it("validates the hello-incompatible error and the stable error-code set", async () => {
		const incompatible = assertEnvelope((await loadFixture("hello-error-incompatible.json")).message);
		expect(incompatible.error).toMatchObject({ data: { code: "incompatible" } });
		expect(["app", "computer"]).toContain((incompatible.error as { data: { needs: string } }).data.needs);

		const codes = await loadFixture("error-codes.json");
		const list = Array.isArray(codes.messages) ? codes.messages : [];
		expect(list.length).toBeGreaterThanOrEqual(7);
		const allowed: readonly string[] = [
			"unauthorized",
			"revoked",
			"incompatible",
			"invalid_params",
			"not_found",
			"gone",
			"stale_ref",
			"content_changed",
			"busy_limit",
			"rejected",
			"internal",
		];
		for (const message of list) {
			const record = assertEnvelope(message);
			expect(record.id).toBeDefined();
			const data = (record.error as { data: { code: string } }).data;
			expect(allowed).toContain(data.code);
		}
	});
});
