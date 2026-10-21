import { EXPLORER_LABEL } from "../lib/i18n/server-text.ts";
import type { OpenTargetId } from "../lib/open-workspace";

/** 打开目标的彩色图标：品牌与系统图标保持原色，不走单色 `Icon`。 */

export function VscodeIcon({ size = 18 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M21.6 4.1 17.4 2 9.2 9.6 4.9 6.3 3 7.2v9.6l1.9.9 4.3-3.3 8.2 7.6 4.2-2.1z" fill="#0078D4" />
			<path d="M17.4 7.4 11.6 12l5.8 4.6z" fill="#fff" />
			<path d="M4.9 6.3 9.2 9.6 3 7.2zM4.9 17.7l4.3-3.3L3 16.8z" fill="#2AA1F5" opacity="0.9" />
		</svg>
	);
}

export function FinderIcon({ size = 18 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<rect x="2" y="3" width="20" height="18" rx="4.5" fill="#2F8CF7" />
			<path d="M12 3h5.5A4.5 4.5 0 0 1 22 7.5v9a4.5 4.5 0 0 1-4.5 4.5H12z" fill="#E8F1FE" />
			<path
				d="M8 9.5v2M16 9.5v2M7.5 15.5c2.7 2 6.3 2 9 0"
				stroke="#0B3A7A"
				strokeWidth="1.4"
				strokeLinecap="round"
				fill="none"
			/>
		</svg>
	);
}

export function ExplorerIcon({ size = 18 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M2 6.5A1.5 1.5 0 0 1 3.5 5h5.3l2 2.2h9.7A1.5 1.5 0 0 1 22 8.7V18a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18z"
				fill="#F4B63F"
			/>
			<path d="M2 10.2h20V18a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18z" fill="#FFD76A" />
		</svg>
	);
}

export function FileManagerIcon({ size = 18 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M2 6.5A1.5 1.5 0 0 1 3.5 5h5.3l2 2.2h9.7A1.5 1.5 0 0 1 22 8.7V18a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18z"
				fill="#7FA6C9"
			/>
			<path d="M2 10.2h20V18a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18z" fill="#A9C6E0" />
		</svg>
	);
}

/** 按目标与标签选择图标：标签用于区分 Finder、资源管理器与通用文件管理器。 */
export function OpenTargetIcon({ id, label, size }: { id: OpenTargetId; label: string; size?: number }) {
	if (id === "vscode") return <VscodeIcon size={size} />;
	if (label === "Finder") return <FinderIcon size={size} />;
	if (label === EXPLORER_LABEL) return <ExplorerIcon size={size} />;
	return <FileManagerIcon size={size} />;
}
