import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';
import 'package:neko_mobile/features/chat/interactions_controller.dart';
import 'package:neko_mobile/features/questions/question_draft.dart';

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
      ..on('todos.get', (_) => todos)
      ..on('questions.list', (_) => questionList)
      ..on('questions.get', (params) {
        final record = records[params!['id']];
        if (record == null) throw const MobileApiException('not_found', '');
        return record;
      });
  }

  final FakeMobileApi api = FakeMobileApi();
  final InMemoryPrefsStore prefs = InMemoryPrefsStore();
  late final ChatController chat = ChatController(prefs: prefs);
  int attached = 0;
  Map<String, dynamic> snapshot = snapshotOf(<Map<String, dynamic>>[]);
  Map<String, dynamic> todos = todoListJson(1, <Map<String, dynamic>>[]);
  Map<String, dynamic> questionList = questionListJson(
    1,
    <Map<String, dynamic>>[],
  );
  Map<int, Map<String, dynamic>> records = <int, Map<String, dynamic>>{};

  InteractionsController get x => chat.interactions;

  Future<void> bind(
    String session, {
    Iterable<String> caps = kInteractionCaps,
  }) async {
    await chat.bind(api, 'srv', capabilities: caps);
    await chat.attach(session);
    await pumpEventQueue();
  }

  /// 把脚本化数据设为“一道未决问题”。
  Map<String, dynamic> ask({int id = 612, String version = 'v-612'}) {
    final record = questionJson(id: id, version: version);
    records[id] = record;
    questionList = questionListJson(
      (questionList['revision'] as int) + 1,
      <Map<String, dynamic>>[record],
    );
    return record;
  }

  void notify(String method, int revision, {String subscription = 'chat-1'}) =>
      api.notify(method, <String, dynamic>{
        'subscriptionId': subscription,
        'revision': revision,
      });

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
    test('旧电脑（hello 无 todos/questions）：不调用任何新方法，入口隐藏', () async {
      env.snapshot = snapshotWith(todos: null, questions: null);
      await env.bind(
        '7',
        caps: const <String>['sessions', 'chat', 'approvals'],
      );
      expect(env.x.todosSupported, isFalse);
      expect(env.x.questionsSupported, isFalse);
      // 通知与状态摘要即使到达，也不触发任何读取。
      env.notify('todos.changed', 9);
      env.notify('questions.changed', 9);
      env.api.notify('chat.patch', <String, dynamic>{
        'subscriptionId': 'chat-1',
        'seq': 1,
        'upserts': <Object>[],
        'status': <String, dynamic>{
          'busy': false,
          'todos': <String, dynamic>{'revision': 5, 'count': 1, 'completed': 0},
        },
      });
      await pumpEventQueue();
      for (final method in <String>[
        'todos.get',
        'questions.list',
        'questions.get',
        'questions.respond',
      ]) {
        expect(_calls(env, method), 0, reason: method);
      }
      expect(env.x.todos, isNull);
      expect(env.x.pendingCount, 0);
      // 回答也不会发出请求。
      await env.x.respond(
        QuestionRecord.fromJson(questionJson()),
        const SkipResponse(),
      );
      expect(_calls(env, 'questions.respond'), 0);
    });

    test('只声明 todos：只读待办，不碰 questions', () async {
      await env.bind('7', caps: const <String>['chat', 'todos']);
      expect(_calls(env, 'todos.get'), 1);
      expect(_calls(env, 'questions.list'), 0);
      expect(env.x.questionsSupported, isFalse);
    });

    test('新电脑：attach 后各查询一次，参数带当前订阅', () async {
      env.todos = fixtureTodos();
      env.ask();
      await env.bind('7');
      expect(env.api.callsOf('todos.get').single, <String, dynamic>{
        'subscriptionId': 'chat-1',
      });
      expect(env.api.callsOf('questions.list').single, <String, dynamic>{
        'subscriptionId': 'chat-1',
      });
      expect(env.x.todos?.revision, 4);
      expect(env.x.todos?.items, hasLength(3));
      expect(env.x.pending.single.id, 612);
      expect(env.x.todosCurrent, isTrue);
    });

    test('支持但为空：摘要为 0 时不显示内容也不报错', () async {
      env.snapshot = snapshotWith(
        todos: <String, dynamic>{'revision': 0, 'count': 0, 'completed': 0},
        questions: <String, dynamic>{'revision': 0, 'pendingCount': 0},
      );
      await env.bind('7');
      expect(env.x.todosSupported, isTrue);
      expect(env.x.todos?.items, isEmpty);
      expect(env.x.pending, isEmpty);
    });
  });

  group('revision 与 attach / 通知竞态', () {
    test('首查期间收到更高 revision 的通知：再读一次，最终持有最新', () async {
      final gate = Completer<void>();
      var reads = 0;
      env.api.on('todos.get', (_) async {
        reads++;
        if (reads == 1) await gate.future;
        return todoListJson(reads == 1 ? 5 : 6, <Map<String, dynamic>>[
          todoItem('a', '任务', reads == 1 ? 'pending' : 'completed'),
        ]);
      });
      final attaching = env.bind('7');
      await pumpEventQueue();
      expect(reads, 1);
      env.notify('todos.changed', 6);
      gate.complete();
      await attaching;
      await pumpEventQueue();
      expect(reads, 2);
      expect(env.x.todos?.revision, 6);
      expect(env.x.todos?.items.single.status, TodoStatus.completed);
    });

    test('在途读取已经返回了通知的 revision：不再多读', () async {
      final gate = Completer<void>();
      var reads = 0;
      env.api.on('todos.get', (_) async {
        reads++;
        await gate.future;
        return todoListJson(6, <Map<String, dynamic>>[]);
      });
      final attaching = env.bind('7');
      await pumpEventQueue();
      env.notify('todos.changed', 6);
      gate.complete();
      await attaching;
      await pumpEventQueue();
      expect(reads, 1);
      expect(env.x.todos?.revision, 6);
    });

    test('questions 同样：在途读取期间的更高 revision 触发再读', () async {
      final gate = Completer<void>();
      var reads = 0;
      env.api.on('questions.list', (_) async {
        reads++;
        if (reads == 1) await gate.future;
        return reads == 1
            ? questionListJson(5, <Map<String, dynamic>>[])
            : questionListJson(6, <Map<String, dynamic>>[
                questionJson(id: 9, version: 'v9'),
              ]);
      });
      final attaching = env.bind('7');
      await pumpEventQueue();
      env.notify('questions.changed', 6);
      gate.complete();
      await attaching;
      await pumpEventQueue();
      expect(reads, 2);
      expect(env.x.pending.single.id, 9);
    });

    test('只接受不低于已持有的 revision：低于/等于持有的通知不读取，过期结果丢弃', () async {
      env.todos = todoListJson(6, <Map<String, dynamic>>[
        todoItem('a', '新', 'completed'),
      ]);
      await env.bind('7');
      expect(_calls(env, 'todos.get'), 1);
      env.notify('todos.changed', 5);
      env.notify('todos.changed', 6);
      await pumpEventQueue();
      expect(_calls(env, 'todos.get'), 1);

      // 通知 7 触发读取，但读到乱序的旧结果（revision 4）：丢弃，仍持有 6，且重读有界。
      env.todos = todoListJson(4, <Map<String, dynamic>>[
        todoItem('a', '旧', 'pending'),
      ]);
      env.notify('todos.changed', 7);
      await pumpEventQueue();
      expect(env.x.todos?.revision, 6);
      expect(env.x.todos?.items.single.text, '新');
      expect(_calls(env, 'todos.get'), lessThanOrEqualTo(1 + 4));

      env.todos = todoListJson(7, <Map<String, dynamic>>[
        todoItem('a', '更新', 'completed'),
      ]);
      env.notify('todos.changed', 8);
      await pumpEventQueue();
      expect(env.x.todos?.revision, 7);
    });

    test('chat.patch 的状态摘要同样是失效提示（不重复读取已持有的版本）', () async {
      env.todos = todoListJson(3, <Map<String, dynamic>>[
        todoItem('a', 'x', 'pending'),
      ]);
      await env.bind('7');
      expect(_calls(env, 'todos.get'), 1);
      Map<String, dynamic> patch(int seq, int revision) => <String, dynamic>{
        'subscriptionId': 'chat-1',
        'seq': seq,
        'upserts': <Object>[],
        'status': <String, dynamic>{
          'busy': false,
          'todos': <String, dynamic>{
            'revision': revision,
            'count': 1,
            'completed': 0,
          },
        },
      };
      env.api.notify('chat.patch', patch(1, 3));
      await pumpEventQueue();
      expect(_calls(env, 'todos.get'), 1);
      env.todos = todoListJson(4, <Map<String, dynamic>>[
        todoItem('a', 'x', 'completed'),
      ]);
      env.api.notify('chat.patch', patch(2, 4));
      await pumpEventQueue();
      expect(_calls(env, 'todos.get'), 2);
      expect(env.x.todos?.revision, 4);
    });

    test('读取失败不破坏已加载内容，下一次提示再读', () async {
      env.todos = todoListJson(2, <Map<String, dynamic>>[
        todoItem('a', 'x', 'pending'),
      ]);
      await env.bind('7');
      env.api.on('todos.get', (_) => throw const RpcNetworkException());
      env.notify('todos.changed', 3);
      await pumpEventQueue();
      expect(env.x.todos?.revision, 2);
      expect(env.x.todosError, isNotNull);
      env.todos = todoListJson(3, <Map<String, dynamic>>[
        todoItem('a', 'x', 'completed'),
      ]);
      env.api.on('todos.get', (_) => env.todos);
      env.notify('todos.changed', 3);
      await pumpEventQueue();
      expect(env.x.todos?.revision, 3);
      expect(env.x.todosError, isNull);
    });
  });

  group('切换与重连的代次隔离', () {
    test('切换会话后，旧会话迟到的读取结果不写入新会话', () async {
      final gate = Completer<void>();
      env.api.on('todos.get', (params) async {
        if (params!['subscriptionId'] == 'chat-1') {
          await gate.future;
          return todoListJson(3, <Map<String, dynamic>>[
            todoItem('old', '旧会话的待办', 'pending'),
          ]);
        }
        return todoListJson(1, <Map<String, dynamic>>[
          todoItem('new', '新会话的待办', 'pending'),
        ]);
      });
      env.api.on('questions.list', (params) async {
        if (params!['subscriptionId'] == 'chat-1') {
          await gate.future;
          return questionListJson(3, <Map<String, dynamic>>[
            questionJson(id: 1, version: 'old'),
          ]);
        }
        return questionListJson(1, <Map<String, dynamic>>[]);
      });
      await env.chat.bind(env.api, 'srv', capabilities: kInteractionCaps);
      final first = env.chat.attach('7');
      await pumpEventQueue();
      await env.chat.attach('8');
      await pumpEventQueue();
      expect(env.x.todos?.items.single.id, 'new');
      gate.complete();
      await first;
      await pumpEventQueue();
      expect(env.x.todos?.items.single.id, 'new');
      expect(env.x.todos?.revision, 1);
      expect(env.x.pending, isEmpty);
    });

    test('旧订阅的 todos.changed / questions.changed 被忽略', () async {
      await env.bind('7');
      await env.chat.attach('8');
      await pumpEventQueue();
      final before = _calls(env, 'todos.get');
      env.notify('todos.changed', 99, subscription: 'chat-1');
      env.notify('questions.changed', 99, subscription: 'chat-1');
      await pumpEventQueue();
      expect(_calls(env, 'todos.get'), before);
      env.todos = todoListJson(99, <Map<String, dynamic>>[]);
      env.notify('todos.changed', 99, subscription: 'chat-2');
      await pumpEventQueue();
      expect(_calls(env, 'todos.get'), before + 1);
    });

    test('断线时保留已加载内容但标记为非最新；重连后重新 attach 并重新查询', () async {
      env.todos = fixtureTodos();
      env.ask();
      await env.bind('7');
      expect(env.x.todosCurrent, isTrue);
      env.chat.unbind();
      expect(env.x.connected, isFalse);
      expect(env.x.todos?.revision, 4, reason: '离线仍可查看已加载内容');
      expect(env.x.todosCurrent, isFalse, reason: '但不当作最新');
      expect(env.x.pending, hasLength(1));

      // 离线期间的通知不产生请求。
      final reads = _calls(env, 'todos.get');
      env.notify('todos.changed', 9);
      await pumpEventQueue();
      expect(_calls(env, 'todos.get'), reads);

      env.todos = todoListJson(5, <Map<String, dynamic>>[
        todoItem('inspect', '阅读现有会话存储', 'completed'),
      ]);
      env.questionList = questionListJson(7, <Map<String, dynamic>>[]);
      env.records[612] = questionJson(
        status: 'answered',
        answer: <String, dynamic>{
          'optionIds': <String>['pg'],
          'text': null,
        },
        settledAt: 1,
      );
      await env.chat.bind(env.api, 'srv', capabilities: kInteractionCaps);
      await pumpEventQueue();
      expect(env.attached, 2, reason: '重连重新 attach');
      expect(env.api.callsOf('todos.get').last?['subscriptionId'], 'chat-2');
      expect(env.x.todos?.revision, 5);
      expect(env.x.todosCurrent, isTrue);
      expect(env.x.pending, isEmpty);
    });

    test('本订阅首个结果无条件接受（不被旧订阅持有的 revision 卡住）', () async {
      env.todos = todoListJson(9, <Map<String, dynamic>>[
        todoItem('a', '旧', 'pending'),
      ]);
      await env.bind('7');
      env.chat.unbind();
      env.todos = todoListJson(2, <Map<String, dynamic>>[
        todoItem('a', '重置后的新数据', 'pending'),
      ]);
      await env.chat.bind(env.api, 'srv', capabilities: kInteractionCaps);
      await pumpEventQueue();
      expect(env.x.todos?.revision, 2);
      expect(env.x.todos?.items.single.text, '重置后的新数据');
    });

    test('离开会话清空内容；电脑切换清空', () async {
      env.todos = fixtureTodos();
      env.ask();
      await env.bind('7');
      await env.chat.leave();
      expect(env.x.todos, isNull);
      expect(env.x.pending, isEmpty);
      expect(env.x.connected, isFalse);
    });
  });

  group('回答', () {
    QuestionRecord pending() => QuestionRecord.fromJson(env.records[612]!);

    test('回答走 questions.respond：参数与 fixture 同形，收到回执后才是终态', () async {
      final fixtureRecord =
          fixtureMessage('questions-get-result.json')['result']
              as Map<String, dynamic>;
      env.records[612] = fixtureRecord;
      env.questionList = questionListJson(5, <Map<String, dynamic>>[
        fixtureRecord,
      ]);
      final fixtureRequest = fixtureMessage('questions-respond-request.json');
      final fixtureReceipt = fixtureMessage(
        'questions-respond-result.json',
      )['result'];
      env.api.on('questions.respond', (_) => fixtureReceipt);
      await env.bind('7');
      final record = pending();
      await env.x.respond(
        record,
        const AnswerResponse(
          optionIds: <String>['lite'],
          text: '先用 SQLite，之后再迁移',
        ),
      );
      final sent = env.api.callsOf('questions.respond').single!;
      final expected = Map<String, Object?>.from(
        fixtureRequest['params'] as Map,
      )..['subscriptionId'] = 'chat-1';
      expect(sent, expected);
      expect(env.x.record(612)?.status, QuestionStatus.answered);
      expect(env.x.pending, isEmpty);
      expect(env.x.settlementNote(record), isNull);
      // 不是聊天提交。
      expect(_calls(env, 'chat.submit'), 0);
    });

    test('回执前不做乐观终态；防重复：并发两次只发一个请求', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      final gate = Completer<void>();
      env.api.on('questions.respond', (_) async {
        await gate.future;
        return questionJson(
          status: 'answered',
          answer: <String, dynamic>{
            'optionIds': <String>['pg'],
            'text': null,
          },
          settledAt: 2,
        );
      });
      final record = pending();
      final first = env.x.respond(
        record,
        const AnswerResponse(optionIds: <String>['pg']),
      );
      final second = env.x.respond(
        record,
        const AnswerResponse(optionIds: <String>['pg']),
      );
      expect(env.x.isSubmitting(record), isTrue);
      expect(env.x.record(612)?.status, QuestionStatus.pending);
      expect(env.x.pending, hasLength(1));
      gate.complete();
      await Future.wait(<Future<void>>[first, second]);
      expect(_calls(env, 'questions.respond'), 1);
      expect(env.x.isSubmitting(record), isFalse);
      expect(env.x.record(612)?.status, QuestionStatus.answered);
    });

    test('跳过：{kind: skip}', () async {
      env.ask();
      await env.bind('7');
      env.api.on(
        'questions.respond',
        (_) => questionJson(status: 'skipped', settledAt: 2),
      );
      await env.x.loadQuestion(612);
      await env.x.respond(pending(), const SkipResponse());
      expect(
        (env.api.callsOf('questions.respond').single!['response'] as Map),
        <String, dynamic>{'kind': 'skip'},
      );
      expect(env.x.record(612)?.status, QuestionStatus.skipped);
    });

    test('其他端先结算：显示返回记录里真正获胜的答案并附说明', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      env.api.on(
        'questions.respond',
        (_) => questionJson(
          status: 'answered',
          answer: <String, dynamic>{
            'optionIds': <String>['my'],
            'text': '桌面端先答',
          },
          settledAt: 3,
        ),
      );
      final record = pending();
      await env.x.respond(
        record,
        const AnswerResponse(optionIds: <String>['pg']),
      );
      final winner = env.x.record(612)!;
      expect(winner.status, QuestionStatus.answered);
      expect(winner.answer?.optionIds, <String>['my']);
      expect(winner.answer?.text, '桌面端先答');
      expect(
        resolveUiText(env.x.settlementNote(record)!, kLocaleZh),
        contains('其他设备'),
      );
    });

    test('停止后迟到的回答得到 cancelled 终态', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      env.api.on(
        'questions.respond',
        (_) => questionJson(status: 'cancelled', settledAt: 3),
      );
      final record = pending();
      await env.x.respond(record, const SkipResponse());
      expect(env.x.record(612)?.status, QuestionStatus.cancelled);
      expect(env.x.settlementNote(record), isNotNull);
    });

    test('失败保留草稿并显示原因；rejected 后读回真实状态', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      final record = pending();
      env.x.saveDraft(
        record,
        const QuestionDraft(optionIds: <String>['pg'], text: '草稿'),
      );
      env.api.on(
        'questions.respond',
        (_) => throw const MobileApiException('rejected', 'version mismatch'),
      );
      await env.x.respond(
        record,
        const AnswerResponse(optionIds: <String>['pg'], text: '草稿'),
      );
      await pumpEventQueue();
      expect(
        resolveUiText(env.x.submitError(record)!, kLocaleZh),
        contains('version mismatch'),
      );
      expect(env.x.isSubmitting(record), isFalse);
      expect(env.x.draftFor(record).text, '草稿');
      expect(env.x.draftFor(record).optionIds, <String>['pg']);
      expect(_calls(env, 'questions.get'), greaterThan(1), reason: '读回真实状态');
    });

    test('本地校验不通过时不发请求（与服务端同一规则）', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      await env.x.respond(
        pending(),
        const AnswerResponse(optionIds: <String>['pg', 'my']),
      );
      expect(_calls(env, 'questions.respond'), 0);
      expect(
        resolveUiText(env.x.submitError(pending())!, kLocaleZh),
        contains('只能选择一项'),
      );
    });

    test('离线不发送；在途回答断线后无回执：不显示成功、不自动重发', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      final record = pending();
      final gate = Completer<void>();
      env.api.on('questions.respond', (_) async {
        await gate.future;
        throw const RpcNetworkException();
      });
      final inFlight = env.x.respond(
        record,
        const AnswerResponse(optionIds: <String>['pg']),
      );
      await pumpEventQueue();
      env.chat.unbind();
      gate.complete();
      await inFlight;
      expect(env.x.isSubmitting(record), isFalse);
      expect(
        env.x.submitError(record),
        InteractionsController.noReceiptMessage,
      );
      expect(env.x.record(612)?.status, QuestionStatus.pending);

      // 离线时再点也不发。
      await env.x.respond(record, const SkipResponse());
      expect(_calls(env, 'questions.respond'), 1);

      // 重连、重新 attach 并查询：仍只发过那一次，答案由用户明确重试才会重发。
      await env.chat.bind(env.api, 'srv', capabilities: kInteractionCaps);
      await pumpEventQueue();
      expect(_calls(env, 'questions.respond'), 1);
      expect(env.x.pending, hasLength(1));
      expect(env.x.record(612)?.status, QuestionStatus.pending);
    });

    test('回执丢失而答案已保存：重连查询读回已回答终态', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      final record = pending();
      env.api.on('questions.respond', (_) => throw const RpcNetworkException());
      await env.x.respond(
        record,
        const AnswerResponse(optionIds: <String>['lite']),
      );
      expect(env.x.record(612)?.status, QuestionStatus.pending);
      env.chat.unbind();
      env.records[612] = questionJson(
        status: 'answered',
        answer: <String, dynamic>{
          'optionIds': <String>['lite'],
          'text': null,
        },
        settledAt: 5,
      );
      env.questionList = questionListJson(9, <Map<String, dynamic>>[]);
      await env.chat.bind(env.api, 'srv', capabilities: kInteractionCaps);
      await pumpEventQueue();
      expect(env.x.record(612)?.status, QuestionStatus.answered);
      expect(env.x.record(612)?.answer?.optionIds, <String>['lite']);
      expect(_calls(env, 'questions.respond'), 1);
    });

    test('他端回答/停止：通知触发重读，缓存的未决记录更新为真实终态', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      expect(env.x.record(612)?.pending, isTrue);
      env.records[612] = questionJson(
        status: 'answered',
        answer: <String, dynamic>{
          'optionIds': <String>['my'],
          'text': '桌面',
        },
        settledAt: 8,
      );
      env.questionList = questionListJson(7, <Map<String, dynamic>>[]);
      env.notify('questions.changed', 7);
      await pumpEventQueue();
      expect(env.x.pending, isEmpty);
      expect(env.x.record(612)?.status, QuestionStatus.answered);
      expect(env.x.record(612)?.answer?.text, '桌面');
    });

    test('questions.get 返回 not_found：给出可读错误并以列表为准', () async {
      env.ask();
      await env.bind('7');
      env.records.remove(612);
      await env.x.loadQuestion(612);
      expect(resolveUiText(env.x.loadError(612)!, kLocaleZh), contains('不存在'));
      expect(env.x.pending, isEmpty);
    });
  });

  group('答案草稿隔离', () {
    test('按 server/session/question/version 隔离，同一会话重进后保留', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      final record = QuestionRecord.fromJson(env.records[612]!);
      expect(env.x.draftFor(record).optionIds, isEmpty);
      env.x.saveDraft(
        record,
        const QuestionDraft(optionIds: <String>['lite'], text: '7 的草稿'),
      );

      // 切到会话 8：同样 id/version 的问题也不复用 7 的草稿。
      await env.chat.attach('8');
      await pumpEventQueue();
      await env.x.loadQuestion(612);
      expect(
        env.x.draftFor(QuestionRecord.fromJson(env.records[612]!)).text,
        isEmpty,
      );

      // 回到 7：草稿仍在（进程内）。
      await env.chat.attach('7');
      await pumpEventQueue();
      expect(env.x.draftFor(record).text, '7 的草稿');
      expect(env.x.draftFor(record).optionIds, <String>['lite']);

      // 同一会话里问题版本变化：不复用旧版本的草稿。
      final newer = QuestionRecord.fromJson(questionJson(version: 'v-new'));
      expect(env.x.draftFor(newer).text, isEmpty);
    });

    test('结算后草稿被清除', () async {
      env.ask();
      await env.bind('7');
      await env.x.loadQuestion(612);
      final record = QuestionRecord.fromJson(env.records[612]!);
      env.x.saveDraft(record, const QuestionDraft(text: '要清除'));
      env.api.on(
        'questions.respond',
        (_) => questionJson(status: 'skipped', settledAt: 2),
      );
      await env.x.respond(record, const SkipResponse());
      expect(env.x.draftFor(record).text, isEmpty);
    });
  });

  group('自动展开规则', () {
    test('进入有未决问题的会话：武装一次，评估后消费', () async {
      env.ask();
      await env.bind('7');
      expect(env.x.hasArmed, isTrue);
      final summary = env.x.takeAutoPresent(canPresent: true);
      expect(summary?.id, 612);
      expect(env.x.hasArmed, isFalse);
      expect(env.x.takeAutoPresent(canPresent: true), isNull);
    });

    test('条件不满足（输入聚焦/有草稿）时消费但不展开，之后不会突然弹出', () async {
      env.ask();
      await env.bind('7');
      expect(env.x.takeAutoPresent(canPresent: false), isNull);
      expect(env.x.hasArmed, isFalse);
      // 刷新/重连不会再武装同一问题。
      env.notify('questions.changed', 9);
      await pumpEventQueue();
      expect(env.x.hasArmed, isFalse);
    });

    test('用户关闭过的问题版本：再次进入会话也不自动展开', () async {
      env.ask();
      await env.bind('7');
      final summary = env.x.takeAutoPresent(canPresent: true)!;
      env.x.markClosed(env.x.keyFor(summary.id, summary.version));
      await env.chat.attach('8');
      await pumpEventQueue();
      await env.chat.attach('7');
      await pumpEventQueue();
      expect(env.x.hasArmed, isFalse);
      expect(env.x.takeAutoPresent(canPresent: true), isNull);
    });

    test('新问题首次出现再次武装；新版本视为新问题', () async {
      env.ask();
      await env.bind('7');
      final first = env.x.takeAutoPresent(canPresent: true)!;
      env.x.markClosed(env.x.keyFor(first.id, first.version));
      env.ask(id: 700, version: 'v-700');
      env.questionList = questionListJson(9, <Map<String, dynamic>>[
        env.records[612]!,
        env.records[700]!,
      ]);
      env.notify('questions.changed', 9);
      await pumpEventQueue();
      expect(env.x.takeAutoPresent(canPresent: true)?.id, 700);

      env.records[612] = questionJson(version: 'v-612-b');
      env.questionList = questionListJson(11, <Map<String, dynamic>>[
        env.records[612]!,
      ]);
      env.notify('questions.changed', 11);
      await pumpEventQueue();
      expect(env.x.takeAutoPresent(canPresent: true)?.version, 'v-612-b');
    });

    test('同一会话的重连不重新武装已见过的问题', () async {
      env.ask();
      await env.bind('7');
      env.x.takeAutoPresent(canPresent: false);
      env.chat.unbind();
      await env.chat.bind(env.api, 'srv', capabilities: kInteractionCaps);
      await pumpEventQueue();
      expect(env.x.hasArmed, isFalse);
    });
  });
}
