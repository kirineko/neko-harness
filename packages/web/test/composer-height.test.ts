import { expect, it } from "vitest";
import { COMPOSER_MAX_HEIGHT, fitHeight } from "../src/client/lib/composer-height.ts";

function textarea(initial: string) {
	const el = { style: { height: initial }, scrollHeight: 0 };
	return el;
}

it("按内容高度设置，不超过上限", () => {
	const el = textarea("");
	el.scrollHeight = 80;
	fitHeight(el);
	expect(el.style.height).toBe("80px");
	el.scrollHeight = 900;
	fitHeight(el);
	expect(el.style.height).toBe(`${COMPOSER_MAX_HEIGHT}px`);
});

it("内容清空后高度收缩，而不是停留在旧值", () => {
	const el = textarea("160px");
	// 浏览器中 height:auto 后 scrollHeight 反映内容；此处用 getter 模拟这一依赖。
	Object.defineProperty(el, "scrollHeight", { get: () => (el.style.height === "auto" ? 40 : 160) });
	fitHeight(el);
	expect(el.style.height).toBe("40px");
});
