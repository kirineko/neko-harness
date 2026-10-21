import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/core/storage/key_value_store.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/sessions/sessions_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';

AppController _controller(PrefsStore prefs) {
  final manager = ConnectionManager(
    store: InMemoryKeyValueStore(),
    rpcFactory: (_) => throw UnimplementedError(),
  );
  addTearDown(manager.dispose);
  return AppController(
    manager: manager,
    sessions: SessionsController(prefs: prefs),
    chat: ChatController(prefs: prefs),
    prefs: prefs,
  );
}

void main() {
  group('parseLocale', () {
    test('只认 zh 与 en，缺省与非法值回落 zh', () {
      expect(parseLocale('en'), kLocaleEn);
      expect(parseLocale('zh'), kLocaleZh);
      for (final bad in <String?>[
        null,
        '',
        'EN',
        'en-GB',
        'fr',
        'zh-CN',
        ' en',
        'system',
      ]) {
        expect(parseLocale(bad), kLocaleZh, reason: '$bad');
      }
    });

    test('localeCode 只产生 zh 或 en（含区域码与未知语言）', () {
      expect(localeCode(const Locale('en')), 'en');
      expect(localeCode(const Locale('en', 'GB')), 'en');
      expect(localeCode(const Locale('zh', 'CN')), 'zh');
      expect(localeCode(const Locale('fr')), 'zh');
    });

    test('支持的语言固定为 zh、en，zh 在前（不跟随系统）', () {
      expect(kSupportedLocales, <Locale>[kLocaleZh, kLocaleEn]);
    });
  });

  group('AppController 语言偏好', () {
    test('全新安装默认 zh，且不写入偏好', () async {
      final prefs = InMemoryPrefsStore();
      final app = _controller(prefs);
      addTearDown(app.dispose);
      expect(app.locale.value, kLocaleZh);
      await app.start();
      expect(app.locale.value, kLocaleZh);
      expect(prefs.data.containsKey(PrefKeys.language), isFalse);
    });

    test('尚未连接任何电脑也能切换：立即通知监听者并持久化', () async {
      final prefs = InMemoryPrefsStore();
      final app = _controller(prefs);
      addTearDown(app.dispose);
      await app.start();
      expect(app.manager.state, isA<NekoConnIdle>());

      final seen = <Locale>[];
      app.locale.addListener(() => seen.add(app.locale.value));
      await app.setLocale(kLocaleEn);
      expect(app.locale.value, kLocaleEn);
      expect(seen, <Locale>[kLocaleEn]);
      expect(prefs.data[PrefKeys.language], 'en');

      await app.setLocale(kLocaleZh);
      expect(prefs.data[PrefKeys.language], 'zh');
    });

    test('重启恢复已保存的语言', () async {
      final prefs = InMemoryPrefsStore();
      final first = _controller(prefs);
      await first.start();
      await first.setLocale(kLocaleEn);
      first.dispose();

      final second = _controller(prefs);
      addTearDown(second.dispose);
      expect(second.locale.value, kLocaleZh, reason: 'start 之前保持默认');
      await second.start();
      expect(second.locale.value, kLocaleEn);
    });

    test('保存的值非法或损坏时回落 zh，不抛错', () async {
      for (final bad in <String>[
        'fr',
        '',
        'EN',
        '{"language":"en"}',
        'system',
      ]) {
        final prefs = InMemoryPrefsStore()..data[PrefKeys.language] = bad;
        final app = _controller(prefs);
        await app.start();
        expect(app.locale.value, kLocaleZh, reason: bad);
        app.dispose();
      }
    });

    test('设置不支持的语言时规范为 zh', () async {
      final prefs = InMemoryPrefsStore();
      final app = _controller(prefs);
      addTearDown(app.dispose);
      await app.start();
      await app.setLocale(const Locale('fr'));
      expect(app.locale.value, kLocaleZh);
      expect(prefs.data[PrefKeys.language], 'zh');
    });

    test('语言偏好与主题偏好互不影响', () async {
      final prefs = InMemoryPrefsStore();
      final app = _controller(prefs);
      addTearDown(app.dispose);
      await app.start();
      await app.setThemeMode(ThemeMode.dark);
      await app.setLocale(kLocaleEn);
      expect(prefs.data[PrefKeys.themeMode], ThemeMode.dark.name);
      expect(prefs.data[PrefKeys.language], 'en');
      expect(PrefKeys.language, isNot(PrefKeys.themeMode));
    });
  });

  group('UiText 按当前语言解析', () {
    test('同一份控制器文案可在两种语言下解析，rawText 不翻译', () {
      String text(AppLocalizations l10n) => l10n.commonCancel;
      expect(resolveUiText(text, kLocaleZh), '取消');
      expect(resolveUiText(text, kLocaleEn), 'Cancel');
      expect(resolveUiText(rawText('原文 original'), kLocaleEn), '原文 original');
    });
  });
}
