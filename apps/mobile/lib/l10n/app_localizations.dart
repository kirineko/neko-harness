import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_zh.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations)!;
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('en'),
    Locale('zh'),
  ];

  /// No description provided for @commonCancel.
  ///
  /// In zh, this message translates to:
  /// **'取消'**
  String get commonCancel;

  /// No description provided for @commonClose.
  ///
  /// In zh, this message translates to:
  /// **'关闭'**
  String get commonClose;

  /// No description provided for @commonRetry.
  ///
  /// In zh, this message translates to:
  /// **'重试'**
  String get commonRetry;

  /// No description provided for @commonBack.
  ///
  /// In zh, this message translates to:
  /// **'返回'**
  String get commonBack;

  /// No description provided for @appearanceTitle.
  ///
  /// In zh, this message translates to:
  /// **'外观'**
  String get appearanceTitle;

  /// No description provided for @themeAuto.
  ///
  /// In zh, this message translates to:
  /// **'自动'**
  String get themeAuto;

  /// No description provided for @themeFollowSystem.
  ///
  /// In zh, this message translates to:
  /// **'跟随系统'**
  String get themeFollowSystem;

  /// No description provided for @themeLight.
  ///
  /// In zh, this message translates to:
  /// **'浅色'**
  String get themeLight;

  /// No description provided for @themeDark.
  ///
  /// In zh, this message translates to:
  /// **'深色'**
  String get themeDark;

  /// No description provided for @languageTitle.
  ///
  /// In zh, this message translates to:
  /// **'语言'**
  String get languageTitle;

  /// No description provided for @languageZh.
  ///
  /// In zh, this message translates to:
  /// **'中文'**
  String get languageZh;

  /// No description provided for @languageEn.
  ///
  /// In zh, this message translates to:
  /// **'English'**
  String get languageEn;

  /// No description provided for @statusThinking.
  ///
  /// In zh, this message translates to:
  /// **'思考中…'**
  String get statusThinking;

  /// No description provided for @statusRunning.
  ///
  /// In zh, this message translates to:
  /// **'运行 {tool}…'**
  String statusRunning(String tool);

  /// No description provided for @statusRetrying.
  ///
  /// In zh, this message translates to:
  /// **'重试中（第 {attempt} 次）…'**
  String statusRetrying(int attempt);

  /// No description provided for @systemContextCompacted.
  ///
  /// In zh, this message translates to:
  /// **'[上下文已压缩]'**
  String get systemContextCompacted;

  /// No description provided for @systemNewContext.
  ///
  /// In zh, this message translates to:
  /// **'[新上下文]'**
  String get systemNewContext;

  /// No description provided for @toolNoteNotRun.
  ///
  /// In zh, this message translates to:
  /// **'未执行：回答被中断'**
  String get toolNoteNotRun;

  /// No description provided for @errorProviderDisabled.
  ///
  /// In zh, this message translates to:
  /// **'PROVIDER_DISABLED: {provider} 未启用，请在 /login 或 Web 设置中启用，或切换模型'**
  String errorProviderDisabled(String provider);

  /// No description provided for @errorProviderKeyRequired.
  ///
  /// In zh, this message translates to:
  /// **'PROVIDER_KEY_REQUIRED: 请在 /login 或 Web 设置中配置 {provider} API Key'**
  String errorProviderKeyRequired(String provider);

  /// No description provided for @errorPlanBusy.
  ///
  /// In zh, this message translates to:
  /// **'PLAN_BUSY: 请等待当前运行结束，或先停止它'**
  String get errorPlanBusy;

  /// No description provided for @apiRejected.
  ///
  /// In zh, this message translates to:
  /// **'电脑拒绝了请求：{message}'**
  String apiRejected(String message);

  /// No description provided for @apiGone.
  ///
  /// In zh, this message translates to:
  /// **'会话已失效，请重新选择'**
  String get apiGone;

  /// No description provided for @apiUnauthorized.
  ///
  /// In zh, this message translates to:
  /// **'设备授权已失效'**
  String get apiUnauthorized;

  /// No description provided for @apiBusyLimit.
  ///
  /// In zh, this message translates to:
  /// **'请求过于频繁，请稍后重试'**
  String get apiBusyLimit;

  /// No description provided for @apiNotFound.
  ///
  /// In zh, this message translates to:
  /// **'内容不存在或已结束'**
  String get apiNotFound;

  /// No description provided for @apiInvalidParams.
  ///
  /// In zh, this message translates to:
  /// **'请求无效：{message}'**
  String apiInvalidParams(String message);

  /// No description provided for @apiFailed.
  ///
  /// In zh, this message translates to:
  /// **'电脑处理失败，请重试'**
  String get apiFailed;

  /// No description provided for @errorGeneric.
  ///
  /// In zh, this message translates to:
  /// **'操作失败，请重试'**
  String get errorGeneric;

  /// No description provided for @certificateMismatch.
  ///
  /// In zh, this message translates to:
  /// **'电脑证书与配对指纹不符'**
  String get certificateMismatch;

  /// No description provided for @rpcUnauthorized.
  ///
  /// In zh, this message translates to:
  /// **'电脑拒绝了本设备（401）'**
  String get rpcUnauthorized;

  /// No description provided for @rpcRevoked.
  ///
  /// In zh, this message translates to:
  /// **'设备授权已被电脑撤销'**
  String get rpcRevoked;

  /// No description provided for @rpcIncompatible.
  ///
  /// In zh, this message translates to:
  /// **'协议版本不兼容'**
  String get rpcIncompatible;

  /// No description provided for @rpcNetwork.
  ///
  /// In zh, this message translates to:
  /// **'网络连接失败'**
  String get rpcNetwork;

  /// No description provided for @protocolHelloInvalid.
  ///
  /// In zh, this message translates to:
  /// **'hello 响应不合法'**
  String get protocolHelloInvalid;

  /// No description provided for @protocolHelloNotObject.
  ///
  /// In zh, this message translates to:
  /// **'hello 结果不是对象'**
  String get protocolHelloNotObject;

  /// No description provided for @protocolHelloError.
  ///
  /// In zh, this message translates to:
  /// **'server.hello 返回错误: {message}'**
  String protocolHelloError(String message);

  /// No description provided for @protocolConnectFailed.
  ///
  /// In zh, this message translates to:
  /// **'连接失败: {type}'**
  String protocolConnectFailed(String type);

  /// No description provided for @protocolFieldInvalid.
  ///
  /// In zh, this message translates to:
  /// **'{field} 不合法'**
  String protocolFieldInvalid(String field);

  /// No description provided for @pairTextMissingPrefix.
  ///
  /// In zh, this message translates to:
  /// **'缺少 nekopair: 前缀'**
  String get pairTextMissingPrefix;

  /// No description provided for @pairTextMissingVersion.
  ///
  /// In zh, this message translates to:
  /// **'缺少版本段'**
  String get pairTextMissingVersion;

  /// No description provided for @pairTextVersionNotNumber.
  ///
  /// In zh, this message translates to:
  /// **'版本段不是数字'**
  String get pairTextVersionNotNumber;

  /// No description provided for @pairTextUnsupportedVersion.
  ///
  /// In zh, this message translates to:
  /// **'不支持的配对版本 {version}'**
  String pairTextUnsupportedVersion(int version);

  /// No description provided for @pairTextNotObject.
  ///
  /// In zh, this message translates to:
  /// **'JSON 必须是对象'**
  String get pairTextNotObject;

  /// No description provided for @pairTextBadPayload.
  ///
  /// In zh, this message translates to:
  /// **'base64url、UTF-8 或 JSON 不合法'**
  String get pairTextBadPayload;

  /// No description provided for @pairTextSidInvalid.
  ///
  /// In zh, this message translates to:
  /// **'sid 缺失或不是字符串'**
  String get pairTextSidInvalid;

  /// No description provided for @pairTextNameInvalid.
  ///
  /// In zh, this message translates to:
  /// **'name 缺失或超过 64 字符'**
  String get pairTextNameInvalid;

  /// No description provided for @pairTextEndpointInvalid.
  ///
  /// In zh, this message translates to:
  /// **'ep 必须是 https://IPv4字面量:端口，不允许 userinfo/query/fragment/path'**
  String get pairTextEndpointInvalid;

  /// No description provided for @pairTextFingerprintInvalid.
  ///
  /// In zh, this message translates to:
  /// **'fp 必须是 64 位十六进制'**
  String get pairTextFingerprintInvalid;

  /// No description provided for @pairTextCodeMissing.
  ///
  /// In zh, this message translates to:
  /// **'code 缺失或不是字符串'**
  String get pairTextCodeMissing;

  /// No description provided for @pairTextCodeLength.
  ///
  /// In zh, this message translates to:
  /// **'code 必须是 32 字节 base64url'**
  String get pairTextCodeLength;

  /// No description provided for @pairTextCodeEncoding.
  ///
  /// In zh, this message translates to:
  /// **'code 不是合法 base64url'**
  String get pairTextCodeEncoding;

  /// No description provided for @pairTextExpInvalid.
  ///
  /// In zh, this message translates to:
  /// **'exp 必须是正整数 Unix 毫秒'**
  String get pairTextExpInvalid;

  /// No description provided for @pairTextExpired.
  ///
  /// In zh, this message translates to:
  /// **'配对码已过期'**
  String get pairTextExpired;

  /// No description provided for @pairRejected.
  ///
  /// In zh, this message translates to:
  /// **'请求被电脑拒绝'**
  String get pairRejected;

  /// No description provided for @pairWrongServer.
  ///
  /// In zh, this message translates to:
  /// **'电脑标识不一致，请确认二维码来自目标电脑'**
  String get pairWrongServer;

  /// No description provided for @pairCodeUsed.
  ///
  /// In zh, this message translates to:
  /// **'配对码已被使用，请重新扫码'**
  String get pairCodeUsed;

  /// No description provided for @pairCodeExpired.
  ///
  /// In zh, this message translates to:
  /// **'配对码已过期，请重新扫码'**
  String get pairCodeExpired;

  /// No description provided for @pairPayloadTooLarge.
  ///
  /// In zh, this message translates to:
  /// **'电脑无法处理该请求'**
  String get pairPayloadTooLarge;

  /// No description provided for @pairRateLimited.
  ///
  /// In zh, this message translates to:
  /// **'尝试过于频繁，请稍后再试'**
  String get pairRateLimited;

  /// No description provided for @pairResponseUnrecognized.
  ///
  /// In zh, this message translates to:
  /// **'电脑返回了无法识别的响应'**
  String get pairResponseUnrecognized;

  /// No description provided for @pairResponseNotJson.
  ///
  /// In zh, this message translates to:
  /// **'响应不是合法 JSON'**
  String get pairResponseNotJson;

  /// No description provided for @pairResponseNotObject.
  ///
  /// In zh, this message translates to:
  /// **'响应不是 JSON 对象'**
  String get pairResponseNotObject;

  /// No description provided for @pairFieldMismatch.
  ///
  /// In zh, this message translates to:
  /// **'{field} 与请求不一致'**
  String pairFieldMismatch(String field);

  /// No description provided for @pairApiVersionsMissing.
  ///
  /// In zh, this message translates to:
  /// **'apiVersions 不含 1'**
  String get pairApiVersionsMissing;

  /// No description provided for @pairNetworkFailed.
  ///
  /// In zh, this message translates to:
  /// **'网络连接失败，请重试'**
  String get pairNetworkFailed;

  /// No description provided for @pairNetworkUnknownStatus.
  ///
  /// In zh, this message translates to:
  /// **'电脑返回了未知状态 {status}'**
  String pairNetworkUnknownStatus(int status);

  /// No description provided for @pairNetworkTimeout.
  ///
  /// In zh, this message translates to:
  /// **'电脑响应超时，请重试'**
  String get pairNetworkTimeout;

  /// No description provided for @pairNetworkInterrupted.
  ///
  /// In zh, this message translates to:
  /// **'电脑连接中断，请重试'**
  String get pairNetworkInterrupted;

  /// No description provided for @pairFailed.
  ///
  /// In zh, this message translates to:
  /// **'配对失败，请重试'**
  String get pairFailed;

  /// No description provided for @scanTitle.
  ///
  /// In zh, this message translates to:
  /// **'连接电脑'**
  String get scanTitle;

  /// No description provided for @scanCameraUnavailable.
  ///
  /// In zh, this message translates to:
  /// **'相机不可用或权限被拒绝，可在系统设置中开启相机权限。'**
  String get scanCameraUnavailable;

  /// No description provided for @scanOpenSettings.
  ///
  /// In zh, this message translates to:
  /// **'打开应用设置'**
  String get scanOpenSettings;

  /// No description provided for @scanRetryCamera.
  ///
  /// In zh, this message translates to:
  /// **'重试相机'**
  String get scanRetryCamera;

  /// No description provided for @scanConfirmTitle.
  ///
  /// In zh, this message translates to:
  /// **'连接 {name}？'**
  String scanConfirmTitle(String name);

  /// No description provided for @scanFingerprint.
  ///
  /// In zh, this message translates to:
  /// **'证书指纹 {fingerprint}…'**
  String scanFingerprint(String fingerprint);

  /// No description provided for @scanConfirmPair.
  ///
  /// In zh, this message translates to:
  /// **'确认连接'**
  String get scanConfirmPair;

  /// No description provided for @scanPasteLabel.
  ///
  /// In zh, this message translates to:
  /// **'粘贴配对文本'**
  String get scanPasteLabel;

  /// No description provided for @scanPairButton.
  ///
  /// In zh, this message translates to:
  /// **'配对'**
  String get scanPairButton;

  /// No description provided for @computersTitle.
  ///
  /// In zh, this message translates to:
  /// **'电脑与设置'**
  String get computersTitle;

  /// No description provided for @computersPaired.
  ///
  /// In zh, this message translates to:
  /// **'已配对的电脑'**
  String get computersPaired;

  /// No description provided for @computersForgetTitle.
  ///
  /// In zh, this message translates to:
  /// **'忘记「{name}」？'**
  String computersForgetTitle(String name);

  /// No description provided for @computersForgetBody.
  ///
  /// In zh, this message translates to:
  /// **'将删除本机保存的凭据；再次控制需要重新扫码。电脑上的任务不受影响。'**
  String get computersForgetBody;

  /// No description provided for @computersForget.
  ///
  /// In zh, this message translates to:
  /// **'忘记'**
  String get computersForget;

  /// No description provided for @computersForgetTooltip.
  ///
  /// In zh, this message translates to:
  /// **'忘记这台电脑'**
  String get computersForgetTooltip;

  /// No description provided for @pairNewComputer.
  ///
  /// In zh, this message translates to:
  /// **'扫码配对新电脑'**
  String get pairNewComputer;

  /// No description provided for @drawerSectionComputers.
  ///
  /// In zh, this message translates to:
  /// **'电脑'**
  String get drawerSectionComputers;

  /// No description provided for @drawerComputersSettings.
  ///
  /// In zh, this message translates to:
  /// **'电脑管理与设置'**
  String get drawerComputersSettings;

  /// No description provided for @connOnline.
  ///
  /// In zh, this message translates to:
  /// **'在线'**
  String get connOnline;

  /// No description provided for @connConnecting.
  ///
  /// In zh, this message translates to:
  /// **'连接中'**
  String get connConnecting;

  /// No description provided for @connReconnecting.
  ///
  /// In zh, this message translates to:
  /// **'重连中'**
  String get connReconnecting;

  /// No description provided for @connOffline.
  ///
  /// In zh, this message translates to:
  /// **'离线'**
  String get connOffline;

  /// No description provided for @connIdle.
  ///
  /// In zh, this message translates to:
  /// **'未连接'**
  String get connIdle;

  /// No description provided for @connNeedsRepair.
  ///
  /// In zh, this message translates to:
  /// **'需要重新配对'**
  String get connNeedsRepair;

  /// No description provided for @connRestoring.
  ///
  /// In zh, this message translates to:
  /// **'正在恢复连接…'**
  String get connRestoring;

  /// No description provided for @connRetryNow.
  ///
  /// In zh, this message translates to:
  /// **'立即重试'**
  String get connRetryNow;

  /// No description provided for @connRescan.
  ///
  /// In zh, this message translates to:
  /// **'重新扫码配对'**
  String get connRescan;

  /// No description provided for @homeConnecting.
  ///
  /// In zh, this message translates to:
  /// **'正在连接电脑…'**
  String get homeConnecting;

  /// No description provided for @homeRevokedTitle.
  ///
  /// In zh, this message translates to:
  /// **'设备授权已被电脑撤销'**
  String get homeRevokedTitle;

  /// No description provided for @homeRevokedGuidance.
  ///
  /// In zh, this message translates to:
  /// **'电脑端已移除本设备。如需重新控制，请重新扫码配对。'**
  String get homeRevokedGuidance;

  /// No description provided for @homeTrustChangedGuidance.
  ///
  /// In zh, this message translates to:
  /// **'电脑可能重新生成了证书。请重新扫码配对以建立信任。'**
  String get homeTrustChangedGuidance;

  /// No description provided for @homeIncompatibleTitle.
  ///
  /// In zh, this message translates to:
  /// **'应用与电脑协议版本不兼容'**
  String get homeIncompatibleTitle;

  /// No description provided for @homeIncompatibleGuidance.
  ///
  /// In zh, this message translates to:
  /// **'请升级手机应用或电脑端后重试。'**
  String get homeIncompatibleGuidance;

  /// No description provided for @homeIdleText.
  ///
  /// In zh, this message translates to:
  /// **'尚未连接电脑'**
  String get homeIdleText;

  /// No description provided for @homeScanConnect.
  ///
  /// In zh, this message translates to:
  /// **'扫码连接'**
  String get homeScanConnect;

  /// No description provided for @homeBackToScan.
  ///
  /// In zh, this message translates to:
  /// **'返回扫码'**
  String get homeBackToScan;

  /// No description provided for @homeOfflineText.
  ///
  /// In zh, this message translates to:
  /// **'网络不可达或电脑已离线'**
  String get homeOfflineText;

  /// No description provided for @homeOfflineRetry.
  ///
  /// In zh, this message translates to:
  /// **'{seconds} 秒后自动重试'**
  String homeOfflineRetry(String seconds);

  /// No description provided for @homeOfflineHint.
  ///
  /// In zh, this message translates to:
  /// **'电脑上的任务不受影响，恢复后自动继续。'**
  String get homeOfflineHint;

  /// No description provided for @homeConnected.
  ///
  /// In zh, this message translates to:
  /// **'已连接 {name}'**
  String homeConnected(String name);

  /// No description provided for @chatSwitchSession.
  ///
  /// In zh, this message translates to:
  /// **'切换会话'**
  String get chatSwitchSession;

  /// No description provided for @sessionNewTitle.
  ///
  /// In zh, this message translates to:
  /// **'新会话'**
  String get sessionNewTitle;

  /// No description provided for @sessionNew.
  ///
  /// In zh, this message translates to:
  /// **'新建会话'**
  String get sessionNew;

  /// No description provided for @chatWaitingForAnswer.
  ///
  /// In zh, this message translates to:
  /// **'等待你的回答'**
  String get chatWaitingForAnswer;

  /// No description provided for @chatRunning.
  ///
  /// In zh, this message translates to:
  /// **'运行中…'**
  String get chatRunning;

  /// No description provided for @chatNoWorkspaces.
  ///
  /// In zh, this message translates to:
  /// **'电脑上还没有登记工作区，请先在电脑端添加。'**
  String get chatNoWorkspaces;

  /// No description provided for @chatSelectOrCreate.
  ///
  /// In zh, this message translates to:
  /// **'选择一个会话或新建会话'**
  String get chatSelectOrCreate;

  /// No description provided for @chatLoadFailed.
  ///
  /// In zh, this message translates to:
  /// **'加载会话失败'**
  String get chatLoadFailed;

  /// No description provided for @connRevoked.
  ///
  /// In zh, this message translates to:
  /// **'授权已撤销'**
  String get connRevoked;

  /// No description provided for @connCertChanged.
  ///
  /// In zh, this message translates to:
  /// **'证书已变更'**
  String get connCertChanged;

  /// No description provided for @connIncompatible.
  ///
  /// In zh, this message translates to:
  /// **'版本不兼容'**
  String get connIncompatible;

  /// No description provided for @connBannerOffline.
  ///
  /// In zh, this message translates to:
  /// **'电脑暂不可达，{seconds} 秒后重试；电脑上的任务不受影响'**
  String connBannerOffline(int seconds);

  /// No description provided for @connReconnectNow.
  ///
  /// In zh, this message translates to:
  /// **'立即重连'**
  String get connReconnectNow;

  /// No description provided for @connBannerRevoked.
  ///
  /// In zh, this message translates to:
  /// **'设备授权已被电脑撤销，请重新扫码配对'**
  String get connBannerRevoked;

  /// No description provided for @connRepair.
  ///
  /// In zh, this message translates to:
  /// **'重新配对'**
  String get connRepair;

  /// No description provided for @connBannerTrustChanged.
  ///
  /// In zh, this message translates to:
  /// **'电脑证书已变更，请重新扫码配对'**
  String get connBannerTrustChanged;

  /// No description provided for @connBannerIncompatible.
  ///
  /// In zh, this message translates to:
  /// **'应用与电脑协议版本不兼容，请升级后重试'**
  String get connBannerIncompatible;

  /// No description provided for @chatSteer.
  ///
  /// In zh, this message translates to:
  /// **'引导'**
  String get chatSteer;

  /// No description provided for @chatQueued.
  ///
  /// In zh, this message translates to:
  /// **'排队'**
  String get chatQueued;

  /// No description provided for @chatImagesOnly.
  ///
  /// In zh, this message translates to:
  /// **'（仅图片）'**
  String get chatImagesOnly;

  /// No description provided for @chatWithdrawing.
  ///
  /// In zh, this message translates to:
  /// **'撤回中'**
  String get chatWithdrawing;

  /// No description provided for @chatWithdraw.
  ///
  /// In zh, this message translates to:
  /// **'撤回'**
  String get chatWithdraw;

  /// No description provided for @chatPendingLabel.
  ///
  /// In zh, this message translates to:
  /// **'待确认：{text}'**
  String chatPendingLabel(String text);

  /// No description provided for @chatDiscard.
  ///
  /// In zh, this message translates to:
  /// **'放弃'**
  String get chatDiscard;

  /// No description provided for @chatQuestionHintShort.
  ///
  /// In zh, this message translates to:
  /// **'消息会排队，回答后才处理'**
  String get chatQuestionHintShort;

  /// No description provided for @chatQuestionHintLong.
  ///
  /// In zh, this message translates to:
  /// **'助手正在等待你的回答；此处发送的消息会排队，回答后才处理。'**
  String get chatQuestionHintLong;

  /// No description provided for @chatAnswerQuestion.
  ///
  /// In zh, this message translates to:
  /// **'回答问题'**
  String get chatAnswerQuestion;

  /// No description provided for @chatHintOffline.
  ///
  /// In zh, this message translates to:
  /// **'未连接，可继续编辑草稿'**
  String get chatHintOffline;

  /// No description provided for @chatHintWaiting.
  ///
  /// In zh, this message translates to:
  /// **'消息会排队，回答问题后才处理'**
  String get chatHintWaiting;

  /// No description provided for @chatHintBusy.
  ///
  /// In zh, this message translates to:
  /// **'回答结束后排队处理，可在上方排队条引导或撤回'**
  String get chatHintBusy;

  /// No description provided for @chatHintIdle.
  ///
  /// In zh, this message translates to:
  /// **'发消息给 Agent'**
  String get chatHintIdle;

  /// No description provided for @chatStop.
  ///
  /// In zh, this message translates to:
  /// **'停止当前运行'**
  String get chatStop;

  /// No description provided for @chatQueue.
  ///
  /// In zh, this message translates to:
  /// **'排队'**
  String get chatQueue;

  /// No description provided for @chatSend.
  ///
  /// In zh, this message translates to:
  /// **'发送'**
  String get chatSend;

  /// No description provided for @chatNoticeSteerWithdrawn.
  ///
  /// In zh, this message translates to:
  /// **'无法改为引导，消息已撤回到输入框'**
  String get chatNoticeSteerWithdrawn;

  /// No description provided for @chatNoticeNotQueued.
  ///
  /// In zh, this message translates to:
  /// **'该消息已不在队列中'**
  String get chatNoticeNotQueued;

  /// No description provided for @chatNoticeAlreadySentSteer.
  ///
  /// In zh, this message translates to:
  /// **'该消息已发送，无法引导'**
  String get chatNoticeAlreadySentSteer;

  /// No description provided for @chatNoticeImagesNotRestored.
  ///
  /// In zh, this message translates to:
  /// **'图片未恢复，请重新添加'**
  String get chatNoticeImagesNotRestored;

  /// No description provided for @chatNoticeAlreadySentWithdraw.
  ///
  /// In zh, this message translates to:
  /// **'该消息已发送，无法撤回'**
  String get chatNoticeAlreadySentWithdraw;

  /// No description provided for @interactionsNoReceiptAnswer.
  ///
  /// In zh, this message translates to:
  /// **'未收到电脑的回执：回答可能已送达，也可能没有。恢复连接后请先查看问题状态，再决定是否重新提交。'**
  String get interactionsNoReceiptAnswer;

  /// No description provided for @interactionsNoReceiptPlan.
  ///
  /// In zh, this message translates to:
  /// **'未收到电脑的回执：决定可能已送达，也可能没有。恢复连接后请先查看计划状态，再决定是否重新提交。'**
  String get interactionsNoReceiptPlan;

  /// No description provided for @interactionsSettledElsewhere.
  ///
  /// In zh, this message translates to:
  /// **'其他设备已先处理，以下是实际结果。'**
  String get interactionsSettledElsewhere;

  /// No description provided for @interactionsQuestionGone.
  ///
  /// In zh, this message translates to:
  /// **'该问题已不存在或已结束'**
  String get interactionsQuestionGone;

  /// No description provided for @questionProblemEmpty.
  ///
  /// In zh, this message translates to:
  /// **'请选择选项，或填写文字。'**
  String get questionProblemEmpty;

  /// No description provided for @questionProblemTooManyOptions.
  ///
  /// In zh, this message translates to:
  /// **'最多选择 {max} 项。'**
  String questionProblemTooManyOptions(int max);

  /// No description provided for @questionProblemDuplicate.
  ///
  /// In zh, this message translates to:
  /// **'选项被重复选择。'**
  String get questionProblemDuplicate;

  /// No description provided for @questionProblemOptionGone.
  ///
  /// In zh, this message translates to:
  /// **'选项已失效，请重新打开问题。'**
  String get questionProblemOptionGone;

  /// No description provided for @questionProblemNoOptions.
  ///
  /// In zh, this message translates to:
  /// **'此问题没有选项。'**
  String get questionProblemNoOptions;

  /// No description provided for @questionProblemSingleOnly.
  ///
  /// In zh, this message translates to:
  /// **'此问题只能选择一项。'**
  String get questionProblemSingleOnly;

  /// No description provided for @questionProblemTextTooLong.
  ///
  /// In zh, this message translates to:
  /// **'文字过长（{length}/{limit}，按 UTF-16 码元计）。'**
  String questionProblemTextTooLong(int length, int limit);

  /// No description provided for @questionProblemTooLarge.
  ///
  /// In zh, this message translates to:
  /// **'回答内容过大（上限 {limit} 字节），请精简文字。'**
  String questionProblemTooLarge(int limit);

  /// No description provided for @planProblemEmpty.
  ///
  /// In zh, this message translates to:
  /// **'请填写修改意见。'**
  String get planProblemEmpty;

  /// No description provided for @planProblemTooLong.
  ///
  /// In zh, this message translates to:
  /// **'修改意见过长（{length}/{limit}，按 UTF-16 码元计）。'**
  String planProblemTooLong(int length, int limit);

  /// No description provided for @commonSubmitting.
  ///
  /// In zh, this message translates to:
  /// **'提交中…'**
  String get commonSubmitting;

  /// No description provided for @separatorClause.
  ///
  /// In zh, this message translates to:
  /// **'，'**
  String get separatorClause;

  /// No description provided for @separatorList.
  ///
  /// In zh, this message translates to:
  /// **'、'**
  String get separatorList;

  /// No description provided for @approvalBarCount.
  ///
  /// In zh, this message translates to:
  /// **'{count} 个命令等待审批'**
  String approvalBarCount(int count);

  /// No description provided for @approvalSubagentTitle.
  ///
  /// In zh, this message translates to:
  /// **'子 agent #{taskId}'**
  String approvalSubagentTitle(int taskId);

  /// No description provided for @approvalCwd.
  ///
  /// In zh, this message translates to:
  /// **'目录：{cwd}'**
  String approvalCwd(String cwd);

  /// No description provided for @approvalTimeout.
  ///
  /// In zh, this message translates to:
  /// **'超时：{seconds} 秒'**
  String approvalTimeout(int seconds);

  /// No description provided for @approvalAllowed.
  ///
  /// In zh, this message translates to:
  /// **'已允许'**
  String get approvalAllowed;

  /// No description provided for @approvalDenied.
  ///
  /// In zh, this message translates to:
  /// **'已拒绝'**
  String get approvalDenied;

  /// No description provided for @approvalCancelled.
  ///
  /// In zh, this message translates to:
  /// **'任务已停止，命令未执行'**
  String get approvalCancelled;

  /// No description provided for @approvalStillWaiting.
  ///
  /// In zh, this message translates to:
  /// **'仍在等待（可能已被其他端处理，请刷新）'**
  String get approvalStillWaiting;

  /// No description provided for @approvalDeny.
  ///
  /// In zh, this message translates to:
  /// **'拒绝'**
  String get approvalDeny;

  /// No description provided for @approvalAllowOnce.
  ///
  /// In zh, this message translates to:
  /// **'允许本次'**
  String get approvalAllowOnce;

  /// No description provided for @todoStatusPending.
  ///
  /// In zh, this message translates to:
  /// **'待办'**
  String get todoStatusPending;

  /// No description provided for @todoStatusInProgress.
  ///
  /// In zh, this message translates to:
  /// **'进行中'**
  String get todoStatusInProgress;

  /// No description provided for @todoStatusCompleted.
  ///
  /// In zh, this message translates to:
  /// **'已完成'**
  String get todoStatusCompleted;

  /// No description provided for @todoProgressLabel.
  ///
  /// In zh, this message translates to:
  /// **'待办进度 {completed}/{total}'**
  String todoProgressLabel(int completed, int total);

  /// No description provided for @todoStale.
  ///
  /// In zh, this message translates to:
  /// **'{label}（非最新）'**
  String todoStale(String label);

  /// No description provided for @todoTitle.
  ///
  /// In zh, this message translates to:
  /// **'待办'**
  String get todoTitle;

  /// No description provided for @todoTitleProgress.
  ///
  /// In zh, this message translates to:
  /// **'待办 · 已完成 {completed}/{total}'**
  String todoTitleProgress(int completed, int total);

  /// No description provided for @todoOffline.
  ///
  /// In zh, this message translates to:
  /// **'当前离线：显示的是上次加载的待办，不一定是最新状态。'**
  String get todoOffline;

  /// No description provided for @todoRefreshing.
  ///
  /// In zh, this message translates to:
  /// **'正在更新待办…'**
  String get todoRefreshing;

  /// No description provided for @todoEmpty.
  ///
  /// In zh, this message translates to:
  /// **'当前没有待办'**
  String get todoEmpty;

  /// No description provided for @todoItemSemantics.
  ///
  /// In zh, this message translates to:
  /// **'{status}：{text}'**
  String todoItemSemantics(String status, String text);

  /// No description provided for @todoSummaryUpdate.
  ///
  /// In zh, this message translates to:
  /// **'更新 todo · 已完成 {completed}/{total}（修订 {revision}）'**
  String todoSummaryUpdate(int completed, int total, int revision);

  /// No description provided for @todoSummaryRead.
  ///
  /// In zh, this message translates to:
  /// **'读取 todo · 已完成 {completed}/{total}（修订 {revision}）'**
  String todoSummaryRead(int completed, int total, int revision);

  /// No description provided for @subagentStopTitle.
  ///
  /// In zh, this message translates to:
  /// **'停止这一轮？'**
  String get subagentStopTitle;

  /// No description provided for @subagentStopBody.
  ///
  /// In zh, this message translates to:
  /// **'只停止「{title}」的当前轮次，主会话与其他子 agent 继续运行。'**
  String subagentStopBody(String title);

  /// No description provided for @subagentStop.
  ///
  /// In zh, this message translates to:
  /// **'停止'**
  String get subagentStop;

  /// No description provided for @subagentForkedReadonly.
  ///
  /// In zh, this message translates to:
  /// **'分叉历史（只读）'**
  String get subagentForkedReadonly;

  /// No description provided for @subagentIdle.
  ///
  /// In zh, this message translates to:
  /// **'空闲'**
  String get subagentIdle;

  /// No description provided for @subagentStopTooltip.
  ///
  /// In zh, this message translates to:
  /// **'停止当前轮'**
  String get subagentStopTooltip;

  /// No description provided for @subagentUsageTotal.
  ///
  /// In zh, this message translates to:
  /// **'累计 {tokens} tokens'**
  String subagentUsageTotal(String tokens);

  /// No description provided for @subagentRound.
  ///
  /// In zh, this message translates to:
  /// **'第 {round} 轮 · {status}'**
  String subagentRound(int round, String status);

  /// No description provided for @subagentEmpty.
  ///
  /// In zh, this message translates to:
  /// **'子 agent 还没有输出'**
  String get subagentEmpty;

  /// No description provided for @subagentReload.
  ///
  /// In zh, this message translates to:
  /// **'重新加载'**
  String get subagentReload;

  /// No description provided for @sessionsSearchHint.
  ///
  /// In zh, this message translates to:
  /// **'搜索标题或首条消息'**
  String get sessionsSearchHint;

  /// No description provided for @sessionsEmpty.
  ///
  /// In zh, this message translates to:
  /// **'还没有会话'**
  String get sessionsEmpty;

  /// No description provided for @sessionsNoMatch.
  ///
  /// In zh, this message translates to:
  /// **'没有匹配的会话'**
  String get sessionsNoMatch;

  /// No description provided for @sessionAwaitingAnswer.
  ///
  /// In zh, this message translates to:
  /// **'等待回答'**
  String get sessionAwaitingAnswer;

  /// No description provided for @sessionAwaitingApproval.
  ///
  /// In zh, this message translates to:
  /// **'等待批准'**
  String get sessionAwaitingApproval;

  /// No description provided for @relTimeNow.
  ///
  /// In zh, this message translates to:
  /// **'刚刚'**
  String get relTimeNow;

  /// No description provided for @relTimeMinutes.
  ///
  /// In zh, this message translates to:
  /// **'{count} 分钟前'**
  String relTimeMinutes(int count);

  /// No description provided for @relTimeHours.
  ///
  /// In zh, this message translates to:
  /// **'{count} 小时前'**
  String relTimeHours(int count);

  /// No description provided for @relTimeDays.
  ///
  /// In zh, this message translates to:
  /// **'{count} 天前'**
  String relTimeDays(int count);

  /// No description provided for @datePattern.
  ///
  /// In zh, this message translates to:
  /// **'yyyy-MM-dd'**
  String get datePattern;

  /// No description provided for @planStatusAwaiting.
  ///
  /// In zh, this message translates to:
  /// **'等待批准'**
  String get planStatusAwaiting;

  /// No description provided for @planStatusApproved.
  ///
  /// In zh, this message translates to:
  /// **'已批准'**
  String get planStatusApproved;

  /// No description provided for @planStatusRevisionRequested.
  ///
  /// In zh, this message translates to:
  /// **'已要求修改'**
  String get planStatusRevisionRequested;

  /// No description provided for @planStatusSuperseded.
  ///
  /// In zh, this message translates to:
  /// **'已被取代'**
  String get planStatusSuperseded;

  /// No description provided for @planStatusCancelled.
  ///
  /// In zh, this message translates to:
  /// **'已取消'**
  String get planStatusCancelled;

  /// No description provided for @planBarSemantics.
  ///
  /// In zh, this message translates to:
  /// **'{label}：{title}'**
  String planBarSemantics(String label, String title);

  /// No description provided for @planHeader.
  ///
  /// In zh, this message translates to:
  /// **'助手提交的计划'**
  String get planHeader;

  /// No description provided for @planCloseTooltip.
  ///
  /// In zh, this message translates to:
  /// **'关闭（计划仍在等待批准）'**
  String get planCloseTooltip;

  /// No description provided for @planGone.
  ///
  /// In zh, this message translates to:
  /// **'没有待批准的计划。'**
  String get planGone;

  /// No description provided for @planOffline.
  ///
  /// In zh, this message translates to:
  /// **'当前离线：暂时无法提交，恢复连接后会重新读取计划状态，不会自动发送决定。'**
  String get planOffline;

  /// No description provided for @planFeedbackLabel.
  ///
  /// In zh, this message translates to:
  /// **'修改意见'**
  String get planFeedbackLabel;

  /// No description provided for @planSubmitFeedback.
  ///
  /// In zh, this message translates to:
  /// **'提交修改意见'**
  String get planSubmitFeedback;

  /// No description provided for @planApprove.
  ///
  /// In zh, this message translates to:
  /// **'批准并执行'**
  String get planApprove;

  /// No description provided for @planRevise.
  ///
  /// In zh, this message translates to:
  /// **'要求修改'**
  String get planRevise;

  /// No description provided for @planExit.
  ///
  /// In zh, this message translates to:
  /// **'取消并退出计划模式'**
  String get planExit;

  /// No description provided for @planDetailApproved.
  ///
  /// In zh, this message translates to:
  /// **'计划已批准，会话在电脑上开始执行。'**
  String get planDetailApproved;

  /// No description provided for @planDetailRevisionRequested.
  ///
  /// In zh, this message translates to:
  /// **'已要求修改，助手会按意见重新提交计划。'**
  String get planDetailRevisionRequested;

  /// No description provided for @planDetailSuperseded.
  ///
  /// In zh, this message translates to:
  /// **'收到了新的输入，这份计划不再需要批准。'**
  String get planDetailSuperseded;

  /// No description provided for @planDetailCancelled.
  ///
  /// In zh, this message translates to:
  /// **'运行已停止或会话已归档，计划不再需要批准。'**
  String get planDetailCancelled;

  /// No description provided for @planFinalFeedback.
  ///
  /// In zh, this message translates to:
  /// **'修改意见：{feedback}'**
  String planFinalFeedback(String feedback);

  /// No description provided for @questionStatusPending.
  ///
  /// In zh, this message translates to:
  /// **'等待回答'**
  String get questionStatusPending;

  /// No description provided for @questionStatusAnswered.
  ///
  /// In zh, this message translates to:
  /// **'已回答'**
  String get questionStatusAnswered;

  /// No description provided for @questionStatusSkipped.
  ///
  /// In zh, this message translates to:
  /// **'已跳过'**
  String get questionStatusSkipped;

  /// No description provided for @questionStatusCancelled.
  ///
  /// In zh, this message translates to:
  /// **'已取消'**
  String get questionStatusCancelled;

  /// No description provided for @questionBarSemantics.
  ///
  /// In zh, this message translates to:
  /// **'等待回答 {count} 个问题'**
  String questionBarSemantics(int count);

  /// No description provided for @questionBarCount.
  ///
  /// In zh, this message translates to:
  /// **'等待回答 · {count}'**
  String questionBarCount(int count);

  /// No description provided for @questionHeader.
  ///
  /// In zh, this message translates to:
  /// **'助手提问'**
  String get questionHeader;

  /// No description provided for @questionPrevious.
  ///
  /// In zh, this message translates to:
  /// **'上一题'**
  String get questionPrevious;

  /// No description provided for @questionNext.
  ///
  /// In zh, this message translates to:
  /// **'下一题'**
  String get questionNext;

  /// No description provided for @questionCloseTooltip.
  ///
  /// In zh, this message translates to:
  /// **'关闭（问题仍在等待回答）'**
  String get questionCloseTooltip;

  /// No description provided for @questionOffline.
  ///
  /// In zh, this message translates to:
  /// **'当前离线：暂时无法提交，恢复连接后会重新读取问题状态，不会自动发送答案。'**
  String get questionOffline;

  /// No description provided for @questionMultipleSemantics.
  ///
  /// In zh, this message translates to:
  /// **'多选，可选择多个选项'**
  String get questionMultipleSemantics;

  /// No description provided for @questionSingleSemantics.
  ///
  /// In zh, this message translates to:
  /// **'单选，只能选择一个选项'**
  String get questionSingleSemantics;

  /// No description provided for @questionMultipleMode.
  ///
  /// In zh, this message translates to:
  /// **'可多选'**
  String get questionMultipleMode;

  /// No description provided for @questionSingleMode.
  ///
  /// In zh, this message translates to:
  /// **'单选'**
  String get questionSingleMode;

  /// No description provided for @questionNoteOptional.
  ///
  /// In zh, this message translates to:
  /// **'补充说明（可选）'**
  String get questionNoteOptional;

  /// No description provided for @questionYourAnswer.
  ///
  /// In zh, this message translates to:
  /// **'你的回答'**
  String get questionYourAnswer;

  /// No description provided for @questionSkip.
  ///
  /// In zh, this message translates to:
  /// **'跳过'**
  String get questionSkip;

  /// No description provided for @questionSubmit.
  ///
  /// In zh, this message translates to:
  /// **'提交回答'**
  String get questionSubmit;

  /// No description provided for @questionRecommended.
  ///
  /// In zh, this message translates to:
  /// **'推荐'**
  String get questionRecommended;

  /// No description provided for @questionDetailSkipped.
  ///
  /// In zh, this message translates to:
  /// **'已跳过，未提供答案。'**
  String get questionDetailSkipped;

  /// No description provided for @questionDetailCancelled.
  ///
  /// In zh, this message translates to:
  /// **'运行已停止或会话已归档，问题不再需要回答。'**
  String get questionDetailCancelled;

  /// No description provided for @questionFinalOptions.
  ///
  /// In zh, this message translates to:
  /// **'选择：{options}'**
  String questionFinalOptions(String options);

  /// No description provided for @questionFinalText.
  ///
  /// In zh, this message translates to:
  /// **'文字：{text}'**
  String questionFinalText(String text);

  /// No description provided for @transcriptEmpty.
  ///
  /// In zh, this message translates to:
  /// **'还没有消息'**
  String get transcriptEmpty;

  /// No description provided for @transcriptToBottom.
  ///
  /// In zh, this message translates to:
  /// **'回到底部'**
  String get transcriptToBottom;

  /// No description provided for @transcriptThinking.
  ///
  /// In zh, this message translates to:
  /// **'思考中…'**
  String get transcriptThinking;

  /// No description provided for @transcriptThinkingProcess.
  ///
  /// In zh, this message translates to:
  /// **'思考过程'**
  String get transcriptThinkingProcess;

  /// No description provided for @transcriptExpand.
  ///
  /// In zh, this message translates to:
  /// **'展开全文（{kb} KB）'**
  String transcriptExpand(int kb);

  /// No description provided for @transcriptDiffSummary.
  ///
  /// In zh, this message translates to:
  /// **'+{added} −{removed}'**
  String transcriptDiffSummary(int added, int removed);

  /// No description provided for @transcriptDiffSummaryTruncated.
  ///
  /// In zh, this message translates to:
  /// **'+{added} −{removed}（diff 已截断）'**
  String transcriptDiffSummaryTruncated(int added, int removed);

  /// No description provided for @transcriptCodemodeCalls.
  ///
  /// In zh, this message translates to:
  /// **'工具调用（{count}）'**
  String transcriptCodemodeCalls(int count);

  /// No description provided for @transcriptCodemodeMore.
  ///
  /// In zh, this message translates to:
  /// **'还有 {count} 条未显示'**
  String transcriptCodemodeMore(int count);

  /// No description provided for @transcriptCodemodeFullOutput.
  ///
  /// In zh, this message translates to:
  /// **'完整输出：{path}'**
  String transcriptCodemodeFullOutput(String path);

  /// No description provided for @transcriptSubagentTitle.
  ///
  /// In zh, this message translates to:
  /// **'子 agent · {title}'**
  String transcriptSubagentTitle(String title);

  /// No description provided for @transcriptViewSubagent.
  ///
  /// In zh, this message translates to:
  /// **'查看子 agent'**
  String get transcriptViewSubagent;

  /// No description provided for @transcriptOptionRecommended.
  ///
  /// In zh, this message translates to:
  /// **'{label}（推荐）'**
  String transcriptOptionRecommended(String label);

  /// No description provided for @transcriptAnswered.
  ///
  /// In zh, this message translates to:
  /// **'已回答：{answer}'**
  String transcriptAnswered(String answer);

  /// No description provided for @transcriptNoContent.
  ///
  /// In zh, this message translates to:
  /// **'（无内容）'**
  String get transcriptNoContent;

  /// No description provided for @transcriptSkippedNoAnswer.
  ///
  /// In zh, this message translates to:
  /// **'已跳过，未提供答案'**
  String get transcriptSkippedNoAnswer;

  /// No description provided for @transcriptViewQuestion.
  ///
  /// In zh, this message translates to:
  /// **'查看问题'**
  String get transcriptViewQuestion;

  /// No description provided for @transcriptImageLabel.
  ///
  /// In zh, this message translates to:
  /// **'图片 {name}'**
  String transcriptImageLabel(String name);

  /// No description provided for @transcriptReloadImage.
  ///
  /// In zh, this message translates to:
  /// **'重新加载图片'**
  String get transcriptReloadImage;

  /// No description provided for @markdownImage.
  ///
  /// In zh, this message translates to:
  /// **'[图片 {alt}]'**
  String markdownImage(String alt);
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'zh'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'zh':
      return AppLocalizationsZh();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
