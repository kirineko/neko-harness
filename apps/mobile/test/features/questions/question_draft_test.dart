import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/features/questions/question_draft.dart';

import '../../helpers/interaction_data.dart';

QuestionRecord _single() => QuestionRecord.fromJson(questionJson());

QuestionRecord _multiple() =>
    QuestionRecord.fromJson(questionJson(multiple: true, question: '需要哪些数据库？'));

QuestionRecord _freeText() =>
    QuestionRecord.fromJson(questionJson(options: <Map<String, dynamic>>[]));

/// 与服务端 `draftProblem`（packages/core/src/interactions.ts）同一组规则。
void main() {
  group('可提交条件', () {
    test('没有选项也没有非空白文字：不可提交', () {
      expect(draftProblem(_single(), const QuestionDraft()), isNotNull);
      expect(
        draftProblem(_single(), const QuestionDraft(text: '  \n\t ')),
        isNotNull,
      );
      expect(draftResponse(_single(), const QuestionDraft(text: ' ')), isNull);
    });

    test('只选选项、只写文字、两者都有：均可提交', () {
      expect(
        draftProblem(_single(), const QuestionDraft(optionIds: <String>['pg'])),
        isNull,
      );
      expect(
        draftProblem(_single(), const QuestionDraft(text: '自定义答案')),
        isNull,
      );
      expect(
        draftProblem(
          _single(),
          const QuestionDraft(optionIds: <String>['lite'], text: '补充'),
        ),
        isNull,
      );
    });

    test('单选至多一个选项；多选可多个且按题目选项顺序规范化', () {
      expect(
        draftProblem(
          _single(),
          const QuestionDraft(optionIds: <String>['pg', 'my']),
        ),
        isNotNull,
      );
      const draft = QuestionDraft(optionIds: <String>['lite', 'pg']);
      expect(draftProblem(_multiple(), draft), isNull);
      expect(draftResponse(_multiple(), draft)?.optionIds, <String>[
        'pg',
        'lite',
      ]);
    });

    test('未知/重复选项与无选项问题带选项：拒绝', () {
      expect(
        draftProblem(
          _multiple(),
          const QuestionDraft(optionIds: <String>['nope']),
        ),
        isNotNull,
      );
      expect(
        draftProblem(
          _multiple(),
          const QuestionDraft(optionIds: <String>['pg', 'pg']),
        ),
        isNotNull,
      );
      expect(
        draftProblem(
          _freeText(),
          const QuestionDraft(optionIds: <String>['pg'], text: 'x'),
        ),
        isNotNull,
      );
      expect(
        draftProblem(_freeText(), const QuestionDraft(text: '答案')),
        isNull,
      );
    });

    test('文字原样保存，trim 只用于判断是否全空白', () {
      final response = draftResponse(
        _single(),
        const QuestionDraft(optionIds: <String>['pg'], text: '  两侧空白 '),
      );
      expect(response?.text, '  两侧空白 ');
      expect(
        draftResponse(
          _single(),
          const QuestionDraft(optionIds: <String>['pg'], text: '   '),
        )?.text,
        isNull,
      );
    });

    test('空白判断沿用 JS trim：U+0085 不是空白（Dart trim 会裁掉它）', () {
      expect('\u0085'.trim(), isEmpty, reason: '前提：Dart trim 把 NEL 当空白');
      expect(isBlankText('\u0085'), isFalse);
      expect(
        draftProblem(_single(), const QuestionDraft(text: '\u0085')),
        isNull,
      );
      for (final blank in <String>[
        ' ',
        '\t\n\r',
        '\u00a0',
        '\u3000',
        '\ufeff',
        '\u2028',
      ]) {
        expect(isBlankText(blank), isTrue, reason: blank.codeUnits.toString());
      }
    });
  });

  group('UTF-16 码元上限（不是 rune 数）', () {
    test('4000 个码元可用；4001 个被拒绝', () {
      expect(
        draftProblem(_freeText(), QuestionDraft(text: 'a' * 4000)),
        isNull,
      );
      final problem = draftProblem(
        _freeText(),
        QuestionDraft(text: 'a' * 4001),
      );
      expect(resolveUiText(problem!, kLocaleZh), contains('4001'));
    });

    test('emoji 占 2 个码元：2000 个恰好满额，2001 个 rune 远低于 4000 仍被拒绝', () {
      final ok = '😀' * 2000;
      final over = '😀' * 2001;
      expect(ok.length, 4000);
      expect(ok.runes.length, 2000);
      expect(over.runes.length, 2001);
      expect(draftProblem(_freeText(), QuestionDraft(text: ok)), isNull);
      expect(draftProblem(_freeText(), QuestionDraft(text: over)), isNotNull);
    });

    test('多字节中文按码元计：4000 个汉字可用，4001 个被拒绝', () {
      expect(
        draftProblem(_freeText(), QuestionDraft(text: '汉' * 4000)),
        isNull,
      );
      expect(
        draftProblem(_freeText(), QuestionDraft(text: '汉' * 4001)),
        isNotNull,
      );
    });

    test('回答 JSON 的 UTF-8 字节上限 16384：转义膨胀按实际字节计算', () {
      // 4000 个控制字符各转义为 6 字节（\u0001），码元数合规但 JSON 超过 16 KiB。
      final bloated = '\u0001' * 4000;
      final problem = draftProblem(_freeText(), QuestionDraft(text: bloated));
      expect(resolveUiText(problem!, kLocaleZh), contains('16384'));
      // 2500 个控制字符（15000 字节 + 包装）仍在上限内。
      expect(
        draftProblem(_freeText(), QuestionDraft(text: '\u0001' * 2500)),
        isNull,
      );
      final response = draftResponse(
        _freeText(),
        QuestionDraft(text: bloated),
      )!;
      expect(
        utf8.encode(jsonEncode(response.toJson())).length,
        greaterThan(QuestionLimits.responseBytes),
      );
    });
  });

  group('草稿切换', () {
    test('单选：选另一项替换，再点同一项取消', () {
      var draft = const QuestionDraft();
      draft = draft.toggle(_single(), 'pg');
      expect(draft.optionIds, <String>['pg']);
      draft = draft.toggle(_single(), 'my');
      expect(draft.optionIds, <String>['my']);
      draft = draft.toggle(_single(), 'my');
      expect(draft.optionIds, isEmpty);
    });

    test('多选逐项切换并保留文字', () {
      var draft = const QuestionDraft(text: '备注');
      draft = draft.toggle(_multiple(), 'pg').toggle(_multiple(), 'lite');
      expect(draft.optionIds, <String>['pg', 'lite']);
      draft = draft.toggle(_multiple(), 'pg');
      expect(draft.optionIds, <String>['lite']);
      expect(draft.text, '备注');
    });
  });

  test('response JSON：answer 省略空字段，skip 只有 kind', () {
    expect(
      const AnswerResponse(optionIds: <String>['pg']).toJson(),
      <String, Object?>{
        'kind': 'answer',
        'optionIds': <String>['pg'],
      },
    );
    expect(const AnswerResponse(text: '文字').toJson(), <String, Object?>{
      'kind': 'answer',
      'text': '文字',
    });
    expect(const SkipResponse().toJson(), <String, Object?>{'kind': 'skip'});
  });
}
