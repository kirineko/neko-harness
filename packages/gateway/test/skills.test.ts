// 技能显式调用（spec: 会话技能列表服务 + 技能命令展开）：
// chat.skills() 返回两级合并列表；/skill: 提交经 gateway 后在 core 展开。

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ChatView } from "@neko-harness/core";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, testSocketPath } from "./helpers.ts";

let dir: string;
let home: string;
let workspace: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "neko-gateway-skills-")));
	home = join(dir, "home");
	workspace = join(dir, "ws");
	await mkdir(join(home, ".agents", "skills", "global"), { recursive: true });
	await writeFile(
		join(home, ".agents", "skills", "global", "SKILL.md"),
		"---\ndescription: Global skill\n---\nglobal body",
	);
	await mkdir(join(workspace, ".agents", "skills", "local"), { recursive: true });
	await writeFile(
		join(workspace, ".agents", "skills", "local", "SKILL.md"),
		"---\ndescription: Local skill\n---\nlocal body",
	);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("skills over the gateway", () => {
	it("lists both levels via chat.skills() and expands /skill: on submit", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
		const gateway = await startGateway({
			storage: "memory",
			storagePath: join(dir, "neko.sqlite"),
			socketPath: testSocketPath(dir),
			port: 0,
			serverId: randomUUID(),
			model: { provider: "faux", modelId: "faux-1" },
			providers: [faux.provider],
			cwd: workspace,
			promptHome: home,
		});
		try {
			const client = await connectTestClient(gateway);
			try {
				const created = await client.management.create({});
				const chat = await client.attach(created.id);

				const skills = await chat.skills(null);
				const byName = new Map(skills.map((s) => [s.name, s]));
				expect(byName.get("global")?.description).toBe("Global skill");
				expect(byName.get("local")?.location).toBe(join(workspace, ".agents", "skills", "local", "SKILL.md"));

				const seen: ChatView[] = [];
				chat.view.subscribe((value) => {
					if (value) seen.push(value);
				});
				await chat.submit({ content: "/skill:local do it" });
				await new Promise((resolve) => setTimeout(resolve, 500));
				const userTexts = seen.flatMap((v) => v.items.filter((i) => i.type === "user").map((i) => i.text));
				const expanded = userTexts.find((t) => t.includes('<skill name="local"'));
				expect(expanded).toBeDefined();
				expect(expanded).toContain("local body");
				expect(expanded).toContain("do it");
			} finally {
				await client.close();
			}
		} finally {
			await gateway.close();
		}
	});
});
