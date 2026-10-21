import 'dart:convert';

/// 配对二维码/粘贴文本的解析结果错误类别。
enum PairingTextErrorKind {
  /// 前缀、编码、JSON 或字段不合法。
  invalid,

  /// 已过 exp。
  expired,

  /// v 不是 1。
  unsupportedVersion,
}

sealed class PairingTextResult {
  const PairingTextResult();
}

class PairingTextOk extends PairingTextResult {
  const PairingTextOk(this.target);

  final PairingTarget target;
}

class PairingTextError extends PairingTextResult {
  const PairingTextError(this.kind, this.code, {this.unsupportedVersion});

  final PairingTextErrorKind kind;

  /// 稳定的细分码（如 missing_prefix、fp_invalid）；用户可见文案由界面层按语言映射。
  final String code;

  /// kind == unsupportedVersion 时的版本号。
  final int? unsupportedVersion;
}

/// 解析成功的配对目标（design D4）。
class PairingTarget {
  const PairingTarget({
    required this.serverId,
    required this.name,
    required this.endpoint,
    required this.fingerprint,
    required this.code,
    required this.expiresAt,
  });

  final String serverId;
  final String name;

  /// 规范化的 `https://<ipv4>:<port>`，无 userinfo/query/fragment/path。
  final Uri endpoint;

  /// DER SHA-256 小写 hex。
  final String fingerprint;

  /// 32 字节随机值的 base64url（无填充）。
  final String code;

  /// Unix 毫秒。
  final int expiresAt;

  /// POST /mobile/v1/pair 的目标地址。
  Uri get pairUri => Uri(
    scheme: 'https',
    host: endpoint.host,
    port: endpoint.port,
    path: '/mobile/v1/pair',
  );
}

const String kPairingScheme = 'nekopair';
const int kPairingVersion = 1;

final RegExp _fingerprintPattern = RegExp(r'^[0-9a-fA-F]{64}$');
final RegExp _ipv4Pattern = RegExp(
  r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$',
);

/// 严格解析 `nekopair:1:<base64url(UTF-8 JSON)>`。
///
/// 区分 invalid（格式/字段）、expired（exp 不晚于当前时间）与
/// unsupportedVersion（v 段不是 1）。凭据类字段只校验形态，不做宽松修复。
PairingTextResult parsePairingText(String text, {DateTime Function()? clock}) {
  final now = (clock ?? DateTime.now)();
  final trimmed = text.trim();
  if (!trimmed.startsWith('$kPairingScheme:')) {
    return const PairingTextError(
      PairingTextErrorKind.invalid,
      'missing_prefix',
    );
  }
  final rest = trimmed.substring('$kPairingScheme:'.length);
  final sep = rest.indexOf(':');
  if (sep <= 0) {
    return const PairingTextError(
      PairingTextErrorKind.invalid,
      'missing_version',
    );
  }
  final versionToken = rest.substring(0, sep);
  final version = int.tryParse(versionToken);
  if (version == null) {
    return const PairingTextError(
      PairingTextErrorKind.invalid,
      'version_not_number',
    );
  }
  if (version != kPairingVersion) {
    return PairingTextError(
      PairingTextErrorKind.unsupportedVersion,
      'unsupported_version',
      unsupportedVersion: version,
    );
  }
  final payload = rest.substring(sep + 1);

  Map<String, dynamic> json;
  try {
    final bytes = base64Url.decode(base64Url.normalize(payload));
    final decoded = utf8.decode(bytes, allowMalformed: false);
    final parsed = jsonDecode(decoded);
    if (parsed is! Map<String, dynamic>) {
      return const PairingTextError(PairingTextErrorKind.invalid, 'not_object');
    }
    json = parsed;
  } on FormatException {
    return const PairingTextError(PairingTextErrorKind.invalid, 'bad_payload');
  }

  final sid = json['sid'];
  if (sid is! String || sid.isEmpty) {
    return const PairingTextError(PairingTextErrorKind.invalid, 'sid_invalid');
  }
  final name = json['name'];
  if (name is! String || name.length > 64) {
    return const PairingTextError(PairingTextErrorKind.invalid, 'name_invalid');
  }
  final endpoint = _parseEndpoint(json['ep']);
  if (endpoint == null) {
    return const PairingTextError(
      PairingTextErrorKind.invalid,
      'endpoint_invalid',
    );
  }
  final fp = json['fp'];
  if (fp is! String || !_fingerprintPattern.hasMatch(fp)) {
    return const PairingTextError(PairingTextErrorKind.invalid, 'fp_invalid');
  }
  final code = json['code'];
  if (code is! String) {
    return const PairingTextError(PairingTextErrorKind.invalid, 'code_missing');
  }
  try {
    if (base64Url.decode(base64Url.normalize(code)).length != 32) {
      return const PairingTextError(
        PairingTextErrorKind.invalid,
        'code_length',
      );
    }
  } on FormatException {
    return const PairingTextError(
      PairingTextErrorKind.invalid,
      'code_encoding',
    );
  }
  final exp = json['exp'];
  if (exp is! int || exp <= 0) {
    return const PairingTextError(PairingTextErrorKind.invalid, 'exp_invalid');
  }
  if (exp <= now.millisecondsSinceEpoch) {
    return const PairingTextError(PairingTextErrorKind.expired, 'expired');
  }
  return PairingTextOk(
    PairingTarget(
      serverId: sid,
      name: name,
      endpoint: endpoint,
      fingerprint: fp.toLowerCase(),
      code: code,
      expiresAt: exp,
    ),
  );
}

Uri? _parseEndpoint(Object? raw) {
  if (raw is! String) return null;
  final uri = Uri.tryParse(raw);
  if (uri == null || uri.scheme != 'https') return null;
  if (uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment) return null;
  if (uri.path.isNotEmpty && uri.path != '/') return null;

  final authority = uri.authority;
  final hostPort = authority.split(':');
  if (hostPort.length != 2) return null;
  final host = hostPort[0];
  final port = int.tryParse(hostPort[1]);
  if (port == null || port < 1 || port > 65535) return null;
  if (!_isIpv4Literal(host)) return null;
  return Uri(scheme: 'https', host: host, port: port);
}

bool _isIpv4Literal(String host) {
  final match = _ipv4Pattern.firstMatch(host);
  if (match == null) return false;
  for (var i = 1; i <= 4; i++) {
    final octet = match.group(i)!;
    if (octet.length > 1 && octet.startsWith('0')) return false;
    if (int.parse(octet) > 255) return false;
  }
  return true;
}
