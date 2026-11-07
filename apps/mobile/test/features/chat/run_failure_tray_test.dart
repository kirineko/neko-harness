import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/api/models.dart';

import '../../helpers/chat_harness.dart';
import '../../helpers/fake_api.dart';

void main() {
  test('chat.patch 夹具的 status 携带 runFailure；缺省表示没有或旧电脑', () {
    final params =
        fixtureMessage('chat-patch-run-failure-notification.json')['params']
            as Map<String, dynamic>;
    final status = ChatStatus.fromJson(
      params['status'] as Map<String, dynamic>,
    );
    expect(status.runFailure?.reason, 'model_error');
    expect(status.runFailure?.detail, '401 Unauthorized: invalid API key');
    expect(
      ChatStatus.fromJson(<String, dynamic>{'busy': false}).runFailure,
      isNull,
    );
  });

  group('失败提示', () {
    late ChatHarness h;

    setUp(() => h = ChatHarness());
    tearDown(() => h.dispose());

    testWidgets('空闲且有失败原因时显示本地化原因与详情，不提供继续', (tester) async {
      h.snapshot = <String, dynamic>{
        ...snapshotOf(<Map<String, dynamic>>[userItem('u-1', 'x')]),
        'runFailure': <String, dynamic>{
          'reason': 'model_error',
          'detail': '401\ninvalid key',
        },
      };
      await h.bind();
      await tester.pumpWidget(h.build());
      await settle(tester);
      expect(find.byKey(const Key('run-failure')), findsOneWidget);
      expect(find.text('模型请求失败: 401 invalid key'), findsOneWidget);
      expect(find.text('继续'), findsNothing);
    });

    testWidgets('运行中或旧电脑（无 runFailure）不显示', (tester) async {
      h.snapshot = <String, dynamic>{
        ...snapshotOf(<Map<String, dynamic>>[userItem('u-1', 'x')], busy: true),
        'runFailure': <String, dynamic>{'reason': 'aborted'},
      };
      await h.bind();
      await tester.pumpWidget(h.build());
      await settle(tester);
      expect(find.byKey(const Key('run-failure')), findsNothing);
    });

    testWidgets('未知原因按代码原样显示', (tester) async {
      h.snapshot = <String, dynamic>{
        ...snapshotOf(<Map<String, dynamic>>[userItem('u-1', 'x')]),
        'runFailure': <String, dynamic>{'reason': 'brand_new'},
      };
      await h.bind();
      await tester.pumpWidget(h.build());
      await settle(tester);
      expect(find.text('brand_new'), findsOneWidget);
    });
  });
}
