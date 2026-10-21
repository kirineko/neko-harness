import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';

/// 工作区与会话列表（design D6/D10）：按工作区过滤、搜索、分页、新建与恢复上次选择。
class SessionsController extends ChangeNotifier {
  SessionsController({required this.prefs});

  final PrefsStore prefs;

  MobileApi? _api;
  String? _serverId;
  StreamSubscription<RpcNotification>? _notifications;
  int _generation = 0;
  int _listGeneration = 0;
  List<Workspace> _workspaces = <Workspace>[];
  String? _workspace;
  List<SessionSummary> _sessions = <SessionSummary>[];
  final Map<String, SessionSummary> _known = <String, SessionSummary>{};
  String? _nextCursor;
  String _query = '';
  bool _loading = false;
  UiText? _error;
  Future<SessionSummary?>? _creating;
  Timer? _searchTimer;

  List<Workspace> get workspaces => _workspaces;

  String? get workspace => _workspace;

  Workspace? get currentWorkspace {
    for (final w in _workspaces) {
      if (w.root == _workspace) return w;
    }
    return null;
  }

  List<SessionSummary> get sessions => _sessions;

  /// 见过的会话摘要（含搜索过滤/翻页之外的）：顶栏标题据此显示，不受列表筛选影响。
  SessionSummary? known(String? id) => id == null ? null : _known[id];

  /// 当前工作区最近使用（含打开）的会话，用于切换工作区后的默认会话（与 Web 一致）。
  SessionSummary? get mostRecentlyUsed {
    SessionSummary? best;
    for (final s in _sessions) {
      if (best == null || s.lastUsedAt > best.lastUsedAt) best = s;
    }
    return best;
  }

  bool get hasMore => _nextCursor != null;

  String get query => _query;

  bool get loading => _loading;

  bool get creating => _creating != null;

  UiText? get error => _error;

  bool get ready => _api != null;

  Future<void> bind(MobileApi api, String serverId) async {
    _api = api;
    if (_serverId != serverId) {
      _serverId = serverId;
      _workspace = null;
      _sessions = <SessionSummary>[];
      _known.clear();
      _query = '';
    }
    await _notifications?.cancel();
    _notifications = api.notifications.listen((event) {
      if (event.method == 'workspaces.changed') unawaited(loadWorkspaces());
      if (event.method == 'sessions.changed') unawaited(refresh());
    });
    await loadWorkspaces();
  }

  void unbind() {
    _generation++;
    _api = null;
    unawaited(_notifications?.cancel());
    _notifications = null;
    _loading = false;
    notifyListeners();
  }

  Future<void> loadWorkspaces() async {
    final api = _api;
    final serverId = _serverId;
    if (api == null || serverId == null) return;
    final generation = _generation;
    try {
      final result = asJson(await api.call('workspaces.list'));
      if (generation != _generation) return;
      _workspaces = asJsonList(result['workspaces'])
          .map(Workspace.fromJson)
          .toList();
      final saved = await prefs.get(PrefKeys.workspace(serverId));
      final roots = _workspaces.map((w) => w.root).toSet();
      final keep = _workspace != null && roots.contains(_workspace)
          ? _workspace
          : (saved != null && roots.contains(saved)
                ? saved
                : (_workspaces.isEmpty ? null : _workspaces.first.root));
      final changed = keep != _workspace;
      _workspace = keep;
      _error = null;
      notifyListeners();
      if (changed || _sessions.isEmpty) await refresh();
    } catch (error) {
      if (generation != _generation) return;
      _error = describeError(error);
      notifyListeners();
    }
  }

  Future<void> selectWorkspace(String root) async {
    final serverId = _serverId;
    if (root == _workspace || serverId == null) return;
    _workspace = root;
    _sessions = <SessionSummary>[];
    _nextCursor = null;
    notifyListeners();
    await prefs.set(PrefKeys.workspace(serverId), root);
    await refresh();
  }

  void search(String query) {
    _query = query;
    _searchTimer?.cancel();
    _searchTimer = Timer(const Duration(milliseconds: 250), refresh);
    notifyListeners();
  }

  Future<void> refresh() => _load(reset: true);

  Future<void> loadMore() => _load(reset: false);

  Future<void> _load({required bool reset}) async {
    final api = _api;
    final workspace = _workspace;
    if (api == null || workspace == null) return;
    if (!reset && (_nextCursor == null || _loading)) return;
    final epoch = _generation;
    final generation = ++_listGeneration;
    bool stale() => epoch != _generation || generation != _listGeneration;
    _loading = true;
    notifyListeners();
    try {
      final result = asJson(
        await api.call('sessions.list', <String, Object?>{
          'workspace': workspace,
          if (_query.trim().isNotEmpty) 'query': _query.trim(),
          if (!reset) 'cursor': _nextCursor,
        }),
      );
      if (stale()) return;
      final page = asJsonList(result['sessions'])
          .map(SessionSummary.fromJson)
          .toList();
      _sessions = reset ? page : <SessionSummary>[..._sessions, ...page];
      for (final item in page) {
        _known[item.id] = item;
      }
      _nextCursor = result['nextCursor'] as String?;
      _error = null;
    } catch (error) {
      if (stale()) return;
      _error = describeError(error);
    } finally {
      if (!stale()) {
        _loading = false;
        notifyListeners();
      }
    }
  }

  /// 在当前工作区新建会话；连续点击只创建一个。
  Future<SessionSummary?> create() {
    if (_creating != null) return _creating!;
    final pending = _create().whenComplete(() {
      _creating = null;
      notifyListeners();
    });
    _creating = pending;
    notifyListeners();
    return pending;
  }

  Future<SessionSummary?> _create() async {
    final api = _api;
    final workspace = _workspace;
    if (api == null || workspace == null) return null;
    try {
      final created = SessionSummary.fromJson(
        asJson(
          await api.call('sessions.create', <String, Object?>{
            'workspace': workspace,
          }),
        ),
      );
      _known[created.id] = created;
      _sessions = <SessionSummary>[
        created,
        ..._sessions.where((s) => s.id != created.id),
      ];
      return created;
    } catch (error) {
      _error = describeError(error);
      return null;
    }
  }

  /// 恢复上次选择的会话；失效时回退到当前工作区最近的会话。
  Future<String?> restoreSession() async {
    final serverId = _serverId;
    if (serverId == null) return null;
    final saved = await prefs.get(PrefKeys.session(serverId));
    if (saved != null && _sessions.any((s) => s.id == saved)) return saved;
    if (saved != null && _query.isEmpty && _nextCursor != null) {
      // 不在第一页时仍尝试附着，失败由调用方回退。
      return saved;
    }
    return _sessions.isEmpty ? null : _sessions.first.id;
  }

  @override
  void dispose() {
    _searchTimer?.cancel();
    unawaited(_notifications?.cancel());
    super.dispose();
  }
}
