import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/features/subagents/subagent_page.dart';
import 'package:neko_mobile/l10n/l10n.dart';

import '../helpers/chat_harness.dart';
import '../helpers/fake_api.dart';
import '../helpers/interaction_data.dart';
import '../helpers/interaction_ui.dart';
import '../helpers/l10n_support.dart';

/// 会话列表接口返回的标题与预览属于数据，不随界面语言翻译。
const List<String> _sessionData = <String>['修复登录页', '登录页按钮错位'];

Map<String, dynamic> _round({String status = 'running'}) => <String, dynamic>{
  'taskId': 9,
  'callId': 'call_9',
  'agentId': 'agent-4',
  'round': 1,
  'role': 'explore',
  'title': 'Check tests',
  'status': status,
  'approvalCount': 1,
  'readonly': false,
  'createdAt': 0,
  'endedAt': null,
};

Map<String, dynamic> _approval() => <String, dynamic>{
  'id': 31,
  'version': 'v1',
  'taskId': 9,
  'agentId': 'agent-4',
  // 不带标题：回退到本地化的“子 agent #id”。
  'command': 'bun test',
  'cwd': '/a/neko',
  'timeoutSeconds': 120,
  'requestedAt': 0,
};

/// 忙碌快照；status 用 core 真实下发的英文串（测试夹具默认的中文状态不是 core 会发的）。
Map<String, dynamic> _busy(
  List<Map<String, dynamic>> items, {
  List<Map<String, dynamic>> subagents = const <Map<String, dynamic>>[],
  String status = 'Thinking...',
}) => <String, dynamic>{
  ...snapshotOf(items, busy: true, subagents: subagents),
  'status': status,
};

void main() {
  late ChatHarness h;

  setUp(() => h = ChatHarness());
  tearDown(() => h.dispose());

  Future<void> pumpChat(
    WidgetTester tester, {
    Locale locale = kLocaleEn,
    Iterable<String> caps = const <String>[],
    String? draft,
  }) async {
    h.app.locale.value = locale;
    await h.bind(capabilities: caps);
    if (draft != null) h.chat.input.text = draft;
    await tester.pumpWidget(h.build(localized: true));
    await settle(tester);
  }

  group('聊天页', () {
    testWidgets('en：输入框、按钮与无障碍标签是英文，对话内容保持原文', (tester) async {
      final semantics = tester.ensureSemantics();
      h.snapshot = snapshotOf(<Map<String, dynamic>>[
        userItem('u-1', 'Hello'),
        assistantItem('a-2', '你好，有什么可以帮忙？'),
      ]);
      await pumpChat(tester);

      expect(find.text('Message the Agent'), findsOneWidget);
      expect(find.byTooltip('Send'), findsOneWidget);
      expect(
        find.text('你好，有什么可以帮忙？', findRichText: true),
        findsOneWidget,
        reason: '模型回答不翻译',
      );
      expect(
        cjkResidue(tester, data: <String>[..._sessionData, '你好，有什么可以帮忙？']),
        isEmpty,
      );
      expect(
        semanticsLabels(tester).where(
          (l) =>
              hasCjk(l) && !l.contains('你好') && !_sessionData.any(l.contains),
        ),
        isEmpty,
      );
      final labels = semanticsLabels(tester);
      expect(labels.any((l) => l.contains('Switch session')), isTrue);
      expect(labels.any((l) => l.contains('Send')), isTrue);
      semantics.dispose();
    });

    testWidgets('zh：同一页面仍是中文', (tester) async {
      await pumpChat(tester, locale: kLocaleZh);
      expect(find.text('发消息给 Agent'), findsOneWidget);
      expect(find.byTooltip('发送'), findsOneWidget);
      expect(find.text('Message the Agent'), findsNothing);
    });

    testWidgets('切换语言后聊天页立即更新，草稿与内容不变', (tester) async {
      h.snapshot = snapshotOf(<Map<String, dynamic>>[
        userItem('u-1', 'Hello'),
        assistantItem('a-2', 'Hi there'),
      ]);
      await pumpChat(tester, locale: kLocaleZh);
      await tester.enterText(
        find.byKey(const Key('composer-input')),
        'draft text',
      );

      await h.app.setLocale(kLocaleEn);
      await tester.pump();
      await tester.pump();
      expect(find.text('Message the Agent'), findsOneWidget);
      expect(find.text('发消息给 Agent'), findsNothing);
      expect(h.chat.input.text, 'draft text');
      expect(find.text('Hi there', findRichText: true), findsOneWidget);
      await settle(tester);
    });

    testWidgets('运行状态与 core 下发的系统行、补充说明、错误码按语言映射', (tester) async {
      h.snapshot = <String, dynamic>{
        ...snapshotOf(<Map<String, dynamic>>[
          userItem('u-1', 'Hello'),
          <String, dynamic>{
            'key': 's-1',
            'type': 'system',
            'text': '[context compacted]',
          },
          <String, dynamic>{
            ...assistantItem('a-2', 'Partial'),
            'note': 'Not run: response interrupted.',
            'error': 'PROVIDER_KEY_REQUIRED: Configure a DeepSeek API key in /login or Web settings.',
          },
          <String, dynamic>{
            'key': 's-2',
            'type': 'system',
            'text': '[something core added later]',
          },
        ], busy: true),
        'status': 'Running bash...',
      };
      await pumpChat(tester);

      expect(find.text('Running bash…'), findsOneWidget);
      expect(find.text('[Context compacted]'), findsOneWidget);
      expect(find.text('Not run: response interrupted'), findsOneWidget);
      expect(
        find.textContaining(
          'PROVIDER_KEY_REQUIRED: Configure a DeepSeek API key in /login',
        ),
        findsOneWidget,
      );
      expect(
        find.text('[something core added later]'),
        findsOneWidget,
        reason: '未知串回退原文',
      );
      expect(cjkResidue(tester, data: _sessionData), isEmpty);

      await h.app.setLocale(kLocaleZh);
      await tester.pump();
      await tester.pump();
      expect(find.text('运行 bash…'), findsOneWidget);
      expect(find.text('[上下文已压缩]'), findsOneWidget);
      expect(find.text('未执行：回答被中断'), findsOneWidget);
      expect(
        find.textContaining('PROVIDER_KEY_REQUIRED: 请在 /login'),
        findsOneWidget,
      );
      expect(find.text('[something core added later]'), findsOneWidget);
    });

    testWidgets('en：忙碌时的输入提示与停止按钮', (tester) async {
      h.snapshot = snapshotOf(<Map<String, dynamic>>[
        userItem('u-1', 'Run it'),
      ], busy: true);
      await pumpChat(tester);
      expect(
        find.textContaining('Queued until the answer ends'),
        findsOneWidget,
      );
      expect(find.byTooltip('Stop the current run'), findsOneWidget);
    });
  });

  group('会话列表', () {
    testWidgets('en：搜索提示与分组为英文，会话标题保持原文', (tester) async {
      await pumpChat(tester);
      await tester.tap(find.byKey(const Key('open-switcher')));
      await transition(tester);
      expect(find.text('Search titles or first messages'), findsOneWidget);
      expect(find.text('修复登录页'), findsWidgets, reason: '标题是数据');
      expect(cjkResidue(tester, data: _sessionData), isEmpty);
    });

    testWidgets('zh：搜索提示仍为中文', (tester) async {
      await pumpChat(tester, locale: kLocaleZh);
      await tester.tap(find.byKey(const Key('open-switcher')));
      await transition(tester);
      expect(find.text('搜索标题或首条消息'), findsOneWidget);
    });
  });

  group('审批', () {
    Future<void> openApproval(WidgetTester tester, Locale locale) async {
      h.approvals = <Object>[_approval()];
      h.snapshot = _busy(
        <Map<String, dynamic>>[userItem('u-1', 'Run tests')],
        subagents: <Map<String, dynamic>>[_round()],
      );
      await pumpChat(tester, locale: locale);
      await tester.tap(find.byKey(const Key('approval-bar')));
      await transition(tester);
    }

    testWidgets('en：审批条与面板为英文，子 agent 写作 sub-agent，命令与路径原样', (tester) async {
      await openApproval(tester, kLocaleEn);
      expect(find.text('Commands awaiting approval: 1'), findsWidgets);
      expect(find.textContaining('Directory: /a/neko'), findsWidgets);
      expect(find.textContaining('Timeout: 120 s'), findsWidgets);
      expect(find.textContaining('bun test'), findsWidgets);
      expect(find.text('Allow once'), findsWidgets);
      expect(find.text('Deny'), findsWidgets);
      expect(find.textContaining('Sub-agent #9'), findsWidgets);
      expect(cjkResidue(tester, data: _sessionData), isEmpty);
    });

    testWidgets('zh：审批面板仍为中文', (tester) async {
      await openApproval(tester, kLocaleZh);
      expect(find.text('1 个命令等待审批'), findsWidgets);
      expect(find.text('允许本次'), findsWidgets);
      expect(find.textContaining('子 agent #9'), findsWidgets);
    });
  });

  group('待办、提问与计划', () {
    testWidgets('en：待办入口与面板为英文，条目原文保留', (tester) async {
      h.todoList = todoListJson(2, <Map<String, dynamic>>[
        todoItem('1', 'Write tests', 'completed'),
        todoItem('2', '修复登录', 'in_progress'),
        todoItem('3', 'Ship', 'pending'),
      ]);
      await pumpChat(tester, caps: kInteractionCaps);
      await tester.tap(find.byKey(const Key('todo-entry')));
      await transition(tester);
      expect(find.text('To-do · 1/3 completed'), findsOneWidget);
      expect(find.text('Write tests'), findsOneWidget);
      expect(find.text('修复登录'), findsOneWidget);
      expect(
        cjkResidue(tester, data: <String>[..._sessionData, '修复登录']),
        isEmpty,
      );
    });

    testWidgets('en：提问条与面板为英文，问题与选项原文保留', (tester) async {
      withQuestion(
        h,
        questionJson(
          question: 'Which database?',
          options: <Map<String, dynamic>>[
            optionJson('pg', 'PostgreSQL', recommended: true),
            optionJson('lite', 'SQLite', description: 'Embedded, no server'),
          ],
        ),
      );
      await pumpChat(tester, caps: kInteractionCaps, draft: 'draft');
      expect(find.text('Awaiting answer · 1'), findsOneWidget);
      await openQuestionSheet(tester);
      expect(find.text('Question from the assistant'), findsOneWidget);
      expect(find.text('Single choice'), findsOneWidget);
      expect(find.text('Skip'), findsOneWidget);
      expect(find.text('Submit answer'), findsOneWidget);
      expect(
        tester.widget<Text>(find.byKey(const Key('question-text'))).data,
        'Which database?',
      );
      expect(find.text('Recommended'), findsWidgets);
      expect(cjkResidue(tester, data: _sessionData), isEmpty);
    });

    testWidgets('en：计划条与面板为英文，标题、步骤与说明原文保留', (tester) async {
      h.app.locale.value = kLocaleEn;
      final plan = planJson(
        title: 'Add a remember-me switch',
        steps: <String>['Read the login form', 'Add rememberMe', 'Run tests'],
        note: 'Stays off by default.',
      );
      h.planRecords[plan['version'] as String] = plan;
      h.snapshot = snapshotWith(plan: planSummaryJson());
      await h.bind(capabilities: kPlanCaps);
      await tester.pumpWidget(h.build(localized: true));
      await settle(tester);
      expect(find.text('Awaiting approval'), findsOneWidget);
      expect(find.text('Add a remember-me switch'), findsOneWidget);

      await tester.tap(find.byKey(const Key('plan-bar')));
      await transition(tester);
      expect(find.text('Plan from the assistant'), findsOneWidget);
      expect(find.text('Approve and run'), findsOneWidget);
      expect(find.text('Request changes'), findsOneWidget);
      expect(find.text('Cancel and exit plan mode'), findsOneWidget);
      expect(cjkResidue(tester, data: _sessionData), isEmpty);

      await h.app.setLocale(kLocaleZh);
      await transition(tester);
      expect(find.text('助手提交的计划'), findsOneWidget);
      expect(find.text('批准并执行'), findsOneWidget);
      expect(
        find.text('Add a remember-me switch'),
        findsWidgets,
        reason: '计划标题是数据',
      );
    });
  });

  group('子 agent 页', () {
    Future<void> openSubagent(WidgetTester tester, Locale locale) async {
      h.api.on(
        'subagents.open',
        (_) => <String, dynamic>{
          'subagentSubscriptionId': 'sub-1',
          'snapshot': <String, dynamic>{
            ...snapshotOf(
              <Map<String, dynamic>>[userItem('u-1', 'Check the tests')],
              busy: true,
              subagents: <Map<String, dynamic>>[_round()],
            ),
            'status': 'Running bash...',
          },
        },
      );
      h.snapshot = _busy(
        <Map<String, dynamic>>[userItem('u-1', 'Check the tests')],
        subagents: <Map<String, dynamic>>[_round()],
      );
      h.app.locale.value = locale;
      await h.bind();
      await tester.pumpWidget(
        h.build(
          home: const SubagentPage(agentId: 'agent-4', title: 'Check tests'),
          localized: true,
        ),
      );
      await settle(tester);
    }

    testWidgets('en：状态、轮次与停止提示为英文', (tester) async {
      await openSubagent(tester, kLocaleEn);
      expect(find.text('Check tests'), findsOneWidget);
      expect(find.text('Running bash…'), findsOneWidget);
      expect(find.byTooltip('Stop the current round'), findsOneWidget);
      expect(find.textContaining('Round 1'), findsOneWidget);
      expect(cjkResidue(tester, data: _sessionData), isEmpty);
    });

    testWidgets('zh：状态与停止提示为中文', (tester) async {
      await openSubagent(tester, kLocaleZh);
      expect(find.text('运行 bash…'), findsOneWidget);
      expect(find.byTooltip('停止当前轮'), findsOneWidget);
    });
  });
}
