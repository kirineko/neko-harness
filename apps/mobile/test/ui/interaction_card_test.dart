import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/features/chat/transcript.dart';
import 'package:neko_mobile/ui/theme.dart';
import 'package:neko_mobile/ui/widgets/transcript_view.dart';

import '../helpers/fake_api.dart';

class _Actions implements TranscriptActions {
  _Actions(this.transcript);

  @override
  final Transcript transcript;

  @override
  bool loadingOlder = false;

  @override
  Future<void> loadOlder() async {}

  @override
  Future<void> expand(ChatItem item, ContentRef ref) async {}

  @override
  Future<Uint8List> image(ImageRef image) async => Uint8List(0);
}

Map<String, dynamic> _askItem({
  String status = 'pending',
  String question = '使用哪种数据库？',
  List<String> optionIds = const <String>[],
  List<String> labels = const <String>[],
  String? text,
  String toolStatus = 'running',
}) => <String, dynamic>{
  'key': 't-ask',
  'type': 'tool',
  'tool': <String, dynamic>{
    'callId': 'call_612',
    'name': 'ask_user',
    'summary': 'ask_user（模型文案，不应被解析）',
    'status': toolStatus,
    'result': 'The user answered. 原始英文文案不应出现在卡片里',
    'interaction': <String, dynamic>{
      'kind': 'ask_user',
      'id': 612,
      'question': question,
      'multiple': false,
      'options': <Object>[
        <String, dynamic>{
          'id': 'pg',
          'label': 'PostgreSQL',
          'recommended': true,
        },
        <String, dynamic>{'id': 'lite', 'label': 'SQLite'},
      ],
      'status': status,
      'optionIds': optionIds,
      'labels': labels,
      'text': text,
    },
  },
};

Map<String, dynamic> _todoItem(String action) => <String, dynamic>{
  'key': 't-todo',
  'type': 'tool',
  'tool': <String, dynamic>{
    'callId': 'call_todo',
    'name': 'todo',
    'summary': 'todo',
    'status': 'done',
    'result': 'Todo list, revision 4',
    'interaction': <String, dynamic>{
      'kind': 'todo',
      'action': action,
      'revision': 4,
      'completed': 1,
      'total': 3,
    },
  },
};

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> item, {
  void Function(int id)? onOpenQuestion,
}) async {
  final transcript = Transcript()
    ..applySnapshot(snapshotOf(<Map<String, dynamic>>[item]));
  await tester.pumpWidget(
    MaterialApp(
      theme: buildNekoTheme(Brightness.light),
      home: Scaffold(
        body: TranscriptView(
          actions: _Actions(transcript),
          onOpenQuestion: onOpenQuestion,
        ),
      ),
    ),
  );
  await tester.pump();
}

/// 转录里的 ask_user / todo 工具项：状态与答案来自结构化 `tool.interaction`，只读、没有回答控件。
void main() {
  testWidgets('ask_user 等待回答：标题、状态与问题；展开后只读，可定位到问题面板', (tester) async {
    int? opened;
    await _pump(tester, _askItem(), onOpenQuestion: (id) => opened = id);
    expect(find.text('助手提问'), findsOneWidget);
    expect(find.text('等待回答 · 使用哪种数据库？'), findsOneWidget);
    expect(find.textContaining('模型文案'), findsNothing);

    await tester.tap(find.text('助手提问'));
    await tester.pump();
    expect(find.byKey(const Key('interaction-question')), findsOneWidget);
    expect(find.text('· PostgreSQL（推荐）'), findsOneWidget);
    expect(find.text('· SQLite'), findsOneWidget);
    expect(find.byKey(const Key('interaction-status')), findsOneWidget);
    expect(find.text('等待回答'), findsOneWidget);
    expect(find.textContaining('原始英文文案'), findsNothing);
    // 没有任何回答控件。
    expect(find.byType(FilledButton), findsNothing);
    expect(find.byType(TextField), findsNothing);
    expect(find.byKey(const Key('question-submit')), findsNothing);
    // 只有一个“查看问题”入口，打开的是问题面板。
    await tester.tap(find.byKey(const Key('open-question-612')));
    expect(opened, 612);
  });

  testWidgets('没有提供 onOpenQuestion（如子 agent 页）时不出现入口', (tester) async {
    await _pump(tester, _askItem());
    await tester.tap(find.text('助手提问'));
    await tester.pump();
    expect(find.byKey(const Key('open-question-612')), findsNothing);
  });

  testWidgets('已回答：摘要与展开都显示标签与文字；选中项带勾', (tester) async {
    await _pump(
      tester,
      _askItem(
        status: 'answered',
        optionIds: <String>['lite'],
        labels: <String>['SQLite'],
        text: '先用 SQLite',
        toolStatus: 'done',
      ),
    );
    expect(find.text('已回答 · 使用哪种数据库？ · SQLite · 先用 SQLite'), findsOneWidget);
    await tester.tap(find.text('助手提问'));
    await tester.pump();
    expect(find.text('✓ SQLite'), findsOneWidget);
    expect(find.text('· PostgreSQL（推荐）'), findsOneWidget);
    expect(find.text('已回答：SQLite · 先用 SQLite'), findsOneWidget);
    expect(find.byKey(const Key('open-question-612')), findsNothing);
  });

  testWidgets('已跳过：摘要与展开', (tester) async {
    await _pump(tester, _askItem(status: 'skipped', toolStatus: 'done'));
    expect(find.text('已跳过 · 使用哪种数据库？'), findsOneWidget);
    await tester.tap(find.text('助手提问'));
    await tester.pump();
    expect(find.text('已跳过，未提供答案'), findsOneWidget);
  });

  testWidgets('已取消：摘要与展开', (tester) async {
    await _pump(tester, _askItem(status: 'cancelled', toolStatus: 'error'));
    expect(find.text('已取消 · 使用哪种数据库？'), findsOneWidget);
    await tester.tap(find.text('助手提问'));
    await tester.pump();
    expect(find.text('已取消'), findsOneWidget);
  });

  testWidgets('问题与选项在转录里同样是纯文本', (tester) async {
    await _pump(
      tester,
      _askItem(question: '<b>粗体</b> [链接](https://evil.example)\n第二行'),
    );
    await tester.tap(find.text('助手提问'));
    await tester.pump();
    final question = tester.widget<Text>(
      find.byKey(const Key('interaction-question')),
    );
    expect(question.data, '<b>粗体</b> [链接](https://evil.example)\n第二行');
    expect(question.textSpan, isNull);
  });

  testWidgets('todo 工具项：动作、进度与修订来自结构化状态', (tester) async {
    await _pump(tester, _todoItem('replace'));
    expect(find.text('todo'), findsOneWidget);
    expect(find.text('更新 todo · 已完成 1/3（修订 4）'), findsOneWidget);
    await _pump(tester, _todoItem('list'));
    expect(find.text('读取 todo · 已完成 1/3（修订 4）'), findsOneWidget);
    expect(find.textContaining('Todo list, revision'), findsNothing);
  });

  testWidgets('窄屏大字体下转录卡片不溢出', (tester) async {
    tester.view
      ..physicalSize = const Size(320, 640)
      ..devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final transcript = Transcript()
      ..applySnapshot(
        snapshotOf(<Map<String, dynamic>>[
          _askItem(
            status: 'answered',
            question: '这是一道很长的问题。' * 60,
            optionIds: <String>['lite'],
            labels: <String>['SQLite'],
            text: '很长的补充说明' * 40,
            toolStatus: 'done',
          ),
          _todoItem('replace'),
        ]),
      );
    await tester.pumpWidget(
      MaterialApp(
        theme: buildNekoTheme(Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          body: TranscriptView(
            actions: _Actions(transcript),
            onOpenQuestion: (_) {},
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.text('助手提问'));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });
}
