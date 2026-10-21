import 'package:flutter/material.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/features/chat/interactions_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';

String todoStatusLabel(AppLocalizations l10n, TodoStatus status) =>
    switch (status) {
      TodoStatus.pending => l10n.todoStatusPending,
      TodoStatus.inProgress => l10n.todoStatusInProgress,
      TodoStatus.completed => l10n.todoStatusCompleted,
    };

/// 顶栏的待办进度入口（如 1/3）：列表为空、电脑端不支持或尚未取得时不占位。
class TodoEntry extends StatelessWidget {
  const TodoEntry({super.key, required this.interactions});

  final InteractionsController interactions;

  @override
  Widget build(BuildContext context) {
    final todos = interactions.todos;
    if (!interactions.todosSupported || todos == null || todos.items.isEmpty) {
      return const SizedBox.shrink();
    }
    final tokens = NekoTokens.of(context);
    final stale = !interactions.todosCurrent;
    final label = context.l10n.todoProgressLabel(todos.completed, todos.total);
    return Tooltip(
      message: label,
      child: Semantics(
        label: stale ? context.l10n.todoStale(label) : label,
        button: true,
        child: InkWell(
          key: const Key('todo-entry'),
          borderRadius: BorderRadius.circular(NekoTokens.radiusControl),
          onTap: () => showTodoSheet(context, interactions),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minWidth: NekoSpace.touch,
              minHeight: NekoSpace.touch,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: NekoSpace.sm),
              child: ExcludeSemantics(
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: <Widget>[
                    NekoIcon(
                      NekoIcons.list,
                      size: 16,
                      color: stale ? tokens.textFaint : tokens.primary,
                    ),
                    const SizedBox(width: NekoSpace.xs),
                    Text(
                      '${todos.completed}/${todos.total}',
                      key: const Key('todo-progress'),
                      style: context.small(
                        stale ? tokens.textFaint : tokens.text,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 只读待办列表（bottom sheet）：有序、三态可区分、可滚动、完整文字可见。
Future<void> showTodoSheet(
  BuildContext context,
  InteractionsController interactions,
) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      minChildSize: 0.3,
      maxChildSize: 0.95,
      builder: (context, scroll) =>
          TodoSheet(interactions: interactions, scroll: scroll),
    ),
  );
}

class TodoSheet extends StatelessWidget {
  const TodoSheet({super.key, required this.interactions, this.scroll});

  final InteractionsController interactions;
  final ScrollController? scroll;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: interactions,
      builder: (context, _) {
        final tokens = NekoTokens.of(context);
        final todos = interactions.todos;
        final items = todos?.items ?? const <TodoItem>[];
        final bottom = MediaQuery.paddingOf(context).bottom;
        return ListView(
          key: const Key('todo-sheet'),
          controller: scroll,
          padding: EdgeInsets.fromLTRB(
            NekoSpace.md,
            0,
            NekoSpace.md,
            NekoSpace.lg + bottom,
          ),
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.only(bottom: NekoSpace.sm),
              child: Semantics(
                header: true,
                child: Text(
                  todos == null || items.isEmpty
                      ? context.l10n.todoTitle
                      : context.l10n.todoTitleProgress(
                          todos.completed,
                          todos.total,
                        ),
                  key: const Key('todo-title'),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
            ),
            if (!interactions.connected)
              _Banner(
                key: const Key('todo-offline'),
                text: context.l10n.todoOffline,
                color: tokens.warning,
              )
            else if (!interactions.todosCurrent &&
                interactions.todosError == null)
              _Banner(
                key: const Key('todo-refreshing'),
                text: context.l10n.todoRefreshing,
                color: tokens.textMuted,
              ),
            if (interactions.todosError != null && !interactions.todosCurrent)
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      interactions.todosError!(context.l10n),
                      key: const Key('todo-error'),
                      style: context.small(tokens.danger),
                    ),
                  ),
                  TextButton(
                    key: const Key('todo-retry'),
                    onPressed: interactions.connected
                        ? interactions.refreshTodos
                        : null,
                    child: Text(context.l10n.commonRetry),
                  ),
                ],
              ),
            if (todos != null && items.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: NekoSpace.xl),
                child: Center(
                  child: Text(
                    context.l10n.todoEmpty,
                    key: const Key('todo-empty'),
                    style: context.small(tokens.textFaint),
                  ),
                ),
              ),
            for (final item in items) _TodoRow(item: item),
          ],
        );
      },
    );
  }
}

class _TodoRow extends StatelessWidget {
  const _TodoRow({required this.item});

  final TodoItem item;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    final (NekoIconData icon, Color color) = switch (item.status) {
      TodoStatus.pending => (NekoIcons.radioOff, tokens.textFaint),
      TodoStatus.inProgress => (NekoIcons.radioOn, tokens.primary),
      TodoStatus.completed => (NekoIcons.checkCircle, tokens.success),
    };
    final label = todoStatusLabel(context.l10n, item.status);
    final done = item.status == TodoStatus.completed;
    return Semantics(
      container: true,
      label: context.l10n.todoItemSemantics(label, item.text),
      excludeSemantics: true,
      child: Padding(
        key: Key('todo-item-${item.id}'),
        padding: const EdgeInsets.symmetric(vertical: NekoSpace.sm),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: NekoIcon(icon, size: 18, color: color),
            ),
            const SizedBox(width: NekoSpace.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    item.text,
                    style: TextStyle(
                      color: done ? tokens.textMuted : tokens.text,
                      fontWeight: item.status == TodoStatus.inProgress
                          ? FontWeight.w600
                          : FontWeight.w400,
                      decoration: done ? TextDecoration.lineThrough : null,
                      decorationColor: tokens.textFaint,
                    ),
                  ),
                  Text(label, style: context.meta(color)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({super.key, required this.text, required this.color});

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
