import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:neko_mobile/core/pairing/pairing_models.dart';
import 'package:neko_mobile/core/rpc/connection_manager.dart';
import 'package:neko_mobile/features/app_controller.dart';
import 'package:neko_mobile/features/computers/computers_page.dart';
import 'package:neko_mobile/l10n/l10n.dart';
import 'package:neko_mobile/ui/neko_icons.dart';
import 'package:neko_mobile/ui/theme.dart';

/// 抽屉只放低频入口：品牌与连接状态、已配对电脑（可切换）、配对/设置、外观。
/// 会话与工作区切换在标题的切换器里，这里不重复。
class NekoDrawer extends ConsumerWidget {
  const NekoDrawer({super.key, required this.manager});

  final ConnectionManager manager;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = NekoTokens.of(context);
    final app = ref.watch(appControllerProvider);
    return Drawer(
      child: SafeArea(
        child: Column(
          children: <Widget>[
            _Header(manager: manager),
            const Divider(),
            Expanded(
              child: ListView(
                padding: EdgeInsets.zero,
                children: <Widget>[
                  _SectionTitle(context.l10n.drawerSectionComputers, tokens),
                  _SavedComputers(manager: manager),
                  ListTile(
                    key: const Key('drawer-pair'),
                    minTileHeight: NekoSpace.touch,
                    leading: const NekoIcon(NekoIcons.scan, size: 20),
                    title: Text(context.l10n.pairNewComputer),
                    onTap: () {
                      Navigator.of(context).pop();
                      manager.stopToScan();
                      context.go('/scan');
                    },
                  ),
                  ListTile(
                    key: const Key('drawer-computers'),
                    minTileHeight: NekoSpace.touch,
                    leading: const NekoIcon(NekoIcons.monitor, size: 20),
                    title: Text(context.l10n.drawerComputersSettings),
                    trailing: NekoIcon(
                      NekoIcons.chevronRight,
                      size: 16,
                      color: tokens.textFaint,
                    ),
                    onTap: () {
                      Navigator.of(context).pop();
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => const ComputersPage(),
                        ),
                      );
                    },
                  ),
                  const Divider(),
                  _SectionTitle(context.l10n.appearanceTitle, tokens),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: NekoSpace.md,
                      vertical: NekoSpace.xs,
                    ),
                    child: ValueListenableBuilder<ThemeMode>(
                      valueListenable: app.themeMode,
                      builder: (context, mode, _) => SegmentedButton<ThemeMode>(
                        key: const Key('drawer-theme'),
                        showSelectedIcon: false,
                        segments: <ButtonSegment<ThemeMode>>[
                          ButtonSegment<ThemeMode>(
                            value: ThemeMode.system,
                            label: Text(context.l10n.themeAuto),
                          ),
                          ButtonSegment<ThemeMode>(
                            value: ThemeMode.light,
                            label: Text(context.l10n.themeLight),
                          ),
                          ButtonSegment<ThemeMode>(
                            value: ThemeMode.dark,
                            label: Text(context.l10n.themeDark),
                          ),
                        ],
                        selected: <ThemeMode>{mode},
                        onSelectionChanged: (value) =>
                            app.setThemeMode(value.first),
                      ),
                    ),
                  ),
                  _SectionTitle(context.l10n.languageTitle, tokens),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: NekoSpace.md,
                      vertical: NekoSpace.xs,
                    ),
                    child: ValueListenableBuilder<Locale>(
                      valueListenable: app.locale,
                      builder: (context, locale, _) => SegmentedButton<Locale>(
                        key: const Key('drawer-language'),
                        showSelectedIcon: false,
                        segments: <ButtonSegment<Locale>>[
                          ButtonSegment<Locale>(
                            value: kLocaleZh,
                            label: Text(context.l10n.languageZh),
                          ),
                          ButtonSegment<Locale>(
                            value: kLocaleEn,
                            label: Text(context.l10n.languageEn),
                          ),
                        ],
                        selected: <Locale>{locale},
                        onSelectionChanged: (value) =>
                            app.setLocale(value.first),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text, this.tokens);

  final String text;
  final NekoTokens tokens;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      NekoSpace.md,
      NekoSpace.md,
      NekoSpace.md,
      NekoSpace.xs,
    ),
    child: Text(text, style: context.meta(tokens.textFaint)),
  );
}

class _Header extends StatelessWidget {
  const _Header({required this.manager});

  final ConnectionManager manager;

  @override
  Widget build(BuildContext context) {
    final tokens = NekoTokens.of(context);
    return StreamBuilder<NekoConnectionState>(
      stream: manager.states,
      initialData: manager.state,
      builder: (context, snapshot) {
        final state = snapshot.data ?? manager.state;
        final l10n = context.l10n;
        final (String label, Color color) = switch (state) {
          NekoConnReady() => (l10n.connOnline, tokens.success),
          NekoConnConnecting() => (l10n.connConnecting, tokens.warning),
          NekoConnRestoring() => (l10n.connReconnecting, tokens.warning),
          NekoConnOffline() => (l10n.connOffline, tokens.danger),
          NekoConnIdle() => (l10n.connIdle, tokens.textFaint),
          _ => (l10n.connNeedsRepair, tokens.danger),
        };
        final computer = manager.computer;
        return Padding(
          padding: const EdgeInsets.all(NekoSpace.md),
          child: Row(
            children: <Widget>[
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: tokens.primary,
                  borderRadius: BorderRadius.circular(NekoTokens.radiusCard),
                ),
                child: const Center(
                  child: NekoIcon(NekoIcons.cat, size: 26, color: Colors.white),
                ),
              ),
              const SizedBox(width: NekoSpace.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      computer?.serverName ?? 'NekoAI',
                      key: const Key('drawer-computer-name'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.text.titleMedium,
                    ),
                    const SizedBox(height: 2),
                    Row(
                      children: <Widget>[
                        Container(
                          width: 6,
                          height: 6,
                          decoration: BoxDecoration(
                            color: color,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: NekoSpace.xs + 2),
                        Text(
                          label,
                          key: const Key('drawer-status'),
                          style: context.small(tokens.textMuted),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _SavedComputers extends StatefulWidget {
  const _SavedComputers({required this.manager});

  final ConnectionManager manager;

  @override
  State<_SavedComputers> createState() => _SavedComputersState();
}

class _SavedComputersState extends State<_SavedComputers> {
  late final Future<List<PairedComputer>> _computers = widget.manager
      .savedComputers();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<PairedComputer>>(
      future: _computers,
      builder: (context, snapshot) {
        final computers = snapshot.data ?? const <PairedComputer>[];
        final current = widget.manager.computer?.serverId;
        return Column(
          children: <Widget>[
            for (final computer in computers)
              ListTile(
                key: Key('drawer-computer-${computer.serverId}'),
                minTileHeight: NekoSpace.touch,
                leading: NekoIcon(
                  computer.serverId == current
                      ? NekoIcons.radioOn
                      : NekoIcons.radioOff,
                  size: 20,
                ),
                title: Text(
                  computer.serverName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(Uri.parse(computer.endpoint).host),
                onTap: computer.serverId == current
                    ? null
                    : () async {
                        final navigator = Navigator.of(context);
                        await widget.manager.switchTo(computer.serverId);
                        navigator.pop();
                      },
              ),
          ],
        );
      },
    );
  }
}
