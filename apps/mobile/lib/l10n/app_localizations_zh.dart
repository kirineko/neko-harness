// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Chinese (`zh`).
class AppLocalizationsZh extends AppLocalizations {
  AppLocalizationsZh([String locale = 'zh']) : super(locale);

  @override
  String get commonCancel => '取消';

  @override
  String get commonClose => '关闭';

  @override
  String get commonRetry => '重试';

  @override
  String get commonBack => '返回';

  @override
  String get appearanceTitle => '外观';

  @override
  String get themeAuto => '自动';

  @override
  String get themeFollowSystem => '跟随系统';

  @override
  String get themeLight => '浅色';

  @override
  String get themeDark => '深色';

  @override
  String get languageTitle => '语言';

  @override
  String get languageZh => '中文';

  @override
  String get languageEn => 'English';

  @override
  String get statusThinking => '思考中…';

  @override
  String statusRunning(String tool) {
    return '运行 $tool…';
  }

  @override
  String statusRetrying(int attempt) {
    return '重试中（第 $attempt 次）…';
  }

  @override
  String get systemContextCompacted => '[上下文已压缩]';

  @override
  String get systemNewContext => '[新上下文]';

  @override
  String get toolNoteNotRun => '未执行：回答被中断';

  @override
  String errorProviderDisabled(String provider) {
    return 'PROVIDER_DISABLED: $provider 未启用，请在 /login 或 Web 设置中启用，或切换模型';
  }

  @override
  String errorProviderKeyRequired(String provider) {
    return 'PROVIDER_KEY_REQUIRED: 请在 /login 或 Web 设置中配置 $provider API Key';
  }

  @override
  String get errorPlanBusy => 'PLAN_BUSY: 请等待当前运行结束，或先停止它';

  @override
  String apiRejected(String message) {
    return '电脑拒绝了请求：$message';
  }

  @override
  String get apiGone => '会话已失效，请重新选择';

  @override
  String get apiUnauthorized => '设备授权已失效';

  @override
  String get apiBusyLimit => '请求过于频繁，请稍后重试';

  @override
  String get apiNotFound => '内容不存在或已结束';

  @override
  String apiInvalidParams(String message) {
    return '请求无效：$message';
  }

  @override
  String get apiFailed => '电脑处理失败，请重试';

  @override
  String get errorGeneric => '操作失败，请重试';

  @override
  String get certificateMismatch => '电脑证书与配对指纹不符';

  @override
  String get rpcUnauthorized => '电脑拒绝了本设备（401）';

  @override
  String get rpcRevoked => '设备授权已被电脑撤销';

  @override
  String get rpcIncompatible => '协议版本不兼容';

  @override
  String get rpcNetwork => '网络连接失败';

  @override
  String get protocolHelloInvalid => 'hello 响应不合法';

  @override
  String get protocolHelloNotObject => 'hello 结果不是对象';

  @override
  String protocolHelloError(String message) {
    return 'server.hello 返回错误: $message';
  }

  @override
  String protocolConnectFailed(String type) {
    return '连接失败: $type';
  }

  @override
  String protocolFieldInvalid(String field) {
    return '$field 不合法';
  }

  @override
  String get pairTextMissingPrefix => '缺少 nekopair: 前缀';

  @override
  String get pairTextMissingVersion => '缺少版本段';

  @override
  String get pairTextVersionNotNumber => '版本段不是数字';

  @override
  String pairTextUnsupportedVersion(int version) {
    return '不支持的配对版本 $version';
  }

  @override
  String get pairTextNotObject => 'JSON 必须是对象';

  @override
  String get pairTextBadPayload => 'base64url、UTF-8 或 JSON 不合法';

  @override
  String get pairTextSidInvalid => 'sid 缺失或不是字符串';

  @override
  String get pairTextNameInvalid => 'name 缺失或超过 64 字符';

  @override
  String get pairTextEndpointInvalid =>
      'ep 必须是 https://IPv4字面量:端口，不允许 userinfo/query/fragment/path';

  @override
  String get pairTextFingerprintInvalid => 'fp 必须是 64 位十六进制';

  @override
  String get pairTextCodeMissing => 'code 缺失或不是字符串';

  @override
  String get pairTextCodeLength => 'code 必须是 32 字节 base64url';

  @override
  String get pairTextCodeEncoding => 'code 不是合法 base64url';

  @override
  String get pairTextExpInvalid => 'exp 必须是正整数 Unix 毫秒';

  @override
  String get pairTextExpired => '配对码已过期';

  @override
  String get pairRejected => '请求被电脑拒绝';

  @override
  String get pairWrongServer => '电脑标识不一致，请确认二维码来自目标电脑';

  @override
  String get pairCodeUsed => '配对码已被使用，请重新扫码';

  @override
  String get pairCodeExpired => '配对码已过期，请重新扫码';

  @override
  String get pairPayloadTooLarge => '电脑无法处理该请求';

  @override
  String get pairRateLimited => '尝试过于频繁，请稍后再试';

  @override
  String get pairResponseUnrecognized => '电脑返回了无法识别的响应';

  @override
  String get pairResponseNotJson => '响应不是合法 JSON';

  @override
  String get pairResponseNotObject => '响应不是 JSON 对象';

  @override
  String pairFieldMismatch(String field) {
    return '$field 与请求不一致';
  }

  @override
  String get pairApiVersionsMissing => 'apiVersions 不含 1';

  @override
  String get pairNetworkFailed => '网络连接失败，请重试';

  @override
  String pairNetworkUnknownStatus(int status) {
    return '电脑返回了未知状态 $status';
  }

  @override
  String get pairNetworkTimeout => '电脑响应超时，请重试';

  @override
  String get pairNetworkInterrupted => '电脑连接中断，请重试';

  @override
  String get pairFailed => '配对失败，请重试';

  @override
  String get scanTitle => '连接电脑';

  @override
  String get scanCameraUnavailable => '相机不可用或权限被拒绝，可在系统设置中开启相机权限。';

  @override
  String get scanOpenSettings => '打开应用设置';

  @override
  String get scanRetryCamera => '重试相机';

  @override
  String scanConfirmTitle(String name) {
    return '连接 $name？';
  }

  @override
  String scanFingerprint(String fingerprint) {
    return '证书指纹 $fingerprint…';
  }

  @override
  String get scanConfirmPair => '确认连接';

  @override
  String get scanPasteLabel => '粘贴配对文本';

  @override
  String get scanPairButton => '配对';

  @override
  String get computersTitle => '电脑与设置';

  @override
  String get computersPaired => '已配对的电脑';

  @override
  String computersForgetTitle(String name) {
    return '忘记「$name」？';
  }

  @override
  String get computersForgetBody => '将删除本机保存的凭据；再次控制需要重新扫码。电脑上的任务不受影响。';

  @override
  String get computersForget => '忘记';

  @override
  String get computersForgetTooltip => '忘记这台电脑';

  @override
  String get pairNewComputer => '扫码配对新电脑';

  @override
  String get drawerSectionComputers => '电脑';

  @override
  String get drawerComputersSettings => '电脑管理与设置';

  @override
  String get connOnline => '在线';

  @override
  String get connConnecting => '连接中';

  @override
  String get connReconnecting => '重连中';

  @override
  String get connOffline => '离线';

  @override
  String get connIdle => '未连接';

  @override
  String get connNeedsRepair => '需要重新配对';

  @override
  String get connRestoring => '正在恢复连接…';

  @override
  String get connRetryNow => '立即重试';

  @override
  String get connRescan => '重新扫码配对';

  @override
  String get homeConnecting => '正在连接电脑…';

  @override
  String get homeRevokedTitle => '设备授权已被电脑撤销';

  @override
  String get homeRevokedGuidance => '电脑端已移除本设备。如需重新控制，请重新扫码配对。';

  @override
  String get homeTrustChangedGuidance => '电脑可能重新生成了证书。请重新扫码配对以建立信任。';

  @override
  String get homeIncompatibleTitle => '应用与电脑协议版本不兼容';

  @override
  String get homeIncompatibleGuidance => '请升级手机应用或电脑端后重试。';

  @override
  String get homeIdleText => '尚未连接电脑';

  @override
  String get homeScanConnect => '扫码连接';

  @override
  String get homeBackToScan => '返回扫码';

  @override
  String get homeOfflineText => '网络不可达或电脑已离线';

  @override
  String homeOfflineRetry(String seconds) {
    return '$seconds 秒后自动重试';
  }

  @override
  String get homeOfflineHint => '电脑上的任务不受影响，恢复后自动继续。';

  @override
  String homeConnected(String name) {
    return '已连接 $name';
  }

  @override
  String get chatSwitchSession => '切换会话';

  @override
  String get sessionNewTitle => '新会话';

  @override
  String get sessionNew => '新建会话';

  @override
  String get chatWaitingForAnswer => '等待你的回答';

  @override
  String get chatRunning => '运行中…';

  @override
  String get chatNoWorkspaces => '电脑上还没有登记工作区，请先在电脑端添加。';

  @override
  String get chatSelectOrCreate => '选择一个会话或新建会话';

  @override
  String get chatLoadFailed => '加载会话失败';

  @override
  String get connRevoked => '授权已撤销';

  @override
  String get connCertChanged => '证书已变更';

  @override
  String get connIncompatible => '版本不兼容';

  @override
  String connBannerOffline(int seconds) {
    return '电脑暂不可达，$seconds 秒后重试；电脑上的任务不受影响';
  }

  @override
  String get connReconnectNow => '立即重连';

  @override
  String get connBannerRevoked => '设备授权已被电脑撤销，请重新扫码配对';

  @override
  String get connRepair => '重新配对';

  @override
  String get connBannerTrustChanged => '电脑证书已变更，请重新扫码配对';

  @override
  String get connBannerIncompatible => '应用与电脑协议版本不兼容，请升级后重试';

  @override
  String get chatSteer => '引导';

  @override
  String get chatQueued => '排队';

  @override
  String get chatImagesOnly => '（仅图片）';

  @override
  String get chatWithdrawing => '撤回中';

  @override
  String get chatWithdraw => '撤回';

  @override
  String chatPendingLabel(String text) {
    return '待确认：$text';
  }

  @override
  String get chatDiscard => '放弃';

  @override
  String get chatQuestionHintShort => '消息会排队，回答后才处理';

  @override
  String get chatQuestionHintLong => '助手正在等待你的回答；此处发送的消息会排队，回答后才处理。';

  @override
  String get chatAnswerQuestion => '回答问题';

  @override
  String get chatHintOffline => '未连接，可继续编辑草稿';

  @override
  String get chatHintWaiting => '消息会排队，回答问题后才处理';

  @override
  String get chatHintBusy => '回答结束后排队处理，可在上方排队条引导或撤回';

  @override
  String get chatHintIdle => '发消息给 Agent';

  @override
  String get chatStop => '停止当前运行';

  @override
  String get chatQueue => '排队';

  @override
  String get chatSend => '发送';

  @override
  String get chatNoticeSteerWithdrawn => '无法改为引导，消息已撤回到输入框';

  @override
  String get chatNoticeNotQueued => '该消息已不在队列中';

  @override
  String get chatNoticeAlreadySentSteer => '该消息已发送，无法引导';

  @override
  String get chatNoticeImagesNotRestored => '图片未恢复，请重新添加';

  @override
  String get chatNoticeAlreadySentWithdraw => '该消息已发送，无法撤回';

  @override
  String get interactionsNoReceiptAnswer =>
      '未收到电脑的回执：回答可能已送达，也可能没有。恢复连接后请先查看问题状态，再决定是否重新提交。';

  @override
  String get interactionsNoReceiptPlan =>
      '未收到电脑的回执：决定可能已送达，也可能没有。恢复连接后请先查看计划状态，再决定是否重新提交。';

  @override
  String get interactionsSettledElsewhere => '其他设备已先处理，以下是实际结果。';

  @override
  String get interactionsQuestionGone => '该问题已不存在或已结束';

  @override
  String get questionProblemEmpty => '请选择选项，或填写文字。';

  @override
  String questionProblemTooManyOptions(int max) {
    return '最多选择 $max 项。';
  }

  @override
  String get questionProblemDuplicate => '选项被重复选择。';

  @override
  String get questionProblemOptionGone => '选项已失效，请重新打开问题。';

  @override
  String get questionProblemNoOptions => '此问题没有选项。';

  @override
  String get questionProblemSingleOnly => '此问题只能选择一项。';

  @override
  String questionProblemTextTooLong(int length, int limit) {
    return '文字过长（$length/$limit，按 UTF-16 码元计）。';
  }

  @override
  String questionProblemTooLarge(int limit) {
    return '回答内容过大（上限 $limit 字节），请精简文字。';
  }

  @override
  String get planProblemEmpty => '请填写修改意见。';

  @override
  String planProblemTooLong(int length, int limit) {
    return '修改意见过长（$length/$limit，按 UTF-16 码元计）。';
  }

  @override
  String get commonSubmitting => '提交中…';

  @override
  String get separatorClause => '，';

  @override
  String get separatorList => '、';

  @override
  String approvalBarCount(int count) {
    return '$count 个命令等待审批';
  }

  @override
  String approvalSubagentTitle(int taskId) {
    return '子 agent #$taskId';
  }

  @override
  String approvalCwd(String cwd) {
    return '目录：$cwd';
  }

  @override
  String approvalTimeout(int seconds) {
    return '超时：$seconds 秒';
  }

  @override
  String get approvalAllowed => '已允许';

  @override
  String get approvalDenied => '已拒绝';

  @override
  String get approvalCancelled => '任务已停止，命令未执行';

  @override
  String get approvalStillWaiting => '仍在等待（可能已被其他端处理，请刷新）';

  @override
  String get approvalDeny => '拒绝';

  @override
  String get approvalAllowOnce => '允许本次';

  @override
  String get todoStatusPending => '待办';

  @override
  String get todoStatusInProgress => '进行中';

  @override
  String get todoStatusCompleted => '已完成';

  @override
  String todoProgressLabel(int completed, int total) {
    return '待办进度 $completed/$total';
  }

  @override
  String todoStale(String label) {
    return '$label（非最新）';
  }

  @override
  String get todoTitle => '待办';

  @override
  String todoTitleProgress(int completed, int total) {
    return '待办 · 已完成 $completed/$total';
  }

  @override
  String get todoOffline => '当前离线：显示的是上次加载的待办，不一定是最新状态。';

  @override
  String get todoRefreshing => '正在更新待办…';

  @override
  String get todoEmpty => '当前没有待办';

  @override
  String todoItemSemantics(String status, String text) {
    return '$status：$text';
  }

  @override
  String todoSummaryUpdate(int completed, int total, int revision) {
    return '更新 todo · 已完成 $completed/$total（修订 $revision）';
  }

  @override
  String todoSummaryRead(int completed, int total, int revision) {
    return '读取 todo · 已完成 $completed/$total（修订 $revision）';
  }

  @override
  String get subagentStopTitle => '停止这一轮？';

  @override
  String subagentStopBody(String title) {
    return '只停止「$title」的当前轮次，主会话与其他子 agent 继续运行。';
  }

  @override
  String get subagentStop => '停止';

  @override
  String get subagentForkedReadonly => '分叉历史（只读）';

  @override
  String get subagentIdle => '空闲';

  @override
  String get subagentStopTooltip => '停止当前轮';

  @override
  String subagentUsageTotal(String tokens) {
    return '累计 $tokens tokens';
  }

  @override
  String subagentRound(int round, String status) {
    return '第 $round 轮 · $status';
  }

  @override
  String get subagentEmpty => '子 agent 还没有输出';

  @override
  String get subagentReload => '重新加载';

  @override
  String get sessionsSearchHint => '搜索标题或首条消息';

  @override
  String get sessionsEmpty => '还没有会话';

  @override
  String get sessionsNoMatch => '没有匹配的会话';

  @override
  String get sessionAwaitingAnswer => '等待回答';

  @override
  String get sessionAwaitingApproval => '等待批准';

  @override
  String get relTimeNow => '刚刚';

  @override
  String relTimeMinutes(int count) {
    return '$count 分钟前';
  }

  @override
  String relTimeHours(int count) {
    return '$count 小时前';
  }

  @override
  String relTimeDays(int count) {
    return '$count 天前';
  }

  @override
  String get datePattern => 'yyyy-MM-dd';

  @override
  String get planStatusAwaiting => '等待批准';

  @override
  String get planStatusApproved => '已批准';

  @override
  String get planStatusRevisionRequested => '已要求修改';

  @override
  String get planStatusSuperseded => '已被取代';

  @override
  String get planStatusCancelled => '已取消';

  @override
  String planBarSemantics(String label, String title) {
    return '$label：$title';
  }

  @override
  String get planHeader => '助手提交的计划';

  @override
  String get planCloseTooltip => '关闭（计划仍在等待批准）';

  @override
  String get planGone => '没有待批准的计划。';

  @override
  String get planOffline => '当前离线：暂时无法提交，恢复连接后会重新读取计划状态，不会自动发送决定。';

  @override
  String get planFeedbackLabel => '修改意见';

  @override
  String get planSubmitFeedback => '提交修改意见';

  @override
  String get planApprove => '批准并执行';

  @override
  String get planRevise => '要求修改';

  @override
  String get planExit => '取消并退出计划模式';

  @override
  String get planDetailApproved => '计划已批准，会话在电脑上开始执行。';

  @override
  String get planDetailRevisionRequested => '已要求修改，助手会按意见重新提交计划。';

  @override
  String get planDetailSuperseded => '收到了新的输入，这份计划不再需要批准。';

  @override
  String get planDetailCancelled => '运行已停止或会话已归档，计划不再需要批准。';

  @override
  String planFinalFeedback(String feedback) {
    return '修改意见：$feedback';
  }

  @override
  String get questionStatusPending => '等待回答';

  @override
  String get questionStatusAnswered => '已回答';

  @override
  String get questionStatusSkipped => '已跳过';

  @override
  String get questionStatusCancelled => '已取消';

  @override
  String questionBarSemantics(int count) {
    return '等待回答 $count 个问题';
  }

  @override
  String questionBarCount(int count) {
    return '等待回答 · $count';
  }

  @override
  String get questionHeader => '助手提问';

  @override
  String get questionPrevious => '上一题';

  @override
  String get questionNext => '下一题';

  @override
  String get questionCloseTooltip => '关闭（问题仍在等待回答）';

  @override
  String get questionOffline => '当前离线：暂时无法提交，恢复连接后会重新读取问题状态，不会自动发送答案。';

  @override
  String get questionMultipleSemantics => '多选，可选择多个选项';

  @override
  String get questionSingleSemantics => '单选，只能选择一个选项';

  @override
  String get questionMultipleMode => '可多选';

  @override
  String get questionSingleMode => '单选';

  @override
  String get questionNoteOptional => '补充说明（可选）';

  @override
  String get questionYourAnswer => '你的回答';

  @override
  String get questionSkip => '跳过';

  @override
  String get questionSubmit => '提交回答';

  @override
  String get questionRecommended => '推荐';

  @override
  String get questionDetailSkipped => '已跳过，未提供答案。';

  @override
  String get questionDetailCancelled => '运行已停止或会话已归档，问题不再需要回答。';

  @override
  String questionFinalOptions(String options) {
    return '选择：$options';
  }

  @override
  String questionFinalText(String text) {
    return '文字：$text';
  }

  @override
  String get transcriptEmpty => '还没有消息';

  @override
  String get transcriptToBottom => '回到底部';

  @override
  String get transcriptThinking => '思考中…';

  @override
  String get transcriptThinkingProcess => '思考过程';

  @override
  String transcriptExpand(int kb) {
    return '展开全文（$kb KB）';
  }

  @override
  String transcriptDiffSummary(int added, int removed) {
    return '+$added −$removed';
  }

  @override
  String transcriptDiffSummaryTruncated(int added, int removed) {
    return '+$added −$removed（diff 已截断）';
  }

  @override
  String transcriptSubagentTitle(String title) {
    return '子 agent · $title';
  }

  @override
  String get transcriptViewSubagent => '查看子 agent';

  @override
  String transcriptOptionRecommended(String label) {
    return '$label（推荐）';
  }

  @override
  String transcriptAnswered(String answer) {
    return '已回答：$answer';
  }

  @override
  String get transcriptNoContent => '（无内容）';

  @override
  String get transcriptSkippedNoAnswer => '已跳过，未提供答案';

  @override
  String get transcriptViewQuestion => '查看问题';

  @override
  String transcriptImageLabel(String name) {
    return '图片 $name';
  }

  @override
  String get transcriptReloadImage => '重新加载图片';

  @override
  String markdownImage(String alt) {
    return '[图片 $alt]';
  }
}
