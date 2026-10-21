import { AppearancePanel } from "../components/appearance-panel";
import { SettingsShell } from "../components/settings-shell";

export function SettingsAppearancePage() {
	return (
		<SettingsShell active="appearance">
			<div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-3">
				<h1 className="text-xl font-bold text-ink-900">外观</h1>
				<p className="mt-1 text-sm text-ink-500">
					选择主题与聊天排版。点选即保存、立即生效，只保存在当前浏览器，不影响终端界面与手机端。
				</p>
			</div>
			<main className="mx-auto w-full max-w-4xl px-5 pb-8">
				<AppearancePanel />
			</main>
		</SettingsShell>
	);
}
