import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/features/chat/transcript.dart';
import 'package:neko_mobile/features/plan/plan_decision.dart';

import '../../helpers/fake_api.dart';

/// 计划协议 fixtures（与 gateway 共用的锚点）的 Dart 解析对拍。
void main() {
  group('hello 能力', () {
    test('hello-result fixture 声明 plan，且旧能力保持不变', () {
      final result = asJson(fixtureMessage('hello-result.json')['result']);
      final capabilities = (result['capabilities'] as List).cast<String>();
      expect(capabilities, contains('plan'));
      expect(
        capabilities,
        containsAll(<String>['workspaces', 'sessions', 'chat', 'questions']),
      );
    });
  });

  group('plan.get / plan.respond', () {
    test('plan.get 结果：标题、有序步骤、说明与待批准状态', () {
      final plan = PlanRecord.fromJson(
        asJson(fixtureMessage('plan-get-result.json')['result']),
      );
      expect(plan.version, 'b7e2a9c4-51d8-4c3a-8f60-2d9e7a1c0b34');
      expect(plan.title, '为登录页增加记住我开关');
      expect(plan.steps, hasLength(3));
      expect(plan.steps.first, '阅读登录表单与会话配置');
      expect(plan.note, '默认保持关闭，不改变现有会话时长。');
      expect(plan.status, PlanStatus.awaitingApproval);
      expect(plan.awaiting, isTrue);
      expect(plan.feedback, isNull);
      expect(plan.settledAt, isNull);
    });

    test('plan.respond 结果：已保存的终态与反馈', () {
      final plan = PlanRecord.fromJson(
        asJson(fixtureMessage('plan-respond-result.json')['result']),
      );
      expect(plan.status, PlanStatus.revisionRequested);
      expect(plan.awaiting, isFalse);
      expect(plan.feedback, '第二步先不要改 cookie，只加开关和测试');
      expect(plan.settledAt, 1730100060000);
    });

    test('请求形状与 PlanDecision 编码一致', () {
      final get = fixtureMessage('plan-get-request.json');
      expect(get['method'], 'plan.get');
      expect(asJson(get['params']).keys, <String>['subscriptionId', 'version']);
      final respond = fixtureMessage('plan-respond-request.json');
      expect(respond['method'], 'plan.respond');
      final params = asJson(respond['params']);
      expect(params.keys, <String>['subscriptionId', 'version', 'decision']);
      expect(
        params['decision'],
        const RevisePlan('第二步先不要改 cookie，只加开关和测试').toJson(),
      );
      expect(const ApprovePlan().toJson(), <String, Object?>{
        'kind': 'approve',
      });
    });

    test('未知状态按已取消处理，缺失字段不抛错', () {
      expect(
        PlanRecord.fromJson(<String, dynamic>{'status': 'future'}).status,
        PlanStatus.cancelled,
      );
      final empty = PlanRecord.fromJson(<String, dynamic>{});
      expect(empty.steps, isEmpty);
      expect(empty.awaiting, isFalse);
    });

    test('plan.changed 通知形状', () {
      final params = asJson(
        fixtureMessage('plan-changed-notification.json')['params'],
      );
      expect(params['subscriptionId'], 'chat-1a2b3c4d-1');
      expect(params['revision'], 4);
    });

    test('修改意见：全空白与超长被拒绝，边界内通过', () {
      expect(feedbackProblem(''), isNotNull);
      expect(feedbackProblem('  \n\t'), isNotNull);
      expect(feedbackProblem('a'), isNull);
      expect(feedbackProblem('x' * PlanLimits.feedbackChars), isNull);
      expect(feedbackProblem('x' * (PlanLimits.feedbackChars + 1)), isNotNull);
    });
  });

  group('状态摘要', () {
    test('chat.attach 快照：plan 摘要带 revision、待批准与版本', () {
      final result = asJson(
        fixtureMessage('chat-attach-result.json')['result'],
      );
      final transcript = Transcript()
        ..applySnapshot(asJson(result['snapshot']));
      final plan = transcript.status.plan!;
      expect(plan.revision, 3);
      expect(plan.pending, isTrue);
      expect(plan.version, 'b7e2a9c4-51d8-4c3a-8f60-2d9e7a1c0b34');
    });

    test('缺省 = 旧电脑；存在且 pending=false = 支持但无待批准计划', () {
      expect(ChatStatus.fromJson(<String, dynamic>{}).plan, isNull);
      final plan = ChatStatus.fromJson(<String, dynamic>{
        'plan': <String, dynamic>{'revision': 0, 'pending': false},
      }).plan!;
      expect((plan.revision, plan.pending, plan.version), (0, false, null));
    });
  });

  group('会话列表', () {
    test('sessions.list fixture：awaitingPlan 三态', () {
      final sessions = asJsonList(
        asJson(
          fixtureMessage('sessions-list-result.json')['result'],
        )['sessions'],
      ).map(SessionSummary.fromJson).toList();
      expect(sessions.first.awaitingPlan, isNull);
      expect(sessions.first.waitingForPlan, isFalse);
      expect(sessions.last.awaitingPlan, isTrue);
      expect(sessions.last.waitingForPlan, isTrue);
    });

    test('非布尔值按“无法判断”处理', () {
      final session = SessionSummary.fromJson(<String, dynamic>{
        'id': '1',
        'workspace': '/w',
        'awaitingPlan': 'yes',
      });
      expect(session.awaitingPlan, isNull);
    });
  });

  group('tool.interaction', () {
    test('submit_plan 的结构化历史当前不生成 interaction，工具项照常解析', () {
      final tool = ToolInfo.fromJson(<String, dynamic>{
        'callId': 'c',
        'name': 'submit_plan',
        'summary': 's',
        'status': 'done',
        'interaction': <String, dynamic>{
          'kind': 'submit_plan',
          'version': 'v',
          'title': 't',
          'steps': <String>['a'],
          'note': '',
        },
      });
      expect(tool.name, 'submit_plan');
      expect(tool.interaction, isNull);
    });
  });
}
