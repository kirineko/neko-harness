import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type PlainKey, useT } from "../lib/i18n/index.ts";
import { Icon } from "./primitives";

export type SettingsSection =
	| "credentials"
	| "search"
	| "context"
	| "codemode"
	| "appearance"
	| "language"
	| "mobile"
	| "about";

const MENU: readonly {
	key: SettingsSection;
	label: PlainKey;
	icon: "key" | "layers" | "code" | "phone" | "info" | "search" | "palette" | "globe";
	to: string;
}[] = [
	{ key: "credentials", label: "settings.menu.credentials", icon: "key", to: "/settings" },
	{ key: "search", label: "settings.menu.search", icon: "search", to: "/settings/search" },
	{ key: "context", label: "settings.menu.context", icon: "layers", to: "/settings/context" },
	{ key: "codemode", label: "settings.menu.codemode", icon: "code", to: "/settings/codemode" },
	{ key: "appearance", label: "settings.menu.appearance", icon: "palette", to: "/settings/appearance" },
	{ key: "language", label: "settings.menu.language", icon: "globe", to: "/settings/language" },
	{ key: "mobile", label: "settings.menu.mobile", icon: "phone", to: "/settings/mobile" },
	{ key: "about", label: "settings.menu.about", icon: "info", to: "/about" },
];

/**
 * 设置区统一外壳：左侧栏菜单（模型服务 / 联网搜索 / 上下文 / Codemode / 外观 / 语言 / 手机配对 / 关于与更新）+ 右侧内容。
 * 移动端侧栏转为顶部横排，菜单项保持可点。
 */
export function SettingsShell({ active, children }: { active: SettingsSection; children: ReactNode }) {
	const t = useT();
	return (
		<div className="flex min-h-dvh flex-col bg-base sm:flex-row">
			<nav
				aria-label={t("settings.menuLabel")}
				className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-sakura-100 px-4 py-2.5 sm:w-48 sm:flex-col sm:items-stretch sm:gap-1 sm:border-r sm:border-b-0 sm:px-3 sm:py-5"
			>
				<Link
					to="/"
					className="focus-neko mr-2 inline-flex shrink-0 items-center rounded-lg px-2 py-1.5 text-sm text-sakura-700 sm:mr-0 sm:mb-3"
				>
					{t("settings.backToChat")}
				</Link>
				<span className="hidden px-2 pb-1 text-xs font-medium text-ink-400 sm:block">{t("settings.title")}</span>
				{MENU.map((item) => (
					<Link
						key={item.key}
						to={item.to}
						activeOptions={{ exact: true }}
						aria-current={active === item.key ? "page" : undefined}
						className={`focus-neko inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm ${
							active === item.key ? "bg-sakura-100 font-semibold text-sakura-800" : "text-ink-600 hover:bg-ink-100"
						}`}
					>
						<Icon name={item.icon} size={15} />
						{t(item.label)}
					</Link>
				))}
			</nav>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}
