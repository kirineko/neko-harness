import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// 非敏感的本地偏好（草稿、待确认请求、上次选择、主题、界面语言）。凭据只在安全存储中。
abstract class PrefsStore {
  Future<String?> get(String key);

  Future<void> set(String key, String value);

  Future<void> remove(String key);
}

class InMemoryPrefsStore implements PrefsStore {
  final Map<String, String> data = <String, String>{};

  @override
  Future<String?> get(String key) async => data[key];

  @override
  Future<void> set(String key, String value) async => data[key] = value;

  @override
  Future<void> remove(String key) async => data.remove(key);
}

class SharedPrefsStore implements PrefsStore {
  SharedPrefsStore([SharedPreferencesAsync? prefs])
    : _prefs = prefs ?? SharedPreferencesAsync();

  final SharedPreferencesAsync _prefs;

  @override
  Future<String?> get(String key) => _prefs.getString(key);

  @override
  Future<void> set(String key, String value) => _prefs.setString(key, value);

  @override
  Future<void> remove(String key) => _prefs.remove(key);
}

abstract final class PrefKeys {
  static String workspace(String serverId) => 'neko.ws.$serverId';

  static String session(String serverId) => 'neko.session.$serverId';

  static String draft(String serverId, String sessionId) =>
      'neko.draft.$serverId.$sessionId';

  static String pending(String serverId) => 'neko.pending.$serverId';

  static const String themeMode = 'neko.theme';

  static const String language = 'neko.language';
}

/// 待确认的发送（design D9）：受理前持久化，重启/重连后先查状态。
class PendingSubmission {
  const PendingSubmission({
    required this.requestId,
    required this.sessionId,
    required this.text,
    required this.steer,
    required this.createdAt,
    this.unknown = false,
  });

  factory PendingSubmission.fromJson(Map<String, dynamic> json) =>
      PendingSubmission(
        requestId: json['requestId'] as String? ?? '',
        sessionId: json['sessionId'] as String? ?? '',
        text: json['text'] as String? ?? '',
        steer: json['steer'] == true,
        createdAt: json['createdAt'] as int? ?? 0,
        unknown: json['unknown'] == true,
      );

  final String requestId;
  final String sessionId;
  final String text;
  final bool steer;
  final int createdAt;

  /// 电脑未确认受理（回执丢失或查询为 unknown），只允许以原请求重试或放弃。
  final bool unknown;

  PendingSubmission markUnknown() => PendingSubmission(
    requestId: requestId,
    sessionId: sessionId,
    text: text,
    steer: steer,
    createdAt: createdAt,
    unknown: true,
  );

  Map<String, dynamic> toJson() => <String, dynamic>{
    'requestId': requestId,
    'sessionId': sessionId,
    'text': text,
    'steer': steer,
    'createdAt': createdAt,
    'unknown': unknown,
  };
}

class PendingStore {
  PendingStore(this.prefs);

  final PrefsStore prefs;

  Future<List<PendingSubmission>> load(String serverId) async {
    final raw = await prefs.get(PrefKeys.pending(serverId));
    if (raw == null) return <PendingSubmission>[];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return <PendingSubmission>[];
      return decoded
          .whereType<Map>()
          .map((e) => PendingSubmission.fromJson(e.cast<String, dynamic>()))
          .where((e) => e.requestId.isNotEmpty)
          .toList();
    } on FormatException {
      return <PendingSubmission>[];
    }
  }

  Future<void> save(String serverId, List<PendingSubmission> list) =>
      list.isEmpty
      ? prefs.remove(PrefKeys.pending(serverId))
      : prefs.set(
          PrefKeys.pending(serverId),
          jsonEncode(list.map((e) => e.toJson()).toList()),
        );
}
