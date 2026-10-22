import 'dart:async';
import 'dart:io';

import 'package:json_rpc_2/json_rpc_2.dart' as jsonrpc;
import 'package:neko_mobile/core/net/pinned_client.dart';
import 'package:neko_mobile/core/pairing/pairing_models.dart';
import 'package:neko_mobile/core/pairing/pairing_service.dart';
import 'package:web_socket_channel/io.dart';

/// 应用版本常量：与 pubspec.yaml 的 version 1.0.0+1 对应（不加 package_info_plus）。
const String kNekoAppVersion = '1.0.0';
const String kNekoAppBuild = '1';
const String kNekoAppPlatform = 'android';

class RpcHelloResult {
  const RpcHelloResult({
    required this.apiVersion,
    required this.serverId,
    required this.serverName,
    required this.gatewayVersion,
    required this.capabilities,
  });

  final int apiVersion;
  final String serverId;
  final String serverName;
  final String gatewayVersion;
  final List<String> capabilities;
}

/// 连接状态：connecting → ready → closed（带 close code）。
sealed class RpcState {
  const RpcState();
}

class RpcConnecting extends RpcState {
  const RpcConnecting();
}

class RpcReady extends RpcState {
  const RpcReady(this.hello);

  final RpcHelloResult hello;
}

class RpcClosed extends RpcState {
  const RpcClosed({this.closeCode, this.reason});

  /// 4401 revoked、4402 incompatible、401 未授权；null 表示异常断开。
  final int? closeCode;
  final String? reason;
}

/// 连接层失败：[code] 是稳定的类别码，[params] 是细节参数；用户可见文案由界面层按语言映射。
sealed class RpcException implements Exception {
  const RpcException(this.code, [this.params = const <String, Object>{}]);

  final String code;
  final Map<String, Object> params;

  @override
  String toString() => 'RpcException($code${params.isEmpty ? '' : ' $params'})';
}

class RpcUnauthorizedException extends RpcException {
  const RpcUnauthorizedException() : super('unauthorized');
}

class RpcRevokedException extends RpcException {
  const RpcRevokedException() : super('revoked');
}

class RpcIncompatibleException extends RpcException {
  const RpcIncompatibleException({this.needs}) : super('incompatible');

  /// 'app' | 'computer'，无法区分时为 null。
  final String? needs;
}

class RpcCertificateException extends RpcException {
  const RpcCertificateException() : super('certificate');
}

class RpcNetworkException extends RpcException {
  const RpcNetworkException() : super('network');
}

/// hello 响应不符合 design D6 契约。
class RpcProtocolException extends RpcException {
  const RpcProtocolException([
    String detail = 'hello_invalid',
    Map<String, Object> params = const <String, Object>{},
  ]) : super('protocol:$detail', params);
}

/// 服务端以 JSON-RPC 通知推送的事件（chat.patch、approvals.changed 等）。
class RpcNotification {
  const RpcNotification(this.method, this.params);

  final String method;
  final Map<String, dynamic> params;
}

/// 业务方法返回的稳定错误（`error.data.code`，见 docs/mobile/api-v1.md）。
class MobileApiException implements Exception {
  const MobileApiException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'MobileApiException($code: $message)';
}

/// 已完成 hello 的移动 API 面：请求与通知。
abstract class MobileApi {
  /// 结果为 JSON 值；连接不可用时抛 [RpcNetworkException]，业务错误抛 [MobileApiException]。
  Future<Object?> call(String method, [Map<String, Object?>? params]);

  Stream<RpcNotification> get notifications;
}

/// 已建立的 RPC 连接（hello 前不发其他请求）。
abstract class ActiveConnection implements MobileApi {
  RpcHelloResult get hello;

  Stream<RpcState> get states;

  void dispose();
}

typedef WebSocketConnector = Future<WebSocket> Function(
  Uri uri,
  Map<String, String> headers,
  HttpClient customClient,
);

Future<WebSocket> _defaultConnector(
  Uri uri,
  Map<String, String> headers,
  HttpClient customClient,
) {
  return WebSocket.connect(
    uri.toString(),
    headers: headers,
    customClient: customClient,
  );
}

class NekoRpcClient implements ActiveConnection {
  NekoRpcClient({
    required this.computer,
    required PinnedClientFactory clientFactory,
    this.platform = kNekoAppPlatform,
    this.appVersion = kNekoAppVersion,
    this.appBuild = kNekoAppBuild,
    WebSocketConnector? connector,
    this.timeout = const Duration(seconds: 15),
  }) : _connector = connector ?? _defaultConnector,
       _pinned = clientFactory(
         Uri.parse(computer.endpoint),
         computer.fingerprint,
       );

  final PairedComputer computer;
  final String platform;
  final String appVersion;
  final String appBuild;
  final Duration timeout;
  final WebSocketConnector _connector;
  final PinnedHttpClient _pinned;

  final StreamController<RpcState> _states =
      StreamController<RpcState>.broadcast(sync: true);
  final StreamController<RpcNotification> _notifications =
      StreamController<RpcNotification>.broadcast();

  jsonrpc.Peer? _rpc;
  WebSocket? _socket;
  bool _connecting = false;
  bool _disposed = false;
  bool _pinnedClosed = false;

  @override
  RpcHelloResult get hello {
    final h = _hello;
    if (h == null) {
      throw StateError('hello has not completed');
    }
    return h;
  }

  RpcHelloResult? _hello;

  @override
  Stream<RpcState> get states => _states.stream;

  @override
  Stream<RpcNotification> get notifications => _notifications.stream;

  @override
  Future<Object?> call(String method, [Map<String, Object?>? params]) async {
    final rpc = _rpc;
    if (rpc == null || rpc.isClosed || _hello == null) {
      throw const RpcNetworkException();
    }
    try {
      return await rpc.sendRequest(method, params).timeout(timeout);
    } on jsonrpc.RpcException catch (e) {
      final data = e.data;
      final code = data is Map && data['code'] is String
          ? data['code'] as String
          : 'internal';
      throw MobileApiException(code, e.message);
    } on TimeoutException {
      // 无响应视为连接已死：关闭 socket 触发 RpcClosed，交给连接管理器重连。
      unawaited(_socket?.close());
      throw const RpcNetworkException();
    } on StateError {
      throw const RpcNetworkException();
    }
  }

  /// 建立 WSS 连接并完成 server.hello；成功返回自身。
  Future<NekoRpcClient> connect() async {
    if (_disposed) {
      throw StateError('client is disposed');
    }
    if (_rpc != null || _connecting) {
      throw StateError('connection already exists or is in progress');
    }
    _connecting = true;
    _emit(const RpcConnecting());
    try {
      final socket = await _connector(_wsUri(), <String, String>{
        'authorization':
            'Neko-Device ${computer.deviceId}.${computer.credential}',
      }, _pinned.httpClient).timeout(timeout);
      _socket = socket;
      // 半开连接（休眠/换网）靠心跳尽快发现，由连接管理器退避重连。
      socket.pingInterval = const Duration(seconds: 20);
      // 流由 jsonrpc/Channel 单订阅消费；用 done 观察关闭，避免二次订阅。
      socket.done.then((_) => _handleDone());
      final peer = jsonrpc.Peer(IOWebSocketChannel(socket).cast<String>());
      _rpc = peer;
      // 服务端推送均为通知；未知方法同样转发，由订阅方按 method 过滤。
      peer.registerFallback((parameters) {
        final value = parameters.value;
        if (!_notifications.isClosed) {
          _notifications.add(
            RpcNotification(
              parameters.method,
              value is Map
                  ? value.cast<String, dynamic>()
                  : <String, dynamic>{},
            ),
          );
        }
      });
      // json_rpc_2 4.x 需显式开始监听通道。
      _rpc!.listen();
      final raw = await _rpc!
          .sendRequest('server.hello', <String, dynamic>{
            'apiVersions': const <int>[1],
            'app': <String, dynamic>{
              'version': appVersion,
              'platform': platform,
              'build': appBuild,
            },
          })
          .timeout(timeout);
      final parsed = _parseHello(raw);
      _hello = parsed;
      _emit(RpcReady(parsed));
      return this;
    } on TimeoutException {
      await _teardown();
      throw const RpcNetworkException();
    } on HandshakeException {
      await _teardown();
      throw const RpcCertificateException();
    } on jsonrpc.RpcException catch (e) {
      await _teardown();
      final data = e.data;
      if (data is Map && data['code'] == 'incompatible') {
        final needs = data['needs'];
        throw RpcIncompatibleException(needs: needs is String ? needs : null);
      }
      throw RpcProtocolException('hello_error', <String, Object>{
        'message': e.message,
      });
    } on WebSocketException {
      // 升级被拒（如 401）：认证失败或授权已撤销。
      await _teardown();
      throw const RpcUnauthorizedException();
    } on SocketException {
      await _teardown();
      throw const RpcNetworkException();
    } on StateError {
      // hello 期间连接被关闭：按 close code 区分 revoked / incompatible。
      final code = _socket?.closeCode;
      await _teardown();
      throw _mapClose(code);
    } on RpcException {
      await _teardown();
      rethrow;
    } catch (e) {
      await _teardown();
      throw RpcProtocolException('connect_failed', <String, Object>{
        'type': e.runtimeType.toString(),
      });
    }
  }

  Uri _wsUri() {
    final uri = Uri.parse(computer.endpoint);
    return Uri(
      scheme: 'wss',
      host: uri.host,
      port: uri.port,
      path: '/mobile/v1/ws',
    );
  }

  RpcException _mapClose(int? code) {
    switch (code) {
      case 4401:
        return const RpcRevokedException();
      case 4402:
        return const RpcIncompatibleException();
      default:
        return const RpcNetworkException();
    }
  }

  void _handleDone() {
    final socket = _socket;
    _emit(RpcClosed(closeCode: socket?.closeCode, reason: socket?.closeReason));
  }

  RpcHelloResult _parseHello(Object? raw) {
    if (raw is! Map<String, dynamic>) {
      throw const RpcProtocolException('hello_not_object');
    }
    final apiVersion = raw['apiVersion'];
    final serverId = raw['serverId'];
    final serverName = raw['serverName'];
    final gatewayVersion = raw['gatewayVersion'];
    final capabilities = raw['capabilities'];
    if (apiVersion is! int || apiVersion < 1) {
      throw const RpcProtocolException('api_version_invalid');
    }
    if (serverId is! String || serverId.isEmpty) {
      throw const RpcProtocolException('server_id_invalid');
    }
    if (serverName is! String || serverName.isEmpty) {
      throw const RpcProtocolException('server_name_invalid');
    }
    if (gatewayVersion is! String || gatewayVersion.isEmpty) {
      throw const RpcProtocolException('gateway_version_invalid');
    }
    if (capabilities is! List || capabilities.any((c) => c is! String)) {
      throw const RpcProtocolException('capabilities_invalid');
    }
    return RpcHelloResult(
      apiVersion: apiVersion,
      serverId: serverId,
      serverName: serverName,
      gatewayVersion: gatewayVersion,
      capabilities: capabilities.cast<String>(),
    );
  }

  void _emit(RpcState state) {
    if (!_states.isClosed) {
      _states.add(state);
    }
  }

  Future<void> _teardown() async {
    _connecting = false;
    final rpc = _rpc;
    _rpc = null;
    rpc?.close();
    final socket = _socket;
    _socket = null;
    socket?.close();
    _closePinned();
  }

  void _closePinned() {
    if (_pinnedClosed) {
      return;
    }
    _pinnedClosed = true;
    // 底层 HttpClient 随 socket 一起释放，避免重连泄漏空闲连接。
    _pinned.close();
  }

  @override
  void dispose() {
    if (_disposed) {
      return;
    }
    _disposed = true;
    unawaited(_teardown());
    // states 是同步广播：连接关闭事件派发中会同步回调 ConnectionManager 并
    // 进而 dispose 本 client；此时 close 正在派发的 controller 会抛
    // Bad state（Cannot fire new event）。推迟到微任务再关闭，
    // 事件本身仍受 _disposed / isClosed 保护。
    scheduleMicrotask(() {
      if (!_states.isClosed) {
        _states.close();
      }
      if (!_notifications.isClosed) {
        _notifications.close();
      }
    });
  }
}
