import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/sessions/sessions_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';

/// 相对时间：一天内用相对写法，超过 30 天用语言对应的日期格式（zh 为 yyyy-MM-dd，en 为 dd/MM/yyyy）。
String relativeTime(AppLocalizations l10n, int millis, [DateTime? now]) {
  if (millis <= 0) return '';
  final at = DateTime.fromMillisecondsSinceEpoch(millis);
  final diff = (now ?? DateTime.now()).difference(at);
  if (diff.inMinutes < 1) return l10n.relTimeNow;
  if (diff.inHours < 1) return l10n.relTimeMinutes(diff.inMinutes);
  if (diff.inDays < 1) return l10n.relTimeHours(diff.inHours);
  if (diff.inDays < 30) return l10n.relTimeDays(diff.inDays);
  return DateFormat(l10n.datePattern).format(at);
}

/// 在当前工作区新建会话并打开；新建动作只经 [SessionsController.create]，
/// 其内部对并发调用去重，因此顶栏与空态入口连点也只创建一个。
Future<void> createAndOpenSession(
  SessionsController sessions,
  ChatController chat,
) async {
  final created = await sessions.create();
  if (created != null) await chat.attach(created.id);
}

/// 切换工作区：像 Web 一样随之切到该工作区最近使用的会话，没有会话时回到空态，
/// 避免顶栏/内容仍停留在原工作区的会话上。
Future<void> switchWorkspace(
  SessionsController sessions,
  ChatController chat,
  String root,
) async {
  if (root == sessions.workspace) return;
  await sessions.selectWorkspace(root);
  if (sessions.workspace != root) return; // 已被更晚的选择取代
  final target = sessions.mostRecentlyUsed;
  if (target != null) {
    await chat.attach(target.id);
  } else {
    await chat.leave();
  }
}

/// 点击主界面标题打开的会话切换器：工作区、搜索与会话列表合在一处，
/// 列表顺序完全沿用服务端（最近消息时间），不在客户端重排。
Future<void> showSessionSwitcher(BuildContext context) {
  final chat = ProviderScope.containerOf(context).read(chatControllerProvider);
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.65,
        minChildSize: 0.35,
        maxChildSize: 0.95,
        builder: (context, scroll) => SessionPicker(
          scroll: scroll,
          onOpen: (session) {
            Navigator.of(context).pop();
            return chat.attach(session.id);
          },
        ),
      ),
    ),
  );
}

/// 同名工作区用父目录名区分，其余只显示名称。
String _workspaceLabel(Workspace workspace, List<Workspace> all) {
  final duplicated = all.where((w) => w.name == workspace.name).length > 1;
  if (!duplicated) return workspace.name;
  final parts = workspace.root.split('/').where((p) => p.isNotEmpty).toList();
  final parent = parts.length >= 2 ? parts[parts.length - 2] : '';
  return parent.isEmpty ? workspace.name : '${workspace.name} · $parent';
}

class SessionPicker extends ConsumerStatefulWidget {
  const SessionPicker({super.key, this.scroll, required this.onOpen});

  final ScrollController? scroll;
  final Future<void> Function(SessionSummary session) onOpen;

  @override
  ConsumerState<SessionPicker> createState() => _SessionPickerState();
}

class _SessionPickerState extends ConsumerState<SessionPicker> {
  late final TextEditingController _search = TextEditingController(
    text: ref.read(sessionsControllerProvider).query,
  );

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final sessions = ref.watch(sessionsControllerProvider);
    final chat = ref.watch(chatControllerProvider);
    final tokens = NekoTokens.of(context);
    return ListenableBuilder(
      listenable: sessions,
      builder: (context, _) {
        final workspace = sessions.currentWorkspace;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (sessions.workspaces.isNotEmpty)
              SizedBox(
                height: NekoSpace.touch,
                child: ListView.separated(
                  key: const Key('switcher-workspaces'),
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: NekoSpace.md),
                  itemCount: sessions.workspaces.length,
                  separatorBuilder: (_, _) =>
                      const SizedBox(width: NekoSpace.sm),
                  itemBuilder: (context, index) {
                    final w = sessions.workspaces[index];
                    return Center(
                      child: ChoiceChip(
                        key: Key('workspace-${w.root}'),
                        materialTapTargetSize: MaterialTapTargetSize.padded,
                        avatar: NekoIcon(
                          NekoIcons.folder,
                          size: 14,
                          color: tokens.textMuted,
                        ),
                        label: Text(_workspaceLabel(w, sessions.workspaces)),
                        selected: w.root == sessions.workspace,
                        showCheckmark: false,
                        onSelected: (_) =>
                            switchWorkspace(sessions, chat, w.root),
                      ),
                    );
                  },
                ),
              ),
            if (workspace != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: NekoSpace.md),
                child: Text(
                  workspace.root,
                  key: const Key('switcher-workspace-path'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: context.meta(tokens.textFaint),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                NekoSpace.md,
                NekoSpace.sm,
                NekoSpace.md,
                NekoSpace.sm,
              ),
              child: TextField(
                key: const Key('sessions-search'),
                controller: _search,
                onChanged: sessions.search,
                decoration: InputDecoration(
                  prefixIcon: const NekoIcon(NekoIcons.search, size: 16),
                  prefixIconConstraints: const BoxConstraints(minWidth: 40),
                  hintText: context.l10n.sessionsSearchHint,
                ),
              ),
            ),
            if (sessions.error != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: NekoSpace.md),
                child: Text(
                  sessions.error!(context.l10n),
                  style: context.small(tokens.danger),
                ),
              ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: sessions.refresh,
                child: ListView.builder(
                  controller: widget.scroll,
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.only(bottom: NekoSpace.lg),
                  itemCount: sessions.sessions.length + 1,
                  itemBuilder: (context, index) {
                    if (index == sessions.sessions.length) {
                      if (sessions.hasMore) {
                        // loadMore 会 notifyListeners，不能在 build 期间同步调用。
                        WidgetsBinding.instance.addPostFrameCallback(
                          (_) => sessions.loadMore(),
                        );
                        return const Padding(
                          padding: EdgeInsets.all(NekoSpace.md),
                          child: Center(child: CircularProgressIndicator()),
                        );
                      }
                      if (sessions.sessions.isEmpty && !sessions.loading) {
                        return Padding(
                          padding: const EdgeInsets.all(NekoSpace.xl),
                          child: Center(
                            child: Text(
                              sessions.query.isEmpty
                                  ? context.l10n.sessionsEmpty
                                  : context.l10n.sessionsNoMatch,
                              style: context.small(tokens.textFaint),
                            ),
                          ),
                        );
                      }
                      return const SizedBox.shrink();
                    }
                    final s = sessions.sessions[index];
                    return ListTile(
                      key: Key('session-${s.id}'),
                      selected: s.id == chat.sessionId,
                      selectedTileColor: tokens.surfaceMuted,
                      minTileHeight: NekoSpace.touch,
                      title: Text(
                        s.title.isEmpty
                            ? context.l10n.sessionNewTitle
                            : s.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle:
                          s.preview.isEmpty &&
                              !s.waitingForAnswer &&
                              !s.waitingForPlan
                          ? null
                          : Row(
                              children: <Widget>[
                                // 等待回答取代“运行中”：电脑端未声明（字段缺省）时不显示任何标记。
                                if (s.waitingForAnswer)
                                  Padding(
                                    key: Key('session-awaiting-${s.id}'),
                                    padding: EdgeInsets.only(
                                      right: s.preview.isEmpty
                                          ? 0
                                          : NekoSpace.sm,
                                    ),
                                    child: Text(
                                      context.l10n.sessionAwaitingAnswer,
                                      style: context.small(tokens.warning),
                                    ),
                                  ),
                                // 计划待批准时会话是空闲的，与“等待回答”互不重叠。
                                if (s.waitingForPlan)
                                  Padding(
                                    key: Key('session-plan-${s.id}'),
                                    padding: EdgeInsets.only(
                                      right: s.preview.isEmpty
                                          ? 0
                                          : NekoSpace.sm,
                                    ),
                                    child: Text(
                                      context.l10n.sessionAwaitingApproval,
                                      style: context.small(tokens.warning),
                                    ),
                                  ),
                                if (s.preview.isNotEmpty)
                                  Expanded(
                                    child: Text(
                                      s.preview,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                              ],
                            ),
                      trailing: Text(
                        relativeTime(context.l10n, s.messageAt),
                        style: context.meta(tokens.textFaint),
                      ),
                      onTap: () => widget.onOpen(s),
                    );
                  },
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}
