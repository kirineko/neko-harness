import 'package:neko_mobile/l10n/app_localizations.dart';

/// core 经投影下发的固定英文串，在显示时映射为当前语言；未匹配时原样返回。
/// 模板由共享夹具 packages/core/test/fixtures/core-ui-strings.json 钉住（见 core_text_test.dart）。
final RegExp _runningPattern = RegExp(r'^Running (.+)\.\.\.$');
final RegExp _retryingPattern = RegExp(r'^Retrying \(attempt (\d+)\)\.\.\.$');

/// 运行状态：`Thinking...`、`Running <tool>...`、`Retrying (attempt N)...`。
String localizeStatus(AppLocalizations l10n, String text) {
  if (text == 'Thinking...') return l10n.statusThinking;
  final running = _runningPattern.firstMatch(text);
  if (running != null) return l10n.statusRunning(running.group(1)!);
  final retrying = _retryingPattern.firstMatch(text);
  if (retrying != null) {
    final attempt = int.tryParse(retrying.group(1)!);
    if (attempt != null) return l10n.statusRetrying(attempt);
  }
  return text;
}

/// 系统行：`[context compacted]`、`[new context]`。
String localizeSystemRow(AppLocalizations l10n, String text) => switch (text) {
  '[context compacted]' => l10n.systemContextCompacted,
  '[new context]' => l10n.systemNewContext,
  _ => text,
};

/// 工具卡补充说明：`Not run: response interrupted.`。
String localizeToolNote(AppLocalizations l10n, String text) =>
    text == 'Not run: response interrupted.' ? l10n.toolNoteNotRun : text;

final RegExp _providerDisabledPattern = RegExp(
  r'^PROVIDER_DISABLED: (.+?) is not enabled\.',
);
final RegExp _providerKeyPattern = RegExp(
  r'^PROVIDER_KEY_REQUIRED: Configure a (.+) API key in /login or Web settings\.$',
);

/// 带错误码前缀的错误正文，按错误码映射；provider 名按原文保留。
String localizeCoreError(AppLocalizations l10n, String text) {
  if (text.startsWith('PROVIDER_DISABLED:')) {
    final match = _providerDisabledPattern.firstMatch(text);
    if (match != null) return l10n.errorProviderDisabled(match.group(1)!);
  } else if (text.startsWith('PROVIDER_KEY_REQUIRED:')) {
    final match = _providerKeyPattern.firstMatch(text);
    if (match != null) return l10n.errorProviderKeyRequired(match.group(1)!);
  } else if (text.startsWith('PLAN_BUSY:')) {
    return l10n.errorPlanBusy;
  }
  return text;
}
