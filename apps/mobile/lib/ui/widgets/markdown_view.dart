import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/theme.dart';
import 'package:neko_mobile/ui/widgets/math_markdown.dart';

/// 助手正文 Markdown：不渲染 HTML（原样显示为文本），代码块、表格与块级公式独立横向滚动，支持 LaTeX 公式。
class NekoMarkdown extends StatelessWidget {
  const NekoMarkdown(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    final theme = Theme.of(context);
    final base = MarkdownStyleSheet.fromTheme(theme);
    return MarkdownBody(
      data: escapeHtml(text),
      selectable: true,
      softLineBreak: true,
      inlineSyntaxes: <md.InlineSyntax>[
        MathInlineSyntax(),
        MathLiteralSyntax(),
      ],
      blockSyntaxes: const <md.BlockSyntax>[MathBlockSyntax()],
      builders: <String, MarkdownElementBuilder>{
        mathInlineTag: MathBuilder(),
        mathBlockTag: MathBuilder(),
      },
      styleSheet: base.copyWith(
        p: theme.textTheme.bodyMedium,
        h1: theme.textTheme.headlineSmall,
        h2: theme.textTheme.titleLarge,
        h3: theme.textTheme.titleMedium,
        h4: theme.textTheme.titleSmall,
        h5: theme.textTheme.titleSmall,
        h6: theme.textTheme.titleSmall,
        listBullet: theme.textTheme.bodyMedium,
        blockSpacing: NekoSpace.sm,
        code: NekoTokens.code.copyWith(
          backgroundColor: tokens.codeInline,
          color: tokens.text,
        ),
        codeblockDecoration: BoxDecoration(
          color: tokens.codeInline,
          borderRadius: BorderRadius.circular(NekoTokens.radiusControl),
        ),
        codeblockPadding: const EdgeInsets.all(NekoSpace.sm),
        blockquoteDecoration: BoxDecoration(
          border: Border(left: BorderSide(color: tokens.border, width: 2)),
        ),
        tableBorder: TableBorder.all(color: tokens.border, width: 0.5),
        tableCellsPadding: const EdgeInsets.symmetric(
          horizontal: NekoSpace.sm,
          vertical: NekoSpace.xs,
        ),
        tableScrollbarThumbVisibility: false,
      ),
      onTapLink: (text, href, title) {},
      // 远程图片不自动加载：避免提示注入借手机发起请求（泄露数据/探测局域网）。
      imageBuilder: (uri, title, alt) =>
          Text(context.l10n.markdownImage(alt ?? uri.toString())),
    );
  }
}

final RegExp _fence = RegExp(r'^\s*(```|~~~)');
final RegExp _inlineCode = RegExp(r'`[^`]*`');

/// 在代码区之外把 `<` 转义为 Markdown 反斜杠转义，使 HTML 标签按原文显示。
String escapeHtml(String source) {
  final out = StringBuffer();
  var inFence = false;
  final lines = source.split('\n');
  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    if (_fence.hasMatch(line)) {
      inFence = !inFence;
      out.write(line);
    } else if (inFence || line.startsWith('    ') || line.startsWith('\t')) {
      out.write(line);
    } else {
      var last = 0;
      for (final match in _inlineCode.allMatches(line)) {
        out
          ..write(line.substring(last, match.start).replaceAll('<', r'\<'))
          ..write(match.group(0));
        last = match.end;
      }
      out.write(line.substring(last).replaceAll('<', r'\<'));
    }
    if (i < lines.length - 1) out.write('\n');
  }
  return out.toString();
}
