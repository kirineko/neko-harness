import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';

/// 一台已配对电脑专用的 HttpClient（design D3）。
///
/// 关闭系统根信任后，任何证书都会进入 [HttpClient.badCertificateCallback]；
/// 仅当 host/port 精确匹配、DER SHA-256 指纹精确匹配且证书处于有效期时放行。
/// TLS 握手本身证明对端持有对应私钥，因此无需也无法依赖签发者链。
class PinnedHttpClient {
  PinnedHttpClient({
    required this.pinnedHost,
    required this.pinnedPort,
    required String pinnedSha256,
    DateTime Function()? clock,
  }) : pinnedSha256 = pinnedSha256.toLowerCase(),
       _clock = clock ?? DateTime.now {
    if (pinnedHost.isEmpty) {
      throw ArgumentError.value(pinnedHost, 'pinnedHost', 'must not be empty');
    }
    if (pinnedPort < 1 || pinnedPort > 65535) {
      throw ArgumentError.value(
        pinnedPort,
        'pinnedPort',
        'must be within 1-65535',
      );
    }
    if (!_pinPattern.hasMatch(pinnedSha256)) {
      throw ArgumentError.value(
        pinnedSha256,
        'pinnedSha256',
        'must be 64 hex characters',
      );
    }
    _client = HttpClient(context: SecurityContext(withTrustedRoots: false));
    _client.findProxy = directProxy;
    _client.badCertificateCallback = _verify;
  }

  /// [HttpClient.findProxy] 的固定返回值：连接永远不经过代理。
  static const String direct = 'DIRECT';

  /// 安装的代理解析函数：对任意 URI 都返回 [direct]。
  static String directProxy(Uri url) => direct;

  static final RegExp _pinPattern = RegExp(r'^[0-9a-f]{64}$');

  final String pinnedHost;
  final int pinnedPort;
  final String pinnedSha256;
  final DateTime Function() _clock;

  late final HttpClient _client;

  /// 底层 HttpClient。供 `WebSocket.connect(customClient:)` 复用同一连接策略；
  /// 新建请求请优先使用 [post]/[openWebSocket]，二者额外校验 scheme 与端点。
  HttpClient get httpClient => _client;

  bool _verify(X509Certificate cert, String host, int port) {
    if (host != pinnedHost || port != pinnedPort) return false;
    if (sha256.convert(cert.der).toString() != pinnedSha256) return false;
    final now = _clock();
    return !now.isBefore(cert.startValidity) && !now.isAfter(cert.endValidity);
  }

  /// HTTPS POST。[url] 必须是已 pin 的 https 端点，绝不跟随重定向；
  /// 凭据仅经 [headers]/[body] 传递，不进入 URL。
  Future<HttpClientResponse> post(
    Uri url, {
    Map<String, String>? headers,
    List<int>? body,
  }) async {
    _requirePinnedEndpoint(url, expectedScheme: 'https');
    final request = await _client.postUrl(url);
    request.followRedirects = false;
    headers?.forEach(request.headers.set);
    if (body != null) request.add(body);
    return request.close();
  }

  /// WSS 连接。[url] 必须是已 pin 的 wss 端点；
  /// 底层经同一 HttpClient 发起升级请求，TLS 仍受 pin 约束。
  Future<WebSocket> openWebSocket(
    Uri url, {
    Map<String, String>? headers,
    List<String>? protocols,
    Duration? pingInterval,
  }) async {
    _requirePinnedEndpoint(url, expectedScheme: 'wss');
    final socket = await WebSocket.connect(
      url.toString(),
      protocols: protocols,
      headers: headers,
      customClient: _client,
    );
    socket.pingInterval = pingInterval;
    return socket;
  }

  void _requirePinnedEndpoint(Uri url, {required String expectedScheme}) {
    if (url.scheme != expectedScheme) {
      throw ArgumentError.value(
        url.scheme,
        'url.scheme',
        'only $expectedScheme is allowed',
      );
    }
    if (url.host != pinnedHost) {
      throw ArgumentError.value(
        url.host,
        'url.host',
        'does not match pinnedHost',
      );
    }
    if (url.port != pinnedPort) {
      throw ArgumentError.value(
        url.port,
        'url.port',
        'does not match pinnedPort',
      );
    }
  }

  void close({bool force = false}) => _client.close(force: force);
}
