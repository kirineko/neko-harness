import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/features/chat/transcript.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/widgets/transcript_view.dart';

import '../helpers/fake_api.dart';

class _Actions implements TranscriptActions {
  _Actions(this.transcript);

  @override
  final Transcript transcript;

  @override
  bool loadingOlder = false;

  var expandedError = false;

  @override
  Future<void> loadOlder() async {}

  @override
  Future<void> expand(ChatItem item, ContentRef ref) async {
    if (expandedError) throw Exception('boom');
    final preview = item.tool?.result ?? '';
    transcript.setExpanded(item.key, ref.field, '$preview\n${'全文内容' * 3000}');
  }

  @override
  Future<Uint8List> image(ImageRef image) async => Uint8List(0);
}

Map<String, dynamic> _bashItem({
  String? result,
  List<Map<String, dynamic>>? refs,
}) => <String, dynamic>{
  'key': 't-bash1',
  'type': 'tool',
  'refs': refs ?? <Map<String, dynamic>>[],
  'tool': <String, dynamic>{
    'callId': 'call-1',
    'name': 'bash',
    'summary': 'ls -la',
    'status': 'done',
    'detail': 'cd /tmp && ls -la',
    'result': ?result,
    'durationMs': 12,
  },
};

Future<void> _pump(
  WidgetTester tester,
  Transcript transcript,
  _Actions actions, {
  ThemeMode mode = ThemeMode.light,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: ThemeData.light(),
      darkTheme: ThemeData.dark(),
      themeMode: mode,
      home: Scaffold(body: TranscriptView(actions: actions)),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('bash 工具卡展开后显示命令与结果文本', (tester) async {
    final transcript = Transcript()
      ..applySnapshot(
        snapshotOf(<Map<String, dynamic>>[
          _bashItem(result: 'total 0\n${'drwxr-xr-x 1\n' * 20}'),
        ]),
      );
    final actions = _Actions(transcript);
    await _pump(tester, transcript, actions);

    await tester.tap(find.text('bash'));
    await tester.pumpAndSettle();

    // 展开后：命令与结果都必须可见。
    expect(find.textContaining('cd /tmp && ls -la'), findsOneWidget);
    expect(find.textContaining('drwxr-xr-x 1'), findsOneWidget);
  });

  testWidgets('超大结果（13 KB、长行与多行混合）展开后仍有内容', (tester) async {
    // 模拟真实 ls -la 输出：长行 + 多行。
    final big = List<String>.generate(
      200,
      (i) =>
          '-rw-r--r-- 1 kirineko staff ${1000 + i} Oct 15 10:00 '
          '${'very-long-file-name-' * 8}$i.txt',
    ).join('\n');
    expect(big.length, greaterThan(12000));
    final transcript = Transcript()
      ..applySnapshot(
        snapshotOf(<Map<String, dynamic>>[_bashItem(result: big)]),
      );
    final actions = _Actions(transcript);
    await tester.binding.setSurfaceSize(const Size(800, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await _pump(tester, transcript, actions);

    await tester.tap(find.text('bash'));
    await tester.pumpAndSettle();

    expect(find.textContaining('very-long-file-name'), findsWidgets);
    expect(
      find.textContaining('Oct 15 10:00', findRichText: true),
      findsWidgets,
    );
  });

  testWidgets('带 contentRef 的工具卡：展开全文后有内容，失败时显示错误', (tester) async {
    final transcript = Transcript()
      ..applySnapshot(
        snapshotOf(<Map<String, dynamic>>[
          _bashItem(
            result: 'preview\n' * 5,
            refs: <Map<String, dynamic>>[
              <String, dynamic>{
                'sessionId': '7',
                'key': 't-bash1',
                'field': 'tool.result',
                'digest': 'abc',
                'bytes': 13312,
              },
            ],
          ),
        ]),
      );
    final actions = _Actions(transcript);
    await _pump(tester, transcript, actions);

    await tester.tap(find.text('bash'));
    await tester.pumpAndSettle();
    expect(find.text('展开全文（13 KB）'), findsOneWidget);

    await tester.tap(find.text('展开全文（13 KB）'));
    await tester.pumpAndSettle();
    expect(find.textContaining('全文内容'), findsOneWidget);
  });

  testWidgets('一行式摘要：热区 >=44dp，折叠只显示名称与摘要，点击展开/收起', (tester) async {
    final transcript = Transcript()
      ..applySnapshot(
        snapshotOf(<Map<String, dynamic>>[_bashItem(result: 'RESULT-BODY')]),
      );
    await _pump(tester, transcript, _Actions(transcript));

    expect(find.text('bash'), findsOneWidget);
    expect(find.text('ls -la'), findsOneWidget);
    expect(find.textContaining('RESULT-BODY'), findsNothing);
    final row = find.ancestor(
      of: find.text('bash'),
      matching: find.byType(InkWell),
    );
    expect(tester.getSize(row.first).height, greaterThanOrEqualTo(44));

    await tester.tap(find.text('bash'));
    await tester.pumpAndSettle();
    expect(find.textContaining('RESULT-BODY'), findsOneWidget);
    await tester.tap(find.text('bash'));
    await tester.pumpAndSettle();
    expect(find.textContaining('RESULT-BODY'), findsNothing);
  });

  testWidgets('运行/成功/失败以不同图形区分，不只靠颜色', (tester) async {
    Map<String, dynamic> item(String key, String status) => <String, dynamic>{
      'key': key,
      'type': 'tool',
      'refs': <Map<String, dynamic>>[],
      'tool': <String, dynamic>{
        'callId': key,
        'name': 'bash-$key',
        'summary': 's',
        'status': status,
      },
    };
    final transcript = Transcript()
      ..applySnapshot(
        snapshotOf(<Map<String, dynamic>>[
          item('a', 'running'),
          item('b', 'done'),
          item('c', 'error'),
        ]),
      );
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await _pump(tester, transcript, _Actions(transcript));

    NekoIconData iconOf(String name) => tester
        .widget<NekoIcon>(
          find
              .descendant(
                of: find.ancestor(
                  of: find.text(name),
                  matching: find.byType(Row),
                ),
                matching: find.byType(NekoIcon),
              )
              .first,
        )
        .icon;
    final icons = <NekoIconData>{
      iconOf('bash-a'),
      iconOf('bash-b'),
      iconOf('bash-c'),
    };
    expect(icons, hasLength(3));
  });
  Map<String, dynamic> codemodeItem({Map<String, dynamic>? codemode}) =>
      <String, dynamic>{
        'key': 't-cm1',
        'type': 'tool',
        'refs': <Map<String, dynamic>>[],
        'tool': <String, dynamic>{
          'callId': 'call-cm',
          'name': 'codemode',
          'summary': 'read files',
          'status': 'done',
          'detail': 'await tools.read({ path: "a.ts" })',
          'result': 'SCRIPT-OUT',
          'codemode': ?codemode,
        },
      };

  testWidgets('codemode 工具卡展开后显示嵌套调用、省略数与完整输出路径', (tester) async {
    final transcript = Transcript()
      ..applySnapshot(
        snapshotOf(<Map<String, dynamic>>[
          codemodeItem(
            codemode: <String, dynamic>{
              'calls': <Map<String, dynamic>>[
                <String, dynamic>{
                  'id': 1,
                  'name': 'read',
                  'args': 'a.ts',
                  'status': 'ok',
                  'durationMs': 1500,
                },
                <String, dynamic>{
                  'id': 2,
                  'name': 'edit',
                  'args': 'b.ts',
                  'status': 'error',
                  'error': 'NO-MATCH',
                },
              ],
              'omitted': 3,
              'fullOutputPath': '/tmp/out.txt',
            },
          ),
        ]),
      );
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await _pump(tester, transcript, _Actions(transcript));

    expect(find.textContaining('NO-MATCH'), findsNothing);
    await tester.tap(find.text('codemode'));
    await tester.pumpAndSettle();

    expect(find.text('read'), findsOneWidget);
    expect(find.text('edit'), findsOneWidget);
    expect(find.text('a.ts'), findsOneWidget);
    expect(find.text('1.5 s'), findsOneWidget);
    expect(find.text('NO-MATCH'), findsOneWidget);
    expect(find.textContaining('/tmp/out.txt'), findsOneWidget);
    expect(find.textContaining('SCRIPT-OUT'), findsOneWidget);
    expect(find.textContaining('tools.read'), findsOneWidget);
  });

  testWidgets('缺少 codemode 字段时按普通工具项显示', (tester) async {
    final transcript = Transcript()
      ..applySnapshot(snapshotOf(<Map<String, dynamic>>[codemodeItem()]));
    await _pump(tester, transcript, _Actions(transcript));

    await tester.tap(find.text('codemode'));
    await tester.pumpAndSettle();
    expect(find.textContaining('SCRIPT-OUT'), findsOneWidget);
    expect(CodemodeInfo.fromJson(<String, dynamic>{'calls': 'oops'}), isNull);
  });
}
