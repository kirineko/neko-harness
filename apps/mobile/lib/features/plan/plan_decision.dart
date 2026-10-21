import 'package:neko_mobile/features/questions/question_draft.dart';
import 'package:neko_mobile/l10n/l10n.dart';

/// 与网关 `PLAN_LIMITS` 一致；字符数按 UTF-16 码元，即 Dart 的 [String.length]。
class PlanLimits {
  const PlanLimits._();

  static const int feedbackChars = 2000;
}

/// `plan.respond` 的 decision：批准并执行，或带文字反馈要求修改。
sealed class PlanDecision {
  const PlanDecision();

  Map<String, Object?> toJson();
}

class ApprovePlan extends PlanDecision {
  const ApprovePlan();

  @override
  Map<String, Object?> toJson() => <String, Object?>{'kind': 'approve'};
}

class RevisePlan extends PlanDecision {
  const RevisePlan(this.feedback);

  /// 原样提交，trim 仅用于判断是否全空白。
  final String feedback;

  @override
  Map<String, Object?> toJson() => <String, Object?>{
    'kind': 'revise',
    'feedback': feedback,
  };
}

/// 修改反馈的校验；通过返回 null。规则与网关一致：1..2000 个码元，且不能全空白。
UiText? feedbackProblem(String feedback) {
  if (isBlankText(feedback)) return (l10n) => l10n.planProblemEmpty;
  if (feedback.length > PlanLimits.feedbackChars) {
    final length = feedback.length;
    return (l10n) => l10n.planProblemTooLong(length, PlanLimits.feedbackChars);
  }
  return null;
}
