import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/features/approvals/approval_sheet.dart';
import 'package:neko_mobile/features/chat/chat_page.dart';
import 'package:neko_mobile/features/subagents/subagent_controller.dart';
import 'package:neko_mobile/l10n/core_text.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';
import 'package:neko_mobile/ui/widgets/transcript_view.dart';

String formatTokens(int tokens) =>
    tokens >= 1000 ? '${(tokens / 1000).toStringAsFixed(1)}k' : '$tokens';

/// 子 agent 全屏详情：连续历史、轮次与用量、停止当前轮、审批；返回不影响主会话草稿与滚动。
class SubagentPage extends ConsumerStatefulWidget {
  const SubagentPage({super.key, required this.agentId, required this.title});

  final String agentId;
  final String title;

  @override
  ConsumerState<SubagentPage> createState() => _SubagentPageState();
}

class _SubagentPageState extends ConsumerState<SubagentPage> {
  late final SubagentController _controller = SubagentController(
    chat: ref.read(chatControllerProvider),
    agentId: widget.agentId,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _stop(SubagentRound round) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(context.l10n.subagentStopTitle),
        content: Text(context.l10n.subagentStopBody(round.title)),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(context.l10n.commonCancel),
          ),
          FilledButton(
            key: const Key('subagent-stop-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(context.l10n.subagentStop),
          ),
        ],
      ),
    );
    if (confirmed == true) await _controller.stop(round);
  }

  @override
  Widget build(BuildContext context) {
    final chat = ref.watch(chatControllerProvider);
    final tokens = NekoTokens.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge(<Listenable>[
        _controller,
        _controller.transcript,
      ]),
      builder: (context, _) {
        final status = _controller.transcript.status;
        final active = _controller.activeRound;
        final rounds = _controller.rounds;
        return Scaffold(
          appBar: AppBar(
            toolbarHeight: nekoToolbarHeight(context),
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  widget.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  status.readonly
                      ? context.l10n.subagentForkedReadonly
                      : status.busy
                      ? (status.status == null
                            ? context.l10n.chatRunning
                            : localizeStatus(context.l10n, status.status!))
                      : context.l10n.subagentIdle,
                  style: context.meta(tokens.textMuted),
                ),
              ],
            ),
            actions: <Widget>[
              if (active != null && !status.readonly)
                IconButton(
                  key: const Key('subagent-stop'),
                  tooltip: context.l10n.subagentStopTooltip,
                  onPressed: _controller.canControl
                      ? () => _stop(active)
                      : null,
                  icon: NekoIcon(NekoIcons.stop, color: tokens.danger),
                ),
            ],
          ),
          body: SafeArea(
            top: false,
            child: Column(
              children: <Widget>[
                if (rounds.isNotEmpty)
                  SizedBox(
                    height:
                        MediaQuery.textScalerOf(context).scale(28) +
                        NekoSpace.md,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.symmetric(
                        horizontal: NekoSpace.md,
                        vertical: NekoSpace.sm,
                      ),
                      children: <Widget>[
                        Padding(
                          padding: const EdgeInsets.only(right: NekoSpace.sm),
                          child: Chip(
                            visualDensity: VisualDensity.compact,
                            materialTapTargetSize:
                                MaterialTapTargetSize.shrinkWrap,
                            label: Text(
                              context.l10n.subagentUsageTotal(
                                formatTokens(status.usage.totalTokens),
                              ),
                            ),
                          ),
                        ),
                        for (final round in rounds)
                          Padding(
                            padding: const EdgeInsets.only(right: NekoSpace.sm),
                            child: Chip(
                              visualDensity: VisualDensity.compact,
                              materialTapTargetSize:
                                  MaterialTapTargetSize.shrinkWrap,
                              key: Key('round-${round.taskId}'),
                              avatar: round.active
                                  ? const SizedBox.square(
                                      dimension: 14,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : null,
                              label: Text(
                                context.l10n.subagentRound(
                                      round.round ?? round.taskId,
                                      round.status,
                                    ) +
                                    (round.usage == null
                                        ? ''
                                        : ' · ${formatTokens(round.usage!.totalTokens)}'),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                Expanded(
                  child: _controller.transcript.loaded
                      ? TranscriptView(
                          actions: _controller,
                          emptyText: context.l10n.subagentEmpty,
                        )
                      : Center(
                          child:
                              _controller.opening || chat.subscriptionId == null
                              ? const CircularProgressIndicator()
                              : TextButton(
                                  onPressed: _controller.open,
                                  child: Text(context.l10n.subagentReload),
                                ),
                        ),
                ),
                ApprovalBar(
                  approvals: _controller.approvals,
                  onDecide: chat.decide,
                  enabled: chat.canControl,
                ),
                StatusStrip(
                  manager: ref.watch(connectionManagerProvider),
                  error: _controller.error,
                  onCloseError: _controller.clearError,
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
