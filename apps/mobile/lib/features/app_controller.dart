import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/sessions/sessions_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';

/// 把连接状态接到业务控制器：就绪时绑定并恢复上次会话，断开时保留内容并禁用控制。
class AppController {
  AppController({
    required this.manager,
    required this.sessions,
    required this.chat,
    required this.prefs,
  });

  final ConnectionManager manager;
  final SessionsController sessions;
  final ChatController chat;
  final PrefsStore prefs;
  final ValueNotifier<ThemeMode> themeMode = ValueNotifier<ThemeMode>(
    ThemeMode.system,
  );

  /// 界面语言：zh（默认）或 en，不跟随系统；偏好只存在本机。
  final ValueNotifier<Locale> locale = ValueNotifier<Locale>(kLocaleZh);

  StreamSubscription<NekoConnectionState>? _subscription;
  String? _serverId;
  int _generation = 0;

  Future<void> start() async {
    final saved = await prefs.get(PrefKeys.themeMode);
    themeMode.value = ThemeMode.values.firstWhere(
      (m) => m.name == saved,
      orElse: () => ThemeMode.system,
    );
    locale.value = parseLocale(await prefs.get(PrefKeys.language));
    _subscription = manager.states.listen(_onState);
    _onState(manager.state);
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    themeMode.value = mode;
    await prefs.set(PrefKeys.themeMode, mode.name);
  }

  Future<void> setLocale(Locale next) async {
    final normalized = parseLocale(localeCode(next));
    locale.value = normalized;
    await prefs.set(PrefKeys.language, localeCode(normalized));
  }

  void _onState(NekoConnectionState state) {
    final generation = ++_generation;
    if (state is NekoConnReady) {
      unawaited(_bind(state, generation));
      return;
    }
    sessions.unbind();
    chat.unbind();
    if (state is NekoConnIdle) {
      _serverId = null;
      unawaited(chat.leave());
    }
  }

  Future<void> _bind(NekoConnReady state, int generation) async {
    final api = manager.api;
    if (api == null) return;
    final serverId = state.computer.serverId;
    if (_serverId != null && _serverId != serverId) await chat.leave();
    _serverId = serverId;
    await sessions.bind(api, serverId);
    if (generation != _generation) return;
    await chat.bind(api, serverId, capabilities: state.hello.capabilities);
    if (generation != _generation) return;
    if (chat.sessionId == null) await _restoreSession(generation);
  }

  Future<void> _restoreSession(int generation) async {
    final target = await sessions.restoreSession();
    if (generation != _generation || target == null) return;
    await chat.attach(target);
    if (generation != _generation) return;
    // 上次会话已失效：回退到同工作区最近的会话。
    if (chat.phase == ChatPhase.error && sessions.sessions.isNotEmpty) {
      final fallback = sessions.sessions.firstWhere(
        (s) => s.id != target,
        orElse: () => sessions.sessions.first,
      );
      if (fallback.id != target) await chat.attach(fallback.id);
    }
  }

  void dispose() {
    unawaited(_subscription?.cancel());
    themeMode.dispose();
    locale.dispose();
  }
}

final appControllerProvider = Provider<AppController>(
  (ref) =>
      ref.watch(appControllerOrNullProvider) ??
      (throw UnimplementedError('appControllerProvider is not overridden')),
);

/// 未覆盖时为 null（M0 冒烟测试只验证连接页）。
final appControllerOrNullProvider = Provider<AppController?>((ref) => null);

final chatControllerProvider = Provider<ChatController>(
  (ref) => ref.watch(appControllerProvider).chat,
);

final sessionsControllerProvider = Provider<SessionsController>(
  (ref) => ref.watch(appControllerProvider).sessions,
);
