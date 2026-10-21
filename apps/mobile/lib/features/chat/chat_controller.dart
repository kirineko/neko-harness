import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:neko_mobile/ui/widgets/transcript_view.dart';
import 'package:flutter/widgets.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/chat/interactions_controller.dart';
import 'package:neko_mobile/features/chat/transcript.dart';
import 'package:neko_mobile/l10n/core_text.dart';
import 'package:neko_mobile/l10n/error_text.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:uuid/uuid.dart';

/// 用户可读的错误文案（不暴露内部细节）；显示时才按当前语言解析。
UiText describeError(Object error) {
  if (error is MobileApiException) {
    return switch (error.code) {
      'rejected' => (l10n) => l10n.apiRejected(
        localizeCoreError(l10n, error.message),
      ),
      'gone' => (l10n) => l10n.apiGone,
      'revoked' || 'unauthorized' => (l10n) => l10n.apiUnauthorized,
      'busy_limit' => (l10n) => l10n.apiBusyLimit,
      'not_found' => (l10n) => l10n.apiNotFound,
      'invalid_params' => (l10n) => l10n.apiInvalidParams(
        localizeCoreError(l10n, error.message),
      ),
      _ => (l10n) => l10n.apiFailed,
    };
  }
  if (error is RpcException) return (l10n) => rpcErrorText(l10n, error);
  return (l10n) => l10n.errorGeneric;
}

/// 按 contentRef 分块读取完整大字段（design D8）。
Future<String> readFullContent(MobileApi api, ContentRef ref) async {
  final bytes = BytesBuilder(copy: false);
  var offset = 0;
  for (;;) {
    final chunk = asJson(
      await api.call('chat.content', <String, Object?>{
        'ref': ref.toJson(),
        'offset': offset,
      }),
    );
    bytes.add(base64Decode(chunk['data'] as String? ?? ''));
    offset = chunk['nextOffset'] as int? ?? offset;
    if (chunk['done'] == true) break;
  }
  return utf8.decode(bytes.takeBytes());
}

/// 按 64 KiB 分块读取历史图片。
Future<Uint8List> readImageBytes(
  MobileApi api, {
  required String subscriptionId,
  required ImageRef image,
  String? agentId,
}) async {
  final bytes = BytesBuilder(copy: false);
  var offset = 0;
  for (;;) {
    final chunk = asJson(
      await api.call('media.read', <String, Object?>{
        'subscriptionId': subscriptionId,
        'agentId': ?agentId,
        'entryId': image.entryId,
        'contentIndex': image.contentIndex,
        'offset': offset,
      }),
    );
    final data = base64Decode(chunk['data'] as String? ?? '');
    bytes.add(data);
    offset = chunk['nextOffset'] as int? ?? offset + data.length;
    if (chunk['done'] == true || data.isEmpty) break;
  }
  return bytes.takeBytes();
}

enum ChatPhase { idle, attaching, ready, offline, error }

/// 当前主会话：订阅、补丁、翻页、发送与审批（design D8/D9）。
class ChatController extends ChangeNotifier implements TranscriptActions {
  ChatController({required this.prefs, Uuid? uuid})
    : _pending = PendingStore(prefs),
      _uuid = uuid ?? const Uuid() {
    input.addListener(_onInputChanged);
  }

  final PrefsStore prefs;
  final PendingStore _pending;
  final Uuid _uuid;

  @override
  final Transcript transcript = Transcript();
  final TextEditingController input = TextEditingController();

  /// 当前会话的待办与用户提问；能力随 hello 声明，旧电脑不会产生任何相关请求。
  final InteractionsController interactions = InteractionsController();

  MobileApi? _api;
  StreamSubscription<RpcNotification>? _notifications;
  String? _serverId;
  String? _sessionId;
  String? _subscriptionId;
  int _generation = 0;
  ChatPhase _phase = ChatPhase.idle;
  UiText? _error;
  bool _loadingOlder = false;
  bool _sending = false;
  int? _withdrawingId;
  UiText? _notice;
  List<Approval> _approvals = <Approval>[];
  List<PendingSubmission> _pendingList = <PendingSubmission>[];
  Timer? _draftTimer;
  bool _restoringDraft = false;
  final Map<String, Uint8List> _images = <String, Uint8List>{};

  ChatPhase get phase => _phase;

  String? get sessionId => _sessionId;

  String? get subscriptionId => _subscriptionId;

  UiText? get error => _error;

  @override
  bool get loadingOlder => _loadingOlder;

  bool get sending => _sending;

  MobileApi? get api => _api;

  /// 控制是否可用：连接就绪且订阅有效。
  bool get canControl => _phase == ChatPhase.ready && _api != null;

  List<Approval> get approvals => _approvals;

  /// 当前会话的待确认发送。
  List<PendingSubmission> get pending =>
      _pendingList.where((p) => p.sessionId == _sessionId).toList();

  /// 电脑上的排队输入；null 表示电脑端不支持（隐藏排队条）。
  List<QueuedInput>? get queued => transcript.status.queued;

  int? get withdrawingId => _withdrawingId;

  /// 撤回的非错误提示（已发送、图片未恢复等）。
  UiText? get notice => _notice;

  void clearNotice() {
    _notice = null;
    notifyListeners();
  }

  void clearError() {
    _error = null;
    notifyListeners();
  }

  void _setError(Object error) {
    _error = describeError(error);
    notifyListeners();
  }

  /// 连接就绪：绑定 API 并恢复会话（若有）。[capabilities] 取自 `server.hello`，
  /// 缺 `todos` / `questions` / `plan` 的旧电脑不会收到对应请求。
  Future<void> bind(
    MobileApi api,
    String serverId, {
    Iterable<String> capabilities = const <String>[],
  }) async {
    final serverChanged = _serverId != serverId;
    _api = api;
    _serverId = serverId;
    interactions.setCapabilities(capabilities);
    await _notifications?.cancel();
    _notifications = api.notifications.listen(_onNotification);
    _pendingList = await _pending.load(serverId);
    if (serverChanged) {
      _sessionId = null;
      transcript.clear();
      interactions.reset();
    }
    final session = _sessionId;
    if (session != null) {
      await attach(session);
    } else {
      notifyListeners();
    }
  }

  /// 连接断开：保留已显示内容，禁用控制，等待重连后重新 attach。
  void unbind() {
    _generation++;
    _api = null;
    _subscriptionId = null;
    unawaited(_notifications?.cancel());
    _notifications = null;
    if (_phase != ChatPhase.idle) _phase = ChatPhase.offline;
    _sending = false;
    _loadingOlder = false;
    interactions.suspend();
    notifyListeners();
  }

  Future<void> attach(String sessionId) async {
    final api = _api;
    final serverId = _serverId;
    if (api == null || serverId == null) return;
    final generation = ++_generation;
    final switching = _sessionId != sessionId;
    if (switching) {
      await _flushDraft();
      _sessionId = sessionId;
      transcript.clear();
      interactions.reset();
      _approvals = <Approval>[];
      _images.clear();
      await _restoreDraft();
    } else {
      interactions.suspend();
    }
    _phase = ChatPhase.attaching;
    _subscriptionId = null;
    _error = null;
    notifyListeners();
    try {
      final result = asJson(
        await api.call('chat.attach', <String, Object?>{
          'sessionId': sessionId,
        }),
      );
      if (generation != _generation) return;
      _subscriptionId = result['subscriptionId'] as String?;
      transcript.applySnapshot(asJson(result['snapshot']));
      _phase = ChatPhase.ready;
      await prefs.set(PrefKeys.session(serverId), sessionId);
      if (generation != _generation) return;
      final subscriptionId = _subscriptionId;
      if (subscriptionId != null) {
        interactions.attach(
          api: api,
          subscriptionId: subscriptionId,
          serverId: serverId,
          sessionId: sessionId,
          plan: transcript.status.plan,
        );
      }
      notifyListeners();
      unawaited(_refreshApprovals(generation));
      await _settlePending(generation);
    } catch (error) {
      if (generation != _generation) return;
      _phase = ChatPhase.error;
      _setError(error);
    }
  }

  void _onNotification(RpcNotification event) {
    final subscriptionId = _subscriptionId;
    if (subscriptionId == null ||
        event.params['subscriptionId'] != subscriptionId) {
      return;
    }
    switch (event.method) {
      case 'chat.patch':
        if (!transcript.applyPatch(event.params)) {
          _reattach();
        } else if (event.params['status'] is Map) {
          interactions.onStatus(transcript.status);
        }
      case 'chat.reset':
        _reattach();
      case 'approvals.changed':
        unawaited(_refreshApprovals(_generation));
      case 'todos.changed' || 'questions.changed' || 'plan.changed':
        interactions.onNotification(
          event.method,
          event.params['revision'] as int?,
        );
    }
  }

  void _reattach() {
    final session = _sessionId;
    if (session != null) unawaited(attach(session));
  }

  @override
  Future<void> loadOlder() async {
    final api = _api;
    final subscriptionId = _subscriptionId;
    final before = transcript.historyBefore;
    if (api == null || subscriptionId == null || before == null) return;
    if (_loadingOlder) return;
    final generation = _generation;
    _loadingOlder = true;
    notifyListeners();
    try {
      final page = asJson(
        await api.call('chat.history', <String, Object?>{
          'subscriptionId': subscriptionId,
          'before': before,
        }),
      );
      if (generation != _generation) return;
      transcript.prepend(
        asJsonList(page['items']).map(ChatItem.fromJson).toList(),
        page['historyBefore'] as String?,
      );
    } on MobileApiException catch (error) {
      if (generation != _generation) return;
      if (error.code == 'stale_ref') {
        _reattach();
      } else {
        _setError(error);
      }
    } catch (error) {
      if (generation == _generation) _setError(error);
    } finally {
      if (generation == _generation) {
        _loadingOlder = false;
        notifyListeners();
      }
    }
  }

  // ——— 发送 ———

  /// 发送输入框内容；受理后仅在输入框仍为原文时清空。
  Future<void> send() async {
    final text = input.text.trim();
    final sessionId = _sessionId;
    final serverId = _serverId;
    if (text.isEmpty ||
        sessionId == null ||
        serverId == null ||
        !canControl ||
        _sending) {
      return;
    }
    final record = PendingSubmission(
      requestId: _uuid.v4(),
      sessionId: sessionId,
      text: text,
      steer: false,
      createdAt: DateTime.now().millisecondsSinceEpoch,
    );
    _pendingList = <PendingSubmission>[..._pendingList, record];
    await _pending.save(serverId, _pendingList);
    await _submit(record, originalInput: input.text);
  }

  Future<void> retry(PendingSubmission record) =>
      _submit(record, originalInput: null);

  Future<void> discard(PendingSubmission record) async {
    final serverId = _serverId;
    if (serverId == null) return;
    _pendingList = _pendingList
        .where((p) => p.requestId != record.requestId)
        .toList();
    await _pending.save(serverId, _pendingList);
    notifyListeners();
  }

  Future<void> _submit(
    PendingSubmission record, {
    required String? originalInput,
  }) async {
    final api = _api;
    final subscriptionId = _subscriptionId;
    final serverId = _serverId;
    if (api == null || subscriptionId == null || serverId == null) return;
    _sending = true;
    _error = null;
    notifyListeners();
    try {
      await api.call('chat.submit', <String, Object?>{
        'subscriptionId': subscriptionId,
        'requestId': record.requestId,
        'text': record.text,
        if (record.steer) 'mode': 'steer',
      });
      await _settled(serverId, record);
      if (originalInput != null && input.text == originalInput) {
        input.clear();
      } else if (originalInput == null && input.text.trim() == record.text) {
        input.clear();
      }
    } on MobileApiException catch (error) {
      // 电脑明确拒绝：不再待确认，草稿保留供修改后重发。
      await _settled(serverId, record);
      _setError(error);
    } catch (error) {
      await _markUnknown(serverId, record);
      _setError(error);
    } finally {
      _sending = false;
      notifyListeners();
    }
  }

  Future<void> _settled(String serverId, PendingSubmission record) async {
    _pendingList = _pendingList
        .where((p) => p.requestId != record.requestId)
        .toList();
    await _pending.save(serverId, _pendingList);
  }

  Future<void> _markUnknown(String serverId, PendingSubmission record) async {
    _pendingList = <PendingSubmission>[
      for (final p in _pendingList)
        p.requestId == record.requestId ? p.markUnknown() : p,
    ];
    await _pending.save(serverId, _pendingList);
  }

  /// 重连/重启后对本会话的待确认记录先查受理状态；不自动重发。
  Future<void> _settlePending(int generation) async {
    final api = _api;
    final serverId = _serverId;
    final subscriptionId = _subscriptionId;
    if (api == null || serverId == null || subscriptionId == null) return;
    for (final record in pending) {
      try {
        final status = asJson(
          await api.call('chat.submissionStatus', <String, Object?>{
            'subscriptionId': subscriptionId,
            'requestId': record.requestId,
          }),
        );
        if (generation != _generation) return;
        if (status['status'] == 'accepted') {
          await _settled(serverId, record);
          if (input.text.trim() == record.text) input.clear();
        } else {
          await _markUnknown(serverId, record);
        }
      } catch (_) {
        if (generation != _generation) return;
        await _markUnknown(serverId, record);
      }
    }
    if (generation == _generation) notifyListeners();
  }

  /// 把一条排队输入改为引导；电脑返回新的提交 id，列表以状态更新为准。
  Future<void> steer(QueuedInput item) async {
    final api = _api;
    final subscriptionId = _subscriptionId;
    if (!canControl ||
        api == null ||
        subscriptionId == null ||
        _withdrawingId != null) {
      return;
    }
    _withdrawingId = item.id;
    _error = null;
    _notice = null;
    notifyListeners();
    try {
      final result = asJson(
        await api.call('chat.steer', <String, Object?>{
          'subscriptionId': subscriptionId,
          'id': item.id,
        }),
      );
      switch (result['result']) {
        case 'steered':
          break;
        case 'withdrawn':
          final text = result['text'] as String? ?? item.preview;
          input.text = input.text.trim().isEmpty
              ? text
              : '${input.text}\n$text';
          input.selection = TextSelection.collapsed(offset: input.text.length);
          _notice = (l10n) => l10n.chatNoticeSteerWithdrawn;
        case 'unknown':
          _notice = (l10n) => l10n.chatNoticeNotQueued;
        default:
          _notice = (l10n) => l10n.chatNoticeAlreadySentSteer;
      }
    } catch (error) {
      _setError(error);
    } finally {
      _withdrawingId = null;
      notifyListeners();
    }
  }

  /// 撤回一条排队输入；成功后把电脑返回的完整原文取回草稿（草稿非空时追加到新行）。
  Future<void> withdraw(QueuedInput item) async {
    final api = _api;
    final subscriptionId = _subscriptionId;
    if (!canControl ||
        api == null ||
        subscriptionId == null ||
        _withdrawingId != null) {
      return;
    }
    _withdrawingId = item.id;
    _error = null;
    _notice = null;
    notifyListeners();
    try {
      final result = asJson(
        await api.call('chat.withdraw', <String, Object?>{
          'subscriptionId': subscriptionId,
          'id': item.id,
        }),
      );
      switch (result['result']) {
        case 'withdrawn':
          final text = result['text'] as String? ?? item.preview;
          input.text = input.text.trim().isEmpty
              ? text
              : '${input.text}\n$text';
          input.selection = TextSelection.collapsed(offset: input.text.length);
          if ((result['images'] as int? ?? 0) > 0) {
            _notice = (l10n) => l10n.chatNoticeImagesNotRestored;
          }
        case 'unknown':
          _notice = (l10n) => l10n.chatNoticeNotQueued;
        default:
          _notice = (l10n) => l10n.chatNoticeAlreadySentWithdraw;
      }
    } catch (error) {
      _setError(error);
    } finally {
      _withdrawingId = null;
      notifyListeners();
    }
  }

  Future<void> abort() async {
    final api = _api;
    final subscriptionId = _subscriptionId;
    if (api == null || subscriptionId == null) return;
    try {
      await api.call('chat.abort', <String, Object?>{
        'subscriptionId': subscriptionId,
      });
    } catch (error) {
      _setError(error);
    }
  }

  // ——— 审批 ———

  Future<void> _refreshApprovals(int generation) async {
    final api = _api;
    final subscriptionId = _subscriptionId;
    if (api == null || subscriptionId == null) return;
    try {
      final result = asJson(
        await api.call('approvals.list', <String, Object?>{
          'subscriptionId': subscriptionId,
        }),
      );
      if (generation != _generation) return;
      _approvals = asJsonList(result['approvals'])
          .map(Approval.fromJson)
          .toList();
      notifyListeners();
    } catch (_) {
      // 审批列表刷新失败不影响主视图；下一次 approvals.changed 再取。
    }
  }

  /// 返回实际结算状态（allowed/denied/cancelled/pending）。
  Future<String?> decide(Approval approval, {required bool allow}) async {
    final api = _api;
    final subscriptionId = _subscriptionId;
    if (api == null || subscriptionId == null) return null;
    try {
      final result = asJson(
        await api.call('approvals.decide', <String, Object?>{
          'subscriptionId': subscriptionId,
          'taskId': approval.taskId,
          'id': approval.id,
          'version': approval.version,
          'decision': allow ? 'allow' : 'deny',
        }),
      );
      _approvals = _approvals.where((a) => a.id != approval.id).toList();
      notifyListeners();
      unawaited(_refreshApprovals(_generation));
      return result['status'] as String?;
    } catch (error) {
      _setError(error);
      unawaited(_refreshApprovals(_generation));
      return null;
    }
  }

  // ——— 大字段与图片 ———

  @override
  Future<void> expand(ChatItem item, ContentRef ref) async {
    final api = _api;
    if (api == null) return;
    try {
      final text = await readFullContent(api, ref);
      transcript.setExpanded(item.key, ref.field, text);
    } on MobileApiException catch (error) {
      if (error.code == 'content_changed') {
        _reattach();
      } else {
        _setError(error);
      }
    } catch (error) {
      _setError(error);
    }
  }

  @override
  Future<Uint8List> image(ImageRef image) async {
    final cached = _images[image.cacheKey];
    if (cached != null) return cached;
    final api = _api;
    final subscriptionId = _subscriptionId;
    if (api == null || subscriptionId == null) {
      throw const RpcNetworkException();
    }
    final bytes = await readImageBytes(
      api,
      subscriptionId: subscriptionId,
      image: image,
    );
    if (_images.length >= 24) _images.remove(_images.keys.first);
    _images[image.cacheKey] = bytes;
    return bytes;
  }

  // ——— 草稿 ———

  void _onInputChanged() {
    if (_restoringDraft) return;
    _draftTimer?.cancel();
    _draftTimer = Timer(const Duration(milliseconds: 300), _flushDraft);
  }

  Future<void> _flushDraft() async {
    _draftTimer?.cancel();
    final serverId = _serverId;
    final sessionId = _sessionId;
    if (serverId == null || sessionId == null) return;
    final key = PrefKeys.draft(serverId, sessionId);
    if (input.text.isEmpty) {
      await prefs.remove(key);
    } else {
      await prefs.set(key, input.text);
    }
  }

  Future<void> _restoreDraft() async {
    final serverId = _serverId;
    final sessionId = _sessionId;
    _restoringDraft = true;
    try {
      input.text = serverId == null || sessionId == null
          ? ''
          : await prefs.get(PrefKeys.draft(serverId, sessionId)) ?? '';
    } finally {
      _restoringDraft = false;
    }
  }

  /// 离开当前会话（被归档或切换电脑）。
  Future<void> leave() async {
    await _flushDraft();
    _generation++;
    final api = _api;
    final subscriptionId = _subscriptionId;
    _sessionId = null;
    _subscriptionId = null;
    _phase = ChatPhase.idle;
    transcript.clear();
    interactions.reset();
    _approvals = <Approval>[];
    _images.clear();
    _restoringDraft = true;
    input.clear();
    _restoringDraft = false;
    notifyListeners();
    if (api != null && subscriptionId != null) {
      unawaited(
        api
            .call('chat.detach', <String, Object?>{
              'subscriptionId': subscriptionId,
            })
            .catchError((Object _) => null),
      );
    }
  }

  @override
  void dispose() {
    _draftTimer?.cancel();
    unawaited(_notifications?.cancel());
    input.dispose();
    transcript.dispose();
    interactions.dispose();
    super.dispose();
  }
}
