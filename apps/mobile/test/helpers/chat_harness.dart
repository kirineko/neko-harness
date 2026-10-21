import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/core/storage/key_value_store.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/chat/chat_page.dart';
import 'package:neko_mobile/features/sessions/sessions_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/theme.dart';

import 'fake_api.dart';

/// 已绑定假 API 的会话页夹具（连接管理器保持空闲，不发起真实连接）。
class ChatHarness {
  ChatHarness() {
    manager = ConnectionManager(
      store: InMemoryKeyValueStore(),
      rpcFactory: (_) => throw UnimplementedError(),
    );
    app = AppController(
      manager: manager,
      sessions: SessionsController(prefs: prefs),
      chat: ChatController(prefs: prefs),
      prefs: prefs,
    );
    api
      ..on(
        'workspaces.list',
        (_) => <String, dynamic>{
          'workspaces': <Object>[
            <String, dynamic>{'root': '/a/neko', 'name': 'neko'},
            <String, dynamic>{'root': '/b/neko', 'name': 'neko'},
          ],
        },
      )
      ..on(
        'sessions.list',
        (_) => <String, dynamic>{
          'sessions': <Object>[
            <String, dynamic>{
              'id': '7',
              'workspace': '/a/neko',
              'title': '修复登录页',
              'preview': '登录页按钮错位',
              'lastUsedAt': 0,
              'archived': false,
            },
          ],
        },
      )
      ..on('approvals.list', (_) => <String, dynamic>{'approvals': approvals})
      ..on('todos.get', (_) => todoList)
      ..on('questions.list', (_) => questionList)
      ..on('questions.get', (params) {
        final record = questionRecords[params!['id']];
        if (record == null) throw const MobileApiException('not_found', '');
        return record;
      })
      ..on('plan.get', (params) {
        final record = planRecords[params!['version']];
        if (record == null) throw const MobileApiException('not_found', '');
        return record;
      })
      ..on(
        'chat.attach',
        (params) => <String, dynamic>{
          'subscriptionId': 'chat-${++attachCount}',
          'sessionId': params!['sessionId'],
          'snapshot': snapshot,
        },
      );
  }

  final FakeMobileApi api = FakeMobileApi();
  final InMemoryPrefsStore prefs = InMemoryPrefsStore();
  late final ConnectionManager manager;
  late final AppController app;
  int attachCount = 0;
  List<Object> approvals = <Object>[];

  /// `todos.get` / `questions.list` / `questions.get` 的脚本化数据（仅声明能力时才会被调用）。
  Map<String, dynamic> todoList = <String, dynamic>{
    'revision': 1,
    'items': <Object>[],
  };
  Map<String, dynamic> questionList = <String, dynamic>{
    'revision': 1,
    'pending': <Object>[],
  };
  Map<int, Map<String, dynamic>> questionRecords =
      <int, Map<String, dynamic>>{};

  /// `plan.get` 的脚本化数据，按版本（仅声明 plan 能力时才会被调用）。
  Map<String, Map<String, dynamic>> planRecords =
      <String, Map<String, dynamic>>{};
  Map<String, dynamic> snapshot = snapshotOf(<Map<String, dynamic>>[
    userItem('u-1', '你好'),
    assistantItem('a-2', '**你好**，有什么可以帮忙？'),
  ]);

  ChatController get chat => app.chat;

  /// [capabilities] 为 hello 声明的能力；缺省 = 旧电脑（不会产生 todos.* / questions.* 请求）。
  Future<void> bind({
    String? attach = '7',
    Iterable<String> capabilities = const <String>[],
  }) async {
    await app.sessions.bind(api, 'srv');
    await app.chat.bind(api, 'srv', capabilities: capabilities);
    if (attach != null) await app.chat.attach(attach);
  }

  /// [localized] 时接上本地化代理并跟随 `app.locale`（与 `NekoApp` 一致）；
  /// 缺省沿用旧行为：不装代理，`context.l10n` 固定回退 zh。
  Widget build({
    ThemeMode mode = ThemeMode.light,
    double textScale = 1,
    Widget home = const ChatPage(),
    bool localized = false,
  }) {
    Widget app(Locale? locale) => MaterialApp(
      theme: buildNekoTheme(Brightness.light),
      darkTheme: buildNekoTheme(Brightness.dark),
      themeMode: mode,
      locale: locale,
      localizationsDelegates: localized
          ? AppLocalizations.localizationsDelegates
          : null,
      supportedLocales: localized
          ? kSupportedLocales
          : const <Locale>[Locale('en', 'US')],
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: home,
    );
    return ProviderScope(
      overrides: [
        connectionManagerProvider.overrideWithValue(manager),
        appControllerOrNullProvider.overrideWithValue(this.app),
      ],
      child: localized
          ? ValueListenableBuilder<Locale>(
              valueListenable: this.app.locale,
              builder: (context, locale, _) => app(locale),
            )
          : app(null),
    );
  }

  void dispose() {
    app.chat.dispose();
    app.sessions.dispose();
    manager.dispose();
  }
}

/// 让 RPC 回调与 ListenableBuilder 稳定下来（含 300 ms 草稿防抖）。
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

const RpcNetworkException kOffline = RpcNetworkException();
