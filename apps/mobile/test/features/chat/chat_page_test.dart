import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/features/chat/chat_page.dart';
import 'package:neko_mobile/features/sessions/session_picker.dart';
import 'package:neko_mobile/l10n/l10n.dart';

import '../../helpers/chat_harness.dart';
import '../../helpers/fake_api.dart';

Map<String, dynamic> _delegationRound({String status = 'running'}) =>
    <String, dynamic>{
      'taskId': 9,
      'callId': 'call_9',
      'agentId': 'agent-4',
      'round': 1,
      'role': 'explore',
      'title': '看看测试',
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
  'title': '看看测试',
  'command': 'bun test ${'--very-long-flag ' * 40}',
  'cwd': '/a/neko',
  'timeoutSeconds': 120,
  'requestedAt': 0,
};

Future<void> transition(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  late ChatHarness h;

  setUp(() => h = ChatHarness());
  tearDown(() => h.dispose());

  testWidgets('渲染转录与 Markdown，HTML 原样显示', (tester) async {
    h.snapshot = snapshotOf(<Map<String, dynamic>>[
      userItem('u-1', '你好'),
      assistantItem('a-2', '<b>不是粗体</b>\n\n```\n<div>代码</div>\n```'),
    ]);
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    expect(find.text('修复登录页'), findsOneWidget);
    expect(
      find.textContaining('<b>不是粗体</b>', findRichText: true),
      findsOneWidget,
    );
    expect(
      find.textContaining('<div>代码</div>', findRichText: true),
      findsOneWidget,
    );
  });

  testWidgets('审批条打开面板并决定；新请求不清空草稿', (tester) async {
    h.approvals = <Object>[_approval()];
    h.snapshot = snapshotOf(
      <Map<String, dynamic>>[userItem('u-1', '跑测试')],
      busy: true,
      subagents: <Map<String, dynamic>>[_delegationRound()],
    );
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.enterText(find.byKey(const Key('composer-input')), '还没写完的草稿');
    h.approvals = <Object>[
      _approval(),
      <String, dynamic>{..._approval(), 'id': 32},
    ];
    h.api.notify('approvals.changed', <String, dynamic>{
      'subscriptionId': 'chat-1',
      'revision': 2,
    });
    await settle(tester);
    expect(find.text('2 个命令等待审批'), findsOneWidget);
    expect(h.chat.input.text, '还没写完的草稿');

    h.api.on('approvals.decide', (_) => <String, dynamic>{'status': 'denied'});
    await tester.tap(find.byKey(const Key('approval-bar')));
    await transition(tester);
    expect(find.textContaining('目录：/a/neko'), findsWidgets);
    expect(find.textContaining('超时：120 秒'), findsWidgets);
    await tester.ensureVisible(find.byKey(const Key('approval-allow-31')));
    await transition(tester);
    await tester.tap(find.byKey(const Key('approval-allow-31')));
    await settle(tester);
    // 被其他端抢先拒绝：显示实际终态。
    expect(find.text('已拒绝'), findsOneWidget);
    expect(h.api.callsOf('approvals.decide').single?['decision'], 'allow');
  });

  testWidgets('附着失败显示错误面板，修复后可重试成功', (tester) async {
    h.api.on('chat.attach', (_) => throw kOffline);
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    expect(find.byKey(const Key('attach-error')), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    h.api.on(
      'chat.attach',
      (params) => <String, dynamic>{
        'subscriptionId': 'chat-2',
        'sessionId': params!['sessionId'],
        'snapshot': h.snapshot,
      },
    );
    await tester.tap(find.byKey(const Key('attach-retry')));
    await settle(tester);
    expect(find.byKey(const Key('attach-error')), findsNothing);
    expect(find.text('你好'), findsOneWidget);
  });

  testWidgets('离线时控制禁用但草稿可编辑；待确认只能重试或放弃', (tester) async {
    await h.bind();
    h.api.on('chat.submit', (_) => throw kOffline);
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.enterText(find.byKey(const Key('composer-input')), '发出去');
    await settle(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await settle(tester);
    expect(find.textContaining('待确认：发出去'), findsOneWidget);
    expect(h.api.callsOf('chat.submit'), hasLength(1));

    h.chat.unbind();
    await settle(tester);
    final send = tester.widget<IconButton>(
      find.byKey(const Key('composer-send')),
    );
    expect(send.onPressed, isNull);
    await tester.enterText(find.byKey(const Key('composer-input')), '离线草稿');
    expect(h.chat.input.text, '离线草稿');
    final retry = find.byKey(
      Key('pending-retry-${h.chat.pending.single.requestId}'),
    );
    expect(tester.widget<TextButton>(retry).onPressed, isNull);
    await settle(tester);
  });

  testWidgets('忙碌时发送一律排队（不带 mode），并可停止', (tester) async {
    h.snapshot = snapshotOf(<Map<String, dynamic>>[
      userItem('u-1', 'x'),
    ], busy: true);
    await h.bind();
    h.api
      ..on(
        'chat.submit',
        (_) => <String, dynamic>{'accepted': true, 'queued': false},
      )
      ..on('chat.abort', (_) => <String, dynamic>{'accepted': true});
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.enterText(find.byKey(const Key('composer-input')), '换个方向');
    await settle(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await settle(tester);
    expect(h.api.callsOf('chat.submit').single?.containsKey('mode'), isFalse);
    await tester.tap(find.byKey(const Key('composer-stop')));
    await settle(tester);
    expect(h.api.callsOf('chat.abort'), hasLength(1));
  });

  testWidgets('委派卡打开子详情；返回不停止、不发送并保留主草稿', (tester) async {
    h.snapshot = snapshotOf(
      <Map<String, dynamic>>[
        userItem('u-1', '调查'),
        <String, dynamic>{
          'key': 't-call_9',
          'type': 'tool',
          'tool': <String, dynamic>{
            'callId': 'call_9',
            'name': 'subagent',
            'summary': 'explore',
            'status': 'running',
          },
        },
      ],
      busy: true,
      subagents: <Map<String, dynamic>>[_delegationRound()],
    );
    h.api.on(
      'subagents.open',
      (_) => <String, dynamic>{
        'subagentSubscriptionId': 'agent-1',
        'agentId': 'agent-4',
        'snapshot': <String, dynamic>{
          ...snapshotOf(
            <Map<String, dynamic>>[assistantItem('c-1', '子 agent 的输出')],
            busy: true,
            subagents: <Map<String, dynamic>>[
              {
                ..._delegationRound(),
                'usage': <String, dynamic>{'totalTokens': 2048},
              },
            ],
            historyBefore: 'entry:3',
          ),
          'readonly': false,
        },
      },
    );
    h.api.on('subagents.close', (_) => null);
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.enterText(find.byKey(const Key('composer-input')), '主会话草稿');
    await tester.tap(find.byKey(const Key('open-subagent-9')));
    await transition(tester);
    expect(find.text('子 agent 的输出'), findsOneWidget);
    expect(find.byKey(const Key('round-9')), findsOneWidget);
    expect(find.textContaining('2.0k'), findsOneWidget);
    expect(h.api.callsOf('subagents.open').single?['agentId'], 'agent-4');

    await tester.pageBack();
    await transition(tester);
    expect(h.api.callsOf('subagents.close'), hasLength(1));
    expect(h.api.callsOf('subagents.stop'), isEmpty);
    expect(h.api.callsOf('chat.submit'), isEmpty);
    expect(h.chat.input.text, '主会话草稿');
  });

  testWidgets('子详情停止当前轮需确认并绑定 taskId', (tester) async {
    h.snapshot = snapshotOf(
      <Map<String, dynamic>>[userItem('u-1', 'x')],
      busy: true,
      subagents: <Map<String, dynamic>>[_delegationRound()],
    );
    h.api
      ..on(
        'subagents.open',
        (_) => <String, dynamic>{
          'subagentSubscriptionId': 'agent-1',
          'agentId': 'agent-4',
          'snapshot': snapshotOf(<Map<String, dynamic>>[], busy: true),
        },
      )
      ..on('subagents.stop', (_) => <String, dynamic>{'stopped': true})
      ..on('subagents.close', (_) => null);
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    final context = tester.element(find.byType(Scaffold).first);
    openSubagent(context, h.chat.transcript.status.subagents.single);
    await transition(tester);
    await tester.tap(find.byKey(const Key('subagent-stop')));
    await transition(tester);
    await tester.tap(find.byKey(const Key('subagent-stop-confirm')));
    await settle(tester);
    expect(h.api.callsOf('subagents.stop').single?['taskId'], 9);
  });

  Map<String, dynamic> sessionJson(
    String id, {
    String workspace = '/a/neko',
    String title = '',
    int lastUsedAt = 0,
    int? lastMessageAt,
  }) => <String, dynamic>{
    'id': id,
    'workspace': workspace,
    'title': title,
    'preview': '',
    'lastUsedAt': lastUsedAt,
    'lastMessageAt': ?lastMessageAt,
    'archived': false,
  };

  testWidgets('新建：顶栏 [+] 是唯一入口，连点只创建一个并绑定当前工作区', (tester) async {
    var created = 0;
    h.api.on('sessions.create', (_) async {
      created++;
      await Future<void>.delayed(const Duration(milliseconds: 50));
      return sessionJson('99');
    });
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    expect(find.byType(FloatingActionButton), findsNothing);
    expect(find.byKey(const Key('open-sessions')), findsNothing);
    expect(find.byKey(const Key('drawer-new-session')), findsNothing);

    final add = find.byKey(const Key('sessions-new'));
    await tester.tap(add);
    await tester.tap(add, warnIfMissed: false);
    await tester.pump(const Duration(milliseconds: 100));
    await settle(tester);
    expect(created, 1);
    expect(h.api.callsOf('sessions.create').single?['workspace'], '/a/neko');
    expect(h.chat.sessionId, '99');
  });

  testWidgets('空工作区不自动创建会话，[+] 不可用', (tester) async {
    h.api.on(
      'workspaces.list',
      (_) => <String, dynamic>{'workspaces': <Object>[]},
    );
    await h.bind(attach: null);
    await tester.pumpWidget(h.build());
    await settle(tester);
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('sessions-new')))
          .onPressed,
      isNull,
    );
    expect(find.byKey(const Key('empty-new-session')), findsNothing);
    expect(h.api.callsOf('sessions.create'), isEmpty);
  });

  testWidgets('切换器：同名工作区可区分并显示完整路径，可切换工作区与搜索', (tester) async {
    h.api.on('sessions.list', (params) {
      final workspace = params!['workspace'] as String;
      return <String, dynamic>{
        'sessions': <Object>[
          sessionJson('7', workspace: workspace, title: '会话-$workspace'),
        ],
      };
    });
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);

    expect(find.text('neko · a'), findsOneWidget);
    expect(find.text('neko · b'), findsOneWidget);
    expect(
      tester
          .widget<Text>(find.byKey(const Key('switcher-workspace-path')))
          .data,
      '/a/neko',
    );
    Finder inRow(String text) => find.descendant(
      of: find.byKey(const Key('session-7')),
      matching: find.text(text),
    );
    expect(inRow('会话-/a/neko'), findsOneWidget);

    await tester.tap(find.byKey(const Key('workspace-/b/neko')));
    await settle(tester);
    expect(h.api.callsOf('sessions.list').last?['workspace'], '/b/neko');
    expect(
      tester
          .widget<Text>(find.byKey(const Key('switcher-workspace-path')))
          .data,
      '/b/neko',
    );
    expect(inRow('会话-/b/neko'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('sessions-search')), '登录');
    await tester.pump(const Duration(milliseconds: 400));
    expect(h.api.callsOf('sessions.list').last?['query'], '登录');
  });

  testWidgets('切换器：顺序沿用服务端，时间取最近消息时间，仅打开不改变顺序', (tester) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    h.api.on(
      'sessions.list',
      (_) => <String, dynamic>{
        'sessions': <Object>[
          sessionJson(
            '9',
            title: '最近发过消息',
            lastUsedAt: now - 5000,
            lastMessageAt: now,
          ),
          sessionJson(
            '8',
            title: '只被打开过',
            lastUsedAt: now,
            lastMessageAt: now - 3 * 3600 * 1000,
          ),
        ],
      },
    );
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);

    List<String> order() =>
        <String>[
          for (final id in <String>['9', '8'])
            if (find.byKey(Key('session-$id')).evaluate().isNotEmpty) id,
        ]..sort(
          (a, b) => tester
              .getTopLeft(find.byKey(Key('session-$a')))
              .dy
              .compareTo(tester.getTopLeft(find.byKey(Key('session-$b'))).dy),
        );

    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);
    expect(order(), <String>['9', '8']);
    expect(find.text('3 小时前'), findsOneWidget, reason: '展示最近消息时间而非打开时间');

    // 打开靠后的会话（只 attach，不发消息）后再次打开：顺序不变。
    await tester.tap(find.byKey(const Key('session-8')));
    await settle(tester);
    expect(h.chat.sessionId, '8');
    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);
    expect(order(), <String>['9', '8']);
  });

  testWidgets('切换器：滚动到末尾自动加载下一页，顺序保持服务端分页顺序', (tester) async {
    h.api.on('sessions.list', (params) {
      final cursor = params!['cursor'];
      return cursor == null
          ? <String, dynamic>{
              'sessions': <Object>[
                sessionJson('3', title: 'P1-a', lastMessageAt: 30),
                sessionJson('2', title: 'P1-b', lastMessageAt: 20),
              ],
              'nextCursor': '2',
            }
          : <String, dynamic>{
              'sessions': <Object>[
                sessionJson('1', title: 'P2-a', lastMessageAt: 10),
              ],
            };
    });
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);
    await settle(tester);

    expect(h.api.callsOf('sessions.list').last?['cursor'], '2');
    final ys = <double>[
      for (final id in <String>['3', '2', '1'])
        tester.getTopLeft(find.byKey(Key('session-$id'))).dy,
    ];
    expect(ys, orderedEquals(<double>[...ys]..sort()));
    expect(ys.toSet(), hasLength(3));
  });

  testWidgets('切换工作区：顶栏与内容随之切到该工作区最近使用的会话', (tester) async {
    h.api.on('sessions.list', (params) {
      return params!['workspace'] == '/b/neko'
          ? <String, dynamic>{
              'sessions': <Object>[
                sessionJson(
                  '9',
                  workspace: '/b/neko',
                  title: 'B旧',
                  lastUsedAt: 1,
                ),
                sessionJson(
                  '8',
                  workspace: '/b/neko',
                  title: 'B最近',
                  lastUsedAt: 10,
                ),
              ],
            }
          : <String, dynamic>{
              'sessions': <Object>[
                sessionJson('7', title: 'A会话', lastUsedAt: 5),
              ],
            };
    });
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    expect(
      tester.widget<Text>(find.byKey(const Key('chat-title'))).data,
      'A会话',
    );

    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);
    await tester.tap(find.byKey(const Key('workspace-/b/neko')));
    await settle(tester);
    expect(h.chat.sessionId, '8');
    expect(
      tester.widget<Text>(find.byKey(const Key('chat-title'))).data,
      'B最近',
    );
  });

  testWidgets('切换到没有会话的工作区：回到空态，不残留原会话标题', (tester) async {
    h.api.on('sessions.list', (params) {
      return params!['workspace'] == '/b/neko'
          ? <String, dynamic>{'sessions': <Object>[]}
          : <String, dynamic>{
              'sessions': <Object>[sessionJson('7', title: 'A会话')],
            };
    });
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);
    await tester.tap(find.byKey(const Key('workspace-/b/neko')));
    await settle(tester);
    expect(h.chat.sessionId, isNull);
    expect(
      tester.widget<Text>(find.byKey(const Key('chat-title'))).data,
      'NekoAI',
    );
    expect(find.byKey(const Key('composer-input')), findsNothing);
  });

  testWidgets('无标题的新会话显示"新会话"而不是 id；搜索筛选不影响顶栏标题', (tester) async {
    h.api.on('sessions.list', (params) {
      final query = params!['query'];
      return <String, dynamic>{
        'sessions': <Object>[
          if (query == null)
            sessionJson('7', title: '')
          else
            sessionJson('5', title: '别的会话'),
        ],
      };
    });
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    final title = find.byKey(const Key('chat-title'));
    expect(tester.widget<Text>(title).data, '新会话');
    expect(find.textContaining('141'), findsNothing);
    expect(find.textContaining('7'), findsNothing, reason: '不用 id 当标题');

    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);
    await tester.enterText(find.byKey(const Key('sessions-search')), '别');
    await tester.pump(const Duration(milliseconds: 400));
    await settle(tester);
    expect(tester.widget<Text>(title).data, '新会话');
  });

  testWidgets('抽屉只有电脑与设置、扫码配对，没有会话/工作区列表', (tester) async {
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.tap(find.byTooltip('Open navigation menu'));
    await transition(tester);
    expect(find.byKey(const Key('drawer-computers')), findsOneWidget);
    expect(find.byKey(const Key('drawer-pair')), findsOneWidget);
    // 抽屉不再空旷：品牌头部、连接状态、外观快捷切换。
    expect(find.byKey(const Key('drawer-status')), findsOneWidget);
    expect(find.byKey(const Key('drawer-theme')), findsOneWidget);
    expect(h.app.themeMode.value, ThemeMode.system);
    await tester.tap(find.text('深色'));
    await settle(tester);
    expect(h.app.themeMode.value, ThemeMode.dark);
    expect(find.byKey(const Key('workspace-/a/neko')), findsNothing);
    expect(find.byKey(const Key('session-7')), findsNothing);
    expect(find.byKey(const Key('drawer-session-7')), findsNothing);
  });

  testWidgets('系统返回先关闭切换器，保留草稿且不切换/新建会话', (tester) async {
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.enterText(find.byKey(const Key('composer-input')), '未发送草稿');
    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);
    expect(find.byKey(const Key('sessions-search')), findsOneWidget);

    final attaches = h.attachCount;
    await tester.binding.handlePopRoute();
    await transition(tester);
    expect(find.byKey(const Key('sessions-search')), findsNothing);
    expect(find.byKey(const Key('composer-input')), findsOneWidget);
    expect(h.chat.input.text, '未发送草稿');
    expect(h.attachCount, attaches);
    expect(h.api.callsOf('sessions.create'), isEmpty);
  });

  testWidgets('快速切换工作区：迟到的旧响应不覆盖最新选择', (tester) async {
    h.api.on('sessions.list', (params) async {
      final workspace = params!['workspace'] as String;
      if (workspace == '/b/neko') {
        await Future<void>.delayed(const Duration(milliseconds: 300));
      }
      return <String, dynamic>{
        'sessions': <Object>[
          sessionJson(
            's-$workspace',
            workspace: workspace,
            title: 'T$workspace',
          ),
        ],
      };
    });
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);

    await tester.tap(find.byKey(const Key('workspace-/b/neko')));
    await tester.pump(const Duration(milliseconds: 20));
    await tester.tap(find.byKey(const Key('workspace-/a/neko')));
    await tester.pump(const Duration(milliseconds: 600));
    await settle(tester);

    expect(h.app.sessions.workspace, '/a/neko');
    expect(find.text('T/a/neko'), findsWidgets);
    expect(find.text('T/b/neko'), findsNothing);

    await tester.tap(find.byKey(const Key('session-s-/a/neko')));
    await settle(tester);
    expect(h.chat.sessionId, 's-/a/neko');
  });

  testWidgets('大字体、窄屏与深色主题下无溢出', (tester) async {
    tester.view.physicalSize = const Size(360 * 3, 640 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    h.approvals = <Object>[_approval()];
    h.snapshot = snapshotOf(<Map<String, dynamic>>[
      userItem(
        'u-1',
        '/Users/kirineko/${'very-long-directory-name/' * 10}file.ts',
      ),
      assistantItem(
        'a-2',
        '| a | b | c |\n|---|---|---|\n| ${'长' * 80} | 2 | 3 |\n\n```\n${'x' * 300}\n```',
      ),
      <String, dynamic>{
        'key': 't-1',
        'type': 'tool',
        'tool': <String, dynamic>{
          'callId': 'c1',
          'name': 'bash',
          'summary': 'cat ${'/deep/path' * 20}',
          'status': 'error',
          'result': 'x' * 400,
        },
      },
    ], busy: true);
    await h.bind();
    for (final mode in <ThemeMode>[ThemeMode.light, ThemeMode.dark]) {
      await tester.pumpWidget(h.build(mode: mode, textScale: 2));
      await settle(tester);
      expect(tester.takeException(), isNull);
    }
    final send = tester.getSize(find.byKey(const Key('composer-send')));
    expect(send.width, greaterThanOrEqualTo(48));
    expect(send.height, greaterThanOrEqualTo(48));
  });

  test('相对时间格式', () {
    final now = DateTime(2026, 10, 15, 12);
    final zh = lookupAppLocalizations(kLocaleZh);
    final en = lookupAppLocalizations(kLocaleEn);
    final half = now.millisecondsSinceEpoch - 30 * 1000;
    final hours = now.millisecondsSinceEpoch - 3 * 3600 * 1000;
    expect(relativeTime(zh, half, now), '刚刚');
    expect(relativeTime(zh, hours, now), '3 小时前');
    expect(relativeTime(en, half, now), 'now');
    expect(relativeTime(en, hours, now), '3h');
  });
}
