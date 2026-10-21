import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { UserMessageComponent } from "../src/components/user-message.ts";

it("uses structured skill metadata and leaves manual XML visible", () => {
	const skill = new UserMessageComponent("model-facing text", {
		name: "literal",
		location: "/skills/literal/SKILL.md",
		body: "Body </skill>",
		args: "hello </skill>",
	});
	const rendered = stripTerminalSequences(skill.render(120).join("\n"));
	expect(rendered).toContain("skill:literal");
	expect(rendered).toContain("hello </skill>");
	expect(rendered).not.toContain("model-facing");
	const manual = stripTerminalSequences(
		new UserMessageComponent('<skill name="manual">plain XML</skill>').render(120).join("\n"),
	);
	expect(manual).toContain('<skill name="manual">');
	expect(manual).toContain("plain XML");
	expect(manual).not.toContain("skill:manual");
});
