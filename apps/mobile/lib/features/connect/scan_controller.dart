import 'package:neko_mobile/core/pairing/pairing_models.dart';
import 'package:neko_mobile/core/pairing/pairing_service.dart';
import 'package:neko_mobile/core/pairing/pairing_text.dart';
import 'package:neko_mobile/l10n/error_text.dart';
import 'package:neko_mobile/l10n/l10n.dart';

/// 页面可展示的错误类别，用于区分提示文案。
enum ScanFailureKind {
  invalid,
  expired,
  unsupported,
  certificate,
  network,
  rateLimited,
  codeUsed,
  wrongServer,
  serverError,
}

class ScanFailure {
  const ScanFailure(this.kind, this.message);

  final ScanFailureKind kind;

  /// 用户可见说明；显示时才按当前语言解析。
  final UiText message;
}

sealed class ScanState {
  const ScanState();
}

/// 扫描/粘贴入口。[cameraActive] 为 false 表示相机不可用或权限被拒；
/// [lastError] 是上一次解析/配对失败，不影响继续扫描。
class ScanCamera extends ScanState {
  const ScanCamera({required this.cameraActive, this.lastError});

  final bool cameraActive;
  final ScanFailure? lastError;
}

/// 已解析出目标电脑，等待用户确认后才发起配对。
class ScanConfirm extends ScanState {
  const ScanConfirm(this.target);

  final PairingTarget target;
}

class ScanPairing extends ScanState {
  const ScanPairing(this.target);

  final PairingTarget target;
}

class ScanPairingDone extends ScanState {
  const ScanPairingDone(this.computer);

  final PairedComputer computer;
}

class ScanFailed extends ScanState {
  const ScanFailed(this.failure, this.target);

  final ScanFailure failure;

  /// 失败时用户正在配对的目标（解析失败时为 null 由调用方处理）。
  final PairingTarget? target;
}

/// 配对成功后的接入回调（生产移交 ConnectionManager，测试注入假实现）。
typedef OnPaired = Future<void> Function(PairedComputer computer);

/// M0 配对流程控制器：解析 → 确认 → 配对 → 移交连接。
/// 扫描回调只在 ScanCamera 状态生效，确认/配对期间重复回调被忽略。
class ScanController {
  ScanController({
    required this.pairingService,
    required this.onPaired,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final PairingService pairingService;
  final OnPaired onPaired;
  final DateTime Function() _clock;

  final List<void Function(ScanState)> _listeners =
      <void Function(ScanState)>[];
  ScanState _state = const ScanCamera(cameraActive: true);

  ScanState get state => _state;

  void addListener(void Function(ScanState) listener) {
    _listeners.add(listener);
  }

  void removeListener(void Function(ScanState) listener) {
    _listeners.remove(listener);
  }

  void _set(ScanState next) {
    _state = next;
    for (final listener in List<void Function(ScanState)>.of(_listeners)) {
      listener(next);
    }
  }

  /// 处理扫码/粘贴文本。返回是否已受理（确认/配对中忽略重复回调）。
  bool onScannedText(String raw) {
    final current = _state;
    if (current is! ScanCamera) {
      return false;
    }
    final result = parsePairingText(raw, clock: _clock);
    switch (result) {
      case PairingTextOk():
        _set(ScanConfirm(result.target));
      case PairingTextError(:final kind):
        final failureKind = switch (kind) {
          PairingTextErrorKind.invalid => ScanFailureKind.invalid,
          PairingTextErrorKind.expired => ScanFailureKind.expired,
          PairingTextErrorKind.unsupportedVersion =>
            ScanFailureKind.unsupported,
        };
        _set(
          ScanCamera(
            cameraActive: current.cameraActive,
            lastError: ScanFailure(
              failureKind,
              (l10n) => pairingTextErrorText(l10n, result),
            ),
          ),
        );
    }
    return true;
  }

  /// 相机不可用/权限被拒时由 UI 上报，切换到可粘贴+引导状态。
  void markCameraUnavailable() {
    final current = _state;
    if (current is ScanCamera) {
      _set(const ScanCamera(cameraActive: false));
    }
  }

  /// 重试相机。
  void retryCamera() {
    final current = _state;
    if (current is ScanCamera && !current.cameraActive) {
      _set(const ScanCamera(cameraActive: true));
    }
  }

  /// 用户返回扫描/粘贴入口。
  void backToCamera() {
    _set(const ScanCamera(cameraActive: true));
  }

  Future<void> confirm() async {
    final current = _state;
    if (current is! ScanConfirm) {
      return;
    }
    final target = current.target;
    _set(ScanPairing(target));
    try {
      final computer = await pairingService.pair(target);
      await onPaired(computer);
      _set(ScanPairingDone(computer));
    } on PairingException catch (e) {
      _set(ScanFailed(_mapPairingError(e), target));
    } catch (_) {
      // 存储、TLS 等非配对类异常：给出可重试的失败页，避免界面停在转圈。
      _set(
        ScanFailed(
          ScanFailure(ScanFailureKind.serverError, (l10n) => l10n.pairFailed),
          target,
        ),
      );
    }
  }

  ScanFailure _mapPairingError(PairingException e) {
    final kind = switch (e) {
      InvalidPairingException() => ScanFailureKind.invalid,
      WrongServerException() => ScanFailureKind.wrongServer,
      CodeUsedException() => ScanFailureKind.codeUsed,
      CodeExpiredException() => ScanFailureKind.expired,
      PayloadTooLargeException() => ScanFailureKind.serverError,
      RateLimitedException() => ScanFailureKind.rateLimited,
      PairingResponseException() => ScanFailureKind.serverError,
      PairingNetworkException() => ScanFailureKind.network,
      PairingCertificateException() => ScanFailureKind.certificate,
    };
    return ScanFailure(kind, (l10n) => pairingErrorText(l10n, e));
  }
}
