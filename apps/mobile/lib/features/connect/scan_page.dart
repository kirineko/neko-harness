import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:neko_mobile/core/pairing/pairing_text.dart';
import 'package:neko_mobile/features/connect/scan_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';

/// 1.2 MainActivity 提供的系统设置通道。
const MethodChannel kSettingsChannel = MethodChannel(
  'dev.neko.harness.mobile/settings',
);

const String kOpenAppDetailsSettingsMethod = 'openAppDetailsSettings';

Future<void> openAppDetailsSettings() async {
  try {
    await kSettingsChannel.invokeMethod<void>(kOpenAppDetailsSettingsMethod);
  } on MissingPluginException {
    // 非 Android 环境（如测试）：忽略。
  } on PlatformException {
    // 设置页无法打开时静默失败，页面有其他入口可用。
  }
}

/// 扫描器构造器：生产用 MobileScanner；测试注入假实现。
typedef ScannerBuilder = Widget Function({
  Key? key,
  required void Function(String code) onDetected,
  required void Function() onCameraError,
});

ScannerBuilder _defaultScannerBuilder() {
  return ({key, required onDetected, required onCameraError}) {
    return MobileScanner(
      key: key,
      onDetect: (capture) {
        final raw = capture.barcodes.firstOrNull?.rawValue;
        if (raw != null) {
          onDetected(raw);
        }
      },
      errorBuilder: (context, error) {
        // 相机错误可能随 MobileScanner 的构建同步上报；回调推迟到当前帧结束后，
        // 避免在 build 期间触发 ScanController 通知 → setState during build。
        scheduleMicrotask(onCameraError);
        return const SizedBox.shrink();
      },
    );
  };
}

final scannerBuilderProvider = Provider<ScannerBuilder>(
  (ref) => _defaultScannerBuilder(),
);

final scanControllerProvider = Provider<ScanController>((ref) {
  throw UnimplementedError(
    'scanControllerProvider must be overridden at the app root or in tests',
  );
});

class ScanPage extends ConsumerStatefulWidget {
  const ScanPage({super.key});

  @override
  ConsumerState<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends ConsumerState<ScanPage> {
  final TextEditingController _pasteController = TextEditingController();
  int _scannerKey = 0;
  bool _lastCameraActive = true;
  late final ScanController _controller;

  @override
  void initState() {
    super.initState();
    // dispose 中不能用 ref，缓存到字段。
    _controller = ref.read(scanControllerProvider);
    _controller.addListener(_onStateChanged);
  }

  void _onStateChanged(ScanState state) {
    if (!mounted) {
      return;
    }
    // 配对成功不再停留在中间页：直接回首页，由首页展示连接进度并进入会话。
    if (state is ScanPairingDone) {
      context.go('/');
      return;
    }
    setState(() {
      final active = state is ScanCamera && state.cameraActive;
      if (active && !_lastCameraActive) {
        _scannerKey++;
      }
      _lastCameraActive = active;
    });
  }

  @override
  void dispose() {
    _controller.removeListener(_onStateChanged);
    _pasteController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scannerBuilder = ref.watch(scannerBuilderProvider);
    final state = _controller.state;

    return Scaffold(
      appBar: AppBar(title: Text(context.l10n.scanTitle)),
      body: switch (state) {
        ScanCamera() => _buildCamera(_controller, scannerBuilder, state),
        ScanConfirm() => _buildConfirm(state.target),
        ScanPairing() => const Center(child: CircularProgressIndicator()),
        ScanPairingDone() => const Center(child: CircularProgressIndicator()),
        ScanFailed() => _buildFailed(state.failure),
      },
    );
  }

  Widget _buildCamera(
    ScanController controller,
    ScannerBuilder scannerBuilder,
    ScanCamera state,
  ) {
    return Column(
      children: <Widget>[
        Expanded(
          child: state.cameraActive
              ? scannerBuilder(
                  key: ObjectKey(_scannerKey),
                  onDetected: controller.onScannedText,
                  onCameraError: controller.markCameraUnavailable,
                )
              : const Center(child: NekoIcon(NekoIcons.cameraOff, size: 64)),
        ),
        if (!state.cameraActive)
          Padding(
            padding: const EdgeInsets.all(NekoSpace.md),
            child: Column(
              children: <Widget>[
                Text(context.l10n.scanCameraUnavailable),
                const SizedBox(height: NekoSpace.sm),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  alignment: WrapAlignment.center,
                  children: <Widget>[
                    FilledButton.tonal(
                      key: const Key('open-settings-button'),
                      onPressed: openAppDetailsSettings,
                      child: Text(context.l10n.scanOpenSettings),
                    ),
                    FilledButton.tonal(
                      key: const Key('retry-camera-button'),
                      onPressed: controller.retryCamera,
                      child: Text(context.l10n.scanRetryCamera),
                    ),
                  ],
                ),
              ],
            ),
          ),
        if (state.lastError != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: NekoSpace.md),
            child: Text(
              state.lastError!.message(context.l10n),
              key: const Key('scan-error-text'),
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        _PastePanel(controller: controller, pasteController: _pasteController),
      ],
    );
  }

  Widget _buildConfirm(PairingTarget target) {
    final controller = _controller;
    return Padding(
      padding: const EdgeInsets.all(NekoSpace.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            context.l10n.scanConfirmTitle(target.name),
            key: const Key('confirm-name'),
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: NekoSpace.sm),
          Text(
            '${target.endpoint.host}:${target.endpoint.port}',
            key: const Key('confirm-endpoint'),
          ),
          Text(
            context.l10n.scanFingerprint(target.fingerprint.substring(0, 12)),
            key: const Key('confirm-fingerprint'),
          ),
          const SizedBox(height: NekoSpace.lg),
          FilledButton(
            key: const Key('confirm-pair-button'),
            onPressed: controller.confirm,
            child: Text(context.l10n.scanConfirmPair),
          ),
          const SizedBox(height: NekoSpace.sm),
          OutlinedButton(
            key: const Key('confirm-back-button'),
            onPressed: controller.backToCamera,
            child: Text(context.l10n.commonBack),
          ),
        ],
      ),
    );
  }

  Widget _buildFailed(ScanFailure failure) {
    return Padding(
      padding: const EdgeInsets.all(NekoSpace.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            failure.message(context.l10n),
            key: const Key('failed-message'),
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
          const SizedBox(height: NekoSpace.lg),
          FilledButton.tonal(
            key: const Key('failed-back-button'),
            onPressed: ref.read(scanControllerProvider).backToCamera,
            child: Text(context.l10n.commonBack),
          ),
        ],
      ),
    );
  }
}

class _PastePanel extends ConsumerWidget {
  const _PastePanel({required this.controller, required this.pasteController});

  final ScanController controller;
  final TextEditingController pasteController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.all(NekoSpace.md),
      child: Row(
        children: <Widget>[
          Expanded(
            child: TextField(
              key: const Key('paste-field'),
              controller: pasteController,
              decoration: InputDecoration(
                labelText: context.l10n.scanPasteLabel,
                border: const OutlineInputBorder(),
              ),
              onSubmitted: (_) => _submit(),
            ),
          ),
          const SizedBox(width: NekoSpace.sm),
          FilledButton(
            key: const Key('paste-submit-button'),
            onPressed: _submit,
            child: Text(context.l10n.scanPairButton),
          ),
        ],
      ),
    );
  }

  void _submit() {
    final text = pasteController.text.trim();
    if (text.isEmpty) {
      return;
    }
    // 失败时保留草稿文本，便于修正后重试。
    controller.onScannedText(text);
  }
}
