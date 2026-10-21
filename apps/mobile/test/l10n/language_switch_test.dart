import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/core/storage/key_value_store.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/computers/computers_page.dart';
import 'package:neko_mobile/features/connect/scan_controller.dart';
import 'package:neko_mobile/features/connect/scan_page.dart';
import 'package:neko_mobile/features/sessions/sessions_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/main.dart';

import '../helpers/chat_harness.dart';
import '../helpers/fakes.dart';
import '../helpers/interaction_ui.dart';
import '../helpers/l10n_support.dart';

AppController _app(PrefsStore prefs, ConnectionManager manager) =>
    AppController(
      manager: manager,
      sessions: SessionsController(prefs: prefs),
      chat: ChatController(prefs: prefs),
      prefs: prefs,
    );

Widget _nekoApp(ConnectionManager manager, AppController app) => ProviderScope(
  overrides: [
    connectionManagerProvider.overrideWithValue(manager),
    appControllerOrNullProvider.overrideWithValue(app),
    scanControllerProvider.overrideWithValue(
      ScanController(
        pairingService: FakePairingService(),
        onPaired: (_) async {},
      ),
    ),
    scannerBuilderProvider.overrideWithValue(
      ({key, required onDetected, required onCameraError}) =>
          SizedBox(key: key),
    ),
  ],
  child: const NekoApp(),
);

/// NekoApp 的路由是进程内单例：每次装载都先回到首页，避免上一个用例的位置泄漏进来。
Future<void> _pumpApp(
  WidgetTester tester,
  ConnectionManager manager,
  AppController app,
) async {
  await tester.pumpWidget(_nekoApp(manager, app));
  await tester.pump();
  GoRouter.of(tester.element(find.byType(Scaffold).first)).go('/');
  await tester.pump();
  await tester.pump();
}

void main() {
  late ChatHarness h;

  setUp(() => h = ChatHarness());
  tearDown(() => h.dispose());

  group('电脑与设置页的语言选择', () {
    testWidgets('默认 zh；选择 English 即时生效并持久化，再选回中文', (tester) async {
      await tester.pumpWidget(
        h.build(home: const ComputersPage(), localized: true),
      );
      await tester.pump();
      expect(find.text('电脑与设置'), findsOneWidget);
      expect(find.text('语言'), findsOneWidget);
      expect(h.prefs.data.containsKey(PrefKeys.language), isFalse);

      await tester.tap(find.text('English'));
      await tester.pump();
      await tester.pump();
      expect(find.text('Computers and settings'), findsOneWidget);
      expect(find.text('Language'), findsOneWidget);
      expect(find.text('电脑与设置'), findsNothing);
      expect(h.app.locale.value, kLocaleEn);
      expect(h.prefs.data[PrefKeys.language], 'en');
      // 语言名始终用各自语言书写，才能在错误语言下找到入口。
      expect(find.text('中文'), findsOneWidget);
      expect(find.text('English'), findsOneWidget);
      expect(cjkResidue(tester), isEmpty);

      await tester.tap(find.text('中文'));
      await tester.pump();
      await tester.pump();
      expect(find.text('电脑与设置'), findsOneWidget);
      expect(h.prefs.data[PrefKeys.language], 'zh');
    });

    testWidgets('当前语言的单选项处于选中状态', (tester) async {
      await tester.pumpWidget(
        h.build(home: const ComputersPage(), localized: true),
      );
      await tester.pump();
      RadioListTile<Locale> tile(String label) =>
          tester.widget<RadioListTile<Locale>>(
            find.widgetWithText(RadioListTile<Locale>, label),
          );
      expect(tile('中文').value, kLocaleZh);
      expect(tile('English').value, kLocaleEn);
      expect(
        RadioGroup.maybeOf<Locale>(
          tester.element(find.byKey(const Key('computers-language'))),
        )?.groupValue,
        kLocaleZh,
      );
      await h.app.setLocale(kLocaleEn);
      await tester.pump();
      expect(
        RadioGroup.maybeOf<Locale>(
          tester.element(find.byKey(const Key('computers-language'))),
        )?.groupValue,
        kLocaleEn,
      );
    });
  });

  group('会话抽屉的语言选择', () {
    testWidgets('与主题选择并列；切换后抽屉与聊天页同时变成英文', (tester) async {
      await h.bind();
      await tester.pumpWidget(h.build(localized: true));
      await settle(tester);
      tester.state<ScaffoldState>(find.byType(Scaffold).first).openDrawer();
      await transition(tester);
      expect(find.byKey(const Key('drawer-theme')), findsOneWidget);
      expect(find.byKey(const Key('drawer-language')), findsOneWidget);
      expect(find.text('电脑管理与设置'), findsOneWidget);

      await tester.tap(
        find.descendant(
          of: find.byKey(const Key('drawer-language')),
          matching: find.text('English'),
        ),
      );
      await transition(tester);
      expect(find.text('Computers and settings'), findsOneWidget);
      expect(find.text('电脑管理与设置'), findsNothing);
      expect(h.prefs.data[PrefKeys.language], 'en');
      // 抽屉之外的聊天页也已切换。
      expect(find.text('Message the Agent'), findsOneWidget);
    });
  });

  group('整个应用（NekoApp）', () {
    testWidgets('未连接时在电脑列表页切换为英文，页面立即变化，重启后保持', (tester) async {
      final prefs = InMemoryPrefsStore();
      final manager = ConnectionManager(
        store: InMemoryKeyValueStore(),
        rpcFactory: (_) => throw UnimplementedError(),
      );
      addTearDown(manager.dispose);
      final first = _app(prefs, manager);
      await first.start();
      await _pumpApp(tester, manager, first);

      expect(find.text('尚未连接电脑'), findsOneWidget);
      expect(find.byKey(const Key('home-go-scan')), findsOneWidget);
      await tester.tap(find.byKey(const Key('home-settings')));
      await transition(tester);
      expect(find.text('电脑与设置'), findsWidgets);

      await tester.tap(find.text('English'));
      await transition(tester);
      expect(find.text('Computers and settings'), findsWidgets);
      expect(prefs.data[PrefKeys.language], 'en');

      // 回到首页：同样是英文。
      Navigator.of(tester.element(find.byType(ComputersPage))).pop();
      await transition(tester);
      expect(find.text('Not connected to a computer'), findsOneWidget);
      expect(find.text('Scan to connect'), findsOneWidget);
      expect(cjkResidue(tester), isEmpty);

      // 扫码页也是英文。
      await tester.tap(find.byKey(const Key('home-go-scan')));
      await transition(tester);
      expect(find.text('Connect computer'), findsOneWidget);
      expect(cjkResidue(tester), isEmpty);
      first.dispose();

      // “重启”：新的控制器读取同一份偏好。
      await tester.pumpWidget(const SizedBox());
      final second = _app(prefs, manager);
      addTearDown(second.dispose);
      await second.start();
      await _pumpApp(tester, manager, second);
      expect(find.text('Not connected to a computer'), findsOneWidget);
    });

    testWidgets('偏好缺失或非法：应用以 zh 启动', (tester) async {
      for (final saved in <String?>[null, 'fr', '']) {
        final prefs = InMemoryPrefsStore();
        if (saved != null) prefs.data[PrefKeys.language] = saved;
        final manager = ConnectionManager(
          store: InMemoryKeyValueStore(),
          rpcFactory: (_) => throw UnimplementedError(),
        );
        final app = _app(prefs, manager);
        await app.start();
        await _pumpApp(tester, manager, app);
        expect(find.text('尚未连接电脑'), findsOneWidget, reason: '$saved');
        expect(
          Localizations.localeOf(tester.element(find.byType(Scaffold).first)),
          kLocaleZh,
        );
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        manager.dispose();
      }
    });

    testWidgets('不跟随系统语言：系统是英文也以 zh 启动', (tester) async {
      tester.platformDispatcher.localesTestValue = const <Locale>[
        Locale('en', 'US'),
      ];
      addTearDown(tester.platformDispatcher.clearLocalesTestValue);
      final prefs = InMemoryPrefsStore();
      final manager = ConnectionManager(
        store: InMemoryKeyValueStore(),
        rpcFactory: (_) => throw UnimplementedError(),
      );
      addTearDown(manager.dispose);
      final app = _app(prefs, manager);
      addTearDown(app.dispose);
      await app.start();
      await _pumpApp(tester, manager, app);
      expect(find.text('尚未连接电脑'), findsOneWidget);
    });
  });
}
