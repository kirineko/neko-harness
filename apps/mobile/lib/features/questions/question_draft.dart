import 'dart:convert';

import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/l10n/l10n.dart';

/// 问答上限（与 `packages/core/src/interactions.ts` 的 `QUESTION_LIMITS` 一致）。
/// 字符数一律按 UTF-16 码元，即 Dart 的 [String.length]，不用 rune 数。
class QuestionLimits {
  const QuestionLimits._();

  static const int questionChars = 2000;
  static const int maxOptions = 12;
  static const int optionIdChars = 64;
  static const int labelChars = 200;
  static const int descriptionChars = 500;
  static const int textChars = 4000;

  /// 回答参数 JSON 的 UTF-8 字节上限。
  static const int responseBytes = 16384;
}

// ECMAScript `String.prototype.trim` 的空白集合；服务端用它判断“全空白”，
// 不能换成 Dart 的 trim（它还会裁掉 U+0085）。
final RegExp _jsBlank = RegExp(
  r'^[\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000-\u200a'
  r'\u2028\u2029\u202f\u205f\u3000\ufeff]*$',
);

bool isBlankText(String text) => _jsBlank.hasMatch(text);

/// 用户已输入但尚未提交的答案；所有前端共用同一规则。
class QuestionDraft {
  const QuestionDraft({this.optionIds = const <String>[], this.text = ''});

  final List<String> optionIds;
  final String text;

  QuestionDraft withText(String value) =>
      QuestionDraft(optionIds: optionIds, text: value);

  /// 单选替换唯一选择（再点一次取消）；多选逐项切换。
  QuestionDraft toggle(QuestionRecord question, String optionId) {
    final chosen = optionIds.contains(optionId);
    if (question.multiple) {
      return QuestionDraft(
        optionIds: chosen
            ? optionIds.where((id) => id != optionId).toList()
            : <String>[...optionIds, optionId],
        text: text,
      );
    }
    return QuestionDraft(
      optionIds: chosen ? const <String>[] : <String>[optionId],
      text: text,
    );
  }
}

/// `questions.respond` 的 response：回答或跳过。
sealed class QuestionResponse {
  const QuestionResponse();

  Map<String, Object?> toJson();
}

class AnswerResponse extends QuestionResponse {
  const AnswerResponse({this.optionIds = const <String>[], this.text});

  /// 按问题选项顺序。
  final List<String> optionIds;

  /// 原样保存，trim 仅用于判断是否全空白。
  final String? text;

  @override
  Map<String, Object?> toJson() => <String, Object?>{
    'kind': 'answer',
    if (optionIds.isNotEmpty) 'optionIds': optionIds,
    if (text != null) 'text': text,
  };
}

class SkipResponse extends QuestionResponse {
  const SkipResponse();

  @override
  Map<String, Object?> toJson() => const <String, Object?>{'kind': 'skip'};
}

/// 草稿将提交的回答；既无选项也无非空白文字时为 null。
AnswerResponse? draftResponse(QuestionRecord question, QuestionDraft draft) {
  final text = isBlankText(draft.text) ? null : draft.text;
  if (draft.optionIds.isEmpty && text == null) return null;
  final chosen = draft.optionIds.toSet();
  final ordered = <String>[
    for (final option in question.options)
      if (chosen.contains(option.id)) option.id,
    // 题目不再列出的 id 保持原样，交给校验报告。
    for (final id in draft.optionIds)
      if (question.option(id) == null) id,
  ];
  return AnswerResponse(optionIds: ordered, text: text);
}

/// 草稿为何不能提交；可提交时为 null。规则与服务端 `draftProblem` 一致。
UiText? draftProblem(QuestionRecord question, QuestionDraft draft) {
  final response = draftResponse(question, draft);
  if (response == null) return (l10n) => l10n.questionProblemEmpty;
  final ids = draft.optionIds;
  if (ids.length > QuestionLimits.maxOptions) {
    return (l10n) =>
        l10n.questionProblemTooManyOptions(QuestionLimits.maxOptions);
  }
  if (ids.toSet().length != ids.length) {
    return (l10n) => l10n.questionProblemDuplicate;
  }
  for (final id in ids) {
    if (question.option(id) == null) {
      return (l10n) => l10n.questionProblemOptionGone;
    }
  }
  if (question.options.isEmpty && ids.isNotEmpty) {
    return (l10n) => l10n.questionProblemNoOptions;
  }
  if (!question.multiple && ids.length > 1) {
    return (l10n) => l10n.questionProblemSingleOnly;
  }
  final text = response.text;
  if (text != null && text.length > QuestionLimits.textChars) {
    final length = text.length;
    return (l10n) =>
        l10n.questionProblemTextTooLong(length, QuestionLimits.textChars);
  }
  if (utf8.encode(jsonEncode(response.toJson())).length >
      QuestionLimits.responseBytes) {
    return (l10n) => l10n.questionProblemTooLarge(QuestionLimits.responseBytes);
  }
  return null;
}
