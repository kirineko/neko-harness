import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/features/chat/transcript.dart';
import 'package:neko_mobile/features/questions/question_sheet.dart'
    show questionStatusLabel;
import 'package:neko_mobile/l10n/core_text.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';
import 'package:neko_mobile/ui/widgets/markdown_view.dart';

/// 主会话与子详情共用的转录操作面。
abstract class TranscriptActions {
  Transcript get transcript;

  bool get loadingOlder;

  Future<void> loadOlder();

  Future<void> expand(ChatItem item, ContentRef ref);

  Future<Uint8List> image(ImageRef image);
}

/// 有界转录列表：以 center sliver 分隔已加载历史与新增内容，
/// 向上翻页不跳动，新输出仅在用户位于底部时自动跟随（design D10）。
class TranscriptView extends StatefulWidget {
  const TranscriptView({
    super.key,
    required this.actions,
    this.onOpenSubagent,
    this.onOpenQuestion,
    this.emptyText,
  });

  final TranscriptActions actions;
  final void Function(SubagentRound round)? onOpenSubagent;

  /// 打开未决问题的面板；只在主会话提供（回答控件只存在于面板，转录里没有）。
  final void Function(int questionId)? onOpenQuestion;

  /// 空转录的提示；缺省为当前语言的“还没有消息”。
  final String? emptyText;

  @override
  State<TranscriptView> createState() => _TranscriptViewState();
}

class _TranscriptViewState extends State<TranscriptView> {
  final ScrollController _scroll = ScrollController();
  final Key _center = UniqueKey();

  /// center sliver 的锚点：当前快照的第一条。更早的历史页插入到锚点之前（center 之上），
  /// 不改变可视位置；锚点之后是快照与新增内容，整体自上而下排布，内容不足一屏时不会出现上方空白。
  String? _anchorKey;
  bool _atBottom = true;
  bool _wasLoaded = false;

  Transcript get _t => widget.actions.transcript;

  @override
  void initState() {
    super.initState();
    _t.addListener(_onChanged);
    _scroll.addListener(_onScroll);
    _resetAnchor();
    _followBottomNextFrame();
  }

  @override
  void didUpdateWidget(covariant TranscriptView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.actions.transcript, _t)) {
      oldWidget.actions.transcript.removeListener(_onChanged);
      _t.addListener(_onChanged);
      _resetAnchor();
      _followBottomNextFrame();
    }
  }

  @override
  void dispose() {
    _t.removeListener(_onChanged);
    _scroll.dispose();
    super.dispose();
  }

  void _resetAnchor() {
    _anchorKey = _t.items.isEmpty ? null : _t.items.first.key;
    _wasLoaded = _t.loaded;
    _atBottom = true;
  }

  void _followBottomNextFrame() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  void _onChanged() {
    if (!mounted) return;
    // 新快照（attach/reset）或锚点条目消失：重新以第一条为锚并回到底部。
    if (_t.loaded != _wasLoaded ||
        (_anchorKey != null && !_t.items.any((e) => e.key == _anchorKey))) {
      _resetAnchor();
    }
    // 空会话收到第一条内容：以它为锚。
    _anchorKey ??= _t.items.isEmpty ? null : _t.items.first.key;
    final follow = _atBottom;
    setState(() {});
    if (follow) _followBottomNextFrame();
  }

  void _onScroll() {
    final position = _scroll.position;
    final atBottom = position.pixels >= position.maxScrollExtent - 48;
    if (atBottom != _atBottom) setState(() => _atBottom = atBottom);
    if (position.pixels <= position.minScrollExtent + 200 &&
        _t.hasOlder &&
        !widget.actions.loadingOlder) {
      widget.actions.loadOlder();
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _t.items;
    if (!_t.loaded) {
      return const Center(child: CircularProgressIndicator());
    }
    final anchor = _anchorKey == null
        ? 0
        : items.indexWhere((e) => e.key == _anchorKey).clamp(0, items.length);
    final before = items.sublist(0, anchor);
    final after = items.sublist(anchor);
    final streaming = _t.streaming;
    final rounds = _t.status.subagents;
    Widget tile(ChatItem item) => Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: NekoSpace.md,
        vertical: NekoSpace.xs,
      ),
      child: ChatItemView(
        item: item,
        actions: widget.actions,
        transcript: _t,
        round: item.tool == null
            ? null
            : rounds.where((r) => r.callId == item.tool!.callId).firstOrNull,
        onOpenSubagent: widget.onOpenSubagent,
        onOpenQuestion: widget.onOpenQuestion,
      ),
    );
    return Stack(
      children: <Widget>[
        CustomScrollView(
          controller: _scroll,
          center: _center,
          slivers: <Widget>[
            // 反向排列：最近的更早条目紧贴 center，历史提示位于最上方。
            SliverList.builder(
              itemCount: before.length + 1,
              itemBuilder: (context, index) {
                if (index == before.length) {
                  return _HistoryHeader(
                    loading: widget.actions.loadingOlder,
                    hasOlder: _t.hasOlder,
                  );
                }
                return tile(before[before.length - 1 - index]);
              },
            ),
            SliverList.builder(
              key: _center,
              itemCount: after.length + 1,
              itemBuilder: (context, index) {
                if (index < after.length) return tile(after[index]);
                if (items.isEmpty && streaming == null) {
                  return Padding(
                    padding: const EdgeInsets.all(NekoSpace.xl),
                    child: Center(
                      child: Text(
                        widget.emptyText ?? context.l10n.transcriptEmpty,
                        style: TextStyle(
                          color: NekoTokens.of(context).textFaint,
                        ),
                      ),
                    ),
                  );
                }
                return Padding(
                  padding: const EdgeInsets.fromLTRB(
                    NekoSpace.md,
                    NekoSpace.xs,
                    NekoSpace.md,
                    NekoSpace.md,
                  ),
                  child: streaming == null
                      ? const SizedBox.shrink()
                      : StreamingView(streaming: streaming),
                );
              },
            ),
          ],
        ),
        if (!_atBottom)
          Positioned(
            right: 16,
            bottom: 16,
            child: FloatingActionButton.small(
              key: const Key('transcript-to-bottom'),
              tooltip: context.l10n.transcriptToBottom,
              onPressed: () => _scroll.animateTo(
                _scroll.position.maxScrollExtent,
                duration: const Duration(milliseconds: 200),
                curve: Curves.easeOut,
              ),
              child: const NekoIcon(NekoIcons.down),
            ),
          ),
      ],
    );
  }
}

class _HistoryHeader extends StatelessWidget {
  const _HistoryHeader({required this.loading, required this.hasOlder});

  final bool loading;
  final bool hasOlder;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Padding(
        padding: EdgeInsets.all(NekoSpace.md),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return SizedBox(height: hasOlder ? 32 : 8);
  }
}

/// 正在生成的回答（只携带尾部时以省略号提示）。
class StreamingView extends StatelessWidget {
  const StreamingView({super.key, required this.streaming});

  final Streaming streaming;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Column(
      key: const Key('streaming-view'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (streaming.thinking.isNotEmpty)
          _Collapsible(
            title: context.l10n.transcriptThinking,
            initiallyExpanded: false,
            child: Text(
              (streaming.thinkingOmitted > 0 ? '…' : '') + streaming.thinking,
              style: context.small(tokens.textMuted),
            ),
          ),
        if (streaming.text.isNotEmpty)
          NekoMarkdown((streaming.textOmitted > 0 ? '…' : '') + streaming.text),
        for (final call in streaming.toolCalls)
          Padding(
            padding: const EdgeInsets.only(top: NekoSpace.xs),
            child: Row(
              children: <Widget>[
                SizedBox.square(
                  dimension: 14,
                  child: call.done
                      ? NekoIcon(
                          NekoIcons.check,
                          size: 14,
                          color: tokens.success,
                        )
                      : const CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: NekoSpace.sm),
                Expanded(
                  child: Text(
                    '${call.name} ${call.summary}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.small(tokens.textMuted),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class ChatItemView extends StatelessWidget {
  const ChatItemView({
    super.key,
    required this.item,
    required this.actions,
    required this.transcript,
    this.round,
    this.onOpenSubagent,
    this.onOpenQuestion,
  });

  final ChatItem item;
  final TranscriptActions actions;
  final Transcript transcript;
  final SubagentRound? round;
  final void Function(SubagentRound round)? onOpenSubagent;
  final void Function(int questionId)? onOpenQuestion;

  String _full(String field, String preview) =>
      transcript.expanded(item.key, field) ?? preview;

  Widget? _expandButton(BuildContext context, String field) {
    final ref = item.refFor(field);
    if (ref == null || transcript.expanded(item.key, field) != null) {
      return null;
    }
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        key: Key('expand-${item.key}-$field'),
        onPressed: () => actions.expand(item, ref),
        icon: const NekoIcon(NekoIcons.unfold, size: 18),
        label: Text(context.l10n.transcriptExpand((ref.bytes / 1024).ceil())),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    switch (item.type) {
      case ChatItemType.user:
        return Align(
          alignment: Alignment.centerRight,
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * 0.85,
            ),
            child: Container(
              padding: const EdgeInsets.symmetric(
                horizontal: NekoSpace.md,
                vertical: NekoSpace.sm,
              ),
              decoration: BoxDecoration(
                color: tokens.userBubble,
                borderRadius: BorderRadius.circular(NekoTokens.radiusBubble),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  if (item.skill != null)
                    Text(
                      '/skill:${item.skill}',
                      style: context.small(tokens.accent),
                    ),
                  if (item.text.isNotEmpty)
                    SelectableText(
                      _full('text', item.text),
                      style: TextStyle(color: tokens.onUserBubble),
                    ),
                  ?_expandButton(context, 'text'),
                  if (item.images.isNotEmpty)
                    _ImageStrip(images: item.images, actions: actions),
                ],
              ),
            ),
          ),
        );
      case ChatItemType.assistant:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (item.thinking.isNotEmpty)
              _Collapsible(
                title: context.l10n.transcriptThinkingProcess,
                initiallyExpanded: false,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    SelectableText(
                      _full('thinking', item.thinking),
                      style: context.small(tokens.textMuted),
                    ),
                    ?_expandButton(context, 'thinking'),
                  ],
                ),
              ),
            if (item.text.isNotEmpty)
              SizedBox(
                width: double.infinity,
                child: NekoMarkdown(_full('text', item.text)),
              ),
            ?_expandButton(context, 'text'),
            if (item.note != null)
              Text(
                localizeToolNote(context.l10n, item.note!),
                style: TextStyle(color: tokens.textFaint),
              ),
            if (item.error != null)
              _Banner(
                text: localizeCoreError(context.l10n, item.error!),
                color: tokens.danger,
              ),
          ],
        );
      case ChatItemType.tool:
        return ToolCard(
          item: item,
          tool: item.tool!,
          full: _full,
          expandButton: (field) => _expandButton(context, field),
          actions: actions,
          round: round,
          onOpenSubagent: onOpenSubagent,
          onOpenQuestion: onOpenQuestion,
        );
      case ChatItemType.system:
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: NekoSpace.xs),
          child: Center(
            child: Text(
              localizeSystemRow(context.l10n, _full('text', item.text)),
              textAlign: TextAlign.center,
              style: context.small(tokens.textFaint),
            ),
          ),
        );
    }
  }
}

class ToolCard extends StatefulWidget {
  const ToolCard({
    super.key,
    required this.item,
    required this.tool,
    required this.full,
    required this.expandButton,
    required this.actions,
    this.round,
    this.onOpenSubagent,
    this.onOpenQuestion,
  });

  final ChatItem item;
  final ToolInfo tool;
  final String Function(String field, String preview) full;
  final Widget? Function(String field) expandButton;
  final TranscriptActions actions;
  final SubagentRound? round;
  final void Function(SubagentRound round)? onOpenSubagent;
  final void Function(int questionId)? onOpenQuestion;

  @override
  State<ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<ToolCard> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final ToolCard(
      :item,
      :tool,
      :full,
      :expandButton,
      :actions,
      :round,
      :onOpenSubagent,
      :onOpenQuestion,
    ) = widget;
    final tokens = NekoTokens.of(context);
    final (NekoIconData icon, Color color) = switch (tool.status) {
      ToolStatus.running => (NekoIcons.more, tokens.primary),
      ToolStatus.done => (NekoIcons.checkCircle, tokens.success),
      ToolStatus.error => (NekoIcons.alert, tokens.danger),
    };
    Widget mono(String field, String value) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Container(
          width: double.infinity,
          margin: const EdgeInsets.only(top: NekoSpace.xs),
          padding: const EdgeInsets.all(NekoSpace.sm),
          decoration: BoxDecoration(
            color: tokens.codeBackground,
            borderRadius: BorderRadius.circular(NekoTokens.radiusControl),
          ),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SelectableText(
              full('tool.$field', value),
              style: NekoTokens.code,
            ),
          ),
        ),
        ?expandButton('tool.$field'),
      ],
    );
    final linked = round;
    final interaction = tool.interaction;
    final details = <Widget>[
      if (interaction != null)
        ..._interactionDetails(context, interaction, onOpenQuestion)
      else ...<Widget>[
        if (tool.detail != null) mono('detail', tool.detail!),
        if (tool.codemode != null && tool.codemode!.total > 0)
          _codemodeCalls(context, tool.codemode!),
        if (tool.result != null)
          mono('result', tool.result!)
        else if (tool.output != null)
          mono('output', tool.output!),
        if (tool.diff != null) ...<Widget>[
          Padding(
            padding: const EdgeInsets.only(top: NekoSpace.xs),
            child: Text(
              tool.diffTruncated
                  ? context.l10n.transcriptDiffSummaryTruncated(
                      tool.diffAdded ?? 0,
                      tool.diffRemoved ?? 0,
                    )
                  : context.l10n.transcriptDiffSummary(
                      tool.diffAdded ?? 0,
                      tool.diffRemoved ?? 0,
                    ),
              style: context.small(tokens.textMuted),
            ),
          ),
          mono('diff', tool.diff!),
        ],
      ],
      if (tool.codemode?.fullOutputPath != null)
        Padding(
          padding: const EdgeInsets.only(top: NekoSpace.xs),
          child: SelectableText(
            context.l10n.transcriptCodemodeFullOutput(
              tool.codemode!.fullOutputPath!,
            ),
            style: context.small(tokens.textFaint),
          ),
        ),
      if (tool.note != null)
        Padding(
          padding: const EdgeInsets.only(top: NekoSpace.xs),
          child: Text(
            localizeToolNote(context.l10n, tool.note!),
            style: context.small(tokens.textFaint),
          ),
        ),
      if (tool.durationMs != null)
        Padding(
          padding: const EdgeInsets.only(top: NekoSpace.xs),
          child: Text(
            '${(tool.durationMs! / 1000).toStringAsFixed(1)} s',
            style: context.meta(tokens.textFaint),
          ),
        ),
      if (item.images.isNotEmpty)
        _ImageStrip(images: item.images, actions: actions),
    ];
    // 一行式摘要 + 左侧状态色条；展开才显示参数与结果。故意不使用
    // ExpansionTile/PageStorageKey：展开布尔值与 mono() 内横向滚动偏移
    // 会按同一键链写入 PageStorage 而撞键，展开时 TypeError、内容黑屏。
    return Container(
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: color, width: 2)),
      ),
      padding: const EdgeInsets.only(left: NekoSpace.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: NekoSpace.touch),
              child: Row(
                children: <Widget>[
                  NekoIcon(
                    icon,
                    size: 16,
                    color: color,
                    semanticLabel: tool.status.name,
                  ),
                  const SizedBox(width: NekoSpace.sm),
                  Text(
                    linked != null
                        ? context.l10n.transcriptSubagentTitle(linked.title)
                        : interaction != null
                        ? interactionTitle(context.l10n, interaction)
                        : tool.name,
                    style: context.text.titleSmall,
                  ),
                  const SizedBox(width: NekoSpace.sm),
                  Expanded(
                    child: Text(
                      linked != null
                          ? '${linked.role} · ${linked.status}'
                          : interaction != null
                          ? interactionSummary(context.l10n, interaction)
                          : tool.summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.small(tokens.textMuted),
                    ),
                  ),
                  if (linked != null && onOpenSubagent != null)
                    IconButton(
                      key: Key('open-subagent-${linked.taskId}'),
                      tooltip: context.l10n.transcriptViewSubagent,
                      icon: Badge(
                        isLabelVisible: linked.approvalCount > 0,
                        label: Text('${linked.approvalCount}'),
                        child: const NekoIcon(NekoIcons.external),
                      ),
                      onPressed: () => onOpenSubagent(linked),
                    )
                  else
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: NekoSpace.sm,
                      ),
                      child: NekoIcon(
                        _open ? NekoIcons.chevronUp : NekoIcons.chevronDown,
                        size: 16,
                        color: tokens.textFaint,
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.only(bottom: NekoSpace.sm),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: details,
              ),
            ),
        ],
      ),
    );
  }
}

/// codemode 脚本的嵌套调用列表：状态图标、工具名、参数预览、耗时与错误。
Widget _codemodeCalls(BuildContext context, CodemodeInfo info) {
  final tokens = NekoTokens.of(context);
  Widget row(CodemodeCall call) {
    final (NekoIconData icon, Color color) = switch (call.status) {
      CodemodeCallStatus.running => (NekoIcons.more, tokens.primary),
      CodemodeCallStatus.ok => (NekoIcons.checkCircle, tokens.success),
      CodemodeCallStatus.error => (NekoIcons.alert, tokens.danger),
      CodemodeCallStatus.cancelled => (NekoIcons.alert, tokens.textFaint),
    };
    final duration = call.durationMs;
    return Padding(
      padding: const EdgeInsets.only(top: NekoSpace.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              NekoIcon(
                icon,
                size: 14,
                color: color,
                semanticLabel: call.status.name,
              ),
              const SizedBox(width: NekoSpace.xs),
              Text(call.name, style: NekoTokens.code),
              const SizedBox(width: NekoSpace.xs),
              Expanded(
                child: Text(
                  call.args,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: context.small(tokens.textMuted),
                ),
              ),
              if (duration != null)
                Text(
                  '${(duration / 1000).toStringAsFixed(1)} s',
                  style: context.meta(tokens.textFaint),
                ),
            ],
          ),
          if (call.error != null)
            Padding(
              padding: const EdgeInsets.only(left: NekoSpace.lg),
              child: Text(call.error!, style: context.small(tokens.danger)),
            ),
        ],
      ),
    );
  }

  return Padding(
    padding: const EdgeInsets.only(top: NekoSpace.xs),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          context.l10n.transcriptCodemodeCalls(info.total),
          style: context.small(tokens.textMuted),
        ),
        for (final call in info.calls) row(call),
        if (info.omitted > 0)
          Padding(
            padding: const EdgeInsets.only(top: NekoSpace.xs),
            child: Text(
              context.l10n.transcriptCodemodeMore(info.omitted),
              style: context.small(tokens.textFaint),
            ),
          ),
      ],
    ),
  );
}

/// `ask_user` / `todo` 工具项的标题；状态来自结构化 `interaction`，不解析 result 文案。
String interactionTitle(AppLocalizations l10n, ToolInteraction interaction) =>
    switch (interaction) {
      AskUserInteraction() => l10n.questionHeader,
      TodoInteraction() => 'todo',
    };

String _answerLine(AppLocalizations l10n, AskUserInteraction ask) {
  final labels = ask.labels.isNotEmpty
      ? ask.labels
      : <String>[
          for (final id in ask.optionIds)
            ask.options.where((o) => o.id == id).firstOrNull?.label ?? id,
        ];
  final text = ask.text;
  return <String>[
    if (labels.isNotEmpty) labels.join(l10n.separatorList),
    if (text != null && text.isNotEmpty) text,
  ].join(' · ');
}

String interactionSummary(AppLocalizations l10n, ToolInteraction interaction) {
  switch (interaction) {
    case AskUserInteraction():
      final answer = interaction.status == QuestionStatus.answered
          ? _answerLine(l10n, interaction)
          : '';
      return <String>[
        questionStatusLabel(l10n, interaction.status),
        interaction.question,
        if (answer.isNotEmpty) answer,
      ].join(' · ');
    case TodoInteraction():
      return interaction.action == 'replace'
          ? l10n.todoSummaryUpdate(
              interaction.completed,
              interaction.total,
              interaction.revision,
            )
          : l10n.todoSummaryRead(
              interaction.completed,
              interaction.total,
              interaction.revision,
            );
  }
}

/// 展开后的结构化内容：只读展示，没有回答控件（回答只在问题面板里）。
List<Widget> _interactionDetails(
  BuildContext context,
  ToolInteraction interaction,
  void Function(int questionId)? onOpenQuestion,
) {
  final tokens = NekoTokens.of(context);
  switch (interaction) {
    case TodoInteraction():
      return <Widget>[
        Padding(
          padding: const EdgeInsets.only(top: NekoSpace.xs),
          child: Text(interactionSummary(context.l10n, interaction)),
        ),
      ];
    case AskUserInteraction():
      final answered = interaction.status == QuestionStatus.answered;
      final l10n = context.l10n;
      return <Widget>[
        Padding(
          padding: const EdgeInsets.only(top: NekoSpace.xs),
          // 问题与选项都是纯文本：保留换行，不解析 Markdown/HTML，不生成链接。
          child: Text(
            interaction.question,
            key: const Key('interaction-question'),
          ),
        ),
        for (final option in interaction.options)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              '${interaction.optionIds.contains(option.id) ? '✓ ' : '· '}'
              '${option.recommended ? l10n.transcriptOptionRecommended(option.label) : option.label}',
              style: context.small(tokens.textMuted),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(top: NekoSpace.xs),
          child: Text(
            switch (interaction.status) {
              QuestionStatus.pending => l10n.questionStatusPending,
              QuestionStatus.answered => l10n.transcriptAnswered(
                _answerLine(l10n, interaction).isEmpty
                    ? l10n.transcriptNoContent
                    : _answerLine(l10n, interaction),
              ),
              QuestionStatus.skipped => l10n.transcriptSkippedNoAnswer,
              QuestionStatus.cancelled => l10n.questionStatusCancelled,
            },
            key: const Key('interaction-status'),
            style: TextStyle(
              color: answered ? tokens.success : tokens.textMuted,
            ),
          ),
        ),
        if (interaction.status == QuestionStatus.pending &&
            onOpenQuestion != null)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              key: Key('open-question-${interaction.id}'),
              onPressed: () => onOpenQuestion(interaction.id),
              child: Text(l10n.transcriptViewQuestion),
            ),
          ),
      ];
  }
}

class _Collapsible extends StatefulWidget {
  const _Collapsible({
    required this.title,
    required this.child,
    required this.initiallyExpanded,
  });

  final String title;
  final Widget child;
  final bool initiallyExpanded;

  @override
  State<_Collapsible> createState() => _CollapsibleState();
}

class _CollapsibleState extends State<_Collapsible> {
  late bool _open = widget.initiallyExpanded;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        InkWell(
          onTap: () => setState(() => _open = !_open),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: Row(
              children: <Widget>[
                NekoIcon(
                  _open ? NekoIcons.chevronUp : NekoIcons.chevronDown,
                  color: tokens.textFaint,
                ),
                Text(widget.title, style: context.small(tokens.textFaint)),
              ],
            ),
          ),
        ),
        if (_open) widget.child,
      ],
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: NekoSpace.xs),
      padding: const EdgeInsets.all(NekoSpace.sm),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(NekoTokens.radiusControl),
      ),
      child: SelectableText(text, style: TextStyle(color: color)),
    );
  }
}

class _ImageStrip extends StatelessWidget {
  const _ImageStrip({required this.images, required this.actions});

  final List<ImageRef> images;
  final TranscriptActions actions;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: NekoSpace.xs),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: <Widget>[
          for (final image in images)
            ImageThumb(image: image, actions: actions),
        ],
      ),
    );
  }
}

/// 图片缩略：按需分块读取，点击全屏预览。
class ImageThumb extends StatefulWidget {
  const ImageThumb({super.key, required this.image, required this.actions});

  final ImageRef image;
  final TranscriptActions actions;

  @override
  State<ImageThumb> createState() => _ImageThumbState();
}

class _ImageThumbState extends State<ImageThumb> {
  late Future<Uint8List> _bytes = widget.actions.image(widget.image);

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return Semantics(
      label: context.l10n.transcriptImageLabel(widget.image.name),
      button: true,
      child: FutureBuilder<Uint8List>(
        future: _bytes,
        builder: (context, snapshot) {
          Widget child;
          if (snapshot.hasData) {
            child = Image.memory(
              snapshot.data!,
              width: 96,
              height: 96,
              fit: BoxFit.cover,
              gaplessPlayback: true,
            );
          } else if (snapshot.hasError) {
            child = IconButton(
              tooltip: context.l10n.transcriptReloadImage,
              icon: NekoIcon(NekoIcons.imageOff, color: tokens.danger),
              onPressed: () => setState(() {
                _bytes = widget.actions.image(widget.image);
              }),
            );
          } else {
            child = const Center(
              child: SizedBox.square(
                dimension: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            );
          }
          return InkWell(
            onTap: snapshot.hasData
                ? () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => _ImageViewer(
                        name: widget.image.name,
                        bytes: snapshot.data!,
                      ),
                    ),
                  )
                : null,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: Container(
                width: 96,
                height: 96,
                color: tokens.surfaceMuted,
                child: child,
              ),
            ),
          );
        },
      ),
    );
  }
}

class _ImageViewer extends StatelessWidget {
  const _ImageViewer({required this.name, required this.bytes});

  final String name;
  final Uint8List bytes;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      body: InteractiveViewer(
        maxScale: 6,
        child: Center(child: Image.memory(bytes)),
      ),
    );
  }
}
