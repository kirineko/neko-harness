import 'package:flutter/material.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/features/chat/interactions_controller.dart';
import 'package:neko_mobile/features/plan/plan_decision.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';
import 'package:neko_mobile/ui/widgets/markdown_view.dart';

String planStatusLabel(AppLocalizations l10n, PlanStatus status) =>
    switch (status) {
      PlanStatus.awaitingApproval => l10n.planStatusAwaiting,
      PlanStatus.approved => l10n.planStatusApproved,
      PlanStatus.revisionRequested => l10n.planStatusRevisionRequested,
      PlanStatus.superseded => l10n.planStatusSuperseded,
      PlanStatus.cancelled => l10n.planStatusCancelled,
    };

/// 输入区上方的“等待批准”条：有待批准计划（或本端刚做出的决定）时出现，打开计划 sheet。
/// 电脑不声明 `plan` 能力、或没有待批准计划时不占位。
class PlanBar extends StatelessWidget {
  const PlanBar({super.key, required this.interactions});

  final InteractionsController interactions;

  @override
  Widget build(BuildContext context) {
    final plan = interactions.planShown;
    if (plan == null) return const SizedBox.shrink();
    final tokens = NekoTokens.of(context);
    final label = plan.awaiting
        ? context.l10n.planStatusAwaiting
        : planStatusLabel(context.l10n, plan.status);
    return Material(
      color: tokens.primary.withValues(alpha: 0.1),
      child: Semantics(
        button: true,
        label: context.l10n.planBarSemantics(label, plan.title),
        excludeSemantics: true,
        child: InkWell(
          key: const Key('plan-bar'),
          onTap: () => showPlanSheet(context, interactions),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: NekoSpace.md),
              child: Row(
                children: <Widget>[
                  NekoIcon(NekoIcons.list, color: tokens.primary),
                  const SizedBox(width: NekoSpace.sm),
                  Text(
                    label,
                    key: const Key('plan-bar-status'),
                    style: TextStyle(
                      color: tokens.text,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: NekoSpace.sm),
                  Expanded(
                    child: Text(
                      plan.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.small(tokens.textMuted),
                    ),
                  ),
                  const NekoIcon(NekoIcons.chevronUp),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 计划 sheet：关闭/下拉只是关闭（计划仍待批准），批准与要求修改各有独立按钮。
Future<void> showPlanSheet(
  BuildContext context,
  InteractionsController interactions,
) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (context) => PlanSheet(interactions: interactions),
  );
}

class PlanSheet extends StatefulWidget {
  const PlanSheet({super.key, required this.interactions});

  final InteractionsController interactions;

  @override
  State<PlanSheet> createState() => _PlanSheetState();
}

class _PlanSheetState extends State<PlanSheet> {
  InteractionsController get _interactions => widget.interactions;

  @override
  Widget build(BuildContext context) {
    final keyboard = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: keyboard),
      child: SafeArea(
        top: false,
        child: ListenableBuilder(
          listenable: _interactions,
          builder: (context, _) {
            final plan = _interactions.planShown;
            return Column(
              key: const Key('plan-sheet'),
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                const _Header(),
                Flexible(
                  child: plan == null
                      ? const _Gone()
                      : plan.awaiting
                      ? _PlanEditor(
                          key: ValueKey<String>(plan.version),
                          interactions: _interactions,
                          plan: plan,
                        )
                      : _PlanFinal(interactions: _interactions, plan: plan),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header();

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Padding(
      padding: const EdgeInsets.only(left: NekoSpace.md),
      child: Row(
        children: <Widget>[
          NekoIcon(NekoIcons.list, color: tokens.primary),
          const SizedBox(width: NekoSpace.sm),
          Flexible(
            child: Semantics(
              header: true,
              child: Text(
                context.l10n.planHeader,
                key: const Key('plan-label'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
          ),
          const Spacer(),
          IconButton(
            key: const Key('plan-close'),
            tooltip: context.l10n.planCloseTooltip,
            constraints: const BoxConstraints(
              minWidth: NekoSpace.touch,
              minHeight: NekoSpace.touch,
            ),
            onPressed: () => Navigator.of(context).maybePop(),
            icon: const NekoIcon(NekoIcons.close),
          ),
        ],
      ),
    );
  }
}

class _Gone extends StatelessWidget {
  const _Gone();

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Padding(
      padding: const EdgeInsets.all(NekoSpace.xl),
      child: Column(
        key: const Key('plan-gone'),
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(context.l10n.planGone, style: context.small(tokens.textMuted)),
          const SizedBox(height: NekoSpace.sm),
          FilledButton(
            key: const Key('plan-done'),
            onPressed: () => Navigator.of(context).maybePop(),
            child: Text(context.l10n.commonClose),
          ),
        ],
      ),
    );
  }
}

/// 标题按纯文本显示；步骤与说明按 Markdown 渲染（[NekoMarkdown]：不渲染 HTML、不开链接、不加载远程图片）。
class _PlanBody extends StatelessWidget {
  const _PlanBody({required this.plan});

  final PlanRecord plan;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          plan.title,
          key: const Key('plan-title'),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: NekoSpace.sm),
        for (var i = 0; i < plan.steps.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: NekoSpace.xs),
            child: Row(
              key: Key('plan-step-${i + 1}'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SizedBox(
                  width: 28,
                  child: Text(
                    '${i + 1}.',
                    style: TextStyle(color: tokens.textMuted),
                  ),
                ),
                Expanded(child: NekoMarkdown(plan.steps[i])),
              ],
            ),
          ),
        if (plan.note.isNotEmpty) ...<Widget>[
          const SizedBox(height: NekoSpace.xs),
          NekoMarkdown(plan.note, key: const Key('plan-note')),
        ],
      ],
    );
  }
}

class _PlanEditor extends StatefulWidget {
  const _PlanEditor({
    super.key,
    required this.interactions,
    required this.plan,
  });

  final InteractionsController interactions;
  final PlanRecord plan;

  @override
  State<_PlanEditor> createState() => _PlanEditorState();
}

class _PlanEditorState extends State<_PlanEditor> {
  late final TextEditingController _feedback = TextEditingController(
    text: widget.interactions.planFeedbackDraft(widget.plan),
  );
  late bool _revising = _feedback.text.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _feedback.addListener(_onChanged);
  }

  @override
  void dispose() {
    _feedback.dispose();
    super.dispose();
  }

  void _onChanged() {
    widget.interactions.savePlanFeedback(widget.plan, _feedback.text);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final interactions = widget.interactions;
    final tokens = NekoTokens.of(context);
    final connected = interactions.connected;
    final submitting = interactions.planSubmitting;
    final error = interactions.planError;
    final text = _feedback.text;
    final problem = _revising ? feedbackProblem(text) : null;
    final overLimit = text.length > PlanLimits.feedbackChars;
    final enabled = connected && !submitting;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Flexible(
          child: SingleChildScrollView(
            key: const Key('plan-scroll'),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: const EdgeInsets.symmetric(horizontal: NekoSpace.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (!connected)
                  _Notice(
                    key: const Key('plan-offline'),
                    text: context.l10n.planOffline,
                    color: tokens.warning,
                  ),
                _PlanBody(plan: widget.plan),
                if (_revising) ...<Widget>[
                  const SizedBox(height: NekoSpace.md),
                  TextField(
                    key: const Key('plan-feedback-input'),
                    controller: _feedback,
                    enabled: !submitting,
                    minLines: 3,
                    maxLines: 6,
                    keyboardType: TextInputType.multiline,
                    textInputAction: TextInputAction.newline,
                    decoration: InputDecoration(
                      labelText: context.l10n.planFeedbackLabel,
                      alignLabelWithHint: true,
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(top: NekoSpace.xs),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Expanded(
                          child: overLimit && problem != null
                              ? Text(
                                  problem(context.l10n),
                                  key: const Key('plan-problem'),
                                  style: context.small(tokens.danger),
                                )
                              : const SizedBox.shrink(),
                        ),
                        Text(
                          '${text.length}/${PlanLimits.feedbackChars}',
                          key: const Key('plan-counter'),
                          style: context.meta(
                            overLimit ? tokens.danger : tokens.textFaint,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: NekoSpace.sm),
                    child: _Notice(
                      key: const Key('plan-error'),
                      text: error(context.l10n),
                      color: tokens.danger,
                    ),
                  ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            NekoSpace.md,
            NekoSpace.xs,
            NekoSpace.md,
            NekoSpace.sm,
          ),
          child: _revising
              ? Row(
                  children: <Widget>[
                    Expanded(
                      child: OutlinedButton(
                        key: const Key('plan-feedback-cancel'),
                        style: _compact,
                        onPressed: submitting
                            ? null
                            : () => setState(() => _revising = false),
                        child: Text(context.l10n.commonBack),
                      ),
                    ),
                    const SizedBox(width: NekoSpace.sm),
                    Expanded(
                      flex: 2,
                      child: FilledButton(
                        key: const Key('plan-feedback-submit'),
                        onPressed: enabled && problem == null
                            ? () => interactions.respondPlan(
                                widget.plan,
                                RevisePlan(text),
                              )
                            : null,
                        child: _Label(
                          submitting,
                          context.l10n.planSubmitFeedback,
                        ),
                      ),
                    ),
                  ],
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    FilledButton(
                      key: const Key('plan-approve'),
                      onPressed: enabled
                          ? () => interactions.respondPlan(
                              widget.plan,
                              const ApprovePlan(),
                            )
                          : null,
                      child: _Label(submitting, context.l10n.planApprove),
                    ),
                    const SizedBox(height: NekoSpace.sm),
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: OutlinedButton(
                            key: const Key('plan-revise'),
                            style: _compact,
                            onPressed: enabled
                                ? () => setState(() => _revising = true)
                                : null,
                            child: Text(context.l10n.planRevise),
                          ),
                        ),
                        const SizedBox(width: NekoSpace.sm),
                        Expanded(
                          child: OutlinedButton(
                            key: const Key('plan-exit'),
                            style: _compact.copyWith(
                              foregroundColor: WidgetStateProperty.resolveWith(
                                (states) =>
                                    states.contains(WidgetState.disabled)
                                    ? null
                                    : tokens.danger,
                              ),
                              side: WidgetStateProperty.resolveWith(
                                (states) => BorderSide(
                                  color: states.contains(WidgetState.disabled)
                                      ? tokens.border
                                      : tokens.danger.withValues(alpha: 0.5),
                                ),
                              ),
                            ),
                            onPressed: enabled ? interactions.exitPlan : null,
                            child: Text(
                              context.l10n.planExit,
                              textAlign: TextAlign.center,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
        ),
      ],
    );
  }
}

/// 同排按钮平分宽度，内边距收窄，使「取消并退出计划模式」在窄屏上仍单行显示。
final ButtonStyle _compact = OutlinedButton.styleFrom(
  padding: const EdgeInsets.symmetric(horizontal: NekoSpace.sm),
);

class _Label extends StatelessWidget {
  const _Label(this.submitting, this.text);

  final bool submitting;
  final String text;

  @override
  Widget build(BuildContext context) {
    if (!submitting) return Text(text);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const SizedBox.square(
          dimension: 16,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
        const SizedBox(width: NekoSpace.sm),
        Text(context.l10n.commonSubmitting),
      ],
    );
  }
}

/// 已结算的计划：显示服务端实际保存的状态，他端先决定时附说明。
class _PlanFinal extends StatelessWidget {
  const _PlanFinal({required this.interactions, required this.plan});

  final InteractionsController interactions;
  final PlanRecord plan;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    final note = interactions.planNote;
    final feedback = plan.feedback;
    final l10n = context.l10n;
    final (Color color, String detail) = switch (plan.status) {
      PlanStatus.approved => (tokens.success, l10n.planDetailApproved),
      PlanStatus.revisionRequested => (
        tokens.warning,
        l10n.planDetailRevisionRequested,
      ),
      PlanStatus.superseded => (tokens.textMuted, l10n.planDetailSuperseded),
      PlanStatus.cancelled => (tokens.danger, l10n.planDetailCancelled),
      PlanStatus.awaitingApproval => (tokens.textMuted, ''),
    };
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Flexible(
          child: SingleChildScrollView(
            key: const Key('plan-scroll'),
            padding: const EdgeInsets.symmetric(horizontal: NekoSpace.md),
            child: Column(
              key: const Key('plan-final'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (note != null)
                  _Notice(
                    key: const Key('plan-note-settled'),
                    text: note(l10n),
                    color: tokens.warning,
                  ),
                _PlanBody(plan: plan),
                const SizedBox(height: NekoSpace.md),
                Text(
                  planStatusLabel(l10n, plan.status),
                  key: const Key('plan-final-status'),
                  style: Theme.of(context).textTheme.titleSmall
                      ?.copyWith(color: color),
                ),
                if (detail.isNotEmpty)
                  Text(
                    detail,
                    key: const Key('plan-final-detail'),
                    style: context.small(tokens.textMuted),
                  ),
                if (feedback != null && feedback.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: NekoSpace.xs),
                    child: Text(
                      l10n.planFinalFeedback(feedback),
                      key: const Key('plan-final-feedback'),
                    ),
                  ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            NekoSpace.md,
            NekoSpace.sm,
            NekoSpace.md,
            NekoSpace.sm,
          ),
          child: SizedBox(
            width: double.infinity,
            child: Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                key: const Key('plan-done'),
                onPressed: () {
                  interactions.dismissPlan();
                  Navigator.of(context).maybePop();
                },
                child: Text(l10n.commonClose),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({super.key, required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: NekoSpace.sm),
      padding: const EdgeInsets.all(NekoSpace.sm),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(NekoTokens.radiusControl),
      ),
      child: Text(text, style: context.small(color)),
    );
  }
}
