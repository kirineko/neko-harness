// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get commonCancel => 'Cancel';

  @override
  String get commonClose => 'Close';

  @override
  String get commonRetry => 'Retry';

  @override
  String get commonBack => 'Back';

  @override
  String get appearanceTitle => 'Appearance';

  @override
  String get themeAuto => 'Auto';

  @override
  String get themeFollowSystem => 'Follow system';

  @override
  String get themeLight => 'Light';

  @override
  String get themeDark => 'Dark';

  @override
  String get languageTitle => 'Language';

  @override
  String get languageZh => '中文';

  @override
  String get languageEn => 'English';

  @override
  String get statusThinking => 'Thinking…';

  @override
  String statusRunning(String tool) {
    return 'Running $tool…';
  }

  @override
  String statusRetrying(int attempt) {
    return 'Retrying (attempt $attempt)…';
  }

  @override
  String get systemContextCompacted => '[Context compacted]';

  @override
  String get systemNewContext => '[New context]';

  @override
  String get toolNoteNotRun => 'Not run: response interrupted';

  @override
  String errorProviderDisabled(String provider) {
    return 'PROVIDER_DISABLED: $provider is not enabled. Enable it in /login or Web settings, or switch model';
  }

  @override
  String errorProviderKeyRequired(String provider) {
    return 'PROVIDER_KEY_REQUIRED: Configure a $provider API key in /login or Web settings';
  }

  @override
  String get errorPlanBusy =>
      'PLAN_BUSY: Wait for the current run to finish or stop it first';

  @override
  String apiRejected(String message) {
    return 'The computer rejected the request: $message';
  }

  @override
  String get apiGone =>
      'This session is no longer available, select another one';

  @override
  String get apiUnauthorized => 'Device authorization is no longer valid';

  @override
  String get apiBusyLimit => 'Too many requests, try again later';

  @override
  String get apiNotFound => 'Not found or already ended';

  @override
  String apiInvalidParams(String message) {
    return 'Invalid request: $message';
  }

  @override
  String get apiFailed =>
      'The computer failed to handle the request, try again';

  @override
  String get errorGeneric => 'Operation failed, try again';

  @override
  String get certificateMismatch =>
      'The computer certificate does not match the pairing fingerprint';

  @override
  String get rpcUnauthorized => 'The computer rejected this device (401)';

  @override
  String get rpcRevoked => 'Device authorization was revoked by the computer';

  @override
  String get rpcIncompatible => 'Incompatible protocol version';

  @override
  String get rpcNetwork => 'Network connection failed';

  @override
  String get protocolHelloInvalid => 'Invalid hello response';

  @override
  String get protocolHelloNotObject => 'The hello result is not an object';

  @override
  String protocolHelloError(String message) {
    return 'server.hello returned an error: $message';
  }

  @override
  String protocolConnectFailed(String type) {
    return 'Connection failed: $type';
  }

  @override
  String protocolFieldInvalid(String field) {
    return 'Invalid $field';
  }

  @override
  String get pairTextMissingPrefix => 'Missing nekopair: prefix';

  @override
  String get pairTextMissingVersion => 'Missing version segment';

  @override
  String get pairTextVersionNotNumber => 'The version segment is not a number';

  @override
  String pairTextUnsupportedVersion(int version) {
    return 'Unsupported pairing version $version';
  }

  @override
  String get pairTextNotObject => 'JSON must be an object';

  @override
  String get pairTextBadPayload => 'Invalid base64url, UTF-8 or JSON';

  @override
  String get pairTextSidInvalid => 'sid is missing or not a string';

  @override
  String get pairTextNameInvalid =>
      'name is missing or longer than 64 characters';

  @override
  String get pairTextEndpointInvalid =>
      'ep must be https://IPv4-literal:port, without userinfo, query, fragment or path';

  @override
  String get pairTextFingerprintInvalid => 'fp must be 64 hex characters';

  @override
  String get pairTextCodeMissing => 'code is missing or not a string';

  @override
  String get pairTextCodeLength => 'code must be 32 bytes of base64url';

  @override
  String get pairTextCodeEncoding => 'code is not valid base64url';

  @override
  String get pairTextExpInvalid =>
      'exp must be a positive Unix timestamp in milliseconds';

  @override
  String get pairTextExpired => 'Pairing code expired';

  @override
  String get pairRejected => 'The computer rejected the request';

  @override
  String get pairWrongServer =>
      'Computer ID mismatch, check that the QR code comes from the target computer';

  @override
  String get pairCodeUsed => 'Pairing code already used, scan again';

  @override
  String get pairCodeExpired => 'Pairing code expired, scan again';

  @override
  String get pairPayloadTooLarge => 'The computer cannot handle this request';

  @override
  String get pairRateLimited => 'Too many attempts, try again later';

  @override
  String get pairResponseUnrecognized =>
      'The computer returned an unrecognized response';

  @override
  String get pairResponseNotJson => 'The response is not valid JSON';

  @override
  String get pairResponseNotObject => 'The response is not a JSON object';

  @override
  String pairFieldMismatch(String field) {
    return '$field does not match the request';
  }

  @override
  String get pairApiVersionsMissing => 'apiVersions does not include 1';

  @override
  String get pairNetworkFailed => 'Network connection failed, try again';

  @override
  String pairNetworkUnknownStatus(int status) {
    return 'The computer returned an unknown status $status';
  }

  @override
  String get pairNetworkTimeout => 'The computer timed out, try again';

  @override
  String get pairNetworkInterrupted =>
      'The connection to the computer was interrupted, try again';

  @override
  String get pairFailed => 'Pairing failed, try again';

  @override
  String get scanTitle => 'Connect computer';

  @override
  String get scanCameraUnavailable =>
      'Camera unavailable or permission denied, enable camera access in system settings';

  @override
  String get scanOpenSettings => 'Open app settings';

  @override
  String get scanRetryCamera => 'Retry camera';

  @override
  String scanConfirmTitle(String name) {
    return 'Connect to $name?';
  }

  @override
  String scanFingerprint(String fingerprint) {
    return 'Certificate fingerprint $fingerprint…';
  }

  @override
  String get scanConfirmPair => 'Confirm and connect';

  @override
  String get scanPasteLabel => 'Paste pairing text';

  @override
  String get scanPairButton => 'Pair';

  @override
  String get computersTitle => 'Computers and settings';

  @override
  String get computersPaired => 'Paired computers';

  @override
  String computersForgetTitle(String name) {
    return 'Forget “$name”?';
  }

  @override
  String get computersForgetBody =>
      'This deletes the credentials saved on this device, and you need to scan again to control the computer. Tasks on the computer are not affected';

  @override
  String get computersForget => 'Forget';

  @override
  String get computersForgetTooltip => 'Forget this computer';

  @override
  String get pairNewComputer => 'Scan to pair a new computer';

  @override
  String get drawerSectionComputers => 'Computers';

  @override
  String get drawerComputersSettings => 'Computers and settings';

  @override
  String get connOnline => 'Online';

  @override
  String get connConnecting => 'Connecting';

  @override
  String get connReconnecting => 'Reconnecting';

  @override
  String get connOffline => 'Offline';

  @override
  String get connIdle => 'Not connected';

  @override
  String get connNeedsRepair => 'Re-pairing required';

  @override
  String get connRestoring => 'Restoring connection…';

  @override
  String get connRetryNow => 'Retry now';

  @override
  String get connRescan => 'Scan to pair again';

  @override
  String get homeConnecting => 'Connecting to computer…';

  @override
  String get homeRevokedTitle =>
      'Device authorization was revoked by the computer';

  @override
  String get homeRevokedGuidance =>
      'The computer removed this device. Scan the QR code again to pair';

  @override
  String get homeTrustChangedGuidance =>
      'The computer may have regenerated its certificate. Scan the QR code again to re-establish trust';

  @override
  String get homeIncompatibleTitle =>
      'The app and the computer use incompatible protocol versions';

  @override
  String get homeIncompatibleGuidance =>
      'Upgrade the mobile app or the computer, then try again';

  @override
  String get homeIdleText => 'Not connected to a computer';

  @override
  String get homeScanConnect => 'Scan to connect';

  @override
  String get homeBackToScan => 'Back to scan';

  @override
  String get homeOfflineText => 'Network unreachable or computer offline';

  @override
  String homeOfflineRetry(String seconds) {
    return 'Retrying in $seconds s';
  }

  @override
  String get homeOfflineHint =>
      'Tasks on the computer are not affected and continue after recovery';

  @override
  String homeConnected(String name) {
    return 'Connected to $name';
  }

  @override
  String get chatSwitchSession => 'Switch session';

  @override
  String get sessionNewTitle => 'New session';

  @override
  String get sessionNew => 'New session';

  @override
  String get chatWaitingForAnswer => 'Waiting for your answer';

  @override
  String get chatRunning => 'Running…';

  @override
  String get chatNoWorkspaces =>
      'No workspaces are registered on the computer, add one on the computer first';

  @override
  String get chatSelectOrCreate => 'Select a session or create a new one';

  @override
  String get chatLoadFailed => 'Failed to load the session';

  @override
  String get connRevoked => 'Authorization revoked';

  @override
  String get connCertChanged => 'Certificate changed';

  @override
  String get connIncompatible => 'Incompatible version';

  @override
  String connBannerOffline(int seconds) {
    return 'Computer unreachable, retrying in $seconds s. Tasks on the computer are not affected';
  }

  @override
  String get connReconnectNow => 'Reconnect now';

  @override
  String get connBannerRevoked =>
      'Device authorization was revoked by the computer, scan the QR code again to pair';

  @override
  String get connRepair => 'Pair again';

  @override
  String get connBannerTrustChanged =>
      'The computer certificate changed, scan the QR code again to pair';

  @override
  String get connBannerIncompatible =>
      'The app and the computer use incompatible protocol versions, upgrade and try again';

  @override
  String get chatSteer => 'Steer';

  @override
  String get chatQueued => 'Queued';

  @override
  String get chatImagesOnly => '(images only)';

  @override
  String get chatWithdrawing => 'Withdrawing';

  @override
  String get chatWithdraw => 'Withdraw';

  @override
  String chatPendingLabel(String text) {
    return 'Unconfirmed: $text';
  }

  @override
  String get chatDiscard => 'Discard';

  @override
  String get chatQuestionHintShort => 'Messages are queued until you answer';

  @override
  String get chatQuestionHintLong =>
      'The assistant is waiting for your answer. Messages sent here are queued until you answer';

  @override
  String get chatAnswerQuestion => 'Answer';

  @override
  String get chatHintOffline => 'Not connected, you can keep editing the draft';

  @override
  String get chatHintWaiting =>
      'Messages are queued until you answer the question';

  @override
  String get chatHintBusy =>
      'Queued until the answer ends, steer or withdraw from the queue above';

  @override
  String get chatHintIdle => 'Message the Agent';

  @override
  String get chatStop => 'Stop the current run';

  @override
  String get chatQueue => 'Queue';

  @override
  String get chatSend => 'Send';

  @override
  String get chatNoticeSteerWithdrawn =>
      'Could not steer, the message was moved back to the input box';

  @override
  String get chatNoticeNotQueued => 'The message is no longer in the queue';

  @override
  String get chatNoticeAlreadySentSteer =>
      'The message was already sent and cannot be steered';

  @override
  String get chatNoticeImagesNotRestored =>
      'Images were not restored, add them again';

  @override
  String get chatNoticeAlreadySentWithdraw =>
      'The message was already sent and cannot be withdrawn';

  @override
  String get interactionsNoReceiptAnswer =>
      'No receipt from the computer: your answer may or may not have been delivered. After the connection recovers, check the question status before deciding to submit again';

  @override
  String get interactionsNoReceiptPlan =>
      'No receipt from the computer: your decision may or may not have been delivered. After the connection recovers, check the plan status before deciding to submit again';

  @override
  String get interactionsSettledElsewhere =>
      'Another device handled it first, the actual result is shown below';

  @override
  String get interactionsQuestionGone =>
      'This question no longer exists or has ended';

  @override
  String get questionProblemEmpty => 'Select an option or enter text';

  @override
  String questionProblemTooManyOptions(int max) {
    return 'Select at most $max options';
  }

  @override
  String get questionProblemDuplicate =>
      'An option was selected more than once';

  @override
  String get questionProblemOptionGone =>
      'An option is no longer available, reopen the question';

  @override
  String get questionProblemNoOptions => 'This question has no options';

  @override
  String get questionProblemSingleOnly =>
      'This question allows only one option';

  @override
  String questionProblemTextTooLong(int length, int limit) {
    return 'Text is too long ($length/$limit UTF-16 code units)';
  }

  @override
  String questionProblemTooLarge(int limit) {
    return 'The answer is too large (limit $limit bytes), shorten the text';
  }

  @override
  String get planProblemEmpty => 'Enter your revision feedback';

  @override
  String planProblemTooLong(int length, int limit) {
    return 'Feedback is too long ($length/$limit UTF-16 code units)';
  }

  @override
  String get commonSubmitting => 'Submitting…';

  @override
  String get separatorClause => ', ';

  @override
  String get separatorList => ', ';

  @override
  String approvalBarCount(int count) {
    return 'Commands awaiting approval: $count';
  }

  @override
  String approvalSubagentTitle(int taskId) {
    return 'Sub-agent #$taskId';
  }

  @override
  String approvalCwd(String cwd) {
    return 'Directory: $cwd';
  }

  @override
  String approvalTimeout(int seconds) {
    return 'Timeout: $seconds s';
  }

  @override
  String get approvalAllowed => 'Allowed';

  @override
  String get approvalDenied => 'Denied';

  @override
  String get approvalCancelled =>
      'The task was stopped and the command did not run';

  @override
  String get approvalStillWaiting =>
      'Still waiting (another device may have handled it, refresh)';

  @override
  String get approvalDeny => 'Deny';

  @override
  String get approvalAllowOnce => 'Allow once';

  @override
  String get todoStatusPending => 'To do';

  @override
  String get todoStatusInProgress => 'In progress';

  @override
  String get todoStatusCompleted => 'Completed';

  @override
  String todoProgressLabel(int completed, int total) {
    return 'To-do progress $completed/$total';
  }

  @override
  String todoStale(String label) {
    return '$label (outdated)';
  }

  @override
  String get todoTitle => 'To-do';

  @override
  String todoTitleProgress(int completed, int total) {
    return 'To-do · $completed/$total completed';
  }

  @override
  String get todoOffline =>
      'Offline: showing the last loaded to-do list, which may be outdated';

  @override
  String get todoRefreshing => 'Updating the to-do list…';

  @override
  String get todoEmpty => 'No to-do items';

  @override
  String todoItemSemantics(String status, String text) {
    return '$status: $text';
  }

  @override
  String todoSummaryUpdate(int completed, int total, int revision) {
    return 'Update todo · $completed/$total completed (revision $revision)';
  }

  @override
  String todoSummaryRead(int completed, int total, int revision) {
    return 'Read todo · $completed/$total completed (revision $revision)';
  }

  @override
  String get subagentStopTitle => 'Stop this round?';

  @override
  String subagentStopBody(String title) {
    return 'Only the current round of “$title” stops. The main session and other sub-agents keep running';
  }

  @override
  String get subagentStop => 'Stop';

  @override
  String get subagentForkedReadonly => 'Forked history (read-only)';

  @override
  String get subagentIdle => 'Idle';

  @override
  String get subagentStopTooltip => 'Stop the current round';

  @override
  String subagentUsageTotal(String tokens) {
    return 'Total $tokens tokens';
  }

  @override
  String subagentRound(int round, String status) {
    return 'Round $round · $status';
  }

  @override
  String get subagentEmpty => 'The sub-agent has no output yet';

  @override
  String get subagentReload => 'Reload';

  @override
  String get sessionsSearchHint => 'Search titles or first messages';

  @override
  String get sessionsEmpty => 'No sessions yet';

  @override
  String get sessionsNoMatch => 'No matching sessions';

  @override
  String get sessionAwaitingAnswer => 'Awaiting answer';

  @override
  String get sessionAwaitingApproval => 'Awaiting approval';

  @override
  String get relTimeNow => 'now';

  @override
  String relTimeMinutes(int count) {
    return '${count}m';
  }

  @override
  String relTimeHours(int count) {
    return '${count}h';
  }

  @override
  String relTimeDays(int count) {
    return '${count}d';
  }

  @override
  String get datePattern => 'dd/MM/yyyy';

  @override
  String get planStatusAwaiting => 'Awaiting approval';

  @override
  String get planStatusApproved => 'Approved';

  @override
  String get planStatusRevisionRequested => 'Revision requested';

  @override
  String get planStatusSuperseded => 'Superseded';

  @override
  String get planStatusCancelled => 'Cancelled';

  @override
  String planBarSemantics(String label, String title) {
    return '$label: $title';
  }

  @override
  String get planHeader => 'Plan from the assistant';

  @override
  String get planCloseTooltip => 'Close (the plan is still awaiting approval)';

  @override
  String get planGone => 'No plan is awaiting approval';

  @override
  String get planOffline =>
      'Offline: cannot submit for now. After the connection recovers the plan status is read again, and no decision is sent automatically';

  @override
  String get planFeedbackLabel => 'Revision feedback';

  @override
  String get planSubmitFeedback => 'Submit feedback';

  @override
  String get planApprove => 'Approve and run';

  @override
  String get planRevise => 'Request changes';

  @override
  String get planExit => 'Cancel and exit plan mode';

  @override
  String get planDetailApproved =>
      'Plan approved, the session starts running on the computer';

  @override
  String get planDetailRevisionRequested =>
      'Changes requested, the assistant will submit the plan again based on your feedback';

  @override
  String get planDetailSuperseded =>
      'New input arrived, this plan no longer needs approval';

  @override
  String get planDetailCancelled =>
      'The run was stopped or the session was archived, this plan no longer needs approval';

  @override
  String planFinalFeedback(String feedback) {
    return 'Feedback: $feedback';
  }

  @override
  String get questionStatusPending => 'Awaiting answer';

  @override
  String get questionStatusAnswered => 'Answered';

  @override
  String get questionStatusSkipped => 'Skipped';

  @override
  String get questionStatusCancelled => 'Cancelled';

  @override
  String questionBarSemantics(int count) {
    return 'Questions awaiting an answer: $count';
  }

  @override
  String questionBarCount(int count) {
    return 'Awaiting answer · $count';
  }

  @override
  String get questionHeader => 'Question from the assistant';

  @override
  String get questionPrevious => 'Previous';

  @override
  String get questionNext => 'Next';

  @override
  String get questionCloseTooltip =>
      'Close (the question is still awaiting an answer)';

  @override
  String get questionOffline =>
      'Offline: cannot submit for now. After the connection recovers the question status is read again, and no answer is sent automatically';

  @override
  String get questionMultipleSemantics =>
      'Multiple choice, select one or more options';

  @override
  String get questionSingleSemantics => 'Single choice, select one option';

  @override
  String get questionMultipleMode => 'Multiple choice';

  @override
  String get questionSingleMode => 'Single choice';

  @override
  String get questionNoteOptional => 'Additional notes (optional)';

  @override
  String get questionYourAnswer => 'Your answer';

  @override
  String get questionSkip => 'Skip';

  @override
  String get questionSubmit => 'Submit answer';

  @override
  String get questionRecommended => 'Recommended';

  @override
  String get questionDetailSkipped => 'Skipped, no answer provided';

  @override
  String get questionDetailCancelled =>
      'The run was stopped or the session was archived, this question no longer needs an answer';

  @override
  String questionFinalOptions(String options) {
    return 'Selected: $options';
  }

  @override
  String questionFinalText(String text) {
    return 'Text: $text';
  }

  @override
  String get transcriptEmpty => 'No messages yet';

  @override
  String get transcriptToBottom => 'Back to bottom';

  @override
  String get transcriptThinking => 'Thinking…';

  @override
  String get transcriptThinkingProcess => 'Thinking process';

  @override
  String transcriptExpand(int kb) {
    return 'Show full text ($kb KB)';
  }

  @override
  String transcriptDiffSummary(int added, int removed) {
    return '+$added −$removed';
  }

  @override
  String transcriptDiffSummaryTruncated(int added, int removed) {
    return '+$added −$removed (diff truncated)';
  }

  @override
  String transcriptCodemodeCalls(int count) {
    return 'Tool calls ($count)';
  }

  @override
  String transcriptCodemodeMore(int count) {
    return '$count more not shown';
  }

  @override
  String transcriptCodemodeFullOutput(String path) {
    return 'Full output: $path';
  }

  @override
  String transcriptSubagentTitle(String title) {
    return 'Sub-agent · $title';
  }

  @override
  String get transcriptViewSubagent => 'View sub-agent';

  @override
  String transcriptOptionRecommended(String label) {
    return '$label (recommended)';
  }

  @override
  String transcriptAnswered(String answer) {
    return 'Answered: $answer';
  }

  @override
  String get transcriptNoContent => '(no content)';

  @override
  String get transcriptSkippedNoAnswer => 'Skipped, no answer provided';

  @override
  String get transcriptViewQuestion => 'View question';

  @override
  String transcriptImageLabel(String name) {
    return 'Image $name';
  }

  @override
  String get transcriptReloadImage => 'Reload image';

  @override
  String markdownImage(String alt) {
    return '[Image $alt]';
  }
}
