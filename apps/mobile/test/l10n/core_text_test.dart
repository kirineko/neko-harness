import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/l10n/core_text.dart';
import 'package:neko_mobile/l10n/l10n.dart';

import '../helpers/l10n_support.dart';

List<Map<String, dynamic>> _list(Map<String, dynamic> data, String key) =>
    (data[key] as List<dynamic>).cast<Map<String, dynamic>>();

void main() {
  final fixture = readJson(coreUiStringsFile);
  final zh = lookupAppLocalizations(kLocaleZh);
  final en = lookupAppLocalizations(kLocaleEn);

  group('运行状态', () {
    for (final entry in _list(fixture, 'status')) {
      final text = entry['text'] as String;
      final params =
          (entry['params'] as Map<String, dynamic>?) ??
          const <String, dynamic>{};
      test('${entry['id']}: $text', () {
        final inZh = localizeStatus(zh, text);
        final inEn = localizeStatus(en, text);
        expect(inZh, isNot(text), reason: 'zh 下必须有映射');
        expect(hasCjk(inZh), isTrue);
        expect(hasCjk(inEn), isFalse, reason: 'en 下不得出现 CJK');
        for (final value in params.values) {
          expect(inZh, contains(value), reason: '参数原样保留');
          expect(inEn, contains(value));
        }
      });
    }

    test('英文映射与夹具同义（省略号用 …）', () {
      expect(localizeStatus(en, 'Thinking...'), 'Thinking…');
      expect(localizeStatus(en, 'Running bash...'), 'Running bash…');
      expect(localizeStatus(zh, 'Running bash...'), '运行 bash…');
      expect(
        localizeStatus(en, 'Retrying (attempt 2)...'),
        'Retrying (attempt 2)…',
      );
    });

    test('工具名按原文保留（含空格与非 ASCII）', () {
      expect(localizeStatus(zh, 'Running my tool...'), '运行 my tool…');
      expect(localizeStatus(zh, 'Running 编辑...'), '运行 编辑…');
    });

    test('未知状态回退原文', () {
      for (final text in <String>[
        '',
        'Compacting...',
        'Running ...',
        'Retrying (attempt x)...',
        'Retrying (attempt 99999999999999999999)...',
        'running bash...',
        '思考中',
      ]) {
        expect(localizeStatus(zh, text), text);
        expect(localizeStatus(en, text), text);
      }
    });
  });

  group('系统行', () {
    for (final entry in _list(fixture, 'systemRows')) {
      final text = entry['text'] as String;
      test('${entry['id']}: $text', () {
        expect(localizeSystemRow(zh, text), isNot(text));
        expect(hasCjk(localizeSystemRow(zh, text)), isTrue);
        expect(hasCjk(localizeSystemRow(en, text)), isFalse);
      });
    }

    test('未知系统行回退原文', () {
      expect(localizeSystemRow(zh, '[something else]'), '[something else]');
      expect(localizeSystemRow(en, '[something else]'), '[something else]');
    });
  });

  group('工具卡补充', () {
    for (final entry in _list(fixture, 'toolNotes')) {
      final text = entry['text'] as String;
      test('${entry['id']}: $text', () {
        expect(localizeToolNote(zh, text), isNot(text));
        expect(hasCjk(localizeToolNote(zh, text)), isTrue);
        expect(hasCjk(localizeToolNote(en, text)), isFalse);
      });
    }

    test('未知补充说明回退原文', () {
      expect(localizeToolNote(zh, 'Not run: other.'), 'Not run: other.');
    });
  });

  group('错误码', () {
    for (final entry in _list(fixture, 'errors')) {
      final text = entry['text'] as String;
      final code = entry['code'] as String;
      test(code, () {
        final inZh = localizeCoreError(zh, text);
        final inEn = localizeCoreError(en, text);
        expect(inZh, isNot(text), reason: 'zh 下必须有映射');
        expect(hasCjk(inZh), isTrue);
        expect(inZh, startsWith('$code:'), reason: '错误码原样保留，判定依赖它');
        expect(inEn, startsWith('$code:'));
        expect(hasCjk(inEn), isFalse);
      });
    }

    test('provider 名按原文保留', () {
      final disabled =
          _list(
                fixture,
                'errors',
              ).firstWhere((e) => e['code'] == 'PROVIDER_DISABLED')['text']
              as String;
      expect(localizeCoreError(zh, disabled), contains('OpenRouter'));
      expect(localizeCoreError(en, disabled), contains('OpenRouter'));
      final key =
          _list(
                fixture,
                'errors',
              ).firstWhere((e) => e['code'] == 'PROVIDER_KEY_REQUIRED')['text']
              as String;
      expect(localizeCoreError(zh, key), contains('DeepSeek'));
    });

    test('未知错误与措辞漂移的错误回退原文', () {
      expect(
        localizeCoreError(zh, 'SOMETHING_ELSE: boom'),
        'SOMETHING_ELSE: boom',
      );
      expect(
        localizeCoreError(zh, 'PROVIDER_DISABLED: reworded'),
        'PROVIDER_DISABLED: reworded',
      );
      expect(localizeCoreError(zh, ''), '');
    });
  });

  test('夹具覆盖四类文案，避免映射表与夹具脱节', () {
    expect(_list(fixture, 'status'), isNotEmpty);
    expect(_list(fixture, 'systemRows'), isNotEmpty);
    expect(_list(fixture, 'toolNotes'), isNotEmpty);
    expect(
      _list(fixture, 'errors').map((e) => e['code']),
      containsAll(<String>[
        'PROVIDER_DISABLED',
        'PROVIDER_KEY_REQUIRED',
        'PLAN_BUSY',
      ]),
    );
  });
}
