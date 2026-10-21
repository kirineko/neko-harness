import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/api/models.dart';

import '../../helpers/chat_harness.dart';
import '../../helpers/interaction_ui.dart';

Map<String, dynamic> _session(
  String id,
  String title, {
  bool? awaitingAnswer,
  bool? awaitingPlan,
  String preview = '预览文字',
}) => <String, dynamic>{
  'id': id,
  'workspace': '/a/neko',
  'title': title,
  'preview': preview,
  'lastUsedAt': 0,
  'lastMessageAt': 0,
  'archived': false,
  'awaitingAnswer': ?awaitingAnswer,
  'awaitingPlan': ?awaitingPlan,
};

void main() {
  late ChatHarness h;

  setUp(() => h = ChatHarness());
  tearDown(() => h.dispose());

  Future<void> openSwitcher(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('open-switcher')));
    await transition(tester);
  }

  testWidgets('awaitingAnswer 为真：会话列表显示“等待回答”；缺省/为假不显示任何标记', (tester) async {
    h.api.on(
      'sessions.list',
      (_) => <String, dynamic>{
        'sessions': <Object>[
          _session('7', '修复登录页', awaitingAnswer: true),
          _session('8', '重构存储', awaitingAnswer: false),
          _session('9', '旧电脑的会话'),
        ],
      },
    );
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await openSwitcher(tester);
    expect(find.text('等待回答'), findsOneWidget);
    expect(find.byKey(const Key('session-awaiting-7')), findsOneWidget);
    expect(find.byKey(const Key('session-awaiting-8')), findsNothing);
    expect(find.byKey(const Key('session-awaiting-9')), findsNothing);
    // 预览仍然显示。
    expect(find.text('预览文字'), findsNWidgets(3));
  });

  testWidgets('awaitingPlan 为真：会话列表显示“等待批准”；缺省/为假不显示任何标记', (tester) async {
    h.api.on(
      'sessions.list',
      (_) => <String, dynamic>{
        'sessions': <Object>[
          _session('7', '修复登录页', awaitingPlan: true),
          _session('8', '重构存储', awaitingPlan: false),
          _session('9', '旧电脑的会话'),
        ],
      },
    );
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await openSwitcher(tester);
    expect(find.text('等待批准'), findsOneWidget);
    expect(find.byKey(const Key('session-plan-7')), findsOneWidget);
    expect(find.byKey(const Key('session-plan-8')), findsNothing);
    expect(find.byKey(const Key('session-plan-9')), findsNothing);
    expect(find.text('等待回答'), findsNothing);
    expect(find.text('预览文字'), findsNWidgets(3));
  });

  testWidgets('没有预览时也显示等待批准；标记随 sessions.changed 清除', (tester) async {
    var awaiting = true;
    h.api.on(
      'sessions.list',
      (_) => <String, dynamic>{
        'sessions': <Object>[
          _session('7', '修复登录页', awaitingPlan: awaiting, preview: ''),
        ],
      },
    );
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await openSwitcher(tester);
    expect(find.byKey(const Key('session-plan-7')), findsOneWidget);

    awaiting = false;
    h.api.notify('sessions.changed', <String, dynamic>{'revision': 2});
    await settle(tester);
    expect(find.byKey(const Key('session-plan-7')), findsNothing);
  });

  testWidgets('没有预览时也显示标记；标记随 sessions.changed 清除', (tester) async {
    var awaiting = true;
    h.api.on(
      'sessions.list',
      (_) => <String, dynamic>{
        'sessions': <Object>[
          _session('7', '修复登录页', awaitingAnswer: awaiting, preview: ''),
        ],
      },
    );
    await h.bind();
    await tester.pumpWidget(h.build());
    await settle(tester);
    await openSwitcher(tester);
    expect(find.byKey(const Key('session-awaiting-7')), findsOneWidget);

    awaiting = false;
    h.api.notify('sessions.changed', <String, dynamic>{'revision': 2});
    await settle(tester);
    expect(find.byKey(const Key('session-awaiting-7')), findsNothing);
  });

  testWidgets('窄屏大字体下标记不溢出，行高 >=44dp', (tester) async {
    tester.view
      ..physicalSize = const Size(320, 640)
      ..devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    h.api.on(
      'sessions.list',
      (_) => <String, dynamic>{
        'sessions': <Object>[
          _session(
            '7',
            '很长很长的会话标题' * 6,
            awaitingAnswer: true,
            preview: '很长的预览' * 20,
          ),
        ],
      },
    );
    await h.bind();
    await tester.pumpWidget(h.build(textScale: 1.5));
    await settle(tester);
    await openSwitcher(tester);
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('session-awaiting-7')), findsOneWidget);
    expect(
      tester.getSize(find.byKey(const Key('session-7'))).height,
      greaterThanOrEqualTo(44),
    );
  });

  test('SessionSummary.awaitingPlan 三态', () {
    SessionSummary parse(Map<String, dynamic> json) =>
        SessionSummary.fromJson(<String, dynamic>{
          'id': '1',
          'workspace': '/w',
          'title': '',
          'preview': '',
          'lastUsedAt': 0,
          ...json,
        });
    expect(parse(<String, dynamic>{}).awaitingPlan, isNull);
    expect(
      parse(<String, dynamic>{'awaitingPlan': false}).waitingForPlan,
      isFalse,
    );
    expect(
      parse(<String, dynamic>{'awaitingPlan': true}).waitingForPlan,
      isTrue,
    );
  });

  test('SessionSummary.awaitingAnswer 三态', () {
    SessionSummary parse(Map<String, dynamic> json) =>
        SessionSummary.fromJson(<String, dynamic>{
          'id': '1',
          'workspace': '/w',
          'title': '',
          'preview': '',
          'lastUsedAt': 0,
          ...json,
        });
    expect(parse(<String, dynamic>{}).awaitingAnswer, isNull);
    expect(
      parse(<String, dynamic>{'awaitingAnswer': false}).waitingForAnswer,
      isFalse,
    );
    expect(
      parse(<String, dynamic>{'awaitingAnswer': true}).waitingForAnswer,
      isTrue,
    );
    // 非布尔值按“无法判断”处理，不推测。
    expect(
      parse(<String, dynamic>{'awaitingAnswer': 'yes'}).awaitingAnswer,
      isNull,
    );
  });
}
