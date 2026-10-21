import 'package:neko_mobile/core/pairing/pairing_service.dart';
import 'package:neko_mobile/core/pairing/pairing_text.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/l10n/app_localizations.dart';

/// 连接层异常的用户可见文案。异常只携带稳定码与参数，语言在这里（界面层）决定。
String rpcErrorText(AppLocalizations l10n, RpcException error) {
  switch (error) {
    case RpcUnauthorizedException():
      return l10n.rpcUnauthorized;
    case RpcRevokedException():
      return l10n.rpcRevoked;
    case RpcIncompatibleException():
      return l10n.rpcIncompatible;
    case RpcCertificateException():
      return l10n.certificateMismatch;
    case RpcNetworkException():
      return l10n.rpcNetwork;
    case RpcProtocolException():
      final detail = error.code.substring('protocol:'.length);
      return switch (detail) {
        'hello_not_object' => l10n.protocolHelloNotObject,
        'hello_error' => l10n.protocolHelloError(
          '${error.params['message'] ?? ''}',
        ),
        'connect_failed' => l10n.protocolConnectFailed(
          '${error.params['type'] ?? ''}',
        ),
        'api_version_invalid' => l10n.protocolFieldInvalid('apiVersion'),
        'server_id_invalid' => l10n.protocolFieldInvalid('serverId'),
        'server_name_invalid' => l10n.protocolFieldInvalid('serverName'),
        'gateway_version_invalid' => l10n.protocolFieldInvalid(
          'gatewayVersion',
        ),
        'capabilities_invalid' => l10n.protocolFieldInvalid('capabilities'),
        _ => l10n.protocolHelloInvalid,
      };
  }
}

/// 二维码/粘贴文本的解析失败说明。
String pairingTextErrorText(AppLocalizations l10n, PairingTextError error) {
  return switch (error.code) {
    'missing_prefix' => l10n.pairTextMissingPrefix,
    'missing_version' => l10n.pairTextMissingVersion,
    'version_not_number' => l10n.pairTextVersionNotNumber,
    'unsupported_version' => l10n.pairTextUnsupportedVersion(
      error.unsupportedVersion ?? 0,
    ),
    'not_object' => l10n.pairTextNotObject,
    'bad_payload' => l10n.pairTextBadPayload,
    'sid_invalid' => l10n.pairTextSidInvalid,
    'name_invalid' => l10n.pairTextNameInvalid,
    'endpoint_invalid' => l10n.pairTextEndpointInvalid,
    'fp_invalid' => l10n.pairTextFingerprintInvalid,
    'code_missing' => l10n.pairTextCodeMissing,
    'code_length' => l10n.pairTextCodeLength,
    'code_encoding' => l10n.pairTextCodeEncoding,
    'exp_invalid' => l10n.pairTextExpInvalid,
    'expired' => l10n.pairTextExpired,
    _ => l10n.pairFailed,
  };
}

/// 配对请求失败的用户可见文案。
String pairingErrorText(AppLocalizations l10n, PairingException error) {
  switch (error) {
    case InvalidPairingException():
      return l10n.pairRejected;
    case WrongServerException():
      return l10n.pairWrongServer;
    case CodeUsedException():
      return l10n.pairCodeUsed;
    case CodeExpiredException():
      return l10n.pairCodeExpired;
    case PayloadTooLargeException():
      return l10n.pairPayloadTooLarge;
    case RateLimitedException():
      return l10n.pairRateLimited;
    case PairingResponseException():
      return switch (error.detail) {
        'not_json' => l10n.pairResponseNotJson,
        'not_object' => l10n.pairResponseNotObject,
        'server_id_mismatch' => l10n.pairFieldMismatch('serverId'),
        'device_id_mismatch' => l10n.pairFieldMismatch('deviceId'),
        'server_name_invalid' => l10n.protocolFieldInvalid('serverName'),
        'grant_revision_invalid' => l10n.protocolFieldInvalid('grantRevision'),
        'api_versions_invalid' => l10n.pairApiVersionsMissing,
        _ => l10n.pairResponseUnrecognized,
      };
    case PairingNetworkException():
      return switch (error.detail) {
        'unknown_status' => l10n.pairNetworkUnknownStatus(
          error.params['status'] is int ? error.params['status'] as int : 0,
        ),
        'timeout' => l10n.pairNetworkTimeout,
        'interrupted' => l10n.pairNetworkInterrupted,
        _ => l10n.pairNetworkFailed,
      };
    case PairingCertificateException():
      return l10n.certificateMismatch;
  }
}
