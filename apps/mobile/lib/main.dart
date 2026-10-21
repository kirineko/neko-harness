import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:neko_mobile/core/pairing/pairing_service.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/core/storage/key_value_store.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/sessions/sessions_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/theme.dart';
import 'package:neko_mobile/features/connect/home_page.dart';
import 'package:neko_mobile/features/connect/scan_controller.dart';
import 'package:neko_mobile/features/connect/scan_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final store = FlutterSecureKeyValueStore();
  final prefs = SharedPrefsStore();
  final manager = ConnectionManager(
    store: store,
    rpcFactory: (computer) => NekoRpcClient(
      computer: computer,
      clientFactory: defaultPinnedClientFactory,
    ),
  );
  final controller = ScanController(
    pairingService: LocalPairingService(
      store: store,
      clientFactory: defaultPinnedClientFactory,
    ),
    onPaired: manager.connectPaired,
  );
  final app = AppController(
    manager: manager,
    sessions: SessionsController(prefs: prefs),
    chat: ChatController(prefs: prefs),
    prefs: prefs,
  );
  runApp(
    ProviderScope(
      overrides: [
        connectionManagerProvider.overrideWithValue(manager),
        scanControllerProvider.overrideWithValue(controller),
        appControllerOrNullProvider.overrideWithValue(app),
      ],
      child: const NekoApp(),
    ),
  );
  unawaited(() async {
    try {
      await app.start();
    } catch (error) {
      debugPrint('偏好恢复失败，继续启动: $error');
    }
    try {
      await manager.restore();
    } catch (error) {
      // 安全存储瞬时失败不应阻断冷启动自动重连之后的重试路径。
      debugPrint('连接恢复失败: $error');
    }
  }());
}

class NekoApp extends ConsumerWidget {
  const NekoApp({super.key});

  static final GoRouter _router = GoRouter(
    routes: <RouteBase>[
      GoRoute(path: '/', builder: (context, state) => const HomePage()),
      GoRoute(path: '/scan', builder: (context, state) => const ScanPage()),
    ],
  );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final app = ref.watch(appControllerOrNullProvider);
    Widget build(ThemeMode mode, Locale locale) => MaterialApp.router(
      title: 'NekoAI',
      theme: buildNekoTheme(Brightness.light),
      darkTheme: buildNekoTheme(Brightness.dark),
      themeMode: mode,
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: kSupportedLocales,
      // 不跟随系统语言：无论系统是什么语言都固定回退 zh。
      localeResolutionCallback: (locale, supported) => supported.firstWhere(
        (s) => s.languageCode == locale?.languageCode,
        orElse: () => kLocaleZh,
      ),
      routerConfig: _router,
    );
    if (app == null) return build(ThemeMode.system, kLocaleZh);
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: app.themeMode,
      builder: (context, mode, _) => ValueListenableBuilder<Locale>(
        valueListenable: app.locale,
        builder: (context, locale, _) => build(mode, locale),
      ),
    );
  }
}
