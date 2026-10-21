import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/core/api/models.dart';
import 'package:neko_mobile/core/rpc/rpc_client.dart';
import 'package:neko_mobile/core/storage/prefs_store.dart';
import 'package:neko_mobile/features/chat/chat_controller.dart';

import '../../helpers/fake_api.dart';

void main() {
  late FakeMobileApi api;
  late InMemoryPrefsStore prefs;
  late ChatController chat;
  var subscription = 0;

  setUp(() {
    api = FakeMobileApi();
    prefs = InMemoryPrefsStore();
    chat = ChatController(prefs: prefs);
    subscription = 0;
    api.on('chat.attach', (params) {
      subscription++;
      return <String, dynamic>{
        'subscriptionId': 'chat-$subscription',
        'sessionId': params!['sessionId'],
        'snapshot': snapshotOf(<Map<String, dynamic>>[userItem('u-1', 'hi')]),
      };
    });
    api.on('approvals.list', (_) => <String, dynamic>{'approvals': <Object>[]});
    api.on(
      'chat.submissionStatus',
      (_) => <String, dynamic>{'status': 'unknown'},
    );
  });

  tearDown(() async {
    chat.dispose();
    await api.close();
  });

  Future<void> attached() async {
    await chat.bind(api, 'srv');
    await chat.attach('7');
  }

  test('attach 后应用补丁，旧订阅的通知被丢弃', () async {
    await attached();
    expect(chat.canControl, isTrue);
    api.notify('chat.patch', <String, dynamic>{
      'subscriptionId': 'chat-1',
      'seq': 1,
      'upserts': <Object>[assistantItem('a-2', 'pong')],
    });
    expect(chat.transcript.items.last.text, 'pong');
    await chat.attach('8');
    api.notify('chat.patch', <String, dynamic>{
      'subscriptionId': 'chat-1',
      'seq': 2,
      'upserts': <Object>[assistantItem('a-9', 'stale')],
    });
    expect(chat.transcript.items.any((e) => e.text == 'stale'), isFalse);
  });

  test('受理后仅在输入框仍为原文时清空；期间继续编辑的内容保留', () async {
    await attached();
    final gate = Completer<void>();
    api.on('chat.submit', (_) async {
      await gate.future;
      return <String, dynamic>{'accepted': true, 'queued': false};
    });
    chat.input.text = '第一条';
    final sending = chat.send();
    await Future<void>.delayed(Duration.zero);
    chat.input.text = '第一条，再补充';
    gate.complete();
    await sending;
    expect(chat.input.text, '第一条，再补充');
    expect(chat.pending, isEmpty);

    chat.input.text = '第二条';
    await chat.send();
    expect(chat.input.text, isEmpty);
    expect(await prefs.get(PrefKeys.pending('srv')), isNull);
  });

  test('回执丢失后待确认；重启先查状态，unknown 只允许以原请求重试', () async {
    await attached();
    api.on('chat.submit', (_) => throw const RpcNetworkException());
    chat.input.text = '离线前发送';
    await chat.send();
    expect(chat.pending.single.unknown, isTrue);
    expect(chat.input.text, '离线前发送');
    final requestId = chat.pending.single.requestId;

    final restarted = ChatController(prefs: prefs);
    addTearDown(restarted.dispose);
    await restarted.bind(api, 'srv');
    await restarted.attach('7');
    expect(api.callsOf('chat.submissionStatus').last?['requestId'], requestId);
    expect(restarted.pending.single.unknown, isTrue);
    expect(api.callsOf('chat.submit'), hasLength(1));

    api.on(
      'chat.submit',
      (_) => <String, dynamic>{'accepted': true, 'queued': true},
    );
    await restarted.retry(restarted.pending.single);
    expect(api.callsOf('chat.submit').last?['requestId'], requestId);
    expect(restarted.pending, isEmpty);
  });

  test('重连后查询为 accepted 即结算并清除原文草稿', () async {
    await attached();
    api.on('chat.submit', (_) => throw const RpcNetworkException());
    chat.input.text = '已受理但回执丢失';
    await chat.send();
    api.on(
      'chat.submissionStatus',
      (_) => <String, dynamic>{'status': 'accepted'},
    );
    chat.unbind();
    expect(chat.canControl, isFalse);
    await chat.bind(api, 'srv');
    expect(chat.pending, isEmpty);
    expect(chat.input.text, isEmpty);
  });

  test('电脑拒绝时保留草稿、显示原因、不留待确认', () async {
    await attached();
    api.on(
      'chat.submit',
      (_) =>
          throw const MobileApiException('rejected', 'DEEPSEEK_KEY_REQUIRED'),
    );
    chat.input.text = '需要凭据';
    await chat.send();
    expect(chat.input.text, '需要凭据');
    expect(chat.pending, isEmpty);
    expect(
      resolveUiText(chat.error!, kLocaleZh),
      contains('DEEPSEEK_KEY_REQUIRED'),
    );
  });

  test('离线时不发送，草稿按会话隔离持久化', () async {
    await attached();
    chat.input.text = '会话 7 的草稿';
    await chat.attach('8');
    expect(chat.input.text, isEmpty);
    chat.input.text = '会话 8 的草稿';
    await chat.attach('7');
    expect(chat.input.text, '会话 7 的草稿');
    chat.unbind();
    await chat.send();
    expect(api.callsOf('chat.submit'), isEmpty);
  });

  test('审批决定后从列表移除并返回实际状态', () async {
    api.on(
      'approvals.list',
      (_) => <String, dynamic>{
        'approvals': <Object>[
          <String, dynamic>{
            'id': 3,
            'version': 'v',
            'taskId': 9,
            'command': 'ls',
            'cwd': '/',
            'requestedAt': 0,
          },
        ],
      },
    );
    await attached();
    await Future<void>.delayed(Duration.zero);
    expect(chat.approvals, hasLength(1));
    api.on('approvals.list', (_) => <String, dynamic>{'approvals': <Object>[]});
    api.on('approvals.decide', (_) => <String, dynamic>{'status': 'denied'});
    expect(await chat.decide(chat.approvals.single, allow: true), 'denied');
    expect(api.callsOf('approvals.decide').single?['decision'], 'allow');
    expect(chat.approvals, isEmpty);
  });

  test('stale_ref 翻页触发重新 attach', () async {
    api.on('chat.attach', (params) {
      subscription++;
      return <String, dynamic>{
        'subscriptionId': 'chat-$subscription',
        'sessionId': '7',
        'snapshot': snapshotOf(<Map<String, dynamic>>[
          userItem('u-5', 'x'),
        ], historyBefore: 'u-5'),
      };
    });
    api.on(
      'chat.history',
      (_) => throw const MobileApiException('stale_ref', ''),
    );
    await attached();
    await chat.loadOlder();
    await Future<void>.delayed(Duration.zero);
    expect(api.callsOf('chat.attach'), hasLength(2));
  });

  test('图片分块读取、拼接并缓存', () async {
    await attached();
    final bytes = List<int>.generate(150000, (i) => i % 251);
    api.on('media.read', (params) {
      final offset = params!['offset']! as int;
      final end = (offset + 65536).clamp(0, bytes.length);
      return <String, dynamic>{
        'data': base64Encode(bytes.sublist(offset, end)),
        'nextOffset': end,
        'total': bytes.length,
        'done': end >= bytes.length,
        'mimeType': 'image/png',
      };
    });
    final image = ImageRef.fromJson(<String, dynamic>{
      'name': 'a.png',
      'mimeType': 'image/png',
      'width': 1,
      'height': 1,
      'bytes': bytes.length,
      'entryId': 3,
      'contentIndex': 0,
    });
    expect(await chat.image(image), bytes);
    expect(api.callsOf('media.read'), hasLength(3));
    await chat.image(image);
    expect(api.callsOf('media.read'), hasLength(3));
  });

  test('大字段展开读取多字节内容', () async {
    await attached();
    final text = '多字节😀' * 5000;
    final raw = utf8.encode(text);
    api.on('chat.content', (params) {
      final offset = params!['offset']! as int;
      final end = (offset + 65536).clamp(0, raw.length);
      return <String, dynamic>{
        'data': base64Encode(raw.sublist(offset, end)),
        'nextOffset': end,
        'total': raw.length,
        'done': end >= raw.length,
      };
    });
    final item = chat.transcript.items.single;
    await chat.expand(
      item,
      const ContentRef(
        sessionId: '7',
        key: 'u-1',
        field: 'text',
        digest: 'd',
        bytes: 1,
      ),
    );
    expect(chat.transcript.expanded('u-1', 'text'), text);
  });
}
