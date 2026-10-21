import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/chat/interactions_controller.dart';
import 'package:neko_mobile/features/plan/plan_decision.dart';

import '../../helpers/fake_api.dart';
import '../../helpers/interaction_data.dart';

class _Env {
  _Env() {
    api
      ..on('chat.attach', (params) {
        attached++;
        return <String, dynamic>{
          'subscriptionId': 'chat-$attached',
          'sessionId': params!['sessionId'],
          'snapshot': snapshot,
        };
      })
      ..on('approvals.list', (_) => <String, dynamic>{'approvals': <Object>[]})
      ..on(
        'chat.submissionStatus',
        (_) => <String, dynamic>{'status': 'unknown'},
      )
      ..on('todos.get', (_) => todoListJson(1, <Map<String, dynamic>>[]))
      ..on(
        'questions.list',
        (_) => questionListJson(1, <Map<String, dynamic>>[]),
      )
      ..on('plan.get', (params) {
        final record = plans[params!['version']];
        if (record == null) throw const MobileApiException('not_found', '');
        return record;
      });
  }

  final FakeMobileApi api = FakeMobileApi();
  final InMemoryPrefsStore prefs = InMemoryPrefsStore();
  late final ChatController chat = ChatController(prefs: prefs);
  int attached = 0;
  Map<String, dynamic> snapshot = snapshotWith(
    plan: planSummaryJson(revision: 0, pending: false, version: null),
  );
  final Map<String, Map<String, dynamic>> plans =
      <String, Map<String, dynamic>>{};

  InteractionsController get x => chat.interactions;

  Future<void> bind({Iterable<String> caps = kPlanCaps}) async {
    await chat.bind(api, 'srv', capabilities: caps);
    await chat.attach('7');
    await pumpEventQueue();
  }

  /// 把脚本化数据设为“一份待批准计划”，并让快照携带它。
  Map<String, dynamic> awaiting({
    String version = 'v-plan-1',
    int revision = 2,
  }) {
    final record = planJson(version: version);
    plans[version] = record;
    snapshot = snapshotWith(
      plan: planSummaryJson(revision: revision, version: version),
    );
    return record;
  }

  void status(Map<String, dynamic> plan, {String subscription = 'chat-1'}) =>
      api.notify('chat.patch', <String, dynamic>{
        'subscriptionId': subscription,
        'seq': ++_seq,
        'upserts': <Object>[],
        'status': <String, dynamic>{
          ...(snapshot..remove('items')),
          'plan': plan,
        },
      });

  void notify(int revision, {String subscription = 'chat-1'}) => api.notify(
    'plan.changed',
    <String, dynamic>{'subscriptionId': subscription, 'revision': revision},
  );

  int _seq = 0;

  Future<void> dispose() async {
    chat.dispose();
    await api.close();
  }
}

int _calls(_Env env, String method) => env.api.callsOf(method).length;

void main() {
  late _Env env;

  setUp(() => env = _Env());
  tearDown(() => env.dispose());

  group('能力协商', () {
    test('旧电脑（hello 无 plan）：不调用 plan.*，通知与状态摘要也不触发读取', () async {
      env.awaiting();
      await env.bind(caps: const <String>['chat', 'todos', 'questions']);
      expect(env.x.planSupported, isFalse);
      expect(env.x.planShown, isNull);
      env.notify(9);
      env.status(planSummaryJson(revision: 9));
      await pumpEventQueue();
      expect(_calls(env, 'plan.get'), 0);
      await env.x.respondPlan(
        PlanRecord.fromJson(planJson()),
        const ApprovePlan(),
      );
      expect(_calls(env, 'plan.respond'), 0);
    });

    test('支持但没有计划：不读取，卡片隐藏', () async {
      await env.bind();
      expect(env.x.planSupported, isTrue);
      expect(_calls(env, 'plan.get'), 0);
      expect(env.x.planShown, isNull);
    });

    test('电脑支持但摘要缺省（旧网关）：不读取，不显示', () async {
      env.snapshot = snapshotWith();
      await env.bind();
      expect(_calls(env, 'plan.get'), 0);
      expect(env.x.planShown, isNull);
    });
  });

  group('读取', () {
    test('attach 后按摘要里的版本读取一次，参数带当前订阅', () async {
      env.awaiting();
      await env.bind();
      expect(env.api.callsOf('plan.get'), <Map<String, Object?>>[
        <String, Object?>{'subscriptionId': 'chat-1', 'version': 'v-plan-1'},
      ]);
      final shown = env.x.planShown!;
      expect(shown.awaiting, isTrue);
      expect(shown.title, '为登录页增加记住我开关');
    });

    test('plan.changed 与状态摘要变化触发再读；相同摘要不重复读取', () async {
      env.awaiting();
      await env.bind();
      expect(_calls(env, 'plan.get'), 1);
      env.status(planSummaryJson(revision: 2));
      await pumpEventQueue();
      expect(_calls(env, 'plan.get'), 1);

      // 他端要求修改：摘要不再待批准，卡片隐藏。
      env.plans['v-plan-1'] = planJson(
        status: 'revision_requested',
        feedback: '缩小范围',
        settledAt: 1,
      );
      env.notify(3);
      env.status(planSummaryJson(revision: 3, pending: false));
      await pumpEventQueue();
      expect(env.x.planShown, isNull);
      expect(_calls(env, 'plan.get'), greaterThanOrEqualTo(2));
    });

    test('新版本出现：读取新版本并显示', () async {
      env.awaiting();
      await env.bind();
      env.plans['v-plan-2'] = planJson(version: 'v-plan-2', title: '第二版');
      env.status(planSummaryJson(revision: 4, version: 'v-plan-2'));
      await pumpEventQueue();
      expect(env.x.planShown!.title, '第二版');
    });

    test('已读到结算状态的记录不会被过期的待批准读取退回', () async {
      env.awaiting();
      await env.bind();
      env.plans['v-plan-1'] = planJson(status: 'approved', settledAt: 1);
      env.notify(3);
      await pumpEventQueue();
      expect(env.x.planShown, isNull);
      env.plans['v-plan-1'] = planJson();
      env.notify(3);
      await pumpEventQueue();
      expect(env.x.planShown, isNull);
    });

    test('读取失败（not_found）时隐藏卡片，其他错误保留并可重试', () async {
      env.awaiting();
      env.plans.clear();
      await env.bind();
      expect(env.x.planShown, isNull);
      expect(env.x.planLoadError, isNull);

      env.api.on('plan.get', (_) => throw const RpcNetworkException());
      env.notify(5);
      await pumpEventQueue();
      expect(env.x.planLoadError, isNotNull);
    });

    test('旧订阅的通知被忽略', () async {
      env.awaiting();
      await env.bind();
      env.notify(9, subscription: 'chat-old');
      await pumpEventQueue();
      expect(_calls(env, 'plan.get'), 1);
    });
  });

  group('决定', () {
    PlanRecord shown(_Env e) => e.x.planShown!;

    test('批准：携带订阅与版本，收到回执后显示已批准', () async {
      env.awaiting();
      env.api.on('plan.respond', (params) {
        env.plans['v-plan-1'] = planJson(status: 'approved', settledAt: 9);
        return env.plans['v-plan-1'];
      });
      await env.bind();
      await env.x.respondPlan(shown(env), const ApprovePlan());
      expect(env.api.callsOf('plan.respond'), <Map<String, Object?>>[
        <String, Object?>{
          'subscriptionId': 'chat-1',
          'version': 'v-plan-1',
          'decision': <String, Object?>{'kind': 'approve'},
        },
      ]);
      expect(env.x.planShown!.status, PlanStatus.approved);
      expect(env.x.planNote, isNull);
      expect(env.x.planSubmitting, isFalse);
      env.x.dismissPlan();
      expect(env.x.planShown, isNull);
    });

    test('提交期间禁止重复提交，只产生一次请求', () async {
      env.awaiting();
      final gate = Completer<void>();
      env.api.on('plan.respond', (_) async {
        await gate.future;
        return planJson(status: 'approved', settledAt: 9);
      });
      await env.bind();
      final plan = shown(env);
      final first = env.x.respondPlan(plan, const ApprovePlan());
      await pumpEventQueue();
      expect(env.x.planSubmitting, isTrue);
      await env.x.respondPlan(plan, const ApprovePlan());
      await env.x.respondPlan(plan, const RevisePlan('再改改'));
      gate.complete();
      await first;
      expect(_calls(env, 'plan.respond'), 1);
    });

    test('他端先要求修改：显示实际保存的状态与反馈，并给出说明', () async {
      env.awaiting();
      env.api.on(
        'plan.respond',
        (_) => planJson(
          status: 'revision_requested',
          feedback: '桌面端先改了',
          settledAt: 9,
        ),
      );
      await env.bind();
      await env.x.respondPlan(shown(env), const ApprovePlan());
      final result = env.x.planShown!;
      expect(result.status, PlanStatus.revisionRequested);
      expect(result.feedback, '桌面端先改了');
      expect(env.x.planNote, isNotNull);
    });

    test('要求修改：反馈原样提交；空白与超长在本地拒绝且不发请求', () async {
      env.awaiting();
      env.api.on(
        'plan.respond',
        (params) => planJson(
          status: 'revision_requested',
          feedback: (params!['decision'] as Map)['feedback'] as String,
          settledAt: 9,
        ),
      );
      await env.bind();
      await env.x.respondPlan(shown(env), const RevisePlan('  '));
      await env.x.respondPlan(
        shown(env),
        RevisePlan('x' * (PlanLimits.feedbackChars + 1)),
      );
      expect(_calls(env, 'plan.respond'), 0);
      expect(env.x.planError, isNotNull);

      await env.x.respondPlan(shown(env), const RevisePlan(' 只加开关 '));
      expect(
        (env.api.callsOf('plan.respond').single!['decision']
            as Map)['feedback'],
        ' 只加开关 ',
      );
      expect(env.x.planShown!.status, PlanStatus.revisionRequested);
      expect(env.x.planNote, isNull);
    });

    test('已取消的计划：迟到的批准得到已保存的取消状态', () async {
      env.awaiting();
      env.api.on(
        'plan.respond',
        (_) => planJson(status: 'cancelled', settledAt: 9),
      );
      await env.bind();
      await env.x.respondPlan(shown(env), const ApprovePlan());
      expect(env.x.planShown!.status, PlanStatus.cancelled);
      expect(env.x.planNote, isNotNull);
    });

    test('rejected：显示错误并重读真实状态，不做乐观结果', () async {
      env.awaiting();
      env.api.on(
        'plan.respond',
        (_) => throw const MobileApiException('rejected', '会话正在运行'),
      );
      await env.bind();
      await env.x.respondPlan(shown(env), const ApprovePlan());
      expect(env.x.planError, isNotNull);
      expect(env.x.planShown!.awaiting, isTrue);
      expect(_calls(env, 'plan.get'), 2);
    });

    test('无回执：提示结果未知，保留卡片，不自动重发', () async {
      env.awaiting();
      env.api.on('plan.respond', (_) => throw const RpcNetworkException());
      await env.bind();
      await env.x.respondPlan(shown(env), const ApprovePlan());
      expect(env.x.planError, InteractionsController.planNoReceiptMessage);
      expect(env.x.planShown!.awaiting, isTrue);
      expect(_calls(env, 'plan.respond'), 1);
    });

    test('断线时在途决定标记为无回执；重连后重新读取', () async {
      env.awaiting();
      final gate = Completer<void>();
      env.api.on('plan.respond', (_) async {
        await gate.future;
        return planJson(status: 'approved', settledAt: 9);
      });
      await env.bind();
      final pending = env.x.respondPlan(shown(env), const ApprovePlan());
      await pumpEventQueue();
      env.chat.unbind();
      expect(env.x.planSubmitting, isFalse);
      expect(env.x.planError, InteractionsController.planNoReceiptMessage);
      gate.complete();
      await pending;
      // 旧订阅的回执不会写入当前状态。
      expect(env.x.planShown!.status, PlanStatus.awaitingApproval);
      await env.chat.bind(env.api, 'srv', capabilities: kPlanCaps);
      await pumpEventQueue();
      expect(_calls(env, 'plan.get'), 2);
    });

    test('修改意见草稿按版本保存在内存里', () async {
      env.awaiting();
      await env.bind();
      env.x.savePlanFeedback(shown(env), '先别动 cookie');
      expect(env.x.planFeedbackDraft(shown(env)), '先别动 cookie');
      env.x.savePlanFeedback(shown(env), '');
      expect(env.x.planFeedbackDraft(shown(env)), '');
    });
  });

  group('退出计划模式', () {
    test('旧电脑（无 plan 能力）：不调用 plan.exit', () async {
      env.awaiting();
      await env.bind(caps: const <String>['chat', 'todos', 'questions']);
      await env.x.exitPlan();
      expect(_calls(env, 'plan.exit'), 0);
    });

    test('收到回执后重读：计划被取消，卡片隐藏', () async {
      env.awaiting();
      env.api.on('plan.exit', (_) {
        env.plans['v-plan-1'] = planJson(status: 'cancelled', settledAt: 9);
        return <String, dynamic>{'mode': 'normal', 'revision': 3};
      });
      await env.bind();
      await env.x.exitPlan();
      expect(env.api.callsOf('plan.exit'), <Map<String, Object?>>[
        <String, Object?>{'subscriptionId': 'chat-1'},
      ]);
      expect(env.x.planShown, isNull);
      expect(env.x.planError, isNull);
      expect(env.x.planSubmitting, isFalse);
    });

    test('提交期间禁止重复请求；批准/修改也被挡住', () async {
      env.awaiting();
      final gate = Completer<void>();
      env.api.on('plan.exit', (_) async {
        await gate.future;
        return <String, dynamic>{'mode': 'normal', 'revision': 3};
      });
      await env.bind();
      final plan = env.x.planShown!;
      final first = env.x.exitPlan();
      await pumpEventQueue();
      expect(env.x.planSubmitting, isTrue);
      await env.x.exitPlan();
      await env.x.respondPlan(plan, const ApprovePlan());
      gate.complete();
      await first;
      expect(_calls(env, 'plan.exit'), 1);
      expect(_calls(env, 'plan.respond'), 0);
    });

    test('rejected：显示错误并重读真实状态，不做乐观结果', () async {
      env.awaiting();
      env.api.on(
        'plan.exit',
        (_) => throw const MobileApiException('rejected', '会话正在运行'),
      );
      await env.bind();
      await env.x.exitPlan();
      expect(env.x.planError, isNotNull);
      expect(env.x.planShown!.awaiting, isTrue);
      expect(_calls(env, 'plan.get'), 2);
    });

    test('无回执：提示结果未知，保留卡片，不自动重发', () async {
      env.awaiting();
      env.api.on('plan.exit', (_) => throw const RpcNetworkException());
      await env.bind();
      await env.x.exitPlan();
      expect(env.x.planError, InteractionsController.planNoReceiptMessage);
      expect(env.x.planShown!.awaiting, isTrue);
      expect(_calls(env, 'plan.exit'), 1);
    });
  });

  group('会话切换', () {
    test('切换会话清空计划内容', () async {
      env.awaiting();
      await env.bind();
      expect(env.x.planShown, isNotNull);
      env.snapshot = snapshotWith(
        plan: planSummaryJson(revision: 0, pending: false, version: null),
      );
      await env.chat.attach('8');
      await pumpEventQueue();
      expect(env.x.planShown, isNull);
    });
  });
}
