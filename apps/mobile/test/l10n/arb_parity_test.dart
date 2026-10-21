import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../helpers/l10n_support.dart';

void main() {
  final zh = readArbMessages('app_zh.arb');
  final en = readArbMessages('app_en.arb');
  final meta = readArbMeta('app_zh.arb');
  final terms = loadProtectedTerms();

  test('zh 与 en 的键集合一致', () {
    expect(
      en.keys.toSet().difference(zh.keys.toSet()),
      isEmpty,
      reason: '多出的 en 键',
    );
    expect(
      zh.keys.toSet().difference(en.keys.toSet()),
      isEmpty,
      reason: '缺少英文翻译',
    );
  });

  test('占位符在两种语言中一致，且在模板 ARB 中声明了类型', () {
    for (final key in zh.keys) {
      final inZh = placeholdersOf(zh[key]!);
      final inEn = placeholdersOf(en[key]!);
      expect(inEn, inZh, reason: '$key 的占位符不一致');
      final declared =
          ((meta[key] as Map<String, dynamic>?)?['placeholders']
                  as Map<String, dynamic>?)
              ?.keys
              .toSet() ??
          <String>{};
      expect(declared, inZh, reason: '$key 的 @元数据 与文案占位符不一致');
    }
  });

  test('en 文案不含中日韩字符，zh 文案不为空', () {
    for (final entry in en.entries) {
      if (entry.key == 'languageZh') continue;
      expect(hasCjk(entry.value), isFalse, reason: '${entry.key} 含 CJK');
    }
    for (final entry in zh.entries) {
      expect(entry.value.trim(), isNotEmpty, reason: entry.key);
    }
  });

  test('英文风格：首字母大写（命令、协议标识与占位符开头除外）、句末不加句号', () {
    const lowercaseStarts = <String>[
      'sid ',
      'ep ',
      'fp ',
      'code ',
      'name ',
      'exp ',
      'apiVersions ',
      'server.hello ',
    ];
    for (final entry in en.entries) {
      final text = entry.value;
      expect(text.endsWith('.'), isFalse, reason: '${entry.key} 句末有句号');
      final first = text.codeUnitAt(0);
      final isLower = first >= 0x61 && first <= 0x7a;
      // 相对时间是紧凑记法（now、5m），日期是格式模式，都不是句子。
      final compact =
          entry.key.startsWith('relTime') || entry.key == 'datePattern';
      if (isLower && !compact) {
        expect(
          lowercaseStarts.any(text.startsWith),
          isTrue,
          reason: '${entry.key} 首字母应大写：$text',
        );
      }
    }
  });

  test('子 agent 在英文中写作 sub-agent', () {
    for (final entry in en.entries) {
      expect(
        entry.value.toLowerCase().contains('subagent'),
        isFalse,
        reason: entry.key,
      );
      expect(entry.value.contains('sub agent'), isFalse, reason: entry.key);
    }
    expect(en['approvalSubagentTitle'], contains('Sub-agent'));
    expect(zh['approvalSubagentTitle'], contains('子 agent'));
  });

  test('保护词在 zh 与 en 文案中原样存在（自动对拍集合相等）', () {
    for (final key in zh.keys) {
      final inZh = findProtectedTerms(zh[key]!, terms);
      final inEn = findProtectedTerms(en[key]!, terms);
      expect(
        inEn,
        inZh,
        reason: '$key：保护词集合不一致\n  zh: ${zh[key]}\n  en: ${en[key]}',
      );
    }
  });

  test('保护词清单被真实使用（防止匹配规则悄悄失效）', () {
    final all = <String>{
      for (final key in zh.keys) ...findProtectedTerms(zh[key]!, terms),
    };
    expect(
      all,
      containsAll(<String>['/login', 'PROVIDER_DISABLED', 'API', 'todo']),
    );
  });

  test('每个 ARB 键都有生成的访问器（生成物与 ARB 同步）', () {
    final generated = File('${mobileL10nDir.path}/app_localizations.dart')
        .readAsStringSync();
    for (final key in zh.keys) {
      final getter = RegExp('String (get )?$key\\b');
      expect(
        getter.hasMatch(generated),
        isTrue,
        reason: '$key 缺少生成物，请运行 flutter gen-l10n',
      );
    }
  });
}
