import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { MouseRegion, stripTerminalSequences } from "@earendil-works/pi-tui";
import { UserMessageComponent } from "../src/components/user-message.ts";

const prompt = { version: 3, text: `${"Saved image prompt.\n".repeat(40)}END OF SAVED PROMPT` };
it("marks image prompts, toggles their full saved text and keeps ordinary text visible", () => {
	const component = new UserMessageComponent("", undefined, prompt);
	for (const width of [60, 80]) {
		expect(stripTerminalSequences(component.render(width).join("\n"))).toContain("Default image prompt");
		expect(stripTerminalSequences(component.render(width).join("\n"))).not.toContain("END OF SAVED PROMPT");
		const click = () => {
			const header = component.children[0];
			expect(header).toBeInstanceOf(MouseRegion);
			if (!(header instanceof MouseRegion)) throw new Error("Missing clickable header");
			return header.handleMouse({
				type: "click",
				button: "left",
				x: 1,
				y: 0,
				screenX: 1,
				screenY: 0,
				width,
				height: 1,
				shift: false,
				alt: false,
				ctrl: false,
			});
		};
		expect(click()).toEqual({ handled: true });
		expect(stripTerminalSequences(component.render(width).join("\n"))).toContain("END OF SAVED PROMPT");
		expect(click()).toEqual({ handled: true });
		expect(stripTerminalSequences(component.render(width).join("\n"))).not.toContain("/image-prompt");
	}
	expect(stripTerminalSequences(new UserMessageComponent(prompt.text).render(80).join("\n"))).toContain(
		"END OF SAVED PROMPT",
	);
});
