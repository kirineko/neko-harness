import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/features/chat/chat_page.dart';
import 'package:neko_mobile/features/computers/computers_page.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';

/// M0 首页：展示当前连接状态；未配对时引导扫码。
/// 前后台切换回到前台时触发连接恢复。
class HomePage extends ConsumerStatefulWidget {
  const HomePage({super.key});

  @override
  ConsumerState<HomePage> createState() => _HomePageState();
}

class _HomePageState extends ConsumerState<HomePage>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(connectionManagerProvider).onForeground();
    }
  }

  @override
  Widget build(BuildContext context) {
    final manager = ref.watch(connectionManagerProvider);
    final app = ref.watch(appControllerOrNullProvider);
    return StreamBuilder<NekoConnectionState>(
      stream: manager.states,
      initialData: manager.state,
      builder: (context, snapshot) {
        final state = snapshot.data ?? const NekoConnIdle();
        // 就绪后进入会话；短暂断线时保留会话页（内容可读、控制禁用）。
        if (app != null &&
            (state is NekoConnReady ||
                (app.chat.sessionId != null &&
                    (state is NekoConnOffline ||
                        state is NekoConnRestoring ||
                        state is NekoConnConnecting)))) {
          return const ChatPage();
        }
        return _buildStatus(state, settings: app != null);
      },
    );
  }

  Widget _buildStatus(NekoConnectionState state, {required bool settings}) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('NekoAI'),
        actions: <Widget>[
          // 未连接时也能切换语言与外观：入口复用“电脑与设置”页。
          if (settings)
            IconButton(
              key: const Key('home-settings'),
              tooltip: context.l10n.computersTitle,
              icon: const NekoIcon(NekoIcons.monitor),
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const ComputersPage()),
              ),
            ),
        ],
      ),
      body: Builder(
        builder: (context) {
          final l10n = context.l10n;
          return switch (state) {
            NekoConnIdle() => _buildIdle(),
            NekoConnConnecting() => _buildPending(
              l10n.homeConnecting,
              'connecting',
            ),
            NekoConnRestoring() => _buildPending(
              l10n.connRestoring,
              'restoring',
            ),
            NekoConnOffline(:final nextRetryIn) => _buildOffline(nextRetryIn),
            NekoConnReady(:final computer, :final hello) => _buildReady(
              computer.serverName,
              hello,
            ),
            NekoConnRevoked() => _buildTerminal(
              l10n.homeRevokedTitle,
              l10n.homeRevokedGuidance,
              'revoked',
            ),
            NekoConnTrustChanged() => _buildTerminal(
              l10n.certificateMismatch,
              l10n.homeTrustChangedGuidance,
              'trust-changed',
            ),
            NekoConnIncompatible() => _buildTerminal(
              l10n.homeIncompatibleTitle,
              l10n.homeIncompatibleGuidance,
              'incompatible',
            ),
          };
        },
      ),
    );
  }

  Widget _buildIdle() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text(context.l10n.homeIdleText, key: const Key('home-idle-text')),
          const SizedBox(height: NekoSpace.md),
          FilledButton(
            key: const Key('home-go-scan'),
            onPressed: () => context.go('/scan'),
            child: Text(context.l10n.homeScanConnect),
          ),
        ],
      ),
    );
  }

  Widget _buildPending(String message, String keyPrefix) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          const CircularProgressIndicator(),
          const SizedBox(height: NekoSpace.md),
          Text(message, key: Key('home-$keyPrefix-text')),
          const SizedBox(height: NekoSpace.md),
          OutlinedButton(
            key: const Key('home-pending-scan'),
            onPressed: () {
              ref.read(connectionManagerProvider).stopToScan();
              context.go('/scan');
            },
            child: Text(context.l10n.homeBackToScan),
          ),
        ],
      ),
    );
  }

  Widget _buildOffline(Duration nextRetryIn) {
    final seconds = (nextRetryIn.inMilliseconds / 1000).toStringAsFixed(1);
    final l10n = context.l10n;
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          const NekoIcon(NekoIcons.cloudOff, size: 48),
          const SizedBox(height: NekoSpace.md),
          Text(l10n.homeOfflineText, key: const Key('home-offline-text')),
          Text(
            l10n.homeOfflineRetry(seconds),
            key: const Key('home-offline-retry'),
          ),
          const SizedBox(height: NekoSpace.sm),
          Text(l10n.homeOfflineHint),
          const SizedBox(height: NekoSpace.md),
          FilledButton.tonal(
            key: const Key('home-retry-now'),
            onPressed: () => ref.read(connectionManagerProvider).onForeground(),
            child: Text(l10n.connRetryNow),
          ),
          const SizedBox(height: NekoSpace.sm),
          OutlinedButton(
            key: const Key('home-offline-scan'),
            onPressed: () {
              ref.read(connectionManagerProvider).stopToScan();
              context.go('/scan');
            },
            child: Text(l10n.homeBackToScan),
          ),
        ],
      ),
    );
  }

  Widget _buildReady(String computerName, RpcHelloResult hello) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text(
            context.l10n.homeConnected(computerName),
            key: const Key('home-ready-title'),
          ),
          const SizedBox(height: NekoSpace.sm),
          Text(
            'server ${hello.serverName} · api v${hello.apiVersion}',
            key: const Key('home-ready-hello'),
          ),
          Text(
            'gateway ${hello.gatewayVersion} · capabilities ${hello.capabilities.length}',
            key: const Key('home-ready-capabilities'),
          ),
          const SizedBox(height: NekoSpace.lg),
          OutlinedButton(
            key: const Key('home-ready-scan'),
            onPressed: () {
              ref.read(connectionManagerProvider).stopToScan();
              context.go('/scan');
            },
            child: Text(context.l10n.homeBackToScan),
          ),
        ],
      ),
    );
  }

  Widget _buildTerminal(String title, String guidance, String keyPrefix) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text(title, key: Key('home-$keyPrefix-title')),
          const SizedBox(height: NekoSpace.sm),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: NekoSpace.xl),
            child: Text(
              guidance,
              key: Key('home-$keyPrefix-guidance'),
              textAlign: TextAlign.center,
            ),
          ),
          const SizedBox(height: NekoSpace.lg),
          FilledButton(
            key: Key('home-$keyPrefix-scan'),
            onPressed: () {
              ref.read(connectionManagerProvider).stopToScan();
              context.go('/scan');
            },
            child: Text(context.l10n.connRescan),
          ),
        ],
      ),
    );
  }
}
