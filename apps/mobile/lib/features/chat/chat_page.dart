import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/features/approvals/approval_sheet.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/chat/neko_drawer.dart';
import 'package:neko_mobile/features/plan/plan_sheet.dart';
import 'package:neko_mobile/features/questions/question_sheet.dart';
import 'package:neko_mobile/features/sessions/session_picker.dart';
import 'package:neko_mobile/features/sessions/sessions_controller.dart';
import 'package:neko_mobile/features/subagents/subagent_page.dart';
import 'package:neko_mobile/features/todos/todo_sheet.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';
import 'package:neko_mobile/ui/widgets/transcript_view.dart';

/// 主会话页：标题打开会话切换器，抽屉只放电脑/配对，单列转录 + 审批条 + 问题条 + 输入区（design D10）。
class ChatPage extends ConsumerStatefulWidget {
  const ChatPage({super.key});

  @override
  ConsumerState<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends ConsumerState<ChatPage> {
  final FocusNode _composerFocus = FocusNode(debugLabel: 'composer');
  bool _presentScheduled = false;

  @override
  void dispose() {
    _composerFocus.dispose();
    super.dispose();
  }

  /// 问题首次出现或进入会话页时，只在输入未聚焦、草稿为空且没有其他面板时自动展开一次；
  /// 否则只显示问题条。无论是否展开，候选都被消费，之后不会突然弹出。
  void _scheduleAutoPresent(ChatController chat) {
    if (!chat.interactions.hasArmed || _presentScheduled) return;
    _presentScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _presentScheduled = false;
      if (!mounted) return;
      final topmost = ModalRoute.of(context)?.isCurrent ?? true;
      final summary = chat.interactions.takeAutoPresent(
        canPresent:
            topmost && !_composerFocus.hasFocus && chat.input.text.isEmpty,
      );
      if (summary != null) {
        showQuestionSheet(context, chat.interactions, initialId: summary.id);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final chat = ref.watch(chatControllerProvider);
    final sessions = ref.watch(sessionsControllerProvider);
    final manager = ref.watch(connectionManagerProvider);
    return ListenableBuilder(
      listenable: Listenable.merge(<Listenable>[
        chat,
        sessions,
        chat.transcript,
        chat.interactions,
      ]),
      builder: (context, _) {
        final session = sessions.known(chat.sessionId);
        final status = chat.transcript.status;
        final waiting = chat.interactions.pendingCount > 0;
        _scheduleAutoPresent(chat);
        return Scaffold(
          drawer: NekoDrawer(manager: manager),
          appBar: AppBar(
            toolbarHeight: nekoToolbarHeight(context),
            title: InkWell(
              key: const Key('open-switcher'),
              borderRadius: BorderRadius.circular(NekoTokens.radiusControl),
              onTap: () => showSessionSwitcher(context),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: NekoSpace.touch),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: NekoSpace.xs),
                  child: Row(
                    children: <Widget>[
                      Flexible(
                        child: Semantics(
                          label: '切换会话',
                          button: true,
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(
                                chat.sessionId == null
                                    ? 'NekoAI'
                                    : (session?.title.isNotEmpty ?? false)
                                    ? session!.title
                                    : '新会话',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                key: const Key('chat-title'),
                              ),
                              Text(
                                status.busy
                                    ? (waiting
                                          ? '等待你的回答'
                                          : (status.status ?? '运行中…'))
                                    : (sessions.currentWorkspace?.name ?? ''),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: context.meta(
                                  NekoTokens.of(context).textMuted,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(width: NekoSpace.xs),
                      NekoIcon(
                        NekoIcons.chevronDown,
                        size: 16,
                        color: NekoTokens.of(context).textFaint,
                      ),
                    ],
                  ),
                ),
              ),
            ),
            actions: <Widget>[
              TodoEntry(interactions: chat.interactions),
              const ConnectionIndicator(),
              IconButton(
                key: const Key('sessions-new'),
                tooltip: '新建会话',
                onPressed:
                    !sessions.ready ||
                        sessions.creating ||
                        sessions.currentWorkspace == null
                    ? null
                    : () => createAndOpenSession(sessions, chat),
                icon: sessions.creating
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const NekoIcon(NekoIcons.plus),
              ),
            ],
          ),
          body: SafeArea(
            top: false,
            child: Column(
              children: <Widget>[
                Expanded(
                  child: chat.sessionId == null
                      ? _EmptySession(sessions: sessions, chat: chat)
                      : chat.phase == ChatPhase.error && !chat.transcript.loaded
                      ? _AttachError(chat: chat)
                      : TranscriptView(
                          key: ValueKey<String>('main-${chat.sessionId}'),
                          actions: chat,
                          onOpenSubagent: (round) =>
                              openSubagent(context, round),
                          onOpenQuestion: chat.interactions.questionsSupported
                              ? (id) => showQuestionSheet(
                                  context,
                                  chat.interactions,
                                  initialId: id,
                                )
                              : null,
                        ),
                ),
                ApprovalBar(
                  approvals: chat.approvals,
                  onDecide: chat.decide,
                  enabled: chat.canControl,
                ),
                QuestionBar(interactions: chat.interactions),
                PlanBar(interactions: chat.interactions),
                StatusStrip(
                  manager: manager,
                  error: chat.error,
                  onCloseError: chat.clearError,
                  notice: chat.notice,
                  onCloseNotice: chat.clearNotice,
                  pending: PendingTray(chat: chat),
                  queue: QueueTray(chat: chat),
                ),
                if (chat.sessionId != null)
                  Composer(chat: chat, focusNode: _composerFocus),
              ],
            ),
          ),
        );
      },
    );
  }
}

void openSubagent(BuildContext context, SubagentRound round) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => SubagentPage(
        agentId: round.readonly ? 'round-${round.taskId}' : round.agentId,
        title: round.title,
      ),
    ),
  );
}

class _EmptySession extends StatelessWidget {
  const _EmptySession({required this.sessions, required this.chat});

  final SessionsController sessions;
  final ChatController chat;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(NekoSpace.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              sessions.workspaces.isEmpty
                  ? '电脑上还没有登记工作区，请先在电脑端添加。'
                  : '选择一个会话或新建会话',
              textAlign: TextAlign.center,
              style: TextStyle(color: tokens.textMuted),
            ),
            const SizedBox(height: NekoSpace.md),
            if (sessions.workspaces.isNotEmpty)
              FilledButton.icon(
                key: const Key('empty-new-session'),
                onPressed: !sessions.ready || sessions.creating
                    ? null
                    : () => createAndOpenSession(sessions, chat),
                icon: const NekoIcon(NekoIcons.plus),
                label: const Text('新建会话'),
              ),
          ],
        ),
      ),
    );
  }
}

/// 附着失败：内容未知，给出重试而不是无限加载。
class _AttachError extends StatelessWidget {
  const _AttachError({required this.chat});

  final ChatController chat;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Center(
      key: const Key('attach-error'),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            chat.error ?? '加载会话失败',
            textAlign: TextAlign.center,
            style: TextStyle(color: tokens.textMuted),
          ),
          const SizedBox(height: NekoSpace.md),
          FilledButton.tonal(
            key: const Key('attach-retry'),
            onPressed: chat.api != null
                ? () => chat.attach(chat.sessionId!)
                : null,
            child: const Text('重试'),
          ),
        ],
      ),
    );
  }
}

/// AppBar 连接状态指示：在线/连接中/重连中/离线一目了然；
/// 断线态点击立即重连，终态点击回到扫码引导。
class ConnectionIndicator extends ConsumerWidget {
  const ConnectionIndicator({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final manager = ref.watch(connectionManagerProvider);
    final tokens = NekoTokens.of(context);
    return StreamBuilder<NekoConnectionState>(
      stream: manager.states,
      initialData: manager.state,
      builder: (context, snapshot) {
        final state = snapshot.data ?? const NekoConnIdle();
        final (
          NekoIconData icon,
          Color color,
          String label,
          bool spinning,
        ) = switch (state) {
          NekoConnReady() => (NekoIcons.dot, tokens.success, '在线', false),
          NekoConnConnecting() => (
            NekoIcons.spinner,
            tokens.warning,
            '连接中',
            true,
          ),
          NekoConnRestoring() => (
            NekoIcons.spinner,
            tokens.warning,
            '重连中',
            true,
          ),
          NekoConnOffline() => (NekoIcons.cloudOff, tokens.danger, '离线', false),
          NekoConnRevoked() => (NekoIcons.block, tokens.danger, '授权已撤销', false),
          NekoConnTrustChanged() => (
            NekoIcons.shieldAlert,
            tokens.danger,
            '证书已变更',
            false,
          ),
          NekoConnIncompatible() => (
            NekoIcons.alert,
            tokens.danger,
            '版本不兼容',
            false,
          ),
          NekoConnIdle() => (NekoIcons.dot, tokens.textFaint, '未连接', false),
        };
        final retryable =
            state is NekoConnOffline ||
            state is NekoConnConnecting ||
            state is NekoConnRestoring;
        final terminal =
            state is NekoConnRevoked ||
            state is NekoConnTrustChanged ||
            state is NekoConnIncompatible;
        final ready = state is NekoConnReady;
        return Tooltip(
          message: label,
          child: Semantics(
            label: label,
            button: retryable || terminal,
            child: InkWell(
              key: const Key('connection-indicator'),
              borderRadius: BorderRadius.circular(NekoTokens.radiusControl),
              onTap: retryable
                  ? manager.onForeground
                  : terminal
                  ? () {
                      manager.stopToScan();
                      context.go('/scan');
                    }
                  : null,
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  minWidth: NekoSpace.touch,
                  minHeight: NekoSpace.touch,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: NekoSpace.sm),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      ExcludeSemantics(
                        child: SizedBox.square(
                          dimension: 14,
                          child: spinning
                              ? CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: color,
                                )
                              : NekoIcon(icon, size: 14, color: color),
                        ),
                      ),
                      if (!ready) ...<Widget>[
                        const SizedBox(width: NekoSpace.xs),
                        ExcludeSemantics(
                          child: Text(
                            label,
                            key: const Key('connection-indicator-label'),
                            style: context.small(color),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// 连接状态条：离线/恢复中时内容保留、控制禁用。
class ConnectionBanner extends StatelessWidget {
  const ConnectionBanner({super.key, required this.manager});

  final ConnectionManager manager;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return StreamBuilder<NekoConnectionState>(
      stream: manager.states,
      initialData: manager.state,
      builder: (context, snapshot) {
        final state = snapshot.data;
        final (String? text, Widget? leading, Widget? action) = switch (state) {
          NekoConnOffline(:final nextRetryIn) => (
            '电脑暂不可达，${nextRetryIn.inSeconds + 1} 秒后重试；电脑上的任务不受影响',
            null,
            TextButton(
              key: const Key('banner-retry'),
              onPressed: manager.onForeground,
              child: const Text('立即重试'),
            ),
          ),
          NekoConnConnecting() || NekoConnRestoring() => (
            '正在恢复连接…',
            const SizedBox.square(
              dimension: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            TextButton(
              key: const Key('banner-retry'),
              onPressed: manager.onForeground,
              child: const Text('立即重连'),
            ),
          ),
          NekoConnRevoked() => (
            '设备授权已被电脑撤销，请重新扫码配对',
            NekoIcon(NekoIcons.block, size: 18, color: tokens.danger),
            TextButton(
              key: const Key('banner-rescan'),
              onPressed: () {
                manager.stopToScan();
                context.go('/scan');
              },
              child: const Text('重新配对'),
            ),
          ),
          NekoConnTrustChanged() => (
            '电脑证书已变更，请重新扫码配对',
            NekoIcon(NekoIcons.shieldAlert, size: 18, color: tokens.danger),
            TextButton(
              key: const Key('banner-rescan'),
              onPressed: () {
                manager.stopToScan();
                context.go('/scan');
              },
              child: const Text('重新配对'),
            ),
          ),
          NekoConnIncompatible() => (
            '应用与电脑协议版本不兼容，请升级后重试',
            NekoIcon(NekoIcons.alert, size: 18, color: tokens.danger),
            null,
          ),
          _ => (null, null, null),
        };
        if (text == null) return const SizedBox.shrink();
        return Material(
          key: const Key('connection-banner'),
          color: tokens.surfaceMuted,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: NekoSpace.md),
            child: Row(
              children: <Widget>[
                leading ??
                    NekoIcon(
                      NekoIcons.cloudOff,
                      size: 16,
                      color: tokens.textMuted,
                    ),
                const SizedBox(width: NekoSpace.sm),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: NekoSpace.xs),
                    child: Text(text, style: context.small(tokens.textMuted)),
                  ),
                ),
                ?action,
              ],
            ),
          ),
        );
      },
    );
  }
}

class ErrorBanner extends StatelessWidget {
  const ErrorBanner({super.key, required this.text, required this.onClose});

  final String text;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Material(
      key: const Key('error-banner'),
      color: tokens.danger.withValues(alpha: 0.1),
      child: Row(
        children: <Widget>[
          const SizedBox(width: NekoSpace.md),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: NekoSpace.xs),
              child: Text(text, style: context.small(tokens.danger)),
            ),
          ),
          IconButton(
            tooltip: '关闭',
            onPressed: onClose,
            icon: const NekoIcon(NekoIcons.close),
          ),
        ],
      ),
    );
  }
}

/// 输入区上方的紧凑状态条：连接提示、错误、待确认发送各自保留原 Key 与操作，
/// 不合并成单一状态机；无内容时不占空间。
class StatusStrip extends StatelessWidget {
  const StatusStrip({
    super.key,
    required this.manager,
    this.error,
    this.onCloseError,
    this.notice,
    this.onCloseNotice,
    this.pending,
    this.queue,
  });

  final ConnectionManager manager;
  final String? error;
  final VoidCallback? onCloseError;
  final String? notice;
  final VoidCallback? onCloseNotice;
  final Widget? pending;
  final Widget? queue;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        ConnectionBanner(manager: manager),
        if (error != null)
          ErrorBanner(text: error!, onClose: onCloseError ?? () {}),
        if (notice != null)
          NoticeBanner(text: notice!, onClose: onCloseNotice ?? () {}),
        ?pending,
        ?queue,
      ],
    );
  }
}

class NoticeBanner extends StatelessWidget {
  const NoticeBanner({super.key, required this.text, required this.onClose});

  final String text;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Material(
      key: const Key('notice-banner'),
      color: tokens.surfaceMuted,
      child: Row(
        children: <Widget>[
          const SizedBox(width: NekoSpace.md),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: NekoSpace.xs),
              child: Text(text, style: context.small(tokens.textMuted)),
            ),
          ),
          IconButton(
            tooltip: '关闭',
            onPressed: onClose,
            icon: const NekoIcon(NekoIcons.close),
          ),
        ],
      ),
    );
  }
}

/// 电脑上排队或待引导、尚未进入会话的消息；电脑为唯一真相，软键盘弹出时限高以免挤占输入区。
class QueueTray extends StatelessWidget {
  const QueueTray({super.key, required this.chat});

  final ChatController chat;

  @override
  Widget build(BuildContext context) {
    final queued = chat.queued;
    if (queued == null || queued.isEmpty) return const SizedBox.shrink();
    final tokens = NekoTokens.of(context);
    final keyboard = View.of(context).viewInsets.bottom > 0;
    return Material(
      key: const Key('queue-tray'),
      color: tokens.surfaceMuted,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: keyboard ? 48 : 132),
        child: ListView(
          shrinkWrap: true,
          padding: EdgeInsets.zero,
          children: <Widget>[
            for (final item in queued)
              Padding(
                key: Key('queued-${item.id}'),
                padding: const EdgeInsets.only(left: NekoSpace.md),
                child: Row(
                  children: <Widget>[
                    Text(
                      item.steer ? '引导' : '排队',
                      style: context.small(tokens.primary),
                    ),
                    const SizedBox(width: NekoSpace.sm),
                    Expanded(
                      child: Text(
                        item.preview.isEmpty && item.images > 0
                            ? '（仅图片）'
                            : item.preview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.small(tokens.textMuted),
                      ),
                    ),
                    if (!item.steer)
                      TextButton(
                        key: Key('queued-steer-${item.id}'),
                        onPressed: chat.canControl && chat.withdrawingId == null
                            ? () => chat.steer(item)
                            : null,
                        child: const Text('引导'),
                      ),
                    TextButton(
                      key: Key('queued-withdraw-${item.id}'),
                      onPressed: chat.canControl && chat.withdrawingId == null
                          ? () => chat.withdraw(item)
                          : null,
                      child: Text(chat.withdrawingId == item.id ? '撤回中' : '撤回'),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 待确认的发送：只允许以原请求重试或放弃，不自动重发。
class PendingTray extends StatelessWidget {
  const PendingTray({super.key, required this.chat});

  final ChatController chat;

  @override
  Widget build(BuildContext context) {
    final unknown = chat.pending.where((p) => p.unknown).toList();
    if (unknown.isEmpty) return const SizedBox.shrink();
    final tokens = NekoTokens.of(context);
    return Column(
      children: <Widget>[
        for (final record in unknown)
          Material(
            key: Key('pending-${record.requestId}'),
            color: tokens.surfaceMuted,
            child: Padding(
              padding: const EdgeInsets.only(left: NekoSpace.md),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      '待确认：${record.text}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: context.small(tokens.textMuted),
                    ),
                  ),
                  TextButton(
                    key: Key('pending-retry-${record.requestId}'),
                    onPressed: chat.canControl && !chat.sending
                        ? () => chat.retry(record)
                        : null,
                    child: const Text('重试'),
                  ),
                  TextButton(
                    key: Key('pending-discard-${record.requestId}'),
                    onPressed: () => chat.discard(record),
                    child: const Text('放弃'),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// 输入区：离线时仍可编辑草稿；忙碌时发送一律排队（引导与撤回在排队条上），并可停止。
/// 有未决问题时提示消息会排队到回答之后，并提供打开问题的入口（聊天文字从不当作答案）。
class Composer extends StatefulWidget {
  const Composer({super.key, required this.chat, this.focusNode});

  final ChatController chat;
  final FocusNode? focusNode;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  @override
  Widget build(BuildContext context) {
    final chat = widget.chat;
    final tokens = NekoTokens.of(context);
    final busy = chat.transcript.status.busy;
    final can = chat.canControl;
    final interactions = chat.interactions;
    final waiting =
        interactions.questionsSupported && interactions.pendingCount > 0;
    return Material(
      color: tokens.base,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          NekoSpace.sm,
          NekoSpace.xs,
          NekoSpace.sm,
          NekoSpace.sm,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (waiting)
              InkWell(
                key: const Key('composer-open-question'),
                borderRadius: BorderRadius.circular(NekoTokens.radiusControl),
                onTap: () => showQuestionSheet(
                  context,
                  interactions,
                  initialId: interactions.pending.first.id,
                ),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: NekoSpace.touch),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: NekoSpace.xs,
                    ),
                    child: Row(
                      key: const Key('composer-question-hint'),
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            View.of(context).viewInsets.bottom > 0
                                ? '消息会排队，回答后才处理'
                                : '助手正在等待你的回答；此处发送的消息会排队，回答后才处理。',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: context.small(tokens.textMuted),
                          ),
                        ),
                        const SizedBox(width: NekoSpace.sm),
                        Text('回答问题', style: context.small(tokens.primary)),
                        NekoIcon(
                          NekoIcons.chevronUp,
                          size: 16,
                          color: tokens.primary,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Expanded(
                  child: TextField(
                    key: const Key('composer-input'),
                    controller: chat.input,
                    focusNode: widget.focusNode,
                    minLines: 1,
                    maxLines: 6,
                    textInputAction: TextInputAction.newline,
                    decoration: InputDecoration(
                      hintText: !can
                          ? '未连接，可继续编辑草稿'
                          : waiting
                          ? '消息会排队，回答问题后才处理'
                          : busy
                          ? '回答结束后排队处理，可在上方排队条引导或撤回'
                          : '发消息给 Agent',
                    ),
                  ),
                ),
                if (busy)
                  IconButton(
                    key: const Key('composer-stop'),
                    tooltip: '停止当前运行',
                    onPressed: can ? chat.abort : null,
                    icon: NekoIcon(NekoIcons.stop, color: tokens.danger),
                  ),
                ListenableBuilder(
                  listenable: chat.input,
                  builder: (context, _) => IconButton.filled(
                    key: const Key('composer-send'),
                    tooltip: busy ? '排队' : '发送',
                    onPressed:
                        can &&
                            !chat.sending &&
                            chat.input.text.trim().isNotEmpty
                        ? chat.send
                        : null,
                    icon: chat.sending
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const NekoIcon(NekoIcons.up, size: 18),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
