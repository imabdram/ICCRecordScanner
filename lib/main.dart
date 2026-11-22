// =============================================================================
// ICC Record Scanner
//
// Offline-first SIM recorder. Records are written to SQLite immediately and
// uploaded to Supabase when the phone has a connection.
//
// DESIGN NOTES
//   * There is a login, but only once per phone: the session is stored by
//     supabase_flutter and refreshed automatically. Offline, the app opens
//     straight to the scanner.
//   * Push-only sync. The phone never deletes a server record; it only
//     uploads what it recorded and marks it synced.
//   * A record that the server already has (duplicate ICCID) is marked
//     `duplicate` locally instead of retrying forever.
//
// File layout:
//   config      -> constants, validators
//   data        -> Record model, SQLite, sync
//   auth        -> login + profile gate
//   shell       -> tabs, drawer
//   scanner     -> camera + new record form
//   records     -> timeline, search, detail/edit
//   settings    -> profile, password, sync, sign out
// =============================================================================

import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:excel/excel.dart' as xls;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:sqflite/sqflite.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

// =============================================================================
// config
// =============================================================================

class AppConfig {
  // Public by design. Security is Row Level Security in Postgres, never this key.
  static const supabaseUrl = 'https://emyycswvbdwiqgzsdxsg.supabase.co';
  static const supabaseKey = 'sb_publishable_VX9t2k0xjWAJDsvJgRrLXQ_K6HawBvY';

  /// Supabase Auth is email-first; usernames map to a domain that never receives
  /// mail. Users only ever type their username.
  static const usernameDomain = 'sim.local';

  static const brandRed = Color(0xFFE11929);
  static const ink = Color(0xFF101C2B);
  static const muted = Color(0xFF6E7A8A);
  static const rail = Color(0xFFD6DCE4);
  static const pageBg = Color(0xFFF4F6F8);

  static const okGreen = Color(0xFF34A853);
  static const warnAmber = Color(0xFFF0AD4E);
  static const badRed = Color(0xFFD93025);

  static String emailFor(String username) =>
      '${username.trim().toLowerCase()}@$usernameDomain';
}

class Validators {
  static final iccidRe = RegExp(r'^89[0-9]{16,20}$');
  /// 071 followed by 7 digits (10 total), e.g. 0716736063.
  static final primaryRe = RegExp(r'^071[0-9]{7}$');
  /// 10 digits starting 090, 061 or 63, e.g. 0905736063.
  static final secondaryRe = RegExp(r'^(090[0-9]{7}|061[0-9]{7}|63[0-9]{8})$');

  static String digits(String v) => v.replaceAll(RegExp(r'[^0-9]'), '');

  static String? iccid(String raw) {
    final v = digits(raw);
    if (v.isEmpty) return 'Enter the ICCID';
    if (!iccidRe.hasMatch(v)) {
      return 'ICCID must start with 89 and be 18-22 digits';
    }
    return null;
  }

  static String? primary(String raw) {
    final v = digits(raw);
    if (!primaryRe.hasMatch(v)) {
      return 'Primary must be 071 followed by 7 digits (e.g. 0716736063)';
    }
    return null;
  }

  static String? secondary(String raw) {
    final v = digits(raw);
    if (!secondaryRe.hasMatch(v)) {
      return 'Backup must be 10 digits starting 090, 061 or 63';
    }
    return null;
  }
}

// =============================================================================
// data: record + sqlite
// =============================================================================

enum SyncState { pending, synced, duplicate, failed }

SyncState syncStateFrom(String? raw) => switch (raw) {
      'synced' => SyncState.synced,
      'duplicate' => SyncState.duplicate,
      'failed' => SyncState.failed,
      _ => SyncState.pending,
    };

class ScanRecord {
  final int? id;
  final String iccid;
  final String fullName;
  final String primary;
  final String secondary;
  final DateTime createdAt;
  final SyncState state;
  final String? serverId;

  const ScanRecord({
    this.id,
    required this.iccid,
    required this.fullName,
    required this.primary,
    required this.secondary,
    required this.createdAt,
    this.state = SyncState.pending,
    this.serverId,
  });

  ScanRecord copyWith({
    int? id,
    String? iccid,
    String? fullName,
    String? primary,
    String? secondary,
    DateTime? createdAt,
    SyncState? state,
    String? serverId,
  }) =>
      ScanRecord(
        id: id ?? this.id,
        iccid: iccid ?? this.iccid,
        fullName: fullName ?? this.fullName,
        primary: primary ?? this.primary,
        secondary: secondary ?? this.secondary,
        createdAt: createdAt ?? this.createdAt,
        state: state ?? this.state,
        serverId: serverId ?? this.serverId,
      );

  Map<String, Object?> toMap() => {
        if (id != null) 'id': id,
        'icc_id': iccid,
        'full_name': fullName,
        'primary_number': primary,
        'secondary_number': secondary,
        'created_at': createdAt.toIso8601String(),
        'sync_status': state.name,
        'server_id': serverId,
      };

  factory ScanRecord.fromMap(Map<String, Object?> m) => ScanRecord(
        id: m['id'] as int?,
        iccid: (m['icc_id'] ?? '') as String,
        fullName: (m['full_name'] ?? '') as String,
        primary: (m['primary_number'] ?? '') as String,
        secondary: (m['secondary_number'] ?? '') as String,
        createdAt:
            DateTime.tryParse((m['created_at'] ?? '') as String) ?? DateTime.now(),
        state: syncStateFrom(m['sync_status'] as String?),
        serverId: m['server_id'] as String?,
      );
}

class RecordStore {
  RecordStore._();
  static final RecordStore instance = RecordStore._();

  Database? _db;

  Future<Database> get db async {
    if (_db != null) return _db!;
    final dir = await getDatabasesPath();
    _db = await openDatabase(
      p.join(dir, 'icc_records.db'),
      version: 4,
      onCreate: (db, _) => db.execute('''
        create table records(
          id integer primary key autoincrement,
          icc_id text not null unique,
          full_name text not null,
          primary_number text not null,
          secondary_number text not null,
          created_at text not null,
          sync_status text not null default 'pending',
          server_id text
        )
      '''),
      onUpgrade: (db, from, to) async {
        // v4 added server_id; older installs keep their scans.
        if (from < 4) {
          final cols = await db.rawQuery('pragma table_info(records)');
          final hasServer = cols.any((c) => c['name'] == 'server_id');
          if (!hasServer) {
            await db.execute('alter table records add column server_id text');
          }
        }
      },
    );
    return _db!;
  }

  Future<List<ScanRecord>> all() async {
    final rows = await (await db).query('records', orderBy: 'created_at desc');
    return rows.map(ScanRecord.fromMap).toList();
  }

  Future<ScanRecord?> byIccid(String iccid) async {
    final rows = await (await db)
        .query('records', where: 'icc_id = ?', whereArgs: [iccid], limit: 1);
    return rows.isEmpty ? null : ScanRecord.fromMap(rows.first);
  }

  Future<ScanRecord?> byId(int id) async {
    final rows =
        await (await db).query('records', where: 'id = ?', whereArgs: [id], limit: 1);
    return rows.isEmpty ? null : ScanRecord.fromMap(rows.first);
  }

  Future<List<ScanRecord>> pending() async {
    final rows = await (await db).query('records',
        where: "sync_status in ('pending','failed')", orderBy: 'created_at asc');
    return rows.map(ScanRecord.fromMap).toList();
  }

  Future<int> pendingCount() async {
    final r = await (await db).rawQuery(
      "select count(*) as n from records where sync_status in ('pending','failed')",
    );
    return (r.first['n'] as int?) ?? 0;
  }

  Future<int> insert(ScanRecord rec) async =>
      (await db).insert('records', rec.toMap());

  Future<void> update(ScanRecord rec) async {
    await (await db)
        .update('records', rec.toMap(), where: 'id = ?', whereArgs: [rec.id]);
  }

  Future<void> delete(int id) async {
    await (await db).delete('records', where: 'id = ?', whereArgs: [id]);
  }

  Future<void> mark(int id,
      {required SyncState state, String? serverId}) async {
    await (await db).update(
      'records',
      {
        'sync_status': state.name,
        if (serverId != null) 'server_id': serverId,
      },
      where: 'id = ?',
      whereArgs: [id],
    );
  }
}

/// Push-only sync. Never pulls, never deletes remotely.
class SyncService {
  SyncService._();
  static final SyncService instance = SyncService._();

  final _changes = StreamController<void>.broadcast();
  Stream<void> get changes => _changes.stream;

  bool _running = false;
  DateTime? lastRun;

  void _notify() {
    if (!_changes.isClosed) _changes.add(null);
  }

  /// True when the device reports a network. Cheap check, never trusted alone:
  /// the upload itself is the real test.
  Future<bool> get online async {
    final result = await Connectivity().checkConnectivity();
    return result.any((r) => r != ConnectivityResult.none);
  }

  Future<void> pushNow() async {
    if (_running) return;
    _running = true;
    try {
      final client = Supabase.instance.client;
      if (client.auth.currentSession == null) return;
      if (!await online) return;

      for (final rec in await RecordStore.instance.pending()) {
        try {
          final row = await client
              .from('scans')
              .insert({
                'iccid': rec.iccid,
                'customer_name': rec.fullName,
                'primary_number': rec.primary,
                'secondary_number': rec.secondary,
                'created_at': rec.createdAt.toUtc().toIso8601String(),
              })
              .select('id')
              .single();

          await RecordStore.instance.mark(rec.id!,
              state: SyncState.synced, serverId: row['id'] as String?);
        } on PostgrestException catch (e) {
          if (e.code == '23505') {
            // Someone already registered this SIM. Stop retrying.
            await RecordStore.instance.mark(rec.id!, state: SyncState.duplicate);
          } else {
            await RecordStore.instance.mark(rec.id!, state: SyncState.failed);
          }
        } catch (_) {
          // Network or anything else: keep it pending for the next attempt.
          await RecordStore.instance.mark(rec.id!, state: SyncState.failed);
        }
      }
    } finally {
      _running = false;
      lastRun = DateTime.now();
      _notify();
    }
  }

  /// Fire-and-forget after each save.
  void pushSoon() {
    unawaited(pushNow());
  }
}

// =============================================================================
// auth
// =============================================================================

class Profile {
  final String userId;
  final String username;
  final String fullName;
  final String role;
  final String? outletName;
  final String? regionName;
  final String? zoneName;
  final String? teamLeaderName;

  const Profile({
    required this.userId,
    required this.username,
    required this.fullName,
    required this.role,
    this.outletName,
    this.regionName,
    this.zoneName,
    this.teamLeaderName,
  });

  String get roleLabel => switch (role) {
        'admin' => 'Administrator',
        'supervisor' => 'Supervisor',
        'team_leader' => 'Team Leader',
        _ => 'Sales Rep',
      };

  String get display => fullName.isEmpty ? username : fullName;

  /// Zone / Region / Outlet as one readable line.
  String get scope =>
      [zoneName, regionName, outletName].whereType<String>().join('  >  ');

  factory Profile.fromMap(Map<String, dynamic> m) => Profile(
        userId: m['user_id'] as String,
        username: (m['username'] ?? '') as String,
        fullName: (m['full_name'] ?? '') as String,
        role: (m['role'] ?? 'sales_rep') as String,
        outletName: m['outlet_name'] as String?,
        regionName: m['region_name'] as String?,
        zoneName: m['zone_name'] as String?,
        teamLeaderName: m['team_leader_name'] as String?,
      );
}

class AuthService {
  AuthService._();
  static final AuthService instance = AuthService._();

  SupabaseClient get client => Supabase.instance.client;

  Session? get session => client.auth.currentSession;

  Future<void> signIn(String username, String password) async {
    final email = AppConfig.emailFor(username);
    if (username.trim().isEmpty || password.isEmpty) {
      throw 'Enter your username and password';
    }
    final res = await client.auth.signInWithPassword(email: email, password: password);
    if (res.session == null) throw 'Could not sign in';
  }

  Future<Profile> profile() async {
    final rows = await client.from('v_my_profile').select();
    if ((rows as List).isEmpty) {
      throw 'No profile is linked to this account. Ask an administrator.';
    }
    return Profile.fromMap(Map<String, dynamic>.from(rows.first as Map));
  }

  Future<void> signOut() => client.auth.signOut();

  /// Changes the signed-in user's password after re-checking the current one.
  /// Re-authenticating makes the check real rather than a client-side formality.
  Future<void> changePassword(String currentPassword, String newPassword) async {
    final email = client.auth.currentUser?.email;
    if (email == null) throw 'You are not signed in';
    try {
      await client.auth.signInWithPassword(email: email, password: currentPassword);
    } on AuthException {
      throw 'Your current password is incorrect';
    }
    await client.auth.updateUser(UserAttributes(password: newPassword));
  }
}

// =============================================================================
// app root
// =============================================================================

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Supabase.initialize(
    url: AppConfig.supabaseUrl,
    publishableKey: AppConfig.supabaseKey,
  );
  runApp(const IccScannerApp());
}

class IccScannerApp extends StatelessWidget {
  const IccScannerApp({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(
      seedColor: AppConfig.brandRed,
      primary: AppConfig.brandRed,
      brightness: Brightness.light,
    );
    return MaterialApp(
      title: 'ICC Record Scanner',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: scheme,
        scaffoldBackgroundColor: AppConfig.pageBg,
        visualDensity: VisualDensity.adaptivePlatformDensity,
      ),
      home: const _AuthGate(),
    );
  }
}

class _AuthGate extends StatefulWidget {
  const _AuthGate();
  @override
  State<_AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<_AuthGate> {
  Profile? _profile;
  String? _error;
  bool _loading = true;
  StreamSubscription<AuthState>? _authSub;

  @override
  void initState() {
    super.initState();
    _authSub = AuthService.instance.client.auth.onAuthStateChange.listen((state) {
      if (state.event == AuthChangeEvent.signedOut) {
        if (mounted) setState(() => _profile = null);
      }
    });
    _load();
  }

  @override
  void dispose() {
    _authSub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (AuthService.instance.session == null) {
        setState(() {
          _profile = null;
          _loading = false;
        });
        return;
      }
      final profile = await AuthService.instance.profile();
      setState(() {
        _profile = profile;
        _loading = false;
      });
      SyncService.instance.pushSoon();
    } catch (e) {
      setState(() {
        _error = e.toString();
        _profile = null;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_profile == null) {
      return LoginPage(
        initialError: _error,
        onSignedIn: _load,
      );
    }
    return AppShell(profile: _profile!, onProfileChanged: _load);
  }
}

// =============================================================================
// login
// =============================================================================

class LoginPage extends StatefulWidget {
  const LoginPage({super.key, this.initialError, required this.onSignedIn});

  final String? initialError;
  final Future<void> Function() onSignedIn;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _error = widget.initialError;
  }

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AuthService.instance.signIn(_username.text, _password.text);
      await widget.onSignedIn();
    } catch (e) {
      setState(() => _error = _readable(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _readable(Object e) {
    final s = e.toString();
    if (s.contains('Invalid login credentials')) {
      return 'That username and password do not match.';
    }
    if (s.contains('SocketException') || s.contains('Failed host lookup')) {
      return 'No internet. Connect once to set up this phone.';
    }
    return s.replaceFirst('Exception: ', '');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
          children: [
            Center(
              child: Container(
                width: 68,
                height: 68,
                decoration: BoxDecoration(
                  color: AppConfig.brandRed,
                  borderRadius: BorderRadius.circular(18),
                ),
                child: const Icon(Icons.list_alt, color: Colors.white, size: 32),
              ),
            ),
            const SizedBox(height: 22),
            const Center(
              child: Text('ICC Record Scanner',
                  style: TextStyle(fontSize: 23, fontWeight: FontWeight.w700)),
            ),
            const SizedBox(height: 6),
            const Center(
              child: Text('Sign in to start recording',
                  style: TextStyle(color: AppConfig.muted, fontSize: 13)),
            ),
            const SizedBox(height: 30),
            if (_error != null) ...[
              _Banner(text: _error!, tone: _BannerTone.error),
              const SizedBox(height: 16),
            ],
            _FieldLabel('USERNAME'),
            TextField(
              controller: _username,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.next,
              decoration: _inputDecoration('your.username'),
            ),
            const SizedBox(height: 16),
            _FieldLabel('PASSWORD'),
            TextField(
              controller: _password,
              obscureText: true,
              onSubmitted: (_) => _submit(),
              decoration: _inputDecoration('Your password'),
            ),
            const SizedBox(height: 22),
            SizedBox(
              height: 52,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: AppConfig.brandRed,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                ),
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white),
                      )
                    : const Text('Sign in',
                        style: TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w600)),
              ),
            ),
            const SizedBox(height: 18),
            const Center(
              child: Text('Accounts are created by your team leader.',
                  style: TextStyle(color: AppConfig.muted, fontSize: 12)),
            ),
          ],
        ),
      ),
    );
  }

  InputDecoration _inputDecoration(String hint) => InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: AppConfig.muted, fontSize: 15),
        filled: true,
        fillColor: const Color(0xFFF8F9FB),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFFE3E8EE)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFFE3E8EE)),
        ),
      );
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6, left: 2),
        child: Text(text,
            style: const TextStyle(
                fontSize: 11,
                letterSpacing: .6,
                fontWeight: FontWeight.w700,
                color: AppConfig.muted)),
      );
}

enum _BannerTone { error, ok, warn }

class _Banner extends StatelessWidget {
  const _Banner({required this.text, this.tone = _BannerTone.warn});
  final String text;
  final _BannerTone tone;

  @override
  Widget build(BuildContext context) {
    final (bg, fg, icon) = switch (tone) {
      _BannerTone.error => (
          const Color(0xFFFDECEE),
          const Color(0xFFB3261E),
          Icons.error_outline
        ),
      _BannerTone.ok => (
          const Color(0xFFE9F7EE),
          const Color(0xFF1E7A3C),
          Icons.check_circle_outline
        ),
      _BannerTone.warn => (
          const Color(0xFFFFF7E6),
          const Color(0xFF9A6A00),
          Icons.info_outline
        ),
    };
    return Container(
      padding: const EdgeInsets.all(12),
      decoration:
          BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        Icon(icon, size: 18, color: fg),
        const SizedBox(width: 8),
        Expanded(
          child: Text(text, style: TextStyle(color: fg, fontSize: 13)),
        ),
      ]),
    );
  }
}

// =============================================================================
// sharing
// =============================================================================

/// The text pasted into WhatsApp when sharing a record.
///
/// Four lines, no labels — the receiving side is a person reading a chat, and
/// "ICCID:" prefixes only add noise:
///
///   89252637900011195321
///   Cisman Cabdulaahi Abubaka
///   0716736063
///   0905736063
String buildShareText(ScanRecord record) => [
      record.iccid,
      record.fullName,
      record.primary,
      record.secondary,
    ].join('\n');

// =============================================================================
// shell
// =============================================================================

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.profile, required this.onProfileChanged});
  final Profile profile;
  final Future<void> Function() onProfileChanged;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> with WidgetsBindingObserver {
  int _index = 0;
  int _pending = 0;
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  StreamSubscription<void>? _syncSub;
  StreamSubscription<List<ConnectivityResult>>? _netSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _syncSub = SyncService.instance.changes.listen((_) => _refreshPending());
    _netSub = Connectivity().onConnectivityChanged.listen((results) {
      if (results.any((r) => r != ConnectivityResult.none)) {
        SyncService.instance.pushSoon();
      }
    });
    _refreshPending();
    SyncService.instance.pushSoon();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _syncSub?.cancel();
    _netSub?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) SyncService.instance.pushSoon();
  }

  Future<void> _refreshPending() async {
    final n = await RecordStore.instance.pendingCount();
    if (mounted && n != _pending) setState(() => _pending = n);
  }

  Future<void> _signOut() async {
    await AuthService.instance.signOut();
    if (mounted) await widget.onProfileChanged();
  }

  @override
  Widget build(BuildContext context) {
    // Captured before any await: using context afterwards across an async gap
    // is what the linter (correctly) warns about.
    final messenger = ScaffoldMessenger.of(context);
    return Scaffold(
      key: _scaffoldKey,
      drawer: _AppDrawer(
        profile: widget.profile,
        pending: _pending,
        onSync: () async {
          await SyncService.instance.pushNow();
          await _refreshPending();
          if (mounted) {
            messenger.showSnackBar(
              const SnackBar(content: Text('Sync finished')),
            );
          }
        },
        onSettings: () async {
          Navigator.of(context).pop();
          await Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => SettingsPage(profile: widget.profile)),
          );
          await _refreshPending();
        },
        onSignOut: _signOut,
      ),
      body: _index == 0
          ? ScannerTab(
              profile: widget.profile,
              onMenu: () => _scaffoldKey.currentState?.openDrawer(),
              onSaved: _refreshPending,
            )
          : RecordsTab(
              profile: widget.profile,
              onMenu: () => _scaffoldKey.currentState?.openDrawer(),
              pending: _pending,
            ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) {
          setState(() => _index = i);
          _refreshPending();
        },
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.qr_code_scanner_outlined),
            selectedIcon: Icon(Icons.qr_code_scanner),
            label: 'Scan',
          ),
          NavigationDestination(
            icon: Icon(Icons.format_list_bulleted_outlined),
            selectedIcon: Icon(Icons.format_list_bulleted),
            label: 'Records',
          ),
        ],
      ),
    );
  }
}

class _AppDrawer extends StatelessWidget {
  const _AppDrawer({
    required this.profile,
    required this.pending,
    required this.onSync,
    required this.onSettings,
    required this.onSignOut,
  });

  final Profile profile;
  final int pending;
  final Future<void> Function() onSync;
  final Future<void> Function() onSettings;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context) {
    final initials = profile.display
        .split(RegExp(r'\s+'))
        .where((w) => w.isNotEmpty)
        .take(2)
        .map((w) => w[0].toUpperCase())
        .join();

    Widget row(String k, String? v) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 86,
                child: Text(k,
                    style:
                        const TextStyle(fontSize: 11, color: AppConfig.muted)),
              ),
              Expanded(
                child: Text(
                  (v == null || v.isEmpty) ? '-' : v,
                  style: const TextStyle(fontSize: 13, color: AppConfig.ink),
                ),
              ),
            ],
          ),
        );

    return Drawer(
      backgroundColor: Colors.white,
      child: SafeArea(
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
              child: Row(children: [
                CircleAvatar(
                  radius: 26,
                  backgroundColor: AppConfig.brandRed,
                  child: Text(initials,
                      style: const TextStyle(
                          color: Colors.white, fontWeight: FontWeight.w700)),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(profile.display,
                          style: const TextStyle(
                              fontSize: 17, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 2),
                      Text('${profile.roleLabel} | ${profile.username}',
                          style: const TextStyle(
                              fontSize: 11.5, color: AppConfig.muted)),
                    ],
                  ),
                ),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: Container(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
                decoration: BoxDecoration(
                  color: const Color(0xFFF8F9FB),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(children: [
                  row('Zone', profile.zoneName),
                  row('Region', profile.regionName),
                  row('Outlet', profile.outletName),
                  row('Team leader', profile.teamLeaderName),
                ]),
              ),
            ),
            const Divider(height: 24),
            ListTile(
              leading: const Icon(Icons.qr_code_scanner_outlined),
              title: const Text('Scan'),
              onTap: () => Navigator.of(context).pop(),
            ),
            ListTile(
              leading: const Icon(Icons.format_list_bulleted),
              title: const Text('Records'),
              onTap: () => Navigator.of(context).pop(),
            ),
            ListTile(
              leading: const Icon(Icons.settings_outlined),
              title: const Text('Settings'),
              onTap: onSettings,
            ),
            const Divider(height: 24),
            ListTile(
              leading: const Icon(Icons.sync),
              title: const Text('Sync now'),
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: const Color(0xFFF3F6F9),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text('$pending pending',
                    style: const TextStyle(
                        fontSize: 11, color: AppConfig.muted)),
              ),
              onTap: onSync,
            ),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('Sign out'),
              onTap: onSignOut,
            ),
          ],
        ),
      ),
    );
  }
}

// =============================================================================
// scanner tab
// =============================================================================

class ScannerTab extends StatefulWidget {
  const ScannerTab({
    super.key,
    required this.profile,
    required this.onMenu,
    required this.onSaved,
  });

  final Profile profile;
  final VoidCallback onMenu;
  final Future<void> Function() onSaved;

  @override
  State<ScannerTab> createState() => _ScannerTabState();
}

class _ScannerTabState extends State<ScannerTab> {
  final MobileScannerController _camera = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode, BarcodeFormat.code128, BarcodeFormat.code39],
  );

  bool _torch = false;
  bool _busy = false;
  DateTime _lastHit = DateTime.fromMillisecondsSinceEpoch(0);

  @override
  void dispose() {
    _camera.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_busy) return;
    // A card often yields several frames per second; ignore the burst.
    if (DateTime.now().difference(_lastHit) < const Duration(seconds: 2)) return;

    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null) continue;
      final digits = Validators.digits(raw);
      if (digits.length < 18 || digits.length > 22) continue;
      if (!digits.startsWith('89')) continue;
      _lastHit = DateTime.now();

      // Copy the scanned number to the clipboard so it can be pasted straight
      // into a chat or a form without retyping it.
      unawaited(Clipboard.setData(ClipboardData(text: digits)));
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(const SnackBar(
            content: Text('ICCID copied'),
            duration: Duration(seconds: 2),
          ));
      }

      _openForm(digits);
      return;
    }
  }

  Future<void> _openForm([String? iccid]) async {
    if (_busy) return;
    setState(() => _busy = true);
    await _camera.stop();
    if (!mounted) return;

    final saved = await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (_) => NewRecordPage(initialIccid: iccid)),
    );

    if (mounted) {
      setState(() => _busy = false);
      await _camera.start();
      if (saved == true) {
        await widget.onSaved();
        SyncService.instance.pushSoon();
      }
    }
  }

  Future<void> _toggleTorch() async {
    try {
      await _camera.toggleTorch();
      setState(() => _torch = !_torch);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Flashlight is not available on this phone')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _camera, onDetect: _onDetect),
          const _ScanFrame(),
          SafeArea(
            child: Column(
              children: [
                Row(
                  children: [
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: _DarkIconButton(
                        icon: Icons.menu,
                        onTap: widget.onMenu,
                      ),
                    ),
                    const Spacer(),
                  ],
                ),
                const Spacer(),
                Text(
                  'Align the ICCID inside the frame',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: .85),
                    fontSize: 12.5,
                  ),
                ),
                const SizedBox(height: 14),
                // Flashlight: large white rectangle, bottom centre.
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: SizedBox(
                    width: 200,
                    height: 54,
                    child: FilledButton.icon(
                      style: FilledButton.styleFrom(
                        backgroundColor: Colors.white,
                        foregroundColor: AppConfig.ink,
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14)),
                      ),
                      onPressed: _toggleTorch,
                      icon: Icon(
                        _torch ? Icons.flashlight_on : Icons.flashlight_off,
                        size: 20,
                      ),
                      label: const Text('Flashlight',
                          style: TextStyle(
                              fontSize: 15, fontWeight: FontWeight.w600)),
                    ),
                  ),
                ),
                TextButton(
                  onPressed: _busy ? null : () => _openForm(),
                  child: Text(
                    'Enter manually',
                    style: TextStyle(
                      color: Colors.white.withValues(alpha: .75),
                      fontSize: 13,
                    ),
                  ),
                ),
                const SizedBox(height: 6),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _DarkIconButton extends StatelessWidget {
  const _DarkIconButton({required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: Colors.black.withValues(alpha: .45),
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(11),
            child: Icon(icon, color: Colors.white, size: 22),
          ),
        ),
      );
}

class _ScanFrame extends StatelessWidget {
  const _ScanFrame();

  @override
  Widget build(BuildContext context) => IgnorePointer(
        child: Center(
          child: LayoutBuilder(builder: (context, c) {
            final w = c.maxWidth * .86;
            final h = w * .42;
            return SizedBox(
              width: w,
              height: h,
              child: CustomPaint(painter: _FramePainter()),
            );
          }),
        ),
      );
}

class _FramePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final rrect = RRect.fromRectAndRadius(rect, const Radius.circular(16));

    canvas.drawRRect(
      rrect,
      Paint()
        ..color = Colors.white.withValues(alpha: .35)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2,
    );

    final corner = Paint()
      ..color = const Color(0xFF26A69A)
      ..strokeWidth = 5
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    const l = 28.0;
    final tl = rect.topLeft, tr = rect.topRight;
    final bl = rect.bottomLeft, br = rect.bottomRight;
    canvas
      ..drawLine(tl, tl + const Offset(l, 0), corner)
      ..drawLine(tl, tl + const Offset(0, l), corner)
      ..drawLine(tr, tr + const Offset(-l, 0), corner)
      ..drawLine(tr, tr + const Offset(0, l), corner)
      ..drawLine(bl, bl + const Offset(l, 0), corner)
      ..drawLine(bl, bl + const Offset(0, -l), corner)
      ..drawLine(br, br + const Offset(-l, 0), corner)
      ..drawLine(br, br + const Offset(0, -l), corner);

    canvas.drawLine(
      Offset(rect.left + 14, rect.center.dy),
      Offset(rect.right - 14, rect.center.dy),
      Paint()
        ..color = const Color(0xFF26A69A).withValues(alpha: .55)
        ..strokeWidth = 2,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

// =============================================================================
// new record
// =============================================================================

class NewRecordPage extends StatefulWidget {
  const NewRecordPage({super.key, this.initialIccid});
  final String? initialIccid;

  @override
  State<NewRecordPage> createState() => _NewRecordPageState();
}

class _NewRecordPageState extends State<NewRecordPage> {
  late final TextEditingController _iccid =
      TextEditingController(text: widget.initialIccid ?? '');
  final _name = TextEditingController();
  final _primary = TextEditingController();
  final _secondary = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _iccid.dispose();
    _name.dispose();
    _primary.dispose();
    _secondary.dispose();
    super.dispose();
  }

  Future<void> _rescan() async {
    final value = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (_) => const _RescanPage()),
    );
    if (value != null && mounted) {
      setState(() => _iccid.text = value);
    }
  }

  Future<void> _save({bool again = false}) async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _saving = true;
      _error = null;
    });

    final iccid = Validators.digits(_iccid.text);
    try {
      // Offline duplicate check first: this phone already has it.
      final existing = await RecordStore.instance.byIccid(iccid);
      if (existing != null && mounted) {
        final open = await showDialog<bool>(
          context: context,
          builder: (_) => AlertDialog(
            title: const Text('Already recorded'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(iccid, style: const TextStyle(fontFamily: 'monospace')),
                const SizedBox(height: 8),
                Text('${existing.fullName} - ${_fmt(existing.createdAt)}'),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Open record'),
              ),
            ],
          ),
        );
        if (open == true && mounted) {
          await Navigator.push(
            context,
            MaterialPageRoute(
                builder: (_) => RecordDetailPage(recordId: existing.id!)),
          );
        }
        setState(() => _saving = false);
        return;
      }

      final rec = ScanRecord(
        iccid: iccid,
        fullName: _name.text.trim(),
        primary: Validators.digits(_primary.text),
        secondary: Validators.digits(_secondary.text),
        createdAt: DateTime.now(),
      );
      await RecordStore.instance.insert(rec);

      if (!mounted) return;
      if (again) {
        setState(() {
          _iccid.clear();
          _name.clear();
          _primary.clear();
          _secondary.clear();
          _saving = false;
        });
        SyncService.instance.pushSoon();
        return;
      }
      Navigator.pop(context, true);
    } catch (e) {
      setState(() {
        _saving = false;
        _error = e.toString();
      });
    }
  }

  String _fmt(DateTime d) => DateFormat('d MMM, HH:mm').format(d);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppConfig.pageBg,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        elevation: 0,
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('New record', style: TextStyle(fontSize: 18)),
            Text('Fill the details, then save',
                style: TextStyle(fontSize: 11.5, color: AppConfig.muted)),
          ],
        ),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 28),
          children: [
            if (_error != null) ...[
              _Banner(text: _error!, tone: _BannerTone.error),
              const SizedBox(height: 14),
            ],
            _LabeledField(
              label: 'ICCID',
              controller: _iccid,
              keyboard: TextInputType.number,
              hint: '8925...',
              helper: 'Edit it, or tap the icon to scan again',
              trailing: IconButton(
                tooltip: 'Scan again',
                icon: const Icon(Icons.qr_code_scanner, size: 20),
                onPressed: _rescan,
              ),
              validator: (v) => Validators.iccid(v ?? ''),
            ),
            _LabeledField(
              label: 'CUSTOMER NAME',
              controller: _name,
              hint: 'Customer name',
              textCapitalization: TextCapitalization.words,
              validator: (v) =>
                  (v ?? '').trim().isEmpty ? 'Enter the customer name' : null,
            ),
            _LabeledField(
              label: 'PRIMARY NUMBER',
              controller: _primary,
              keyboard: TextInputType.phone,
              hint: '71xxxxxxx',
              validator: (v) => Validators.primary(v ?? ''),
            ),
            _LabeledField(
              label: 'BACKUP NUMBER',
              controller: _secondary,
              keyboard: TextInputType.phone,
              hint: '7-12 digits',
              validator: (v) => Validators.secondary(v ?? ''),
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 54,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: AppConfig.brandRed,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                ),
                onPressed: _saving ? null : () => _save(),
                child: _saving
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : const Text('Save record',
                        style: TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w600)),
              ),
            ),
            const SizedBox(height: 10),
            SizedBox(
              height: 54,
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: Color(0xFFE3E8EE)),
                  backgroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                ),
                onPressed: _saving ? null : () => _save(again: true),
                child: const Text('Save and scan another',
                    style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: AppConfig.ink)),
              ),
            ),
            const SizedBox(height: 18),
            const Center(
              child: Text('Saved on the phone first. Uploaded when online.',
                  style: TextStyle(fontSize: 12, color: AppConfig.muted)),
            ),
          ],
        ),
      ),
    );
  }
}

class _RescanPage extends StatefulWidget {
  const _RescanPage();
  @override
  State<_RescanPage> createState() => _RescanPageState();
}

class _RescanPageState extends State<_RescanPage> {
  final MobileScannerController _c = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _done = false;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture cap) {
    if (_done) return;
    for (final b in cap.barcodes) {
      final raw = b.rawValue;
      if (raw == null) continue;
      final digits = Validators.digits(raw);
      if (digits.length >= 18 && digits.length <= 22 && digits.startsWith('89')) {
        _done = true;
        Navigator.pop(context, digits);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Colors.black,
        appBar: AppBar(
          backgroundColor: Colors.black,
          foregroundColor: Colors.white,
          title: const Text('Scan again'),
        ),
        body: Stack(
          fit: StackFit.expand,
          children: [
            MobileScanner(controller: _c, onDetect: _onDetect),
            const _ScanFrame(),
          ],
        ),
      );
}

class _LabeledField extends StatelessWidget {
  const _LabeledField({
    required this.label,
    required this.controller,
    this.hint,
    this.helper,
    this.validator,
    this.keyboard,
    this.trailing,
    this.textCapitalization = TextCapitalization.none,
  });

  final String label;
  final TextEditingController controller;
  final String? hint;
  final String? helper;
  final String? Function(String?)? validator;
  final TextInputType? keyboard;
  final Widget? trailing;
  final TextCapitalization textCapitalization;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 2, bottom: 6),
              child: Text(label,
                  style: const TextStyle(
                      fontSize: 11,
                      letterSpacing: .6,
                      fontWeight: FontWeight.w700,
                      color: AppConfig.muted)),
            ),
            TextFormField(
              controller: controller,
              keyboardType: keyboard,
              validator: validator,
              textCapitalization: textCapitalization,
              style: const TextStyle(fontSize: 15),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle:
                    const TextStyle(color: AppConfig.muted, fontSize: 14),
                filled: true,
                fillColor: Colors.white,
                suffixIcon: trailing,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: Color(0xFFE3E8EE)),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: Color(0xFFE3E8EE)),
                ),
              ),
            ),
            if (helper != null)
              Padding(
                padding: const EdgeInsets.only(left: 2, top: 5),
                child: Text(helper!,
                    style: const TextStyle(
                        fontSize: 11.5, color: AppConfig.muted)),
              ),
          ],
        ),
      );
}

// =============================================================================
// records tab (timeline)
// =============================================================================

class RecordsTab extends StatefulWidget {
  const RecordsTab({
    super.key,
    required this.profile,
    required this.onMenu,
    required this.pending,
  });

  final Profile profile;
  final VoidCallback onMenu;
  final int pending;

  @override
  State<RecordsTab> createState() => _RecordsTabState();
}

class _RecordsTabState extends State<RecordsTab> {
  final _search = TextEditingController();
  List<ScanRecord> _all = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _search.addListener(() => setState(() {}));
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final rows = await RecordStore.instance.all();
    if (!mounted) return;
    setState(() {
      _all = rows;
      _loading = false;
    });
  }

  List<ScanRecord> get _filtered {
    final q = _search.text.trim().toLowerCase();
    if (q.isEmpty) return _all;
    return _all
        .where((r) =>
            r.fullName.toLowerCase().contains(q) ||
            r.iccid.contains(q) ||
            r.primary.contains(q) ||
            r.secondary.contains(q))
        .toList();
  }

  /// Groups by calendar day, newest first.
  Map<DateTime, List<ScanRecord>> get _byDay {
    final map = <DateTime, List<ScanRecord>>{};
    for (final r in _filtered) {
      final d = DateTime(r.createdAt.year, r.createdAt.month, r.createdAt.day);
      map.putIfAbsent(d, () => []).add(r);
    }
    return map;
  }

  String _dayLabel(DateTime d) {
    final today = DateTime.now();
    final t0 = DateTime(today.year, today.month, today.day);
    final diff = t0.difference(d).inDays;
    final fmt = DateFormat('d MMM');
    if (diff == 0) return 'Today - ${fmt.format(d)}';
    if (diff == 1) return 'Yesterday - ${fmt.format(d)}';
    return fmt.format(d);
  }

  /// Long-press on a record: offer to share it or copy it.
  ///
  /// The shared text is the four lines people paste into WhatsApp — ICCID,
  /// name, primary, backup — with no labels.
  Future<void> _showShareSheet(ScanRecord record) {
    return showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: Text(record.fullName,
                  style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text(record.iccid,
                  style: const TextStyle(fontSize: 12.5, fontFamily: 'monospace')),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.share_outlined),
              title: const Text('Share'),
              subtitle: const Text('WhatsApp, Messages, email…'),
              onTap: () async {
                Navigator.pop(ctx);
                await SharePlus.instance
                    .share(ShareParams(text: buildShareText(record)));
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy_all_outlined),
              title: const Text('Copy'),
              subtitle: const Text('The same four lines, to the clipboard'),
              onTap: () async {
                Navigator.pop(ctx);
                await Clipboard.setData(
                    ClipboardData(text: buildShareText(record)));
                if (!mounted) return;
                ScaffoldMessenger.of(context)
                  ..hideCurrentSnackBar()
                  ..showSnackBar(const SnackBar(content: Text('Record copied')));
              },
            ),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
  }

  /// The signed-in user records every row in this list, so the report's
  /// "Sales Rep" column is always them.
  String get _repName => widget.profile.display;

  /// Styled Excel export matching the team's existing report layout:
  ///   No | Name | Sales Rep | ICC ID | Golis Num | Amtel Num | Status | plan
  /// Dark blue header, white bold text, thin bottom borders, centred IDs.
  /// "Status" and "plan" are left empty on purpose: they are filled in after
  /// export, and inventing values would be worse than a blank cell.
  Future<void> _export() async {
    final rows = _filtered;
    if (rows.isEmpty) return;

    final bytes = buildCustomersWorkbook(rows, _repName);
    if (bytes == null) return;

    final dir = await getTemporaryDirectory();
    final file = File(p.join(dir.path,
        'customers_${DateFormat('dd_MMMM').format(DateTime.now())}.xlsx'));
    await file.writeAsBytes(bytes, flush: true);
    await SharePlus.instance.share(ShareParams(
      files: [XFile(file.path)],
      text: 'Customer records',
    ));
  }

  @override
  Widget build(BuildContext context) {
    final days = _byDay;
    return Scaffold(
      backgroundColor: AppConfig.pageBg,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.menu),
          onPressed: widget.onMenu,
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Records', style: TextStyle(fontSize: 20)),
            Text('${_all.length} records | ${widget.pending} pending',
                style: const TextStyle(
                    fontSize: 11.5, color: AppConfig.muted)),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Export',
            icon: const Icon(Icons.file_download_outlined),
            onPressed: _export,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () async {
                await SyncService.instance.pushNow();
                await _load();
              },
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
                children: [
                  TextField(
                    controller: _search,
                    decoration: InputDecoration(
                      hintText: 'Search name, ICCID or number',
                      prefixIcon: const Icon(Icons.search, size: 20),
                      filled: true,
                      fillColor: Colors.white,
                      contentPadding: const EdgeInsets.symmetric(vertical: 4),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFFE3E8EE)),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFFE3E8EE)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  if (days.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 60),
                      child: Center(
                        child: Text('No records yet.\nScan a SIM to start.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: AppConfig.muted)),
                      ),
                    ),
                  for (final day in days.keys.toList()..sort((a, b) => b.compareTo(a)))
                    _DayGroup(
                      label: _dayLabel(day),
                      records: days[day]!,
                      onShare: _showShareSheet,
                      onTap: (r) async {
                        await Navigator.push(
                          context,
                          MaterialPageRoute(
                              builder: (_) => RecordDetailPage(recordId: r.id!)),
                        );
                        await _load();
                      },
                    ),
                ],
              ),
            ),
    );
  }
}

class _DayGroup extends StatelessWidget {
  const _DayGroup({
    required this.label,
    required this.records,
    required this.onTap,
    required this.onShare,
  });

  final String label;
  final List<ScanRecord> records;
  final void Function(ScanRecord) onTap;
  final void Function(ScanRecord) onShare;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 10, bottom: 8),
          child: Row(
            children: [
              Text(label,
                  style: const TextStyle(
                      fontSize: 14, fontWeight: FontWeight.w700)),
              const Spacer(),
              Text('${records.length} SIM${records.length == 1 ? '' : 's'}',
                  style: const TextStyle(
                      fontSize: 11.5, color: AppConfig.muted)),
            ],
          ),
        ),
        const Divider(height: 1, color: Color(0xFFE3E8EE)),
        const SizedBox(height: 10),
        for (var i = 0; i < records.length; i++)
          _TimelineEntry(
            record: records[i],
            first: i == 0,
            last: i == records.length - 1,
            onTap: () => onTap(records[i]),
            onLongPress: () => onShare(records[i]),
          ),
        const SizedBox(height: 8),
      ],
    );
  }
}

class _TimelineEntry extends StatelessWidget {
  const _TimelineEntry({
    required this.record,
    required this.first,
    required this.last,
    required this.onTap,
    required this.onLongPress,
  });

  final ScanRecord record;
  final bool first;
  final bool last;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final time = DateFormat('HH:mm').format(record.createdAt);
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 48,
            child: Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Text(time,
                  textAlign: TextAlign.right,
                  style: const TextStyle(
                      fontSize: 11.5, color: AppConfig.muted)),
            ),
          ),
          SizedBox(
            width: 28,
            child: CustomPaint(
              painter: _RailPainter(
                color: _statusColor(record.state),
                first: first,
                last: last,
              ),
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Material(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                child: InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: onTap,
                  onLongPress: onLongPress,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(record.fullName,
                                  style: const TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w600)),
                              const SizedBox(height: 3),
                              Text(record.iccid,
                                  style: const TextStyle(
                                      fontSize: 12.5,
                                      color: AppConfig.muted,
                                      fontFamily: 'monospace')),
                              const SizedBox(height: 3),
                              Text('${record.primary}  |  ${record.secondary}',
                                  style: const TextStyle(
                                      fontSize: 11.5,
                                      color: Color(0xFF9AA3AF))),
                            ],
                          ),
                        ),
                        _StatusChip(state: record.state),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RailPainter extends CustomPainter {
  _RailPainter({required this.color, required this.first, required this.last});
  final Color color;
  final bool first;
  final bool last;

  @override
  void paint(Canvas canvas, Size size) {
    final x = size.width / 2;
    final paint = Paint()
      ..color = AppConfig.rail
      ..strokeWidth = 2.5;
    final top = first ? 22.0 : 0.0;
    final bottom = last ? size.height - 16 : size.height;
    canvas.drawLine(Offset(x, top), Offset(x, bottom), paint);

    canvas.drawCircle(Offset(x, 22), 6, Paint()..color = Colors.white);
    canvas.drawCircle(Offset(x, 22), 4.5, Paint()..color = color);
  }

  @override
  bool shouldRepaint(covariant _RailPainter old) =>
      old.color != color || old.first != first || old.last != last;
}

Color _statusColor(SyncState s) => switch (s) {
      SyncState.synced => AppConfig.okGreen,
      SyncState.duplicate => AppConfig.badRed,
      SyncState.failed => AppConfig.warnAmber,
      SyncState.pending => AppConfig.warnAmber,
    };

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.state});
  final SyncState state;

  @override
  Widget build(BuildContext context) {
    final (label, bg, fg) = switch (state) {
      SyncState.synced => ('', Colors.transparent, AppConfig.okGreen),
      SyncState.duplicate => (
          'duplicate',
          const Color(0xFFFDECEE),
          AppConfig.badRed
        ),
      SyncState.failed => (
          'retry',
          const Color(0xFFFFF7E6),
          const Color(0xFF9A6A00)
        ),
      SyncState.pending => (
          'pending',
          const Color(0xFFFFF7E6),
          const Color(0xFF9A6A00)
        ),
    };

    if (label.isEmpty) {
      return Container(
        width: 14,
        height: 14,
        decoration: const BoxDecoration(
            color: AppConfig.okGreen, shape: BoxShape.circle),
      );
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(8)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: fg, shape: BoxShape.circle),
        ),
        const SizedBox(width: 5),
        Text(label, style: TextStyle(fontSize: 11, color: fg)),
      ]),
    );
  }
}

// =============================================================================
// record detail / edit
// =============================================================================

class RecordDetailPage extends StatefulWidget {
  const RecordDetailPage({super.key, required this.recordId});
  final int recordId;

  @override
  State<RecordDetailPage> createState() => _RecordDetailPageState();
}

class _RecordDetailPageState extends State<RecordDetailPage> {
  final _formKey = GlobalKey<FormState>();
  ScanRecord? _record;
  late TextEditingController _iccid;
  late TextEditingController _name;
  late TextEditingController _primary;
  late TextEditingController _secondary;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _iccid = TextEditingController();
    _name = TextEditingController();
    _primary = TextEditingController();
    _secondary = TextEditingController();
    _load();
  }

  @override
  void dispose() {
    _iccid.dispose();
    _name.dispose();
    _primary.dispose();
    _secondary.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final r = await RecordStore.instance.byId(widget.recordId);
    if (!mounted || r == null) return;
    setState(() {
      _record = r;
      _iccid.text = r.iccid;
      _name.text = r.fullName;
      _primary.text = r.primary;
      _secondary.text = r.secondary;
    });
  }

  Future<void> _rescan() async {
    final value = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (_) => const _RescanPage()),
    );
    if (value != null && mounted) setState(() => _iccid.text = value);
  }

  /// Copy button beside a field in the detail screen.
  Widget _copyField(String label, String Function() read) => IconButton(
        tooltip: 'Copy $label',
        icon: const Icon(Icons.copy, size: 18),
        onPressed: () async {
          await Clipboard.setData(ClipboardData(text: read()));
          if (!mounted) return;
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(SnackBar(content: Text('$label copied')));
        },
      );

  Future<void> _update() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final rec = _record!;
    setState(() {
      _busy = true;
      _error = null;
    });

    final updated = rec.copyWith(
      iccid: Validators.digits(_iccid.text),
      fullName: _name.text.trim(),
      primary: Validators.digits(_primary.text),
      secondary: Validators.digits(_secondary.text),
    );

    try {
      await RecordStore.instance.update(updated);

      // Already on the server: push the correction too (allowed for own rows).
      if (rec.state == SyncState.synced && rec.serverId != null) {
        try {
          await Supabase.instance.client.from('scans').update({
            'customer_name': updated.fullName,
            'primary_number': updated.primary,
            'secondary_number': updated.secondary,
          }).eq('id', rec.serverId!);
        } on PostgrestException catch (e) {
          if (e.code == '23505') {
            setState(() => _error = 'That ICCID is already registered.');
            setState(() => _busy = false);
            await _load();
            return;
          }
          rethrow;
        }
      } else if (rec.state == SyncState.pending ||
          rec.state == SyncState.failed) {
        SyncService.instance.pushSoon();
      }

      if (!mounted) return;
      Navigator.pop(context, true);
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _delete() async {
    final rec = _record!;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Delete this record?'),
        content: Text('${rec.iccid}\n\nThis cannot be undone on this phone.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    await RecordStore.instance.delete(rec.id!);
    if (mounted) Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    final rec = _record;
    if (rec == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final synced = rec.state == SyncState.synced;

    return Scaffold(
      backgroundColor: AppConfig.pageBg,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        elevation: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Record', style: TextStyle(fontSize: 18)),
            Text(
              synced ? 'Uploaded to the office' : 'Saved on this phone',
              style: const TextStyle(fontSize: 11.5, color: AppConfig.muted),
            ),
          ],
        ),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
          children: [
            _StatusStrip(state: rec.state),
            const SizedBox(height: 16),
            if (_error != null) ...[
              _Banner(text: _error!, tone: _BannerTone.error),
              const SizedBox(height: 14),
            ],
            _LabeledField(
              label: 'ICCID',
              controller: _iccid,
              keyboard: TextInputType.number,
              // A synced row is already on the server under this ICCID; changing
              // it locally would diverge, so the field is locked.
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _copyField('ICCID', () => Validators.digits(_iccid.text)),
                  if (!synced)
                    IconButton(
                      tooltip: 'Scan again',
                      icon: const Icon(Icons.qr_code_scanner, size: 20),
                      onPressed: _rescan,
                    ),
                ],
              ),
              validator: (v) => Validators.iccid(v ?? ''),
            ),
            _LabeledField(
              label: 'CUSTOMER NAME',
              controller: _name,
              trailing: _copyField('Name', () => _name.text.trim()),
              validator: (v) =>
                  (v ?? '').trim().isEmpty ? 'Enter the customer name' : null,
            ),
            _LabeledField(
              label: 'PRIMARY NUMBER',
              controller: _primary,
              keyboard: TextInputType.phone,
              trailing: _copyField('Primary number', () => Validators.digits(_primary.text)),
              validator: (v) => Validators.primary(v ?? ''),
            ),
            _LabeledField(
              label: 'BACKUP NUMBER',
              controller: _secondary,
              keyboard: TextInputType.phone,
              trailing: _copyField('Backup number', () => Validators.digits(_secondary.text)),
              validator: (v) => Validators.secondary(v ?? ''),
            ),
            const SizedBox(height: 4),
            _MetaLine(
                label: 'Recorded',
                value: DateFormat('d MMM yyyy, HH:mm').format(rec.createdAt)),
            const SizedBox(height: 18),
            SizedBox(
              height: 54,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: AppConfig.brandRed,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                ),
                onPressed: _busy ? null : _update,
                child: _busy
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : const Text('Update',
                        style: TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w600)),
              ),
            ),
            if (!synced) ...[
              const SizedBox(height: 10),
              SizedBox(
                height: 54,
                child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    backgroundColor: Colors.white,
                    side: const BorderSide(color: Color(0xFFF0CDD0)),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                  ),
                  onPressed: _busy ? null : _delete,
                  icon: const Icon(Icons.delete_outline,
                      color: AppConfig.brandRed, size: 20),
                  label: const Text('Delete record',
                      style: TextStyle(
                          color: AppConfig.brandRed,
                          fontSize: 15,
                          fontWeight: FontWeight.w600)),
                ),
              ),
              const SizedBox(height: 8),
              const Center(
                child: Text('Only possible until it uploads.',
                    style: TextStyle(fontSize: 12, color: AppConfig.muted)),
              ),
            ] else ...[
              const SizedBox(height: 10),
              const Center(
                child: Text('No delete: the office keeps this record.',
                    style: TextStyle(fontSize: 12, color: AppConfig.muted)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatusStrip extends StatelessWidget {
  const _StatusStrip({required this.state});
  final SyncState state;

  @override
  Widget build(BuildContext context) {
    final (title, sub, colour) = switch (state) {
      SyncState.synced => (
          'Uploaded',
          'Saved by the office; edit it there',
          AppConfig.okGreen
        ),
      SyncState.duplicate => (
          'Duplicate',
          'This SIM is already registered in the system',
          AppConfig.badRed
        ),
      SyncState.failed => (
          'Waiting to upload',
          'Last attempt failed; will retry when online',
          AppConfig.warnAmber
        ),
      SyncState.pending => (
          'Waiting to upload',
          'Will send automatically when online',
          AppConfig.warnAmber
        ),
    };

    return Container(
      padding: const EdgeInsets.all(12),
      decoration:
          BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(color: colour, shape: BoxShape.circle),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title,
                  style: const TextStyle(
                      fontSize: 14.5, fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(sub,
                  style:
                      const TextStyle(fontSize: 11.5, color: AppConfig.muted)),
            ],
          ),
        ),
      ]),
    );
  }
}

class _MetaLine extends StatelessWidget {
  const _MetaLine({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 92,
              child: Text(label,
                  style:
                      const TextStyle(fontSize: 11.5, color: AppConfig.muted)),
            ),
            Expanded(
              child: Text(value,
                  style: const TextStyle(fontSize: 13, color: AppConfig.ink)),
            ),
          ],
        ),
      );
}

// =============================================================================
// settings
// =============================================================================

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.profile});
  final Profile profile;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _message;
  bool _ok = true;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _changePassword() async {
    if (_next.text != _confirm.text) {
      setState(() {
        _message = 'The new passwords do not match.';
        _ok = false;
      });
      return;
    }
    if (_next.text.length < 8) {
      setState(() {
        _message = 'Use at least 8 characters.';
        _ok = false;
      });
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await AuthService.instance
          .changePassword(_current.text, _next.text);
      _current.clear();
      _next.clear();
      _confirm.clear();
      setState(() {
        _message = 'Password changed. Use it next time you sign in.';
        _ok = true;
      });
    } catch (e) {
      setState(() {
        _message = e.toString().replaceFirst('Exception: ', '');
        _ok = false;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final messenger = ScaffoldMessenger.of(context);
    final p = widget.profile;
    return Scaffold(
      backgroundColor: AppConfig.pageBg,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        elevation: 0,
        title: const Text('Settings', style: TextStyle(fontSize: 18)),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
                color: Colors.white, borderRadius: BorderRadius.circular(12)),
            child: Column(children: [
              _MetaLine(label: 'Name', value: p.display),
              _MetaLine(label: 'Username', value: p.username),
              _MetaLine(label: 'Role', value: p.roleLabel),
              _MetaLine(label: 'Zone', value: p.zoneName ?? '-'),
              _MetaLine(label: 'Region', value: p.regionName ?? '-'),
              _MetaLine(label: 'Outlet', value: p.outletName ?? '-'),
              _MetaLine(label: 'Team leader', value: p.teamLeaderName ?? '-'),
            ]),
          ),
          const SizedBox(height: 18),
          const Text('CHANGE PASSWORD',
              style: TextStyle(
                  fontSize: 11,
                  letterSpacing: .6,
                  fontWeight: FontWeight.w700,
                  color: AppConfig.muted)),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
                color: Colors.white, borderRadius: BorderRadius.circular(12)),
            child: Column(children: [
              if (_message != null) ...[
                _Banner(
                    text: _message!,
                    tone: _ok ? _BannerTone.ok : _BannerTone.error),
                const SizedBox(height: 12),
              ],
              TextField(
                controller: _current,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'Current password'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _next,
                obscureText: true,
                decoration: const InputDecoration(
                    labelText: 'New password', helperText: 'At least 8 characters'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _confirm,
                obscureText: true,
                decoration:
                    const InputDecoration(labelText: 'Repeat the new password'),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: AppConfig.brandRed,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12)),
                  ),
                  onPressed: _busy ? null : _changePassword,
                  child: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white))
                      : const Text('Change password'),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 18),
          ListTile(
            tileColor: Colors.white,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            leading: const Icon(Icons.sync),
            title: const Text('Sync now'),
            onTap: () async {
              await SyncService.instance.pushNow();
              if (!mounted) return;
              messenger.showSnackBar(
                const SnackBar(content: Text('Sync finished')),
              );
            },
          ),
        ],
      ),
    );
  }
}




// =============================================================================
// excel export
// =============================================================================

/// Builds the styled "Customers" workbook, matching the team's existing report:
///
///   No | Name | Sales Rep | ICC ID | Golis Num | Amtel Num | Status | plan
///
/// Dark blue header, white bold text, thin bottom borders, centred IDs.
/// "Status" and "plan" are left empty on purpose: they are filled in after
/// export, and inventing values would be worse than a blank cell.
///
/// Kept out of the widget so it can be tested without a device -- the styling is
/// the part that is easy to get silently wrong.
List<int>? buildCustomersWorkbook(List<ScanRecord> rows, String repName) {
  final excel = xls.Excel.createExcel();
  final sheet = excel['Customers'];

  // Drop the workbook's default empty sheet and make Customers the first thing
  // the file opens on -- an empty 'Sheet1' in front of the report looks broken.
  if (excel.tables.containsKey('Sheet1')) excel.delete('Sheet1');
  excel.setDefaultSheet('Customers');

  const headers = <String>[
    'No',
    'Name',
    'Sales Rep',
    'ICC ID',
    'Golis Num',
    'Amtel Num',
    'Status',
    'plan',
  ];
  const widths = <double>[6, 34, 28, 16, 16, 16, 12, 10];
  for (var i = 0; i < widths.length; i++) {
    sheet.setColumnWidth(i, widths[i]);
  }

  final headerStyle = xls.CellStyle(
    bold: true,
    fontSize: 11,
    fontColorHex: xls.ExcelColor.white,
    backgroundColorHex: xls.ExcelColor.fromHexString('FF1F4E78'),
    horizontalAlign: xls.HorizontalAlign.Center,
    verticalAlign: xls.VerticalAlign.Center,
    bottomBorder: xls.Border(borderStyle: xls.BorderStyle.Thin),
  );

  sheet.appendRow(headers.map<xls.CellValue>(xls.TextCellValue.new).toList());
  sheet.setRowHeight(0, 24);
  for (var c = 0; c < headers.length; c++) {
    sheet
        .cell(xls.CellIndex.indexByColumnRow(columnIndex: c, rowIndex: 0))
        .cellStyle = headerStyle;
  }

  final bodyBorder = xls.Border(borderStyle: xls.BorderStyle.Thin);
  final centered = xls.CellStyle(
    fontSize: 11,
    horizontalAlign: xls.HorizontalAlign.Center,
    bottomBorder: bodyBorder,
  );
  final left = xls.CellStyle(
    fontSize: 11,
    horizontalAlign: xls.HorizontalAlign.Left,
    bottomBorder: bodyBorder,
  );

  for (var i = 0; i < rows.length; i++) {
    final r = rows[i];
    sheet.appendRow([
      xls.IntCellValue(i + 1),
      xls.TextCellValue(r.fullName),
      xls.TextCellValue(repName),
      xls.TextCellValue(r.iccid),
      xls.TextCellValue(r.secondary),
      xls.TextCellValue(r.primary),
      xls.TextCellValue(''),
      xls.TextCellValue(''),
    ]);

    final rowIndex = i + 1;
    // Centred: No, ICC ID, Golis, Amtel, Status, plan. Left: Name, Sales Rep.
    for (var c = 0; c < headers.length; c++) {
      final style = (c == 1 || c == 2) ? left : centered;
      sheet
          .cell(xls.CellIndex.indexByColumnRow(columnIndex: c, rowIndex: rowIndex))
          .cellStyle = style;
    }
  }

  return excel.save();
}

