import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neko_mobile/core/pairing/pairing_models.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/core/storage/key_value_store.dart';

/// 应用级连接状态（UI 据此渲染）。
sealed class NekoConnectionState {
  const NekoConnectionState();
}

/// 无已配对电脑：进入扫码页。
class NekoConnIdle extends NekoConnectionState {
  const NekoConnIdle();
}

/// 首次连接（启动恢复或配对成功后的首次 hello）。
class NekoConnConnecting extends NekoConnectionState {
  const NekoConnConnecting();
}

/// 断线后的重连尝试中。
class NekoConnRestoring extends NekoConnectionState {
  const NekoConnRestoring();
}

/// 网络断开/电脑暂不可达，已安排退避重试。
class NekoConnOffline extends NekoConnectionState {
  const NekoConnOffline({required this.computer, required this.nextRetryIn});

  final PairedComputer computer;

  /// 距下次重试的等待时长。
  final Duration nextRetryIn;
}

class NekoConnReady extends NekoConnectionState {
  const NekoConnReady({required this.computer, required this.hello});

  final PairedComputer computer;
  final RpcHelloResult hello;
}

class NekoConnRevoked extends NekoConnectionState {
  const NekoConnRevoked({required this.computer});

  final PairedComputer computer;
}

/// 证书与配对指纹不符（电脑可能更换了证书）。
class NekoConnTrustChanged extends NekoConnectionState {
  const NekoConnTrustChanged({required this.computer});

  final PairedComputer computer;
}

class NekoConnIncompatible extends NekoConnectionState {
  const NekoConnIncompatible({required this.computer});

  final PairedComputer computer;
}

typedef RpcClientFactory = NekoRpcClient Function(PairedComputer computer);
typedef RetrySleep = Future<void> Function(Duration delay);

/// 统一的连接所有者（design D9）：
/// 启动恢复、配对后接入、断线退避重连、前后台恢复都经由此处，
/// 任何时刻至多一个活动连接；旧连接 dispose 且释放 pinned client。
class ConnectionManager {
  ConnectionManager({
    required this.store,
    required this.rpcFactory,
    RetrySleep? sleep,
    double Function()? random,
  }) : _sleep = sleep ?? Future<void>.delayed,
       _random = random ?? Random().nextDouble;

  final KeyValueStore store;
  final RpcClientFactory rpcFactory;
  final RetrySleep _sleep;
  final double Function() _random;

  final StreamController<NekoConnectionState> _states =
      StreamController<NekoConnectionState>.broadcast(sync: true);

  NekoConnectionState _state = const NekoConnIdle();
  NekoRpcClient? _client;
  PairedComputer? _computer;
  int _generation = 0;
  int _attempt = 0;
  bool _restored = false;
  bool _disposed = false;

  Stream<NekoConnectionState> get states => _states.stream;

  NekoConnectionState get state => _state;

  PairedComputer? get computer => _computer;

  /// 已就绪的移动 API；未就绪时为 null（UI 据此禁用控制）。
  MobileApi? get api => _state is NekoConnReady ? _client : null;

  Future<List<String>> _index() async {
    final raw = await store.read(StorageKeys.computerIndex);
    final ids = <String>[];
    if (raw != null) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is List) ids.addAll(decoded.whereType<String>());
      } on FormatException {
        // 损坏的索引按空处理，下面用 lastComputer 兜底。
      }
    }
    final last = await store.read(StorageKeys.lastComputer);
    if (last != null && last.isNotEmpty && !ids.contains(last)) ids.add(last);
    return ids;
  }

  Future<void> _writeIndex(List<String> ids) =>
      store.write(StorageKeys.computerIndex, jsonEncode(ids));

  Future<PairedComputer?> _load(String serverId) async {
    final raw = await store.read(StorageKeys.pairedComputer(serverId));
    if (raw == null) return null;
    try {
      return PairedComputer.fromJson(jsonDecode(raw));
    } on FormatException {
      return null;
    }
  }

  /// 已保存的电脑（状态与草稿按电脑隔离，切换需显式进行）。
  Future<List<PairedComputer>> savedComputers() async {
    final result = <PairedComputer>[];
    for (final id in await _index()) {
      final computer = await _load(id);
      if (computer != null) result.add(computer);
    }
    return result;
  }

  /// 切换到另一台已保存电脑：释放当前连接后连接目标。
  Future<void> switchTo(String serverId) async {
    final computer = await _load(serverId);
    if (computer == null || _disposed) return;
    await connectPaired(computer);
  }

  /// 忘记电脑：删除本地凭据记录；若为当前电脑则断开并回到扫码。
  Future<void> forget(String serverId) async {
    final ids = await _index()
      ..remove(serverId);
    await _writeIndex(ids);
    await store.delete(StorageKeys.pairedComputer(serverId));
    if (await store.read(StorageKeys.lastComputer) == serverId) {
      await store.delete(StorageKeys.lastComputer);
    }
    if (_computer?.serverId == serverId) stopToScan();
  }

  void _set(NekoConnectionState next) {
    _state = next;
    if (!_states.isClosed) {
      _states.add(next);
    }
  }

  bool _stale(int generation) => _disposed || generation != _generation;

  /// App 启动恢复：读取最近已配对电脑，存在则自动完成 server.hello。
  Future<void> restore() async {
    if (_restored || _disposed) {
      return;
    }
    _restored = true;
    final lastId = await store.read(StorageKeys.lastComputer);
    if (lastId == null || lastId.isEmpty) {
      _set(const NekoConnIdle());
      return;
    }
    final raw = await store.read(StorageKeys.pairedComputer(lastId));
    PairedComputer? computer;
    try {
      computer = raw == null ? null : PairedComputer.fromJson(jsonDecode(raw));
    } on FormatException {
      computer = null;
    }
    if (computer == null) {
      _set(const NekoConnIdle());
      return;
    }
    _computer = computer;
    _startAttempt(const NekoConnConnecting());
  }

  /// 配对成功后接入：持久化“当前电脑”并立即连接。
  Future<void> connectPaired(PairedComputer computer) async {
    _computer = computer;
    final ids = await _index();
    if (!ids.contains(computer.serverId)) ids.add(computer.serverId);
    await _writeIndex(ids);
    await store.write(StorageKeys.lastComputer, computer.serverId);
    _attempt = 0;
    _startAttempt(const NekoConnConnecting());
  }

  /// 前后台恢复：连接未 ready 时立即重试（不走退避）。
  /// 身份类终止态（revoked/trustChanged/incompatible）不重试。
  void onForeground() {
    if (_disposed || _computer == null) {
      return;
    }
    final state = _state;
    if (state is NekoConnReady ||
        state is NekoConnRevoked ||
        state is NekoConnTrustChanged ||
        state is NekoConnIncompatible) {
      return;
    }
    _attempt = 0;
    _startAttempt(const NekoConnRestoring());
  }

  /// 用户返回扫码：停止重试并释放连接（持久化记录保留，下次启动仍恢复）。
  void stopToScan() {
    _computer = null;
    _attempt = 0;
    _generation++;
    final old = _client;
    _client = null;
    old?.dispose();
    _set(const NekoConnIdle());
  }

  void _startAttempt(NekoConnectionState pendingState) {
    final computer = _computer;
    if (computer == null || _disposed) {
      return;
    }
    _generation++;
    final generation = _generation;
    final old = _client;
    _client = null;
    old?.dispose();
    _set(pendingState);
    final client = rpcFactory(computer);
    _client = client;
    unawaited(_runAttempt(client, computer, generation));
  }

  /// 仅当 [client] 仍是当前活动连接时 dispose；已被替换的旧连接跳过，
  /// 避免与 _startAttempt 的急切释放重复。
  void _disposeIfCurrent(NekoRpcClient client) {
    if (identical(client, _client)) {
      _client = null;
      client.dispose();
    }
  }

  Future<void> _runAttempt(
    NekoRpcClient client,
    PairedComputer computer,
    int generation,
  ) async {
    try {
      final connected = await client.connect();
      if (_stale(generation)) {
        _disposeIfCurrent(client);
        return;
      }
      _attempt = 0;
      _set(NekoConnReady(computer: computer, hello: connected.hello));
      _watchClose(client, generation);
    } on RpcException catch (e) {
      _disposeIfCurrent(client);
      if (_stale(generation)) {
        return;
      }
      switch (e) {
        case RpcRevokedException() || RpcUnauthorizedException():
          _set(NekoConnRevoked(computer: computer));
        case RpcIncompatibleException():
          _set(NekoConnIncompatible(computer: computer));
        case RpcCertificateException():
          _set(NekoConnTrustChanged(computer: computer));
        case RpcNetworkException() || RpcProtocolException():
          _scheduleRetry(computer, generation);
      }
    }
  }

  void _watchClose(NekoRpcClient client, int generation) {
    client.states.listen((state) {
      if (_stale(generation)) {
        return;
      }
      if (state is RpcClosed) {
        _handleClose(client, state.closeCode, generation);
      }
    });
  }

  void _handleClose(NekoRpcClient client, int? closeCode, int generation) {
    if (!identical(client, _client)) {
      // 该 client 已被替换/释放：重复 close 回调或旧 generation，忽略。
      return;
    }
    // socket 已关闭：释放 pinned client，按需重建。
    _client = null;
    client.dispose();
    switch (closeCode) {
      case 4401:
        _set(NekoConnRevoked(computer: _computer!));
      case 4402:
        _set(NekoConnIncompatible(computer: _computer!));
      default:
        // 网络断开/电脑网关重启：可恢复，进入退避重试。
        _scheduleRetry(_computer!, generation);
    }
  }

  void _scheduleRetry(PairedComputer computer, int generation) {
    if (_stale(generation)) {
      return;
    }
    final delay = _backoff(_attempt++);
    _set(NekoConnOffline(computer: computer, nextRetryIn: delay));
    unawaited(_retryAfter(delay, generation));
  }

  Future<void> _retryAfter(Duration delay, int generation) async {
    await _sleep(delay);
    if (_stale(generation)) {
      return;
    }
    _startAttempt(const NekoConnRestoring());
  }

  /// design D9 退避：1s 起、×2、上限 30s、±20% jitter。
  Duration _backoff(int attempt) {
    final seconds = attempt >= 5 ? 30 : 1 << attempt;
    final factor = 0.8 + 0.4 * _random();
    return Duration(milliseconds: (seconds * 1000 * factor).round());
  }

  void dispose() {
    if (_disposed) {
      return;
    }
    _disposed = true;
    _generation++;
    final old = _client;
    _client = null;
    old?.dispose();
    _states.close();
  }
}

/// 必须在根部或测试中覆盖。
final connectionManagerProvider = Provider<ConnectionManager>(
  (ref) =>
      throw UnimplementedError('connectionManagerProvider is not overridden'),
);
