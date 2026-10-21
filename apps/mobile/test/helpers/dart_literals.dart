/// 一个 Dart 字符串字面量（只含正文，不含引号；插值表达式里的字面量单独成条）。
class StringLiteral {
  const StringLiteral(this.value, this.line, this.codeBefore);

  final String value;
  final int line;

  /// 字面量所在行中它之前的代码，用来识别 `Text(`、`tooltip:` 等位置。
  final String codeBefore;
}

/// 提取源码里的字符串字面量，跳过行注释与块注释，以及 `debugPrint(` 所在语句（日志不译）。
/// 够用的词法扫描：支持单/双引号、三引号、原始字符串与 `${}` 插值嵌套。
List<StringLiteral> extractStringLiterals(String source) {
  final out = <StringLiteral>[];
  _Scanner(source, out).scanCode(0, topLevel: true);
  return out;
}

class _Scanner {
  _Scanner(this.s, this.out);

  final String s;
  final List<StringLiteral> out;

  int lineAt(int index) {
    var line = 1;
    for (var i = 0; i < index && i < s.length; i++) {
      if (s.codeUnitAt(i) == 0x0a) line++;
    }
    return line;
  }

  String lineStart(int index) {
    var start = index;
    while (start > 0 && s.codeUnitAt(start - 1) != 0x0a) {
      start--;
    }
    return s.substring(start, index);
  }

  bool _isDebugPrint(int index) => lineStart(index).contains('debugPrint(');

  /// 从 [from] 起扫描代码；遇到不配对的 `}`（插值结束）返回其下标。
  int scanCode(int from, {bool topLevel = false}) {
    var i = from;
    var depth = 0;
    while (i < s.length) {
      final c = s[i];
      if (c == '/' && i + 1 < s.length && s[i + 1] == '/') {
        while (i < s.length && s[i] != '\n') {
          i++;
        }
      } else if (c == '/' && i + 1 < s.length && s[i + 1] == '*') {
        final end = s.indexOf('*/', i + 2);
        i = end < 0 ? s.length : end + 2;
      } else if (c == '{') {
        depth++;
        i++;
      } else if (c == '}') {
        if (depth == 0 && !topLevel) return i;
        depth--;
        i++;
      } else if (c == "'" || c == '"') {
        final raw = i > 0 && s[i - 1] == 'r';
        i = _scanString(i, raw: raw);
      } else {
        i++;
      }
    }
    return i;
  }

  int _scanString(int start, {required bool raw}) {
    final quote = s[start];
    final triple = s.startsWith(quote * 3, start);
    final open = triple ? 3 : 1;
    var i = start + open;
    final buffer = StringBuffer();
    final pending = <StringLiteral>[];
    final inDebug = _isDebugPrint(start);
    while (i < s.length) {
      final c = s[i];
      if (!raw && c == r'\') {
        buffer.write(s.substring(i, i + 2 > s.length ? s.length : i + 2));
        i += 2;
        continue;
      }
      if (triple ? s.startsWith(quote * 3, i) : c == quote) {
        i += open;
        break;
      }
      if (!raw && c == r'$' && i + 1 < s.length && s[i + 1] == '{') {
        i = scanCode(i + 2) + 1;
        continue;
      }
      if (c == '\n' && !triple) {
        i++;
        break;
      }
      buffer.write(c);
      i++;
    }
    if (!inDebug) {
      pending.add(
        StringLiteral(buffer.toString(), lineAt(start), lineStart(start)),
      );
    }
    out.addAll(pending);
    return i;
  }
}
