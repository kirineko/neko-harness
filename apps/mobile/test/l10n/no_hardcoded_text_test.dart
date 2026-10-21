import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../helpers/dart_literals.dart';
import '../helpers/l10n_support.dart';

/// 允许出现 CJK 的字面量：键为相对 lib/ 的路径，值为 {字面量全文: 理由}。
/// 新增条目必须写明理由；用户可见文案一律进 ARB，不要加到这里。
const Map<String, Map<String, String>> _cjkAllowlist =
    <String, Map<String, String>>{};

/// 允许出现在用户可见位置的非本地化英文字面量：键为相对 lib/ 的路径，值为 {字面量全文: 理由}。
const Map<String, Map<String, String>> _visibleEnglishAllowlist =
    <String, Map<String, String>>{
      'main.dart': <String, String>{
        'NekoAI': '产品名，MaterialApp.title 供系统任务切换器显示，两种语言相同',
      },
      'features/connect/home_page.dart': <String, String>{
        'NekoAI': '产品名，首页标题，两种语言相同',
      },
    };

/// 这些位置的第一个字符串参数会直接展示给用户或读屏软件。
final RegExp _visiblePosition = RegExp(
  r'(\bText\(|\bTooltip\(message:|\b(?:tooltip|hintText|labelText|semanticLabel|semanticsLabel|label|title|subtitle):)\s*$',
);

bool _isGenerated(String relative) =>
    relative.startsWith('l10n/app_localizations');

List<File> _dartFiles() =>
    mobileLibDir
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .toList()
      ..sort((a, b) => a.path.compareTo(b.path));

String _relative(File file) =>
    file.path.substring(mobileLibDir.path.length + 1);

void main() {
  test('lib/ 下没有 CJK 字符串字面量（生成文件、注释与 debugPrint 日志除外）', () {
    final offenders = <String>[];
    for (final file in _dartFiles()) {
      final relative = _relative(file);
      if (_isGenerated(relative)) continue;
      final allowed = _cjkAllowlist[relative] ?? const <String, String>{};
      for (final literal in extractStringLiterals(file.readAsStringSync())) {
        if (!hasCjk(literal.value)) continue;
        if (allowed.containsKey(literal.value)) continue;
        offenders.add('$relative:${literal.line}  "${literal.value}"');
      }
    }
    expect(
      offenders,
      isEmpty,
      reason:
          '用户可见文案请写入 lib/l10n/app_zh.arb 与 app_en.arb：\n${offenders.join('\n')}',
    );
  });

  test('用户可见位置（Text、tooltip、label 等）没有未经本地化的英文字面量', () {
    final offenders = <String>[];
    for (final file in _dartFiles()) {
      final relative = _relative(file);
      if (_isGenerated(relative)) continue;
      final allowed =
          _visibleEnglishAllowlist[relative] ?? const <String, String>{};
      for (final literal in extractStringLiterals(file.readAsStringSync())) {
        if (!_visiblePosition.hasMatch(literal.codeBefore)) continue;
        if (!RegExp('[A-Za-z]').hasMatch(literal.value)) continue;
        if (allowed.containsKey(literal.value)) continue;
        offenders.add('$relative:${literal.line}  "${literal.value}"');
      }
    }
    expect(
      offenders,
      isEmpty,
      reason: '用户可见文案请写入 ARB（协议标识等确需保留的在白名单里写明理由）：\n${offenders.join('\n')}',
    );
  });

  test('白名单条目仍然有效（过期条目必须删除）', () {
    for (final (name, list) in <(String, Map<String, Map<String, String>>)>[
      ('CJK', _cjkAllowlist),
      ('英文', _visibleEnglishAllowlist),
    ]) {
      for (final entry in list.entries) {
        final file = File('${mobileLibDir.path}/${entry.key}');
        expect(
          file.existsSync(),
          isTrue,
          reason: '$name 白名单文件不存在：${entry.key}',
        );
        final literals = extractStringLiterals(file.readAsStringSync())
            .map((l) => l.value)
            .toSet();
        for (final item in entry.value.entries) {
          expect(
            literals,
            contains(item.key),
            reason: '$name 白名单条目已过期：${entry.key} "${item.key}"',
          );
          expect(item.value.trim(), isNotEmpty, reason: '白名单条目必须写理由');
        }
      }
    }
  });

  group('扫描器自检', () {
    test('跳过注释与 debugPrint，识别插值与原始字符串', () {
      const source = r'''
// "注释里的中文"
/* "块注释里的中文" */
final a = '你好 ${'嵌套'}';
final b = r'原始\n';
debugPrint('日志 $a');
final c = """
多行
""";
''';
      final values = extractStringLiterals(source).map((l) => l.value).toList();
      expect(values, containsAll(<String>['嵌套', r'原始\n']));
      expect(values.any((v) => v.contains('注释里')), isFalse);
      expect(values.any((v) => v.contains('日志')), isFalse);
      expect(values.any((v) => v.contains('多行')), isTrue);
      expect(values.any((v) => v.startsWith('你好')), isTrue);
    });

    test('检测到 CJK 与生成文件被排除', () {
      expect(hasCjk('abc'), isFalse);
      expect(hasCjk('a中'), isTrue);
      expect(hasCjk('，'), isTrue);
      expect(_isGenerated('l10n/app_localizations_zh.dart'), isTrue);
      expect(_isGenerated('l10n/core_text.dart'), isFalse);
    });
  });
}
