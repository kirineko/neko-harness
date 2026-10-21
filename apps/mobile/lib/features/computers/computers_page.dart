import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:neko_mobile/core/pairing/pairing_models.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';

/// 已保存电脑（切换/忘记）与外观设置。
class ComputersPage extends ConsumerStatefulWidget {
  const ComputersPage({super.key});

  @override
  ConsumerState<ComputersPage> createState() => _ComputersPageState();
}

class _ComputersPageState extends ConsumerState<ComputersPage> {
  late Future<List<PairedComputer>> _computers = ref
      .read(connectionManagerProvider)
      .savedComputers();

  void _reload() => setState(() {
    _computers = ref.read(connectionManagerProvider).savedComputers();
  });

  Future<void> _forget(PairedComputer computer) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(context.l10n.computersForgetTitle(computer.serverName)),
        content: Text(context.l10n.computersForgetBody),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(context.l10n.commonCancel),
          ),
          FilledButton(
            key: const Key('forget-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(context.l10n.computersForget),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await ref.read(connectionManagerProvider).forget(computer.serverId);
    _reload();
  }

  @override
  Widget build(BuildContext context) {
    final manager = ref.watch(connectionManagerProvider);
    final app = ref.watch(appControllerProvider);
    final tokens = NekoTokens.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(context.l10n.computersTitle)),
      body: FutureBuilder<List<PairedComputer>>(
        future: _computers,
        builder: (context, snapshot) {
          final computers = snapshot.data ?? const <PairedComputer>[];
          return ListView(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NekoSpace.md,
                  NekoSpace.md,
                  NekoSpace.md,
                  NekoSpace.xs,
                ),
                child: Text(
                  context.l10n.computersPaired,
                  style: TextStyle(color: tokens.textFaint),
                ),
              ),
              for (final computer in computers)
                ListTile(
                  key: Key('computer-${computer.serverId}'),
                  leading: NekoIcon(
                    computer.serverId == manager.computer?.serverId
                        ? NekoIcons.radioOn
                        : NekoIcons.radioOff,
                  ),
                  title: Text(computer.serverName),
                  subtitle: Text(Uri.parse(computer.endpoint).host),
                  onTap: computer.serverId == manager.computer?.serverId
                      ? null
                      : () async {
                          final navigator = Navigator.of(context);
                          await manager.switchTo(computer.serverId);
                          navigator.pop();
                        },
                  trailing: IconButton(
                    key: Key('forget-${computer.serverId}'),
                    tooltip: context.l10n.computersForgetTooltip,
                    icon: const NekoIcon(NekoIcons.trash),
                    onPressed: () => _forget(computer),
                  ),
                ),
              ListTile(
                leading: const NekoIcon(NekoIcons.scan),
                title: Text(context.l10n.pairNewComputer),
                onTap: () {
                  manager.stopToScan();
                  context.go('/scan');
                },
              ),
              const Divider(),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NekoSpace.md,
                  NekoSpace.sm,
                  NekoSpace.md,
                  NekoSpace.xs,
                ),
                child: Text(
                  context.l10n.appearanceTitle,
                  style: context.meta(tokens.textFaint),
                ),
              ),
              ValueListenableBuilder<ThemeMode>(
                valueListenable: app.themeMode,
                builder: (context, mode, _) => RadioGroup<ThemeMode>(
                  groupValue: mode,
                  onChanged: (value) {
                    if (value != null) app.setThemeMode(value);
                  },
                  child: Column(
                    children: <Widget>[
                      RadioListTile<ThemeMode>(
                        value: ThemeMode.system,
                        title: Text(context.l10n.themeFollowSystem),
                      ),
                      RadioListTile<ThemeMode>(
                        value: ThemeMode.light,
                        title: Text(context.l10n.themeLight),
                      ),
                      RadioListTile<ThemeMode>(
                        value: ThemeMode.dark,
                        title: Text(context.l10n.themeDark),
                      ),
                    ],
                  ),
                ),
              ),
              const Divider(),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NekoSpace.md,
                  NekoSpace.sm,
                  NekoSpace.md,
                  NekoSpace.xs,
                ),
                child: Text(
                  context.l10n.languageTitle,
                  style: context.meta(tokens.textFaint),
                ),
              ),
              ValueListenableBuilder<Locale>(
                valueListenable: app.locale,
                builder: (context, locale, _) => RadioGroup<Locale>(
                  groupValue: locale,
                  onChanged: (value) {
                    if (value != null) app.setLocale(value);
                  },
                  child: Column(
                    key: const Key('computers-language'),
                    children: <Widget>[
                      RadioListTile<Locale>(
                        value: kLocaleZh,
                        title: Text(context.l10n.languageZh),
                      ),
                      RadioListTile<Locale>(
                        value: kLocaleEn,
                        title: Text(context.l10n.languageEn),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
