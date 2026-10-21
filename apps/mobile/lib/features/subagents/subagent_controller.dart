import 'dart:async';

import 'package:neko_mobile/ui/widgets/transcript_view.dart';
import 'package:flutter/foundation.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/chat/transcript.dart';
import 'package:neko_mobile/l10n/l10n.dart';

/// 子 agent 全屏详情（design D10）：跟随主会话订阅打开/重开，返回时关闭。
class SubagentController extends ChangeNotifier implements TranscriptActions {
  SubagentController({required this.chat, required this.agentId}) {
    chat.addListener(_onChatChanged);
    _onChatChanged();
  }

  final ChatController chat;
  final String agentId;
  @override
  final Transcript transcript = Transcript();

  String? _subscriptionId;
  String? _openedFor;
  int _generation = 0;
  bool _opening = false;
  bool _loadingOlder = false;
  UiText? _error;
  StreamSubscription<RpcNotification>? _notifications;
  MobileApi? _boundApi;
  final Map<String, Uint8List> _images = <String, Uint8List>{};
  bool _disposed = false;

  bool get opening => _opening;

  @override
  bool get loadingOlder => _loadingOlder;

  UiText? get error => _error;

  void clearError() {
    _error = null;
    notifyListeners();
  }

  bool get canControl => chat.canControl && _subscriptionId != null;

  /// 当前子 agent 的待决审批（与主页共用同一列表）。
  List<Approval> get approvals =>
      chat.approvals.where((a) => a.agentId == agentId).toList();

  /// 该身份的全部轮次（取自主会话状态，含本轮/累计用量）。
  List<SubagentRound> get rounds => transcript.status.subagents.isNotEmpty
      ? transcript.status.subagents
      : chat.transcript.status.subagents
            .where((r) => r.agentId == agentId)
            .toList();

  SubagentRound? get activeRound {
    for (final round in chat.transcript.status.subagents) {
      if (round.agentId == agentId && round.active) return round;
    }
    return null;
  }

  void _onChatChanged() {
    final subscription = chat.subscriptionId;
    final api = chat.api;
    if (!identical(api, _boundApi)) {
      _boundApi = api;
      unawaited(_notifications?.cancel());
      _notifications = api?.notifications.listen(_onNotification);
    }
    if (subscription == null) {
      _subscriptionId = null;
      _openedFor = null;
      _generation++;
      notifyListeners();
      return;
    }
    if (subscription != _openedFor) unawaited(open());
    notifyListeners();
  }

  void _onNotification(RpcNotification event) {
    if (_subscriptionId == null ||
        event.params['subagentSubscriptionId'] != _subscriptionId) {
      return;
    }
    if (event.method == 'subagents.patch') {
      if (!transcript.applyPatch(event.params)) unawaited(open());
    } else if (event.method == 'subagents.reset') {
      unawaited(open());
    }
  }

  Future<void> open() async {
    final api = chat.api;
    final chatSubscription = chat.subscriptionId;
    if (api == null || chatSubscription == null || _disposed) return;
    final generation = ++_generation;
    _openedFor = chatSubscription;
    _opening = true;
    _error = null;
    notifyListeners();
    try {
      final result = asJson(
        await api.call('subagents.open', <String, Object?>{
          'subscriptionId': chatSubscription,
          if (agentId.startsWith('round-'))
            'taskId': int.tryParse(agentId.substring(6)) ?? 0
          else
            'agentId': agentId,
        }),
      );
      if (generation != _generation || _disposed) return;
      _subscriptionId = result['subagentSubscriptionId'] as String?;
      transcript.applySnapshot(asJson(result['snapshot']));
    } catch (error) {
      if (generation != _generation || _disposed) return;
      _error = describeError(error);
    } finally {
      if (generation == _generation && !_disposed) {
        _opening = false;
        notifyListeners();
      }
    }
  }

  @override
  Future<void> loadOlder() async {
    final api = chat.api;
    final subscription = _subscriptionId;
    final before = transcript.historyBefore;
    if (api == null || subscription == null || before == null) return;
    if (_loadingOlder) return;
    final generation = _generation;
    _loadingOlder = true;
    notifyListeners();
    try {
      final page = asJson(
        await api.call('subagents.history', <String, Object?>{
          'subagentSubscriptionId': subscription,
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
        unawaited(open());
      } else {
        _error = describeError(error);
      }
    } catch (error) {
      if (generation == _generation) _error = describeError(error);
    } finally {
      if (generation == _generation && !_disposed) {
        _loadingOlder = false;
        notifyListeners();
      }
    }
  }

  /// 停止当前活动轮次（精确绑定 taskId）。
  Future<bool> stop(SubagentRound round) async {
    final api = chat.api;
    final subscription = chat.subscriptionId;
    if (api == null || subscription == null) return false;
    try {
      await api.call('subagents.stop', <String, Object?>{
        'subscriptionId': subscription,
        'taskId': round.taskId,
      });
      return true;
    } catch (error) {
      _error = describeError(error);
      notifyListeners();
      return false;
    }
  }

  @override
  Future<void> expand(ChatItem item, ContentRef ref) async {
    final api = chat.api;
    if (api == null) return;
    try {
      transcript.setExpanded(
        item.key,
        ref.field,
        await readFullContent(api, ref),
      );
    } on MobileApiException catch (error) {
      if (error.code == 'content_changed') {
        unawaited(open());
      } else {
        _error = describeError(error);
        notifyListeners();
      }
    } catch (error) {
      _error = describeError(error);
      notifyListeners();
    }
  }

  @override
  Future<Uint8List> image(ImageRef image) async {
    final cached = _images[image.cacheKey];
    if (cached != null) return cached;
    final api = chat.api;
    final subscription = chat.subscriptionId;
    if (api == null || subscription == null) throw const RpcNetworkException();
    final bytes = await readImageBytes(
      api,
      subscriptionId: subscription,
      image: image,
      agentId: agentId,
    );
    if (_images.length >= 24) _images.remove(_images.keys.first);
    _images[image.cacheKey] = bytes;
    return bytes;
  }

  @override
  void dispose() {
    _disposed = true;
    chat.removeListener(_onChatChanged);
    unawaited(_notifications?.cancel());
    final api = chat.api;
    final subscription = _subscriptionId;
    if (api != null && subscription != null) {
      unawaited(
        api
            .call('subagents.close', <String, Object?>{
              'subagentSubscriptionId': subscription,
            })
            .catchError((Object _) => null),
      );
    }
    transcript.dispose();
    super.dispose();
  }
}
