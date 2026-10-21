import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

/// 仓库根目录：测试从 apps/mobile 运行，共享契约文件都经这里定位。
final Directory repoRoot = () {
  var dir = Directory.current.absolute;
  while (!File('${dir.path}/packages/core/src/i18n/protected-terms.json')
      .existsSync()) {
    final parent = dir.parent;
    if (parent.path == dir.path) {
      throw StateError(
        '找不到仓库根目录（缺少 packages/core/src/i18n/protected-terms.json）',
      );
    }
    dir = parent;
  }
  return dir;
}();

/// 共享保护词清单（core 持有，三端对拍）。
File get protectedTermsFile =>
    File('${repoRoot.path}/packages/core/src/i18n/protected-terms.json');

/// core 推送英文串的共享夹具。
File get coreUiStringsFile =>
    File('${repoRoot.path}/packages/core/test/fixtures/core-ui-strings.json');

Directory get mobileLibDir => Directory('${Directory.current.path}/lib');

Directory get mobileL10nDir => Directory('${Directory.current.path}/lib/l10n');

Map<String, dynamic> readJson(File file) =>
    jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;

/// ARB 里的文案条目（排除 `@` 元数据与 `@@locale`）。
Map<String, String> readArbMessages(String name) {
  final data = readJson(File('${mobileL10nDir.path}/$name'));
  return <String, String>{
    for (final entry in data.entries)
      if (!entry.key.startsWith('@')) entry.key: entry.value as String,
  };
}

/// ARB 里的 `@key` 元数据（占位符声明）。
Map<String, dynamic> readArbMeta(String name) {
  final data = readJson(File('${mobileL10nDir.path}/$name'));
  return <String, dynamic>{
    for (final entry in data.entries)
      if (entry.key.startsWith('@') && !entry.key.startsWith('@@'))
        entry.key.substring(1): entry.value,
  };
}

final RegExp _placeholderPattern = RegExp(r'\{(\w+)\}');

Set<String> placeholdersOf(String message) => <String>{
  for (final m in _placeholderPattern.allMatches(message)) m.group(1)!,
};

class ProtectedTerm {
  const ProtectedTerm(this.term, this.kind, this.auto);

  final String term;
  final String kind;
  final bool auto;
}

List<ProtectedTerm> loadProtectedTerms() {
  final data = readJson(protectedTermsFile);
  return <ProtectedTerm>[
    for (final raw in data['terms'] as List<dynamic>)
      ProtectedTerm(
        (raw as Map<String, dynamic>)['term'] as String,
        raw['kind'] as String,
        raw['auto'] != false,
      ),
  ];
}

bool _isWord(String char) => RegExp(r'[A-Za-z0-9_]').hasMatch(char);

/// 与 core 的 `findProtectedTerms` 同一规则：大小写敏感、词边界，
/// 以词字符结尾的词其后不能紧跟词字符或连字符；`auto: false` 的普通英文词默认跳过。
Set<String> findProtectedTerms(
  String text,
  List<ProtectedTerm> terms, {
  bool includeAmbiguous = false,
}) {
  final found = <String>{};
  for (final entry in terms) {
    if (!entry.auto && !includeAmbiguous) continue;
    var from = 0;
    while (true) {
      final at = text.indexOf(entry.term, from);
      if (at < 0) break;
      from = at + 1;
      if (at > 0 && _isWord(text[at - 1])) continue;
      final end = at + entry.term.length;
      if (_isWord(entry.term[entry.term.length - 1]) &&
          end < text.length &&
          (_isWord(text[end]) || text[end] == '-')) {
        continue;
      }
      found.add(entry.term);
      break;
    }
  }
  return found;
}

final RegExp cjkPattern = RegExp(
  r'[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]',
);

bool hasCjk(String text) => cjkPattern.hasMatch(text);

/// 界面上当前可见的全部文案：文本、提示、输入框提示、语义标签。
List<String> visibleStrings(WidgetTester tester) {
  final out = <String>[];
  void add(String? text) {
    if (text != null && text.isNotEmpty) out.add(text);
  }

  void visit(Element element) {
    final widget = element.widget;
    if (widget is Text) {
      add(widget.data ?? widget.textSpan?.toPlainText());
    } else if (widget is RichText) {
      add(widget.text.toPlainText());
    } else if (widget is Tooltip) {
      add(widget.message);
    } else if (widget is Semantics) {
      add(widget.properties.label);
      add(widget.properties.hint);
      add(widget.properties.tooltip);
    } else if (widget is TextField) {
      add(widget.decoration?.hintText);
      add(widget.decoration?.labelText);
    }
    element.visitChildren(visit);
  }

  visit(tester.binding.rootElement!);
  return out;
}

/// 界面里含 CJK 的文案，排除 [data]（对话、计划、技能名等不翻译的数据）与语言名本身。
List<String> cjkResidue(
  WidgetTester tester, {
  Iterable<String> data = const <String>[],
}) {
  final allowed = <String>['中文', ...data];
  return <String>[
    for (final text in visibleStrings(tester))
      if (hasCjk(text) && !allowed.any(text.contains)) text,
  ];
}

/// 当前语义树里的全部无障碍标签（含提示）。
List<String> semanticsLabels(WidgetTester tester) {
  final out = <String>[];
  void visit(SemanticsNode node) {
    if (node.label.isNotEmpty) out.add(node.label);
    if (node.hint.isNotEmpty) out.add(node.hint);
    if (node.tooltip.isNotEmpty) out.add(node.tooltip);
    node.visitChildren((child) {
      visit(child);
      return true;
    });
  }

  // 语义树挂在视图自己的 PipelineOwner 上；需先 tester.ensureSemantics()。
  final root =
      tester.binding.renderViews.first.owner?.semanticsOwner?.rootSemanticsNode;
  expect(root, isNotNull, reason: '语义树不可用，先调用 tester.ensureSemantics()');
  visit(root!);
  return out;
}
