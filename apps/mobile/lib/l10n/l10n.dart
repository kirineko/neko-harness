import 'package:flutter/widgets.dart';
import 'package:neko_mobile/l10n/app_localizations.dart';

export 'package:neko_mobile/l10n/app_localizations.dart';

const Locale kLocaleZh = Locale('zh');
const Locale kLocaleEn = Locale('en');

/// 界面语言只有这两种：不跟随系统，缺省与非法值一律回到 zh。
const List<Locale> kSupportedLocales = <Locale>[kLocaleZh, kLocaleEn];

/// 偏好里保存的语言码；非法或缺失时为 zh。
Locale parseLocale(String? code) => code == 'en' ? kLocaleEn : kLocaleZh;

String localeCode(Locale locale) => locale.languageCode == 'en' ? 'en' : 'zh';

extension AppL10nContext on BuildContext {
  /// 未安装本地化代理的子树（如孤立的 widget 测试）固定回退 zh，与应用的固定回退一致。
  AppLocalizations get l10n =>
      Localizations.of<AppLocalizations>(this, AppLocalizations) ??
      lookupAppLocalizations(kLocaleZh);
}

/// 控制器持有的用户可见文案：显示时才按当前语言解析，切换语言后无需重建状态。
typedef UiText = String Function(AppLocalizations l10n);

/// 不翻译的原文（电脑端下发的错误细节等）。
UiText rawText(String text) =>
    (AppLocalizations l10n) => text;

/// 无 BuildContext 的解析入口：测试与非 widget 代码使用。
String resolveUiText(UiText text, Locale locale) =>
    text(lookupAppLocalizations(locale));
