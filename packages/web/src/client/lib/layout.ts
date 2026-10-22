/**
 * 布局常量单一来源。与 styles.css 中的 --breakpoint-mobile / .chat-column
 * 保持一致，由 test/layout-tokens.test.ts 对拍守护（CSS 媒体查询无法引用
 * 脚本常量，只能靠测试防止漂移）。
 * 本模块保持 DOM-free（根 tsc 不含 DOM lib 也会编译到它），
 * matchMedia 调用由使用方（client 代码）发起。
 */
export const MOBILE_BREAKPOINT = 768;
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;
export const MESSAGE_COLUMN_REM = 48;

/** 右侧面板（工作区 / 后台任务 / 子 agent）共用的桌面宽度（px）；窄屏（≤1023px）为抽屉，不使用该宽度。 */
export const SIDE_PANEL_WIDTH = { min: 320, max: 960, initial: 560, step: 24 } as const;
/** 面板在任何视口下都不超过视口宽度的这一比例（与面板 className 的 max-w-[60vw] 对拍）。 */
export const SIDE_PANEL_MAX_VIEWPORT = 0.6;
export const clampSidePanelWidth = (width: number): number =>
	Math.min(SIDE_PANEL_WIDTH.max, Math.max(SIDE_PANEL_WIDTH.min, Math.round(width)));

/**
 * 宽屏分层宽度分档（与 styles.css 的 .chat-column 媒体查询对拍，
 * 由 test/layout-tokens.test.ts 守护）：视口达到 minViewportRem 时
 * 消息列抬升到 columnRem；气泡与工具卡均不突破消息列。
 */
export const COLUMN_TIERS: readonly { minViewportRem: number; columnRem: number }[] = [
	{ minViewportRem: 80, columnRem: 56 },
	{ minViewportRem: 105, columnRem: 64 },
];
