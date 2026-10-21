import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/pairing/pairing_service.dart';
import 'package:neko_mobile/core/pairing/pairing_text.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/sessions/session_picker.dart';
import 'package:neko_mobile/l10n/error_text.dart';
import 'package:neko_mobile/l10n/l10n.dart';

import '../helpers/l10n_support.dart';

void main() {
  final zh = lookupAppLocalizations(kLocaleZh);
  final en = lookupAppLocalizations(kLocaleEn);

  group('类型化错误由界面层本地化', () {
    final rpcErrors = <RpcException>[
      const RpcUnauthorizedException(),
      const RpcRevokedException(),
      const RpcIncompatibleException(),
      const RpcCertificateException(),
      const RpcNetworkException(),
      const RpcProtocolException(),
      const RpcProtocolException('hello_not_object'),
      const RpcProtocolException('hello_error', <String, Object>{
        'message': 'boom',
      }),
      const RpcProtocolException('connect_failed', <String, Object>{
        'type': 'SocketException',
      }),
      for (final field in <String>[
        'api_version',
        'server_id',
        'server_name',
        'gateway_version',
        'capabilities',
      ])
        RpcProtocolException('${field}_invalid'),
    ];
    final pairingErrors = <PairingException>[
      const InvalidPairingException(),
      const WrongServerException(),
      const CodeUsedException(),
      const CodeExpiredException(),
      const PayloadTooLargeException(),
      const RateLimitedException(),
      for (final detail in <String>[
        'not_json',
        'not_object',
        'server_id_mismatch',
        'device_id_mismatch',
        'server_name_invalid',
        'grant_revision_invalid',
        'api_versions_invalid',
        'unrecognized',
      ])
        PairingResponseException(detail),
      const PairingNetworkException('unknown_status', <String, Object>{
        'status': 418,
      }),
      const PairingNetworkException('timeout'),
      const PairingNetworkException('interrupted'),
      const PairingNetworkException(),
      const PairingCertificateException(),
    ];

    test('连接错误：zh 为中文，en 无 CJK，协议字段名与错误细节原样', () {
      for (final error in rpcErrors) {
        final inZh = rpcErrorText(zh, error);
        final inEn = rpcErrorText(en, error);
        expect(inZh, isNotEmpty);
        expect(inEn, isNotEmpty);
        expect(hasCjk(inEn), isFalse, reason: '${error.code}: $inEn');
      }
      expect(
        rpcErrorText(
          en,
          const RpcProtocolException('hello_error', <String, Object>{
            'message': 'boom',
          }),
        ),
        contains('boom'),
      );
      expect(
        rpcErrorText(en, const RpcProtocolException('server_id_invalid')),
        contains('serverId'),
      );
      expect(
        rpcErrorText(zh, const RpcProtocolException('server_id_invalid')),
        contains('serverId'),
      );
      expect(
        rpcErrorText(zh, const RpcNetworkException()),
        isNot(rpcErrorText(en, const RpcNetworkException())),
      );
    });

    test('配对错误：zh 与 en 都有文案，en 无 CJK，参数原样', () {
      for (final error in pairingErrors) {
        final inEn = pairingErrorText(en, error);
        expect(pairingErrorText(zh, error), isNotEmpty);
        expect(inEn, isNotEmpty);
        expect(
          hasCjk(inEn),
          isFalse,
          reason: '${error.code}/${error.detail}: $inEn',
        );
      }
      const unknown = PairingNetworkException(
        'unknown_status',
        <String, Object>{'status': 418},
      );
      expect(pairingErrorText(en, unknown), contains('418'));
      expect(pairingErrorText(zh, unknown), contains('418'));
    });

    test('二维码文本解析错误：每个稳定码都有本地化，nekopair: 原样', () {
      for (final code in <String>[
        'missing_prefix',
        'missing_version',
        'version_not_number',
        'unsupported_version',
        'not_object',
        'bad_payload',
        'sid_invalid',
        'name_invalid',
        'endpoint_invalid',
        'fp_invalid',
        'code_missing',
        'code_length',
        'code_encoding',
        'exp_invalid',
        'expired',
        'something_new',
      ]) {
        final error = PairingTextError(
          PairingTextErrorKind.values.first,
          code,
          unsupportedVersion: 2,
        );
        expect(hasCjk(pairingTextErrorText(en, error)), isFalse, reason: code);
        expect(pairingTextErrorText(zh, error), isNotEmpty, reason: code);
      }
      final missing = PairingTextError(
        PairingTextErrorKind.values.first,
        'missing_prefix',
      );
      expect(pairingTextErrorText(zh, missing), contains('nekopair:'));
      expect(pairingTextErrorText(en, missing), contains('nekopair:'));
    });

    test('接口错误经 describeError 延迟解析：同一错误随语言变化，错误码前缀保留', () {
      final rejected = describeError(
        const MobileApiException(
          'rejected',
          'PLAN_BUSY: Wait for the current run to finish or stop it first.',
        ),
      );
      final inEn = resolveUiText(rejected, kLocaleEn);
      final inZh = resolveUiText(rejected, kLocaleZh);
      expect(inEn, contains('PLAN_BUSY:'));
      expect(inZh, contains('PLAN_BUSY:'));
      expect(hasCjk(inEn), isFalse);
      expect(hasCjk(inZh), isTrue);
      final unknownCode = describeError(const MobileApiException('weird', 'x'));
      expect(hasCjk(resolveUiText(unknownCode, kLocaleEn)), isFalse);
      expect(
        resolveUiText(describeError(StateError('x')), kLocaleEn),
        en.errorGeneric,
      );
    });
  });

  group('日期与相对时间', () {
    final now = DateTime(2026, 10, 15, 12);
    int ago(Duration d) => now.subtract(d).millisecondsSinceEpoch;

    test('相对时间：en 为 now / 5m / 3h / 2d，zh 为中文', () {
      expect(relativeTime(en, ago(const Duration(seconds: 20)), now), 'now');
      expect(relativeTime(en, ago(const Duration(minutes: 5)), now), '5m');
      expect(relativeTime(en, ago(const Duration(hours: 3)), now), '3h');
      expect(relativeTime(en, ago(const Duration(days: 2)), now), '2d');
      expect(relativeTime(zh, ago(const Duration(minutes: 5)), now), '5 分钟前');
      expect(relativeTime(zh, ago(const Duration(days: 2)), now), '2 天前');
    });

    test('超过 30 天的绝对日期：zh 用 zh-CN 的 yyyy-MM-dd，en 用 en-GB 的 dd/MM/yyyy', () {
      final at = DateTime(2026, 8, 1, 9).millisecondsSinceEpoch;
      expect(relativeTime(zh, at, now), '2026-08-01');
      expect(relativeTime(en, at, now), '01/08/2026');
    });

    test('同一语言内不混用格式；无时间戳返回空串', () {
      expect(relativeTime(en, 0, now), '');
      expect(en.datePattern, 'dd/MM/yyyy');
      expect(zh.datePattern, 'yyyy-MM-dd');
    });
  });
}
