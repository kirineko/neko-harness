/**
 * 目录面板面包屑：按宿主路径形态切分。
 * Windows 盘符路径（`D:\code`）以盘符 crumb 回到盘根、根按钮直达盘符列表层（"/"）；
 * POSIX 路径以 `/` 为根，行为与旧实现一致。
 */

import { getT } from "./i18n/index.ts";

export type PathCrumb = {
	/** 面包屑显示名（POSIX 为目录名，Windows 首项为盘符 `D:`）。 */
	readonly label: string;
	/** 点击后导航到的完整路径。 */
	readonly path: string;
};

export type PathCrumbs = {
	/** 根按钮的导航目标：恒为 "/"（POSIX 文件系统根；Windows 网关把它解析为盘符列表层）。 */
	readonly root: string;
	/** 根按钮的显示文案：POSIX "/"；盘符路径下 "此电脑"。 */
	readonly rootLabel: string;
	readonly crumbs: readonly PathCrumb[];
};

export function pathCrumbs(path: string): PathCrumbs {
	const drive = /^([A-Za-z]:)[\\/]/.exec(path);
	const letter = drive?.[1];
	if (letter !== undefined) {
		const driveRoot = `${letter}\\`;
		const names = path
			.slice(driveRoot.length)
			.split(/[\\/]+/)
			.filter(Boolean);
		return {
			root: "/",
			rootLabel: getT()("path.thisComputer"),
			crumbs: [
				{ label: letter, path: driveRoot },
				...names.map((name, i) => ({ label: name, path: driveRoot + names.slice(0, i + 1).join("\\") })),
			],
		};
	}
	const names = path.split("/").filter(Boolean);
	return {
		root: "/",
		rootLabel: "/",
		crumbs: names.map((name, i) => ({ label: name, path: `/${names.slice(0, i + 1).join("/")}` })),
	};
}
