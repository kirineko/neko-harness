/// 移动 API v1 DTO（docs/mobile/api-v1.md）。解析宽松：缺失字段取默认值，
/// 未知字段忽略，使电脑端追加可选字段不破坏旧 App。
library;

typedef Json = Map<String, dynamic>;

String _str(Object? v, [String fallback = '']) => v is String ? v : fallback;
String? _strOrNull(Object? v) => v is String ? v : null;
int _int(Object? v, [int fallback = 0]) =>
    v is int ? v : (v is num ? v.round() : fallback);
int? _intOrNull(Object? v) => v is int ? v : (v is num ? v.round() : null);
double? _numOrNull(Object? v) => v is num ? v.toDouble() : null;
bool _bool(Object? v) => v == true;
Json _map(Object? v) =>
    v is Map ? v.cast<String, dynamic>() : <String, dynamic>{};
List<Json> _list(Object? v) => v is List
    ? v.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList()
    : <Json>[];

Json asJson(Object? value) => _map(value);
List<Json> asJsonList(Object? value) => _list(value);

class Workspace {
  const Workspace({required this.root, required this.name});

  factory Workspace.fromJson(Json json) =>
      Workspace(root: _str(json['root']), name: _str(json['name']));

  final String root;
  final String name;
}

class SessionSummary {
  const SessionSummary({
    required this.id,
    required this.workspace,
    required this.title,
    required this.preview,
    required this.lastUsedAt,
    this.lastMessageAt,
    this.awaitingAnswer,
    this.awaitingPlan,
  });

  factory SessionSummary.fromJson(Json json) => SessionSummary(
    id: _str(json['id']),
    workspace: _str(json['workspace']),
    title: _str(json['title']),
    preview: _str(json['preview']),
    lastUsedAt: _int(json['lastUsedAt']),
    lastMessageAt: _intOrNull(json['lastMessageAt']),
    awaitingAnswer: json['awaitingAnswer'] is bool
        ? json['awaitingAnswer'] as bool
        : null,
    awaitingPlan: json['awaitingPlan'] is bool
        ? json['awaitingPlan'] as bool
        : null,
  );

  final String id;
  final String workspace;
  final String title;
  final String preview;
  final int lastUsedAt;

  /// 旧网关不返回该字段，此时回退到最近使用时间。
  final int? lastMessageAt;

  /// 会话有问题在等用户回答；缺省表示电脑端无法判断，列表不显示任何标记。
  final bool? awaitingAnswer;

  bool get waitingForAnswer => awaitingAnswer == true;

  /// 空闲会话有已提交的计划等待批准；缺省表示电脑端无法判断，列表不显示任何标记。
  final bool? awaitingPlan;

  bool get waitingForPlan => awaitingPlan == true;

  /// 列表排序与展示用的时间：最近消息时间（无消息为创建时间），由服务端决定顺序。
  int get messageAt => lastMessageAt ?? lastUsedAt;
}

class ContentRef {
  const ContentRef({
    required this.sessionId,
    required this.key,
    required this.field,
    required this.digest,
    required this.bytes,
    this.agentId,
  });

  factory ContentRef.fromJson(Json json) => ContentRef(
    sessionId: _str(json['sessionId']),
    agentId: _strOrNull(json['agentId']),
    key: _str(json['key']),
    field: _str(json['field']),
    digest: _str(json['digest']),
    bytes: _int(json['bytes']),
  );

  final String sessionId;
  final String? agentId;
  final String key;
  final String field;
  final String digest;
  final int bytes;

  Json toJson() => <String, dynamic>{
    'sessionId': sessionId,
    'agentId': ?agentId,
    'key': key,
    'field': field,
    'digest': digest,
    'bytes': bytes,
  };
}

class ImageRef {
  const ImageRef({
    required this.name,
    required this.mimeType,
    required this.width,
    required this.height,
    required this.bytes,
    required this.entryId,
    required this.contentIndex,
  });

  factory ImageRef.fromJson(Json json) => ImageRef(
    name: _str(json['name']),
    mimeType: _str(json['mimeType']),
    width: _int(json['width']),
    height: _int(json['height']),
    bytes: _int(json['bytes']),
    entryId: _int(json['entryId']),
    contentIndex: _int(json['contentIndex']),
  );

  final String name;
  final String mimeType;
  final int width;
  final int height;
  final int bytes;
  final int entryId;
  final int contentIndex;

  String get cacheKey => '$entryId:$contentIndex';
}

enum ToolStatus { running, done, error }

enum CodemodeCallStatus { running, ok, error, cancelled }

/// codemode 脚本发起的一次嵌套工具调用；只含有界的参数预览与错误，没有结果正文。
class CodemodeCall {
  const CodemodeCall({
    required this.id,
    required this.name,
    required this.args,
    required this.status,
    this.durationMs,
    this.error,
  });

  factory CodemodeCall.fromJson(Json json) => CodemodeCall(
    id: _int(json['id']),
    name: _str(json['name']),
    args: _str(json['args']),
    status: switch (json['status']) {
      'ok' => CodemodeCallStatus.ok,
      'error' => CodemodeCallStatus.error,
      'cancelled' => CodemodeCallStatus.cancelled,
      _ => CodemodeCallStatus.running,
    },
    durationMs: _intOrNull(json['durationMs']),
    error: _strOrNull(json['error']),
  );

  final int id;
  final String name;
  final String args;
  final CodemodeCallStatus status;
  final int? durationMs;
  final String? error;
}

/// codemode 工具项的嵌套调用列表；旧网关没有该字段，此时按普通工具项显示。
class CodemodeInfo {
  const CodemodeInfo({
    required this.calls,
    required this.omitted,
    this.fullOutputPath,
  });

  /// 缺少或结构不对时返回 null。
  static CodemodeInfo? fromJson(Object? value) {
    if (value is! Map || value['calls'] is! List) return null;
    final json = asJson(value);
    return CodemodeInfo(
      calls: _list(json['calls']).map(CodemodeCall.fromJson).toList(),
      omitted: _int(json['omitted']),
      fullOutputPath: _strOrNull(json['fullOutputPath']),
    );
  }

  final List<CodemodeCall> calls;
  final int omitted;
  final String? fullOutputPath;

  int get total => calls.length + omitted;
}

class ToolInfo {
  const ToolInfo({
    required this.callId,
    required this.name,
    required this.summary,
    required this.status,
    this.detail,
    this.output,
    this.result,
    this.diff,
    this.diffAdded,
    this.diffRemoved,
    this.diffTruncated = false,
    this.durationMs,
    this.note,
    this.interaction,
    this.codemode,
  });

  factory ToolInfo.fromJson(Json json) => ToolInfo(
    callId: _str(json['callId']),
    name: _str(json['name'], 'tool'),
    summary: _str(json['summary']),
    status: switch (json['status']) {
      'done' => ToolStatus.done,
      'error' => ToolStatus.error,
      _ => ToolStatus.running,
    },
    detail: _strOrNull(json['detail']),
    output: _strOrNull(json['output']),
    result: _strOrNull(json['result']),
    diff: _strOrNull(json['diff']),
    diffAdded: _intOrNull(json['diffAdded']),
    diffRemoved: _intOrNull(json['diffRemoved']),
    diffTruncated: _bool(json['diffTruncated']),
    durationMs: _intOrNull(json['durationMs']),
    note: _strOrNull(json['note']),
    interaction: ToolInteraction.fromJson(json['interaction']),
    codemode: CodemodeInfo.fromJson(json['codemode']),
  );

  final String callId;
  final String name;
  final String summary;
  final ToolStatus status;
  final String? detail;
  final String? output;
  final String? result;
  final String? diff;
  final int? diffAdded;
  final int? diffRemoved;
  final bool diffTruncated;
  final int? durationMs;
  final String? note;

  /// `todo` / `ask_user` 调用的结构化状态；其他工具缺省。
  final ToolInteraction? interaction;

  /// `codemode` 脚本的嵌套调用；其他工具与旧网关缺省。
  final CodemodeInfo? codemode;
}

enum TodoStatus { pending, inProgress, completed }

class TodoItem {
  const TodoItem({required this.id, required this.text, required this.status});

  factory TodoItem.fromJson(Json json) => TodoItem(
    id: _str(json['id']),
    text: _str(json['text']),
    status: switch (json['status']) {
      'in_progress' => TodoStatus.inProgress,
      'completed' => TodoStatus.completed,
      _ => TodoStatus.pending,
    },
  );

  final String id;
  final String text;
  final TodoStatus status;
}

/// `todos.get` 的结果：只读、有序，revision 只增。
class TodoList {
  const TodoList({required this.revision, required this.items});

  factory TodoList.fromJson(Json json) => TodoList(
    revision: _int(json['revision']),
    items: _list(json['items']).map(TodoItem.fromJson).toList(),
  );

  final int revision;
  final List<TodoItem> items;

  int get total => items.length;

  int get completed =>
      items.where((item) => item.status == TodoStatus.completed).length;
}

/// 状态里的待办摘要；缺省表示电脑端不支持，存在且 `count == 0` 表示支持但为空。
class TodoSummary {
  const TodoSummary({
    required this.revision,
    required this.count,
    required this.completed,
  });

  factory TodoSummary.fromJson(Json json) => TodoSummary(
    revision: _int(json['revision']),
    count: _int(json['count']),
    completed: _int(json['completed']),
  );

  final int revision;
  final int count;
  final int completed;
}

/// 状态里的问题摘要；缺省表示电脑端不支持，`pendingCount == 0` 表示支持但没有未决问题。
class QuestionsSummary {
  const QuestionsSummary({required this.revision, required this.pendingCount});

  factory QuestionsSummary.fromJson(Json json) => QuestionsSummary(
    revision: _int(json['revision']),
    pendingCount: _int(json['pendingCount']),
  );

  final int revision;
  final int pendingCount;
}

/// 状态里的计划摘要；缺省表示电脑端不支持，`pending == false` 表示支持但没有待批准计划。
class PlanSummary {
  const PlanSummary({
    required this.revision,
    required this.pending,
    this.version,
  });

  factory PlanSummary.fromJson(Json json) => PlanSummary(
    revision: _int(json['revision']),
    pending: _bool(json['pending']),
    version: _strOrNull(json['version']),
  );

  final int revision;
  final bool pending;

  /// 最新计划的版本（待批准时即该计划）；首个计划出现前为空。
  final String? version;
}

enum PlanStatus {
  awaitingApproval,
  approved,
  revisionRequested,
  superseded,
  cancelled,
}

PlanStatus _planStatus(Object? value) => switch (value) {
  'awaiting_approval' => PlanStatus.awaitingApproval,
  'approved' => PlanStatus.approved,
  'revision_requested' => PlanStatus.revisionRequested,
  'superseded' => PlanStatus.superseded,
  // 未知终态按已取消处理：不暴露任何无法提交的控件。
  _ => PlanStatus.cancelled,
};

/// 一份计划的完整持久记录（`plan.get` / `plan.respond` 的结果），全部按纯文本显示。
class PlanRecord {
  const PlanRecord({
    required this.version,
    required this.title,
    required this.steps,
    required this.note,
    required this.status,
    required this.createdAt,
    this.feedback,
    this.settledAt,
  });

  factory PlanRecord.fromJson(Json json) => PlanRecord(
    version: _str(json['version']),
    title: _str(json['title']),
    steps: json['steps'] is List
        ? (json['steps'] as List).whereType<String>().toList()
        : <String>[],
    note: _str(json['note']),
    status: _planStatus(json['status']),
    feedback: _strOrNull(json['feedback']),
    createdAt: _int(json['createdAt']),
    settledAt: _intOrNull(json['settledAt']),
  );

  final String version;
  final String title;
  final List<String> steps;
  final String note;
  final PlanStatus status;
  final String? feedback;
  final int createdAt;
  final int? settledAt;

  bool get awaiting => status == PlanStatus.awaitingApproval;
}

enum QuestionStatus { pending, answered, skipped, cancelled }

QuestionStatus _questionStatus(Object? value) => switch (value) {
  'pending' => QuestionStatus.pending,
  'answered' => QuestionStatus.answered,
  'skipped' => QuestionStatus.skipped,
  // 未知终态按已取消处理：不暴露任何无法提交的控件。
  _ => QuestionStatus.cancelled,
};

class QuestionOption {
  const QuestionOption({
    required this.id,
    required this.label,
    this.description,
    this.recommended = false,
  });

  factory QuestionOption.fromJson(Json json) => QuestionOption(
    id: _str(json['id']),
    label: _str(json['label']),
    description: _strOrNull(json['description']),
    recommended: _bool(json['recommended']),
  );

  final String id;
  final String label;
  final String? description;

  /// 仅是提示：界面标注“推荐”，从不预选。
  final bool recommended;
}

/// `questions.list` 的条目；完整题目用 `questions.get`。
class QuestionSummary {
  const QuestionSummary({
    required this.id,
    required this.version,
    required this.preview,
    required this.multiple,
    required this.optionCount,
    required this.createdAt,
  });

  factory QuestionSummary.fromJson(Json json) => QuestionSummary(
    id: _int(json['id']),
    version: _str(json['version']),
    preview: _str(json['preview']),
    multiple: _bool(json['multiple']),
    optionCount: _int(json['optionCount']),
    createdAt: _int(json['createdAt']),
  );

  final int id;
  final String version;
  final String preview;
  final bool multiple;
  final int optionCount;
  final int createdAt;
}

class QuestionList {
  const QuestionList({required this.revision, required this.pending});

  factory QuestionList.fromJson(Json json) => QuestionList(
    revision: _int(json['revision']),
    pending: _list(json['pending']).map(QuestionSummary.fromJson).toList(),
  );

  final int revision;
  final List<QuestionSummary> pending;
}

class QuestionAnswer {
  const QuestionAnswer({required this.optionIds, this.text});

  factory QuestionAnswer.fromJson(Json json) => QuestionAnswer(
    optionIds: json['optionIds'] is List
        ? (json['optionIds'] as List).whereType<String>().toList()
        : <String>[],
    text: _strOrNull(json['text']),
  );

  /// 按问题选项顺序。
  final List<String> optionIds;
  final String? text;
}

/// 一道问题的完整持久记录（`questions.get` / `questions.respond` 的结果）。
class QuestionRecord {
  const QuestionRecord({
    required this.id,
    required this.callId,
    required this.version,
    required this.question,
    required this.multiple,
    required this.options,
    required this.status,
    required this.createdAt,
    this.answer,
    this.settledAt,
  });

  factory QuestionRecord.fromJson(Json json) => QuestionRecord(
    id: _int(json['id']),
    callId: _str(json['callId']),
    version: _str(json['version']),
    question: _str(json['question']),
    multiple: _bool(json['multiple']),
    options: _list(json['options']).map(QuestionOption.fromJson).toList(),
    status: _questionStatus(json['status']),
    answer: json['answer'] is Map
        ? QuestionAnswer.fromJson(_map(json['answer']))
        : null,
    createdAt: _int(json['createdAt']),
    settledAt: _intOrNull(json['settledAt']),
  );

  final int id;
  final String callId;
  final String version;
  final String question;
  final bool multiple;
  final List<QuestionOption> options;
  final QuestionStatus status;
  final QuestionAnswer? answer;
  final int createdAt;
  final int? settledAt;

  bool get pending => status == QuestionStatus.pending;

  QuestionOption? option(String id) {
    for (final option in options) {
      if (option.id == id) return option;
    }
    return null;
  }

  /// 已选选项的标签；题目已不再列出的 id 退回 id 本身。
  List<String> get answerLabels => <String>[
    for (final id in answer?.optionIds ?? const <String>[])
      option(id)?.label ?? id,
  ];
}

/// 转录里 `todo` / `ask_user` 工具项的结构化状态（不解析 `result` 文案）。
sealed class ToolInteraction {
  const ToolInteraction();

  static ToolInteraction? fromJson(Object? value) {
    if (value is! Map) return null;
    final json = value.cast<String, dynamic>();
    return switch (json['kind']) {
      'ask_user' => AskUserInteraction(
        id: _int(json['id']),
        question: _str(json['question']),
        multiple: _bool(json['multiple']),
        options: _list(json['options']).map(QuestionOption.fromJson).toList(),
        status: _questionStatus(json['status']),
        optionIds: json['optionIds'] is List
            ? (json['optionIds'] as List).whereType<String>().toList()
            : const <String>[],
        labels: json['labels'] is List
            ? (json['labels'] as List).whereType<String>().toList()
            : const <String>[],
        text: _strOrNull(json['text']),
      ),
      'todo' => TodoInteraction(
        action: _str(json['action'], 'list'),
        revision: _int(json['revision']),
        completed: _int(json['completed']),
        total: _int(json['total']),
      ),
      _ => null,
    };
  }
}

class AskUserInteraction extends ToolInteraction {
  const AskUserInteraction({
    required this.id,
    required this.question,
    required this.multiple,
    required this.options,
    required this.status,
    required this.optionIds,
    required this.labels,
    this.text,
  });

  final int id;
  final String question;
  final bool multiple;
  final List<QuestionOption> options;
  final QuestionStatus status;
  final List<String> optionIds;
  final List<String> labels;
  final String? text;
}

class TodoInteraction extends ToolInteraction {
  const TodoInteraction({
    required this.action,
    required this.revision,
    required this.completed,
    required this.total,
  });

  /// `list` 或 `replace`。
  final String action;
  final int revision;
  final int completed;
  final int total;
}

enum ChatItemType { user, assistant, tool, system }

class ChatItem {
  const ChatItem({
    required this.key,
    required this.type,
    this.text = '',
    this.thinking = '',
    this.note,
    this.error,
    this.skill,
    this.tool,
    this.images = const <ImageRef>[],
    this.refs = const <ContentRef>[],
  });

  factory ChatItem.fromJson(Json json) {
    final legacyError = json['type'] == 'error';
    return ChatItem(
      key: _str(json['key']),
      type: switch (json['type']) {
        'user' => ChatItemType.user,
        'assistant' || 'error' => ChatItemType.assistant,
        'tool' => ChatItemType.tool,
        _ => ChatItemType.system,
      },
      text: legacyError ? '' : _str(json['text']),
      thinking: _str(json['thinking']),
      note: _strOrNull(json['note']),
      error: legacyError ? _str(json['text']) : _strOrNull(json['error']),
      skill: _strOrNull(json['skill']),
      tool: json['tool'] is Map ? ToolInfo.fromJson(_map(json['tool'])) : null,
      images: _list(json['images']).map(ImageRef.fromJson).toList(),
      refs: _list(json['refs']).map(ContentRef.fromJson).toList(),
    );
  }

  final String key;
  final ChatItemType type;
  final String text;
  final String thinking;
  final String? note;
  final String? error;
  final String? skill;
  final ToolInfo? tool;
  final List<ImageRef> images;

  /// 被截为预览的大字段引用；字段名见 [ContentRef.field]。
  final List<ContentRef> refs;

  ContentRef? refFor(String field) {
    for (final ref in refs) {
      if (ref.field == field) return ref;
    }
    return null;
  }
}

class Usage {
  const Usage({
    this.input = 0,
    this.output = 0,
    this.cacheRead = 0,
    this.cacheWrite = 0,
    this.totalTokens = 0,
    this.cost = 0,
  });

  factory Usage.fromJson(Json json) => Usage(
    input: _int(json['input']),
    output: _int(json['output']),
    cacheRead: _int(json['cacheRead']),
    cacheWrite: _int(json['cacheWrite']),
    totalTokens: _int(json['totalTokens']),
    cost: _numOrNull(json['cost']) ?? 0,
  );

  final int input;
  final int output;
  final int cacheRead;
  final int cacheWrite;
  final int totalTokens;
  final double cost;
}

class SubagentRound {
  const SubagentRound({
    required this.taskId,
    this.callId = '',
    required this.agentId,
    required this.role,
    required this.title,
    required this.status,
    required this.approvalCount,
    required this.readonly,
    this.round,
    this.usage,
  });

  factory SubagentRound.fromJson(Json json) => SubagentRound(
    taskId: _int(json['taskId']),
    callId: _str(json['callId']),
    agentId: _str(json['agentId']),
    round: _intOrNull(json['round']),
    role: _str(json['role']),
    title: _str(json['title']),
    status: _str(json['status']),
    approvalCount: _int(json['approvalCount']),
    readonly: _bool(json['readonly']),
    usage: json['usage'] is Map ? Usage.fromJson(_map(json['usage'])) : null,
  );

  final int taskId;
  final String callId;
  final String agentId;
  final int? round;
  final String role;
  final String title;
  final String status;
  final int approvalCount;
  final bool readonly;
  final Usage? usage;

  bool get active => status == 'queued' || status == 'running';
}

class AgentSummary {
  const AgentSummary({
    required this.agentId,
    required this.role,
    required this.title,
    required this.status,
    required this.roundCount,
    required this.approvalCount,
    this.activeRoundId,
  });

  factory AgentSummary.fromJson(Json json) => AgentSummary(
    agentId: _str(json['agentId']),
    role: _str(json['role']),
    title: _str(json['title']),
    status: _str(json['status']),
    activeRoundId: _intOrNull(json['activeRoundId']),
    roundCount: _int(json['roundCount']),
    approvalCount: _int(json['approvalCount']),
  );

  final String agentId;
  final String role;
  final String title;
  final String status;
  final int? activeRoundId;
  final int roundCount;
  final int approvalCount;
}

/// 电脑上仍在排队、尚未进入会话的用户输入。
class QueuedInput {
  const QueuedInput({
    required this.id,
    required this.mode,
    required this.preview,
    required this.images,
  });

  factory QueuedInput.fromJson(Json json) => QueuedInput(
    id: _int(json['id']),
    mode: _str(json['mode'], 'followUp'),
    preview: _str(json['preview']),
    images: _int(json['images']),
  );

  final int id;

  /// `steer`（引导当前运行）或 `followUp`（回答结束后排队）。
  final String mode;
  final String preview;
  final int images;

  bool get steer => mode == 'steer';
}

class ChatStatus {
  const ChatStatus({
    this.busy = false,
    this.queued,
    this.status,
    this.usage = const Usage(),
    this.taskUsage,
    this.contextPercent,
    this.model,
    this.thinkingLevel,
    this.subagents = const <SubagentRound>[],
    this.agents = const <AgentSummary>[],
    this.approvalCount = 0,
    this.readonly = false,
    this.todos,
    this.questions,
    this.plan,
  });

  factory ChatStatus.fromJson(Json json) {
    final agent = _map(json['agent']);
    final context = _map(json['contextUsage']);
    return ChatStatus(
      busy: _bool(json['busy']),
      queued: json['queued'] is List
          ? _list(json['queued']).map(QueuedInput.fromJson).toList()
          : null,
      status: _strOrNull(json['status']),
      usage: Usage.fromJson(_map(json['usage'])),
      taskUsage: json['taskUsage'] is Map
          ? Usage.fromJson(_map(json['taskUsage']))
          : null,
      contextPercent: _numOrNull(context['percent']),
      model: _strOrNull(agent['model']),
      thinkingLevel: _strOrNull(agent['thinkingLevel']),
      subagents: _list(json['subagents']).map(SubagentRound.fromJson).toList(),
      agents: _list(json['agents']).map(AgentSummary.fromJson).toList(),
      approvalCount: _int(json['approvalCount']),
      readonly: _bool(json['readonly']),
      todos: json['todos'] is Map
          ? TodoSummary.fromJson(_map(json['todos']))
          : null,
      questions: json['questions'] is Map
          ? QuestionsSummary.fromJson(_map(json['questions']))
          : null,
      plan: json['plan'] is Map
          ? PlanSummary.fromJson(_map(json['plan']))
          : null,
    );
  }

  final bool busy;

  /// 缺省表示电脑端不支持排队列表（旧版本）；空列表表示支持且无排队项。
  final List<QueuedInput>? queued;
  final String? status;
  final Usage usage;
  final Usage? taskUsage;
  final double? contextPercent;
  final String? model;
  final String? thinkingLevel;
  final List<SubagentRound> subagents;
  final List<AgentSummary> agents;
  final int approvalCount;
  final bool readonly;

  /// 缺省表示电脑端不支持待办；`count == 0` 表示支持但为空。
  final TodoSummary? todos;

  /// 缺省表示电脑端不支持提问；`pendingCount == 0` 表示支持但没有未决问题。
  final QuestionsSummary? questions;

  /// 缺省表示电脑端不支持计划；`pending == false` 表示支持但没有待批准计划。
  final PlanSummary? plan;
}

class StreamingToolCall {
  const StreamingToolCall({
    required this.callId,
    required this.name,
    required this.summary,
    required this.done,
  });

  factory StreamingToolCall.fromJson(Json json) => StreamingToolCall(
    callId: _str(json['callId']),
    name: _str(json['name']),
    summary: _str(json['summary']),
    done: json['status'] == 'done',
  );

  final String callId;
  final String name;
  final String summary;
  final bool done;
}

class Streaming {
  const Streaming({
    this.text = '',
    this.thinking = '',
    this.textOmitted = 0,
    this.thinkingOmitted = 0,
    this.toolCalls = const <StreamingToolCall>[],
  });

  factory Streaming.fromJson(Json json) => Streaming(
    text: _str(json['text']),
    thinking: _str(json['thinking']),
    textOmitted: _int(json['textOmitted']),
    thinkingOmitted: _int(json['thinkingOmitted']),
    toolCalls: _list(json['toolCalls'])
        .map(StreamingToolCall.fromJson)
        .toList(),
  );

  final String text;
  final String thinking;
  final int textOmitted;
  final int thinkingOmitted;
  final List<StreamingToolCall> toolCalls;

  Streaming append({String? text, String? thinking}) => Streaming(
    text: this.text + (text ?? ''),
    thinking: this.thinking + (thinking ?? ''),
    textOmitted: textOmitted,
    thinkingOmitted: thinkingOmitted,
    toolCalls: toolCalls,
  );
}

class Approval {
  const Approval({
    required this.id,
    required this.version,
    required this.taskId,
    required this.command,
    required this.cwd,
    required this.requestedAt,
    this.agentId,
    this.title,
    this.timeoutSeconds,
  });

  factory Approval.fromJson(Json json) => Approval(
    id: _int(json['id']),
    version: _str(json['version']),
    taskId: _int(json['taskId']),
    agentId: _strOrNull(json['agentId']),
    title: _strOrNull(json['title']),
    command: _str(json['command']),
    cwd: _str(json['cwd']),
    timeoutSeconds: _numOrNull(json['timeoutSeconds']),
    requestedAt: _int(json['requestedAt']),
  );

  final int id;
  final String version;
  final int taskId;
  final String? agentId;
  final String? title;
  final String command;
  final String cwd;
  final double? timeoutSeconds;
  final int requestedAt;
}
