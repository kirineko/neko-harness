import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/features/plan/plan_decision.dart';

import '../../helpers/chat_harness.dart';
import '../../helpers/interaction_data.dart';
import '../../helpers/interaction_ui.dart';

void main() {
  late ChatHarness h;

  setUp(() => h = ChatHarness());
  tearDown(() => h.dispose());

  /// 已绑定新电脑（声明 plan）、有一份待批准计划。
  Future<void> pumpPlan(
    WidgetTester tester, {
    Map<String, dynamic>? record,
    Iterable<String> caps = kPlanCaps,
    double textScale = 1,
  }) async {
    final plan = record ?? planJson();
    h.planRecords[plan['version'] as String] = plan;
    h.snapshot = snapshotWith(
      plan: planSummaryJson(version: plan['version'] as String),
    );
    await h.bind(capabilities: caps);
    await tester.pumpWidget(h.build(textScale: textScale));
    await settle(tester);
  }

  Future<void> openSheet(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('plan-bar')));
    await transition(tester);
  }

  group('计划条与卡片内容', () {
    testWidgets('计划条显示“等待批准”和标题；旧电脑不显示也不请求', (tester) async {
      await pumpPlan(tester);
      expect(find.byKey(const Key('plan-bar')), findsOneWidget);
      expect(find.byKey(const Key('plan-bar-status')), findsOneWidget);
      expect(find.text('等待批准'), findsOneWidget);
      expect(find.text('为登录页增加记住我开关'), findsOneWidget);
      expect(find.byKey(const Key('plan-sheet')), findsNothing);
    });

    testWidgets('电脑不声明 plan 能力：没有计划条，从不请求 plan.*', (tester) async {
      await pumpPlan(tester, caps: const <String>['todos', 'questions']);
      expect(find.byKey(const Key('plan-bar')), findsNothing);
      expect(h.api.callsOf('plan.get'), isEmpty);
    });

    testWidgets('没有待批准计划：计划条隐藏', (tester) async {
      h.snapshot = snapshotWith(
        plan: planSummaryJson(revision: 0, pending: false, version: null),
      );
      await h.bind(capabilities: kPlanCaps);
      await tester.pumpWidget(h.build());
      await settle(tester);
      expect(find.byKey(const Key('plan-bar')), findsNothing);
    });

    testWidgets('sheet：标题按纯文本，步骤与说明按 Markdown 渲染，HTML 与链接不生效', (tester) async {
      await pumpPlan(
        tester,
        record: planJson(
          title: '**加粗** <b>标题</b>',
          steps: <String>[
            '第一步 **粗体** [链接](http://x)',
            '运行 `bun test` <i>x</i>',
          ],
          note: '# 假设与风险\n\n- 风险一\n- 风险二',
        ),
      );
      await openSheet(tester);
      expect(find.byKey(const Key('plan-label')), findsOneWidget);
      expect(
        tester.widget<Text>(find.byKey(const Key('plan-title'))).data,
        '**加粗** <b>标题</b>',
      );
      // 标记被解析：界面上看不到原始的 ** / ` / [](...)，HTML 标签按原文显示。
      expect(find.text('第一步 粗体 链接', findRichText: true), findsOneWidget);
      expect(
        find.text('运行 bun test <i>x</i>', findRichText: true),
        findsOneWidget,
      );
      expect(find.textContaining('粗体 **', findRichText: true), findsNothing);
      expect(find.text('1.'), findsOneWidget);
      expect(find.text('2.'), findsOneWidget);
      expect(find.byKey(const Key('plan-step-2')), findsOneWidget);
      expect(find.byKey(const Key('plan-note')), findsOneWidget);
      expect(find.text('假设与风险', findRichText: true), findsOneWidget);
      expect(find.text('风险一', findRichText: true), findsOneWidget);
      expect(find.textContaining('# 假设', findRichText: true), findsNothing);
      expect(buttonEnabled(tester, 'plan-approve'), isTrue);
      expect(buttonEnabled(tester, 'plan-revise'), isTrue);
    });

    testWidgets('说明为空时不显示说明区', (tester) async {
      await pumpPlan(tester, record: planJson(note: ''));
      await openSheet(tester);
      expect(find.byKey(const Key('plan-note')), findsNothing);
    });
  });

  group('决定', () {
    testWidgets('点击批准：提交一次，卡片显示已批准，关闭后条隐藏', (tester) async {
      final gate = Completer<void>();
      h.api.on('plan.respond', (_) async {
        await gate.future;
        return planJson(status: 'approved', settledAt: 9);
      });
      await pumpPlan(tester);
      await openSheet(tester);
      await tester.tap(find.byKey(const Key('plan-approve')));
      await tester.pump();
      // 提交期间两个按钮都不可用，重复点击不会产生第二次请求。
      expect(buttonEnabled(tester, 'plan-approve'), isFalse);
      expect(buttonEnabled(tester, 'plan-revise'), isFalse);
      await tester.tap(
        find.byKey(const Key('plan-approve')),
        warnIfMissed: false,
      );
      gate.complete();
      await transition(tester);
      expect(h.api.callsOf('plan.respond'), hasLength(1));
      expect(
        h.api.callsOf('plan.respond').single!['decision'],
        <String, Object?>{'kind': 'approve'},
      );
      expect(
        tester.widget<Text>(find.byKey(const Key('plan-final-status'))).data,
        '已批准',
      );
      await tester.tap(find.byKey(const Key('plan-done')));
      await transition(tester);
      expect(find.byKey(const Key('plan-sheet')), findsNothing);
      expect(find.byKey(const Key('plan-bar')), findsNothing);
    });

    testWidgets('取消并退出计划模式：提交一次，计划被取消后卡片消失；提交期间三个按钮都禁用', (tester) async {
      final gate = Completer<void>();
      h.api.on('plan.exit', (_) async {
        await gate.future;
        h.planRecords['v-plan-1'] = planJson(status: 'cancelled', settledAt: 9);
        return <String, dynamic>{'mode': 'normal', 'revision': 3};
      });
      await pumpPlan(tester);
      await openSheet(tester);
      expect(find.text('取消并退出计划模式'), findsOneWidget);
      expect(buttonEnabled(tester, 'plan-exit'), isTrue);
      await tester.tap(find.byKey(const Key('plan-exit')));
      await tester.pump();
      expect(buttonEnabled(tester, 'plan-exit'), isFalse);
      expect(buttonEnabled(tester, 'plan-approve'), isFalse);
      expect(buttonEnabled(tester, 'plan-revise'), isFalse);
      gate.complete();
      await transition(tester);
      expect(h.api.callsOf('plan.exit'), hasLength(1));
      expect(h.api.callsOf('plan.respond'), isEmpty);
      expect(find.byKey(const Key('plan-gone')), findsOneWidget);
      expect(find.byKey(const Key('plan-exit')), findsNothing);
    });

    testWidgets('批准提交期间退出按钮也禁用', (tester) async {
      final gate = Completer<void>();
      h.api.on('plan.respond', (_) async {
        await gate.future;
        return planJson(status: 'approved', settledAt: 9);
      });
      await pumpPlan(tester);
      await openSheet(tester);
      await tester.tap(find.byKey(const Key('plan-approve')));
      await tester.pump();
      expect(buttonEnabled(tester, 'plan-exit'), isFalse);
      gate.complete();
      await transition(tester);
    });

    testWidgets('要求修改：反馈框有计数，空白不可提交，提交后显示已要求修改与反馈', (tester) async {
      h.api.on(
        'plan.respond',
        (params) => planJson(
          status: 'revision_requested',
          feedback: (params!['decision'] as Map)['feedback'] as String,
          settledAt: 9,
        ),
      );
      await pumpPlan(tester);
      await openSheet(tester);
      expect(find.byKey(const Key('plan-feedback-input')), findsNothing);
      await tester.tap(find.byKey(const Key('plan-revise')));
      await tester.pump();
      expect(find.byKey(const Key('plan-feedback-input')), findsOneWidget);
      expect(buttonEnabled(tester, 'plan-feedback-submit'), isFalse);
      expect(
        tester.widget<Text>(find.byKey(const Key('plan-counter'))).data,
        '0/${PlanLimits.feedbackChars}',
      );

      await tester.enterText(
        find.byKey(const Key('plan-feedback-input')),
        '   ',
      );
      await tester.pump();
      expect(buttonEnabled(tester, 'plan-feedback-submit'), isFalse);

      await tester.enterText(
        find.byKey(const Key('plan-feedback-input')),
        '只加开关和测试',
      );
      await tester.pump();
      expect(buttonEnabled(tester, 'plan-feedback-submit'), isTrue);
      await tester.tap(find.byKey(const Key('plan-feedback-submit')));
      await transition(tester);
      expect(
        h.api.callsOf('plan.respond').single!['decision'],
        <String, Object?>{'kind': 'revise', 'feedback': '只加开关和测试'},
      );
      expect(
        tester.widget<Text>(find.byKey(const Key('plan-final-status'))).data,
        '已要求修改',
      );
      expect(find.text('修改意见：只加开关和测试'), findsOneWidget);
    });

    testWidgets('反馈超过 2000 个码元：显示超限提示且不可提交', (tester) async {
      await pumpPlan(tester);
      await openSheet(tester);
      await tester.tap(find.byKey(const Key('plan-revise')));
      await tester.pump();
      await tester.enterText(
        find.byKey(const Key('plan-feedback-input')),
        'x' * (PlanLimits.feedbackChars + 1),
      );
      await tester.pump();
      expect(find.byKey(const Key('plan-problem')), findsOneWidget);
      expect(buttonEnabled(tester, 'plan-feedback-submit'), isFalse);
      await tester.enterText(
        find.byKey(const Key('plan-feedback-input')),
        'x' * PlanLimits.feedbackChars,
      );
      await tester.pump();
      expect(find.byKey(const Key('plan-problem')), findsNothing);
      expect(buttonEnabled(tester, 'plan-feedback-submit'), isTrue);
    });

    testWidgets('关闭 sheet 后再打开：未提交的修改意见仍在', (tester) async {
      await pumpPlan(tester);
      await openSheet(tester);
      await tester.tap(find.byKey(const Key('plan-revise')));
      await tester.pump();
      await tester.enterText(
        find.byKey(const Key('plan-feedback-input')),
        '还没写完',
      );
      await tester.tap(find.byKey(const Key('plan-close')));
      await transition(tester);
      expect(find.byKey(const Key('plan-sheet')), findsNothing);
      expect(find.byKey(const Key('plan-bar')), findsOneWidget);
      await openSheet(tester);
      expect(find.text('还没写完'), findsOneWidget);
    });

    testWidgets('他端抢先：显示实际保存的状态并附说明', (tester) async {
      h.api.on(
        'plan.respond',
        (_) => planJson(
          status: 'revision_requested',
          feedback: '桌面端先改了',
          settledAt: 9,
        ),
      );
      await pumpPlan(tester);
      await openSheet(tester);
      await tester.tap(find.byKey(const Key('plan-approve')));
      await transition(tester);
      expect(find.byKey(const Key('plan-note-settled')), findsOneWidget);
      expect(
        tester.widget<Text>(find.byKey(const Key('plan-final-status'))).data,
        '已要求修改',
      );
      expect(find.text('修改意见：桌面端先改了'), findsOneWidget);
    });

    testWidgets('提交失败：显示错误，按钮恢复可用', (tester) async {
      h.api.on('plan.respond', (_) => throw const RpcNetworkException());
      await pumpPlan(tester);
      await openSheet(tester);
      await tester.tap(find.byKey(const Key('plan-approve')));
      await transition(tester);
      expect(find.byKey(const Key('plan-error')), findsOneWidget);
      expect(buttonEnabled(tester, 'plan-approve'), isTrue);
    });

    testWidgets('他端先决定且本端没有提交：打开的 sheet 提示没有待批准计划', (tester) async {
      await pumpPlan(tester);
      await openSheet(tester);
      h.planRecords['v-plan-1'] = planJson(status: 'approved', settledAt: 9);
      h.api.notify('plan.changed', <String, dynamic>{
        'subscriptionId': 'chat-1',
        'revision': 3,
      });
      await transition(tester);
      expect(find.byKey(const Key('plan-gone')), findsOneWidget);
      expect(find.byKey(const Key('plan-approve')), findsNothing);
    });
  });

  group('布局', () {
    testWidgets('窄屏大字体下不溢出，按钮触控高度足够', (tester) async {
      tester.view
        ..physicalSize = const Size(320, 640)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await pumpPlan(
        tester,
        record: planJson(
          title: '很长很长的计划标题' * 6,
          steps: <String>[for (var i = 0; i < 12; i++) '很长的步骤说明' * 12],
          note: '很长的说明' * 40,
        ),
        textScale: 1.5,
      );
      await openSheet(tester);
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('plan-approve')), findsOneWidget);
      expect(
        tester.getSize(find.byKey(const Key('plan-approve'))).height,
        greaterThanOrEqualTo(40),
      );
    });
  });
}
