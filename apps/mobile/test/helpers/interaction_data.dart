import 'fake_api.dart';

/// hello 声明了待办与提问能力的新电脑。
const List<String> kInteractionCaps = <String>['todos', 'questions'];

/// hello 另外声明了计划能力的新电脑。
const List<String> kPlanCaps = <String>['todos', 'questions', 'plan'];

/// 与协议 fixtures 同形的待办条目。
Map<String, dynamic> todoItem(String id, String text, String status) =>
    <String, dynamic>{'id': id, 'text': text, 'status': status};

Map<String, dynamic> todoListJson(
  int revision,
  List<Map<String, dynamic>> items,
) => <String, dynamic>{'revision': revision, 'items': items};

/// `todos-get-result.json` 的真实 fixture（3 项，revision 4）。
Map<String, dynamic> fixtureTodos() =>
    fixtureMessage('todos-get-result.json')['result'] as Map<String, dynamic>;

Map<String, dynamic> optionJson(
  String id,
  String label, {
  String? description,
  bool recommended = false,
}) => <String, dynamic>{
  'id': id,
  'label': label,
  'description': ?description,
  if (recommended) 'recommended': true,
};

/// `questions.get` / `questions.respond` 的完整记录（默认与 fixture 的数据库问题同形）。
Map<String, dynamic> questionJson({
  int id = 612,
  String version = 'v-612',
  String question = '使用哪种数据库？',
  bool multiple = false,
  List<Map<String, dynamic>>? options,
  String status = 'pending',
  Map<String, dynamic>? answer,
  int? settledAt,
}) => <String, dynamic>{
  'id': id,
  'callId': 'call_$id',
  'version': version,
  'question': question,
  'multiple': multiple,
  'options':
      options ??
      <Map<String, dynamic>>[
        optionJson('pg', 'PostgreSQL', recommended: true),
        optionJson('my', 'MySQL'),
        optionJson('lite', 'SQLite', description: '嵌入式，无需服务'),
      ],
  'status': status,
  'answer': answer,
  'createdAt': 1730100000000,
  'settledAt': settledAt,
};

/// `questions.list` 的摘要条目，取自完整记录。
Map<String, dynamic> summaryOf(Map<String, dynamic> record) {
  final question = record['question'] as String;
  return <String, dynamic>{
    'id': record['id'],
    'version': record['version'],
    'preview': question.length <= 256 ? question : question.substring(0, 256),
    'multiple': record['multiple'],
    'optionCount': (record['options'] as List).length,
    'createdAt': record['createdAt'],
  };
}

Map<String, dynamic> questionListJson(
  int revision,
  List<Map<String, dynamic>> records,
) => <String, dynamic>{
  'revision': revision,
  'pending': <Map<String, dynamic>>[for (final r in records) summaryOf(r)],
};

/// 带 todos / questions 状态摘要的快照。
Map<String, dynamic> snapshotWith({
  Map<String, dynamic>? todos,
  Map<String, dynamic>? questions,
  Map<String, dynamic>? plan,
  bool busy = false,
  List<Map<String, dynamic>> items = const <Map<String, dynamic>>[],
}) => <String, dynamic>{
  ...snapshotOf(<Map<String, dynamic>>[
    userItem('u-1', '你好'),
    ...items,
  ], busy: busy),
  'todos': ?todos,
  'questions': ?questions,
  'plan': ?plan,
};

/// `plan.get` / `plan.respond` 的完整记录（默认与 fixture 的“记住我”计划同形）。
Map<String, dynamic> planJson({
  String version = 'v-plan-1',
  String title = '为登录页增加记住我开关',
  List<String>? steps,
  String note = '默认保持关闭，不改变现有会话时长。',
  String status = 'awaiting_approval',
  String? feedback,
  int? settledAt,
}) => <String, dynamic>{
  'version': version,
  'title': title,
  'steps': steps ?? <String>['阅读登录表单与会话配置', '增加 rememberMe 字段', '补充单元测试并运行'],
  'note': note,
  'status': status,
  'feedback': feedback,
  'createdAt': 1730100000000,
  'settledAt': settledAt,
};

/// 状态里的 `plan` 摘要。
Map<String, dynamic> planSummaryJson({
  int revision = 1,
  bool pending = true,
  String? version = 'v-plan-1',
}) => <String, dynamic>{
  'revision': revision,
  'pending': pending,
  'version': ?version,
};
