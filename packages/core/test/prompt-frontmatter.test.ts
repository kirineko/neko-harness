import { expect, it } from "vitest";
import { parseFrontmatter, stripFrontmatter } from "../src/prompt/frontmatter.ts";

it("requires standalone delimiters and normalizes BOM and newlines", () => {
	expect(parseFrontmatter("\uFEFF---\r\ndescription: demo\r\n---\r\nbody")).toEqual({
		frontmatter: { description: "demo" },
		body: "body",
	});
	for (const input of ["---not-a-delimiter\ndescription: demo\n---\nbody", "---\ndescription: demo\n---suffix\nbody"]) {
		expect(parseFrontmatter(input)).toEqual({ frontmatter: {}, body: input });
		expect(stripFrontmatter(input)).toBe(input);
	}
	expect(parseFrontmatter("---\n---\nbody").body).toBe("body");
	expect(() => parseFrontmatter("---\n- item\n---\nbody")).toThrow("mapping");
	expect(() => parseFrontmatter("---\nscalar\n---\nbody")).toThrow("mapping");
});
