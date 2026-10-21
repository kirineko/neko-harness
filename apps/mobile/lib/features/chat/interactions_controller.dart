import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart'
    show describeError;
import 'package:neko_mobile/features/plan/plan_decision.dart';
import 'package:neko_mobile/features/questions/question_draft.dart';
import 'package:neko_mobile/l10n/l10n.dart';

/// 失效提示驱动的读取：同一时刻只有一个在途读取；读取期间收到更高 revision
/// 就在本次结束后再读，直到持有的 revision 追上提示（有界，避免异常服务端造成死循环）。
class _RevisionReader {
  _RevisionReader({required this.read, required this.held});

  /// 读取并应用结果，返回应用后持有的 revision；失败或结果被丢弃时为 null。
  final Future<int?> Function() read;

  /// 当前持有的 revision；尚未取得本订阅首个结果时为 -1。
  final int Function() held;

  int _hint = 0;
  int _generation = 0;
  bool _running = false;
  Future<void> _loop = Future<void>.value();

  void reset() {
    _generation++;
    _running = false;
    _hint = 0;
    _loop = Future<void>.value();
  }

  /// [hint] 为失效提示里的 revision；不带 hint 表示无条件读取（attach 首查）。
  Future<void> request({int? hint}) {
    if (hint != null) {
      if (hint > _hint) _hint = hint;
      if (!_running && hint <= held()) return Future<void>.value();
    }
    if (_running) return _loop;
    return _loop = _run();
  }

  Future<void> _run() async {
    final generation = _generation;
    _running = true;
    try {
      for (var attempt = 0; attempt < 4; attempt++) {
        final revision = await read();
        if (generation != _generation) return;
        if (revision == null || _hint <= revision) return;
      }
    } finally {
      if (generation == _generation) _running = false;
    }
  }
}

/// 当前主会话的待办、用户提问与计划批准（design D7/D8/D9）：读取、草稿、回答与自动展开规则。
///
/// 能力由 `server.hello.capabilities` 决定：缺 `todos` / `questions` / `plan` 时绝不调用对应方法。
/// 所有异步结果都带订阅代次（[_epoch]）：切换会话、断线重连后，旧订阅的结果不会写入当前状态。
class InteractionsController extends ChangeNotifier {
  InteractionsController() {
    _todoReader = _RevisionReader(
      read: _readTodos,
      held: () => _todosFresh ? (_todos?.revision ?? -1) : -1,
    );
    _questionReader = _RevisionReader(
      read: _readQuestions,
      held: () => _questionsFresh ? _questionsRevision : -1,
    );
  }

  static const int _maxDrafts = 64;

  /// 回执丢失：回答可能已送达，不自动重发。
  static String noReceiptMessage(AppLocalizations l10n) =>
      l10n.interactionsNoReceiptAnswer;

  static String planNoReceiptMessage(AppLocalizations l10n) =>
      l10n.interactionsNoReceiptPlan;

  late final _RevisionReader _todoReader;
  late final _RevisionReader _questionReader;

  MobileApi? _api;
  String? _subscriptionId;
  String? _serverId;
  String? _sessionId;
  int _epoch = 0;
  bool _todosSupported = false;
  bool _questionsSupported = false;
  bool _planSupported = false;

  PlanSummary? _planSummary;
  PlanRecord? _plan;
  bool _planFresh = false;
  bool _planReading = false;
  bool _planDirty = false;
  UiText? _planLoadError;
  bool _planSubmitting = false;
  UiText? _planError;
  UiText? _planNote;

  /// 本端提交决定后收到的记录；他端先决定时它就是实际结果。卡片保留到用户关闭。
  PlanRecord? _planOutcome;
  String? _planDismissed;

  /// 修改意见草稿，按 server/session/version 隔离，只在内存。
  final Map<String, String> _planFeedback = <String, String>{};

  TodoList? _todos;
  bool _todosFresh = false;
  UiText? _todosError;

  int _questionsRevision = 0;
  bool _questionsFresh = false;
  List<QuestionSummary> _pending = <QuestionSummary>[];
  UiText? _questionsError;
  final Map<int, QuestionRecord> _records = <int, QuestionRecord>{};
  final Set<int> _loading = <int>{};
  final Map<int, UiText> _loadErrors = <int, UiText>{};
  final Set<String> _submitting = <String>{};
  final Map<String, UiText> _errors = <String, UiText>{};
  final Map<String, UiText> _notes = <String, UiText>{};

  /// 进程内的答案草稿与“用户已关闭”记录：按 server/session/question/version 隔离，不落盘。
  final LinkedHashMap<String, QuestionDraft> _drafts =
      LinkedHashMap<String, QuestionDraft>();
  final Set<String> _closed = <String>{};
  final Set<String> _seen = <String>{};
  final List<int> _armed = <int>[];

  // ——— 能力与状态 ———

  bool get todosSupported => _todosSupported;

  bool get questionsSupported => _questionsSupported;

  bool get planSupported => _planSupported;

  /// 订阅有效、可以读取与提交；离线时为 false（内容保留但标记为非最新）。
  bool get connected => _api != null && _subscriptionId != null;

  /// 已加载的待办；null 表示尚未取得（或不支持）。
  TodoList? get todos => _todos;

  /// 本订阅是否已读到最新待办；离线或重连后尚未重读时为 false，界面据此标注“非最新”。
  bool get todosCurrent => connected && _todosFresh;

  UiText? get todosError => _todosError;

  List<QuestionSummary> get pending => _pending;

  int get pendingCount => _pending.length;

  bool get questionsLoaded => _questionsFresh;

  UiText? get questionsError => _questionsError;

  QuestionRecord? record(int id) => _records[id];

  bool isLoading(int id) => _loading.contains(id);

  UiText? loadError(int id) => _loadErrors[id];

  bool isSubmitting(QuestionRecord question) =>
      _submitting.contains(_keyOf(question));

  UiText? submitError(QuestionRecord question) => _errors[_keyOf(question)];

  /// 实际结果与本端提交不同时的说明（如他端先回答）。
  UiText? settlementNote(QuestionRecord question) => _notes[_keyOf(question)];

  /// 卡片要显示的计划：本端刚做出的决定（含他端先决定的实际结果），否则是仍待批准的计划。
  /// 没有待批准计划且没有本端结果时为 null（隐藏）。
  PlanRecord? get planShown {
    if (!_planSupported) return null;
    final outcome = _planOutcome;
    if (outcome != null && outcome.version != _planDismissed) return outcome;
    final plan = _plan;
    return plan != null && plan.awaiting ? plan : null;
  }

  /// 提交期间禁止重复提交。
  bool get planSubmitting => _planSubmitting;

  UiText? get planError => _planError;

  UiText? get planLoadError => _planLoadError;

  /// 实际结果与本端提交不同时的说明（如他端先决定）。
  UiText? get planNote => _planNote;

  /// 状态摘要里的版本是否已读到记录；用于“读取中/重试”提示。
  bool get planLoaded => _planFresh;

  String planFeedbackDraft(PlanRecord plan) =>
      _planFeedback[_planKey(plan.version)] ?? '';

  void savePlanFeedback(PlanRecord plan, String feedback) {
    final key = _planKey(plan.version);
    if (feedback.isEmpty) {
      _planFeedback.remove(key);
    } else {
      _planFeedback[key] = feedback;
    }
  }

  String _planKey(String version) => '$_serverId/$_sessionId/$version';

  // ——— 会话与连接生命周期 ———

  /// 能力来自 hello；旧电脑两者皆无，此时不会发出任何 todos.* / questions.* 请求。
  void setCapabilities(Iterable<String> capabilities) {
    final todos = capabilities.contains('todos');
    final questions = capabilities.contains('questions');
    final plan = capabilities.contains('plan');
    if (todos == _todosSupported &&
        questions == _questionsSupported &&
        plan == _planSupported) {
      return;
    }
    _todosSupported = todos;
    _questionsSupported = questions;
    _planSupported = plan;
    if (!todos) _clearTodos();
    if (!questions) _clearQuestions();
    if (!plan) _clearPlan();
    notifyListeners();
  }

  /// 订阅建立：绑定新订阅并重新查询（不依赖通知重放）；本订阅的首个结果无条件接受。
  void attach({
    required MobileApi api,
    required String subscriptionId,
    required String serverId,
    required String sessionId,
    PlanSummary? plan,
  }) {
    if (_serverId != serverId || _sessionId != sessionId) {
      _clearContent();
    }
    _epoch++;
    _todoReader.reset();
    _questionReader.reset();
    _todosFresh = false;
    _questionsFresh = false;
    _planFresh = false;
    _planReading = false;
    _planDirty = false;
    _planSummary = plan;
    _loading.clear();
    _api = api;
    _subscriptionId = subscriptionId;
    _serverId = serverId;
    _sessionId = sessionId;
    notifyListeners();
    if (_todosSupported) unawaited(_todoReader.request());
    if (_questionsSupported) unawaited(_questionReader.request());
    if (_planSupported) unawaited(refreshPlan());
  }

  /// 订阅失效（断线、重新 attach 开始）：保留已加载内容但视为非最新，旧结果被隔离。
  /// 在途的回答没有回执，不显示成功，也不会自动重发。
  void suspend() {
    _epoch++;
    _todoReader.reset();
    _questionReader.reset();
    _api = null;
    _subscriptionId = null;
    _loading.clear();
    for (final key in _submitting) {
      _errors[key] = noReceiptMessage;
    }
    _submitting.clear();
    _planFresh = false;
    _planReading = false;
    _planDirty = false;
    if (_planSubmitting) {
      _planSubmitting = false;
      _planError = planNoReceiptMessage;
    }
    notifyListeners();
  }

  /// 切换/离开会话或电脑：清空当前会话内容（草稿与“已关闭”记录按键保留）。
  void reset() {
    _epoch++;
    _todoReader.reset();
    _questionReader.reset();
    _api = null;
    _subscriptionId = null;
    _serverId = null;
    _sessionId = null;
    _clearContent();
    notifyListeners();
  }

  void _clearContent() {
    _clearTodos();
    _clearQuestions();
    _clearPlan();
  }

  void _clearPlan() {
    _planSummary = null;
    _plan = null;
    _planFresh = false;
    _planReading = false;
    _planDirty = false;
    _planLoadError = null;
    _planSubmitting = false;
    _planError = null;
    _planNote = null;
    _planOutcome = null;
    _planDismissed = null;
  }

  void _clearTodos() {
    _todos = null;
    _todosFresh = false;
    _todosError = null;
  }

  void _clearQuestions() {
    _questionsRevision = 0;
    _questionsFresh = false;
    _pending = <QuestionSummary>[];
    _questionsError = null;
    _records.clear();
    _loading.clear();
    _loadErrors.clear();
    _submitting.clear();
    _errors.clear();
    _notes.clear();
    _seen.clear();
    _armed.clear();
  }

  // ——— 通知 ———

  /// `todos.changed` / `questions.changed` / `plan.changed`：失效提示，不含数据；按 revision 重新读取。
  void onNotification(String method, int? revision) {
    if (revision == null) return;
    switch (method) {
      case 'todos.changed' when _todosSupported && connected:
        unawaited(_todoReader.request(hint: revision));
      case 'questions.changed' when _questionsSupported && connected:
        unawaited(_questionReader.request(hint: revision));
      case 'plan.changed' when _planSupported && connected:
        unawaited(refreshPlan());
    }
  }

  /// `chat.patch` 的状态摘要同样是失效提示（缺省 = 不支持，不触发读取）。
  void onStatus(ChatStatus status) {
    if (!connected) return;
    final todos = status.todos;
    if (todos != null && _todosSupported) {
      unawaited(_todoReader.request(hint: todos.revision));
    }
    final questions = status.questions;
    if (questions != null && _questionsSupported) {
      unawaited(_questionReader.request(hint: questions.revision));
    }
    final plan = status.plan;
    if (plan != null && _planSupported) {
      final old = _planSummary;
      _planSummary = plan;
      if (!_planFresh ||
          old == null ||
          old.revision != plan.revision ||
          old.version != plan.version) {
        unawaited(refreshPlan());
      }
    }
  }

  // ——— 读取 ———

  Future<int?> _readTodos() async {
    final api = _api;
    final subscription = _subscriptionId;
    final epoch = _epoch;
    if (api == null || subscription == null) return null;
    try {
      final result = TodoList.fromJson(
        asJson(
          await api.call('todos.get', <String, Object?>{
            'subscriptionId': subscription,
          }),
        ),
      );
      if (epoch != _epoch) return null;
      final held = _todos;
      // 只接受 revision 不低于已持有的结果（乱序/过期的读取被丢弃）。
      if (_todosFresh && held != null && result.revision < held.revision) {
        return held.revision;
      }
      _todos = result;
      _todosFresh = true;
      _todosError = null;
      notifyListeners();
      return result.revision;
    } catch (error) {
      if (epoch != _epoch) return null;
      _todosError = describeError(error);
      notifyListeners();
      return null;
    }
  }

  Future<int?> _readQuestions() async {
    final api = _api;
    final subscription = _subscriptionId;
    final epoch = _epoch;
    if (api == null || subscription == null) return null;
    try {
      final list = QuestionList.fromJson(
        asJson(
          await api.call('questions.list', <String, Object?>{
            'subscriptionId': subscription,
          }),
        ),
      );
      if (epoch != _epoch) return null;
      if (_questionsFresh && list.revision < _questionsRevision) {
        return _questionsRevision;
      }
      _questionsRevision = list.revision;
      _questionsFresh = true;
      _questionsError = null;
      _pending = list.pending;
      _armNewQuestions(list.pending);
      notifyListeners();
      unawaited(_reconcileRecords(epoch));
      return list.revision;
    } catch (error) {
      if (epoch != _epoch) return null;
      _questionsError = describeError(error);
      notifyListeners();
      return null;
    }
  }

  /// 重新读取待办（界面“重试”）。
  Future<void> refreshTodos() => _todosSupported && connected
      ? _todoReader.request()
      : Future<void>.value();

  Future<void> refreshQuestions() => _questionsSupported && connected
      ? _questionReader.request()
      : Future<void>.value();

  /// 已缓存的未决记录若不再出现在未决列表里（他端回答、跳过、停止），读回真实终态；
  /// 版本变化的缓存记录丢弃。
  Future<void> _reconcileRecords(int epoch) async {
    final stale = <int>[];
    for (final record in _records.values.toList()) {
      if (!record.pending) continue;
      final listed = _pending.where((s) => s.id == record.id).firstOrNull;
      if (listed == null) {
        stale.add(record.id);
      } else if (listed.version != record.version) {
        _records.remove(record.id);
      }
    }
    for (final id in stale) {
      if (epoch != _epoch) return;
      await loadQuestion(id, force: true);
    }
  }

  /// 读取一道问题的完整记录（`questions.get`）；用于 sheet 展示与取得真实终态。
  Future<void> loadQuestion(int id, {bool force = false}) async {
    final api = _api;
    final subscription = _subscriptionId;
    if (api == null || subscription == null || !_questionsSupported) return;
    if (_loading.contains(id)) return;
    if (!force && _records.containsKey(id)) return;
    final epoch = _epoch;
    _loading.add(id);
    _loadErrors.remove(id);
    notifyListeners();
    try {
      final record = QuestionRecord.fromJson(
        asJson(
          await api.call('questions.get', <String, Object?>{
            'subscriptionId': subscription,
            'id': id,
          }),
        ),
      );
      if (epoch != _epoch) return;
      _applyRecord(record);
    } catch (error) {
      if (epoch != _epoch) return;
      _loadErrors[id] = error is MobileApiException && error.code == 'not_found'
          ? (l10n) => l10n.interactionsQuestionGone
          : describeError(error);
      // 未决列表里已没有它：以列表为准。
      if (error is MobileApiException && error.code == 'not_found') {
        _pending = _pending.where((s) => s.id != id).toList();
      }
    } finally {
      if (epoch == _epoch) {
        _loading.remove(id);
        notifyListeners();
      }
    }
  }

  void _applyRecord(QuestionRecord record) {
    final old = _records[record.id];
    // 已读到终态的记录不会被过期的“未决”读取退回。
    if (old != null &&
        old.version == record.version &&
        !old.pending &&
        record.pending) {
      return;
    }
    _records[record.id] = record;
    _loadErrors.remove(record.id);
    if (!record.pending) {
      _pending = _pending.where((s) => s.id != record.id).toList();
      _drafts.remove(_keyOf(record));
    }
    notifyListeners();
  }

  // ——— 计划 ———

  /// 按状态摘要里的版本读取计划记录；读取期间摘要变化会在本次结束后再读（有界）。
  Future<void> refreshPlan() async {
    if (!_planSupported || !connected) return;
    if (_planReading) {
      _planDirty = true;
      return;
    }
    _planReading = true;
    final epoch = _epoch;
    try {
      for (var attempt = 0; attempt < 4; attempt++) {
        _planDirty = false;
        await _readPlan();
        if (epoch != _epoch || !_planDirty) break;
      }
    } finally {
      if (epoch == _epoch) _planReading = false;
    }
  }

  Future<void> _readPlan() async {
    final api = _api;
    final subscription = _subscriptionId;
    final epoch = _epoch;
    if (api == null || subscription == null) return;
    final version = _planSummary?.version;
    if (version == null) {
      _plan = null;
      _planFresh = true;
      _planLoadError = null;
      notifyListeners();
      return;
    }
    try {
      final record = PlanRecord.fromJson(
        asJson(
          await api.call('plan.get', <String, Object?>{
            'subscriptionId': subscription,
            'version': version,
          }),
        ),
      );
      if (epoch != _epoch) return;
      // 摘要在读取期间已指向别的版本时丢弃，随后的再读会取新的。
      if (record.version != _planSummary?.version) return;
      _applyPlan(record);
      _planFresh = true;
      _planLoadError = null;
      notifyListeners();
    } catch (error) {
      if (epoch != _epoch) return;
      if (error is MobileApiException && error.code == 'not_found') {
        _plan = null;
        _planFresh = true;
        _planLoadError = null;
      } else {
        _planLoadError = describeError(error);
      }
      notifyListeners();
    }
  }

  void _applyPlan(PlanRecord record) {
    final old = _plan;
    // 已读到结算状态的记录不会被过期的“待批准”读取退回。
    if (old != null &&
        old.version == record.version &&
        !old.awaiting &&
        record.awaiting) {
      return;
    }
    _plan = record;
    if (_planOutcome?.version != record.version) {
      _planOutcome = null;
      _planNote = null;
      _planError = null;
    }
  }

  /// 用户关闭已结算的计划卡片。
  void dismissPlan() {
    final shown = planShown;
    if (shown == null || shown.awaiting) return;
    _planDismissed = shown.version;
    notifyListeners();
  }

  /// 批准或要求修改；与普通聊天提交无关。只有收到回执才更新：
  /// 无回执时不做乐观结果，保留反馈草稿并提示，由用户重连后明确重试，绝不自动重发。
  Future<void> respondPlan(PlanRecord plan, PlanDecision decision) async {
    final api = _api;
    final subscription = _subscriptionId;
    if (api == null ||
        subscription == null ||
        !_planSupported ||
        !plan.awaiting ||
        _planSubmitting) {
      return;
    }
    if (decision is RevisePlan) {
      final problem = feedbackProblem(decision.feedback);
      if (problem != null) {
        _planError = problem;
        notifyListeners();
        return;
      }
    }
    final epoch = _epoch;
    _planSubmitting = true;
    _planError = null;
    _planNote = null;
    notifyListeners();
    try {
      final result = PlanRecord.fromJson(
        asJson(
          await api.call('plan.respond', <String, Object?>{
            'subscriptionId': subscription,
            'version': plan.version,
            'decision': decision.toJson(),
          }),
        ),
      );
      if (epoch != _epoch) return;
      final expected = decision is ApprovePlan
          ? PlanStatus.approved
          : PlanStatus.revisionRequested;
      if (result.status != expected) {
        _planNote = (l10n) => l10n.interactionsSettledElsewhere;
      }
      _plan = result;
      _planOutcome = result;
      _planFeedback.remove(_planKey(plan.version));
      unawaited(refreshPlan());
    } on MobileApiException catch (error) {
      if (epoch != _epoch) return;
      _planError = describeError(error);
      if (error.code == 'rejected' || error.code == 'not_found') {
        unawaited(refreshPlan());
      }
    } catch (error) {
      if (epoch != _epoch) return;
      _planError = error is RpcException
          ? planNoReceiptMessage
          : describeError(error);
    } finally {
      if (epoch == _epoch) {
        _planSubmitting = false;
        notifyListeners();
      }
    }
  }

  /// 取消待批准的计划并退出 plan 模式（手机不能进入）。与 [respondPlan] 同样只认回执：
  /// 无回执时不做乐观结果，由用户重连后明确重试；之后以服务端状态为准重新读取。
  Future<void> exitPlan() async {
    final api = _api;
    final subscription = _subscriptionId;
    if (api == null ||
        subscription == null ||
        !_planSupported ||
        _planSubmitting) {
      return;
    }
    final epoch = _epoch;
    _planSubmitting = true;
    _planError = null;
    _planNote = null;
    notifyListeners();
    try {
      await api.call('plan.exit', <String, Object?>{
        'subscriptionId': subscription,
      });
      if (epoch != _epoch) return;
      await refreshPlan();
    } on MobileApiException catch (error) {
      if (epoch != _epoch) return;
      _planError = describeError(error);
      if (error.code == 'rejected' || error.code == 'not_found') {
        unawaited(refreshPlan());
      }
    } catch (error) {
      if (epoch != _epoch) return;
      _planError = error is RpcException
          ? planNoReceiptMessage
          : describeError(error);
    } finally {
      if (epoch == _epoch) {
        _planSubmitting = false;
        notifyListeners();
      }
    }
  }

  // ——— 回答 ———

  /// 回答或跳过；与普通聊天提交无关。只有收到回执才更新为终态：
  /// 无回执时不做乐观终态，保留草稿并提示，由用户重连后明确重试，绝不自动重发。
  Future<void> respond(
    QuestionRecord question,
    QuestionResponse response,
  ) async {
    final api = _api;
    final subscription = _subscriptionId;
    final key = _keyOf(question);
    if (api == null ||
        subscription == null ||
        !_questionsSupported ||
        !question.pending ||
        _submitting.contains(key)) {
      return;
    }
    if (response is AnswerResponse) {
      final problem = draftProblem(
        question,
        QuestionDraft(optionIds: response.optionIds, text: response.text ?? ''),
      );
      if (problem != null) {
        _errors[key] = problem;
        notifyListeners();
        return;
      }
    }
    final epoch = _epoch;
    _submitting.add(key);
    _errors.remove(key);
    _notes.remove(key);
    notifyListeners();
    try {
      final result = QuestionRecord.fromJson(
        asJson(
          await api.call('questions.respond', <String, Object?>{
            'subscriptionId': subscription,
            'id': question.id,
            'version': question.version,
            'response': response.toJson(),
          }),
        ),
      );
      if (epoch != _epoch) return;
      if (!_sameOutcome(response, result)) {
        _notes[key] = (l10n) => l10n.interactionsSettledElsewhere;
      }
      _applyRecord(result);
      unawaited(refreshQuestions());
    } on MobileApiException catch (error) {
      if (epoch != _epoch) return;
      _errors[key] = describeError(error);
      if (error.code == 'rejected' || error.code == 'not_found') {
        unawaited(loadQuestion(question.id, force: true));
        unawaited(refreshQuestions());
      }
    } catch (error) {
      if (epoch != _epoch) return;
      _errors[key] = error is RpcException
          ? noReceiptMessage
          : describeError(error);
    } finally {
      if (epoch == _epoch) {
        _submitting.remove(key);
        notifyListeners();
      }
    }
  }

  bool _sameOutcome(QuestionResponse response, QuestionRecord result) {
    return switch (response) {
      SkipResponse() => result.status == QuestionStatus.skipped,
      AnswerResponse(:final optionIds, :final text) =>
        result.status == QuestionStatus.answered &&
            result.answer != null &&
            listEquals(result.answer!.optionIds, optionIds) &&
            result.answer!.text == text,
    };
  }

  // ——— 答案草稿 ———

  QuestionDraft draftFor(QuestionRecord question) =>
      _drafts[_keyOf(question)] ?? const QuestionDraft();

  /// 只写内存，不通知监听者（输入过程中不需要重建）。
  void saveDraft(QuestionRecord question, QuestionDraft draft) {
    final key = _keyOf(question);
    _drafts.remove(key);
    _drafts[key] = draft;
    while (_drafts.length > _maxDrafts) {
      _drafts.remove(_drafts.keys.first);
    }
  }

  // ——— 自动展开（design D9）———

  bool get hasArmed => _armed.isNotEmpty;

  /// 会话页首次进入或问题首次出现时，把尚未被用户关闭过的问题“武装”为待评估的自动展开候选。
  void _armNewQuestions(List<QuestionSummary> list) {
    for (final summary in list) {
      final key = _keyOfSummary(summary);
      if (_seen.add(key) && !_closed.contains(key)) _armed.add(summary.id);
    }
  }

  /// 评估自动展开：返回应展开的问题（至多一个）。无论是否展开，候选都被消费，
  /// 因此条件不满足（输入聚焦/有草稿/有其他面板）时只显示提示条，之后不会突然弹出。
  QuestionSummary? takeAutoPresent({required bool canPresent}) {
    if (_armed.isEmpty) return null;
    final ids = List<int>.of(_armed);
    _armed.clear();
    if (!canPresent || !connected) return null;
    for (final id in ids) {
      final summary = _pending.where((s) => s.id == id).firstOrNull;
      if (summary != null && !_closed.contains(_keyOfSummary(summary))) {
        return summary;
      }
    }
    return null;
  }

  /// 问题版本的隔离键（server/session/question/version）；sheet 展示时取走，关闭时回传。
  String keyFor(int id, String version) =>
      '$_serverId/$_sessionId/$id/$version';

  /// 用户关闭了展示过该问题版本的 sheet：同一版本不再自动展开。
  void markClosed(String key) => _closed.add(key);

  String _keyOf(QuestionRecord question) =>
      keyFor(question.id, question.version);

  String _keyOfSummary(QuestionSummary summary) =>
      keyFor(summary.id, summary.version);

  @override
  void dispose() {
    _epoch++;
    super.dispose();
  }
}
