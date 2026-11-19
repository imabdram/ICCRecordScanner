import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:excel/excel.dart' as xl;
import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:local_auth/local_auth.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:sqflite/sqflite.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

bool isValidIccid(String value) =>
    RegExp(r'^892526379[0-9]{11}$').hasMatch(value);

bool isValidPhone(String value) => RegExp(r'^[0-9]{10}$').hasMatch(value);

/// Endpoints, injected at build time:
///
///   dart-define=NEON_DATA_API_URL=https://EP.apirest.REGION.aws.neon.tech/neondb/rest/v1
///   dart-define=NEON_AUTH_URL=https://EP.neonauth.REGION.aws.neon.tech/neondb/auth
///
/// These are the same two values the web console uses (NEON_DATA_API_URL and
/// NEON_AUTH_BASE_URL in .env.local).
const String neonDataApiUrl = String.fromEnvironment('NEON_DATA_API_URL');
const String neonAuthUrl = String.fromEnvironment('NEON_AUTH_URL');

/// Origin the app presents to Neon Auth on every request.
///
/// Neon Auth requires an `Origin` header and only accepts origins registered as
/// trusted domains for the branch (or localhost). A native build sends no Origin
/// of its own, so the app states one explicitly; this exact value is registered
/// with `neon neon-auth domain add`.
const String neonAuthOrigin = String.fromEnvironment(
  'NEON_AUTH_ORIGIN',
  defaultValue: 'https://app.neon-mobile.local',
);

String profileText(Map<String, dynamic> profile, String key,
        [String fallback = '']) =>
    profile[key] is String && (profile[key] as String).isNotEmpty
        ? profile[key] as String
        : fallback;

/// Human label for a role stored in Postgres (`sales_rep`, `team_leader`,
/// `supervisor`, `admin`).
String roleLabel(String role) => switch (role) {
      'sales_rep' || 'salesRep' => 'Sales Rep',
      'team_leader' || 'teamLeader' => 'Team Leader',
      'supervisor' => 'Supervisor',
      'admin' => 'Administrator',
      _ => role.isEmpty ? 'User' : role,
    };

/// Talks to the Neon backend (Data API/PostgREST + GoTrue auth).
///
/// Firebase has been removed: authentication is a Neon Auth session token kept
/// in secure storage and every data call is scoped by the signed-in user's
/// zone/region/outlet, so an outlet's reps only ever see their own records.
class NeonBackend {
  NeonBackend({
    http.Client? client,
    this.apiUrl = neonDataApiUrl,
    this.authUrl = neonAuthUrl,
  }) : _client = client ?? http.Client();

  final http.Client _client;

  /// PostgREST root, e.g. https://EP.apirest.REGION.aws.neon.tech/neondb/rest/v1
  final String apiUrl;

  /// Better Auth root, e.g. https://EP.neonauth.REGION.aws.neon.tech/neondb/auth
  final String authUrl;
  final _secure = const FlutterSecureStorage();
  String? _token;
  String? _sessionCookie;
  Map<String, dynamic>? _profile;

  static const _tokenKey = 'neon_access_token';
  static const _refreshKey = 'neon_refresh_token';

  bool get isConfigured => apiUrl.isNotEmpty && authUrl.isNotEmpty;
  bool get isSignedIn => _token != null;
  Map<String, dynamic>? get profile => _profile;

  /// The profile view exposes `user_id`; older code read `id`.
  String get userId => '${_profile?['user_id'] ?? _profile?['id'] ?? ''}';

  /// Builds a URL under one of the two service roots.
  Uri _uri(String path, [Map<String, String>? query]) {
    final base = Uri.parse(apiUrl);
    final basePath = base.path.endsWith('/')
        ? base.path.substring(0, base.path.length - 1)
        : base.path;
    return base.replace(path: '$basePath$path', queryParameters: query);
  }

  /// Builds a URL on the auth service (sign-in, session, sign-out).
  Uri _authUri(String path) {
    final base = Uri.parse(authUrl);
    final basePath = base.path.endsWith('/')
        ? base.path.substring(0, base.path.length - 1)
        : base.path;
    return base.replace(path: '$basePath$path');
  }

  Map<String, String> _headers({bool auth = true}) => {
        'apikey': apiUrl,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        if (auth && _token != null) 'Authorization': 'Bearer $_token',
      };

  Future<void> _ensureConfigured() async {
    if (isConfigured) return;
    throw StateError(
      'This build has no NEON_API_URL. Rebuild with '
      '--dart-define=NEON_API_URL=https://your-project.apirest.region.aws.neon.tech/neondb',
    );
  }

  /// Restores a saved session so a rep is not asked to sign in on every open.
  ///
  /// The stored JWT is short lived, so a saved session is verified by using it:
  /// if the profile cannot be read the session is dropped and the login shows.
  Future<bool> restoreSession() async {
    if (!isConfigured) return false;
    _token ??= await _secure.read(key: _tokenKey);
    if (_token == null) return false;
    try {
      await loadProfile();
      return true;
    } catch (_) {
      await signOut();
      return false;
    }
  }

  /// Signs in with the email and password an administrator created.
  ///
  /// Managed Better Auth answers `/sign-in/email` with the session user; the JWT
  /// that the Data API accepts arrives in the `set-auth-jwt` response header
  /// (a cookie holds the session). Both are captured here.
  Future<Map<String, dynamic>> signIn(String email, String password) async {
    await _ensureConfigured();
    http.Response response;
    try {
      response = await _client
          .post(
            _authUri('/sign-in/email'),
            headers: {
              'Content-Type': 'application/json',
              'Origin': neonAuthOrigin,
              'Accept': 'application/json',
            },
            body: jsonEncode({'email': email.trim(), 'password': password}),
          )
          .timeout(const Duration(seconds: 30));
    } on SocketException {
      throw const NeonException('Internet is required to sign in.');
    }
    if (response.statusCode >= 400) {
      throw NeonException(switch (response.statusCode) {
        400 || 401 => 'Email or password is incorrect.',
        429 => 'Too many attempts. Please wait a moment and try again.',
        _ => 'Could not sign in (error ${response.statusCode}).',
      });
    }

    final jwt = response.headers['set-auth-jwt'];
    if (jwt == null || jwt.isEmpty) {
      throw const NeonException('Signed in, but no access token was returned.');
    }
    // Managed Better Auth also sets a session cookie; /change-password needs it.
    final setCookie = response.headers['set-cookie'];
    if (setCookie != null && setCookie.isNotEmpty) {
      _sessionCookie = setCookie
          .split(',')
          .map((part) => part.split(';').first.trim())
          .where((part) => part.contains('='))
          .join('; ');
    }
    await _storeToken(jwt);
    return loadProfile();
  }

  Future<void> _storeToken(String access) async {
    _token = access;
    await _secure.write(key: _tokenKey, value: access);
  }

  Future<void> signOut() async {
    final token = _token;
    _token = null;
    _profile = null;
    _sessionCookie = null;
    await _secure.delete(key: _tokenKey);
    await _secure.delete(key: _refreshKey);
    // Best-effort revoke; never block sign-out on the network.
    if (token != null && isConfigured) {
      unawaited(_client
          .post(
            _authUri('/sign-out'),
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: '{}',
          )
          .then((_) {}, onError: (Object _) {}));
    }
  }

  /// Loads the signed-in user's assignment (outlet -> region -> zone).
  Future<Map<String, dynamic>> loadProfile() async {
    await _ensureConfigured();
    final response = await _client.get(
      _uri('/v_my_profile', {'select': '*', 'limit': '1'}),
      headers: _headers(),
    );
    if (response.statusCode == 401 || response.statusCode == 403) {
      throw const NeonException('Your session expired. Sign in again.');
    }
    if (response.statusCode >= 400) {
      throw NeonException('Could not load profile (${response.statusCode}).');
    }
    final rows = jsonDecode(response.body);
    if (rows is! List || rows.isEmpty) {
      throw StateError('Your account is not approved for this application.');
    }
    final data = rows.first as Map<String, dynamic>;
    if (data['active'] == false) {
      throw StateError('This account has been disabled.');
    }
    _profile = data;
    return data;
  }

  /// The scans this user is allowed to see: their own, their outlet's, their
  /// region's, or their zone's depending on their role (enforced by RLS).
  Future<List<Map<String, dynamic>>> visibleScans() async {
    await _ensureConfigured();
    final response = await _client.get(
      _uri('/v_scan_records', {'select': '*', 'order': 'created_at.desc'}),
      headers: _headers(),
    );
    if (response.statusCode >= 400) {
      throw NeonException('Could not load records (${response.statusCode}).');
    }
    final rows = jsonDecode(response.body);
    return (rows as List).cast<Map<String, dynamic>>();
  }

  /// Inserts a scan. The unique ICCID is the dedupe key the server enforces.
  Future<void> insertScan(CustomerRecord record) async {
    await _ensureConfigured();
    final response = await _client.post(
      _uri('/scans'),
      headers: {..._headers(), 'Prefer': 'return=minimal'},
      body: jsonEncode({
        'iccid': record.iccId,
        'customer_name': record.fullName,
        'primary_number': record.primaryNumber,
        'secondary_number': record.secondaryNumber,
        'created_at': record.createdAt.toUtc().toIso8601String(),
        'created_by': userId,
      }),
    );
    if (response.statusCode == 409) {
      throw const NeonException('This ICC ID already exists.');
    }
    if (response.statusCode >= 400) {
      throw NeonException('Could not save record (${response.statusCode}).');
    }
  }

  Future<void> updateScan(CustomerRecord record) async {
    await _ensureConfigured();
    final response = await _client.patch(
      _uri('/scans', {'iccid': 'eq.${record.iccId}'}),
      headers: {..._headers(), 'Prefer': 'return=minimal'},
      body: jsonEncode({
        'customer_name': record.fullName,
        'primary_number': record.primaryNumber,
        'secondary_number': record.secondaryNumber,
      }),
    );
    if (response.statusCode >= 400) {
      throw NeonException('Could not update record (${response.statusCode}).');
    }
  }

  Future<void> deleteScans(Iterable<String> iccIds) async {
    await _ensureConfigured();
    final ids = iccIds.toList();
    if (ids.isEmpty) return;
    final response = await _client.delete(
      _uri('/scans', {'iccid': 'in.(${ids.join(',')})'}),
      headers: _headers(),
    );
    if (response.statusCode >= 400) {
      throw NeonException('Could not delete records (${response.statusCode}).');
    }
  }

  /// Pulls cloud scans into SQLite, and removes local rows the server no
  /// longer has, so a dashboard delete reaches the phone as well.
  Future<int> syncInto(RecordDatabase database) async {
    final rows = await visibleScans();
    return database.applyCloudRows(rows);
  }

  /// Changes the signed-in user's own password.
  ///
  /// Neon Auth requires their current password. The session cookie from sign-in
  /// is what authorises the change, so the returned cookie is carried here along
  /// with the bearer token (kept in memory only for the life of the session).
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    await _ensureConfigured();
    if (!isSignedIn) {
      throw const NeonException('Sign in again before changing your password.');
    }
    if (newPassword.length < 8) {
      throw const NeonException('The new password must be at least 8 characters.');
    }
    http.Response response;
    try {
      response = await _client
          .post(
            _authUri('/change-password'),
            headers: {
              'Content-Type': 'application/json',
              'Origin': neonAuthOrigin,
              'Accept': 'application/json',
              'Authorization': 'Bearer $_token',
              if (_sessionCookie != null) 'Cookie': _sessionCookie!,
            },
            body: jsonEncode({
              'currentPassword': currentPassword,
              'newPassword': newPassword,
              'revokeOtherSessions': false,
            }),
          )
          .timeout(const Duration(seconds: 30));
    } on SocketException {
      throw const NeonException('Internet is required to change your password.');
    }
    if (response.statusCode == 400 || response.statusCode == 401) {
      throw const NeonException('Your current password is incorrect.');
    }
    if (response.statusCode >= 400) {
      throw NeonException('Could not change the password (error ${response.statusCode}).');
    }
  }
}

class NeonException implements Exception {
  const NeonException(this.message);
  final String message;
  @override
  String toString() => message;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await NeonBackend().restoreSession();
  runApp(const IccRecordsApp());
}

class IccRecordsApp extends StatelessWidget {
  const IccRecordsApp({super.key});

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF155EEF);
    const accentRed = Color(0xFFD32F2F);
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'ICC Record Scanner',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: seed).copyWith(
          secondary: accentRed,
          tertiary: accentRed,
        ),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF7F8FC),
        inputDecorationTheme: const InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.all(Radius.circular(16)),
            borderSide: BorderSide.none,
          ),
        ),
      ),
      home: const AuthGate(),
    );
  }
}

class AuthGate extends StatelessWidget {
  const AuthGate({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<Map<String, dynamic>?>(
      valueListenable: SessionStore.profileChanges,
      builder: (context, profile, _) {
        if (profile == null) return const LoginPage();
        return BiometricGate(profile: profile);
      },
    );
  }
}

/// Single place that owns the Neon session so every screen reads the same
/// signed-in user instead of reaching into FirebaseAuth like before.
class SessionStore {
  SessionStore._();

  static final NeonBackend backend = NeonBackend();
  static final ValueNotifier<Map<String, dynamic>?> _profile =
      ValueNotifier<Map<String, dynamic>?>(backend.profile);

  static ValueListenable<Map<String, dynamic>?> get profileChanges => _profile;

  static void set(Map<String, dynamic>? value) => _profile.value = value;

  static Future<void> signOut() async {
    await backend.signOut();
    set(null);
  }
}

class BiometricGate extends StatefulWidget {
  const BiometricGate({super.key, required this.profile});

  final Map<String, dynamic> profile;

  @override
  State<BiometricGate> createState() => _BiometricGateState();
}

class _BiometricGateState extends State<BiometricGate> {
  final LocalAuthentication _localAuth = LocalAuthentication();
  bool _checking = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _authenticateIfEnabled();
  }

  Future<void> _authenticateIfEnabled() async {
    final preferences = await SharedPreferences.getInstance();
    final enabled = preferences.getBool('biometric_enabled') ?? false;
    if (!enabled) {
      if (mounted) setState(() => _checking = false);
      return;
    }

    try {
      final supported = await _localAuth.isDeviceSupported();
      final available = await _localAuth.canCheckBiometrics;
      if (!supported || !available) {
        await preferences.setBool('biometric_enabled', false);
        if (mounted) {
          setState(() {
            _checking = false;
            _error = 'Biometric login is no longer available on this device.';
          });
        }
        return;
      }
      final authenticated = await _localAuth.authenticate(
        localizedReason: 'Verify your identity to open SIM Management System',
        options: const AuthenticationOptions(
          biometricOnly: false,
          stickyAuth: true,
          useErrorDialogs: true,
        ),
      );
      if (!authenticated) {
        if (mounted) {
          setState(() {
            _checking = false;
            _error = 'Biometric verification was cancelled or failed.';
          });
        }
        return;
      }
    } on PlatformException catch (error) {
      if (mounted) {
        setState(() {
          _checking = false;
          _error = error.message ?? 'Biometric verification could not be completed.';
        });
      }
      return;
    } catch (_) {
      if (mounted) {
        setState(() {
          _checking = false;
          _error = 'Biometric verification could not be completed.';
        });
      }
      return;
    }
    if (mounted) setState(() => _checking = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_checking) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }
    if (_error != null) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.fingerprint, size: 64),
                const SizedBox(height: 16),
                Text(_error!, textAlign: TextAlign.center),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: () {
                    setState(() {
                      _checking = true;
                      _error = null;
                    });
                    unawaited(_authenticateIfEnabled());
                  },
                  child: const Text('Try again'),
                ),
                TextButton(
                  onPressed: () async {
                    final preferences =
                        await SharedPreferences.getInstance();
                    await preferences.setBool('biometric_enabled', false);
                    if (mounted) setState(() => _error = null);
                  },
                  child: const Text('Use normal sign-in next time'),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return UserProfileGate(profile: widget.profile);
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _signIn() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final profile =
          await SessionStore.backend.signIn(_email.text.trim(), _password.text);
      SessionStore.set(profile);
    } on NeonException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not sign in.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(Icons.sim_card,
                        size: 72, color: Color(0xFFD32F2F)),
                    const SizedBox(height: 16),
                    Text(
                      'ICC Record Scanner',
                      textAlign: TextAlign.center,
                      style:
                          Theme.of(context).textTheme.headlineSmall?.copyWith(
                                fontWeight: FontWeight.w800,
                              ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Sign in with an administrator-created account.',
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 28),
                    TextFormField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.username],
                      decoration: const InputDecoration(
                        labelText: 'Email',
                        prefixIcon: Icon(Icons.email_outlined),
                      ),
                      validator: (value) =>
                          value == null || !value.contains('@')
                              ? 'Enter a valid email.'
                              : null,
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _password,
                      obscureText: _obscure,
                      autofillHints: const [AutofillHints.password],
                      decoration: InputDecoration(
                        labelText: 'Password',
                        prefixIcon: const Icon(Icons.lock_outline),
                        suffixIcon: IconButton(
                          onPressed: () => setState(() => _obscure = !_obscure),
                          icon: Icon(_obscure
                              ? Icons.visibility
                              : Icons.visibility_off),
                        ),
                      ),
                      validator: (value) => value == null || value.length < 6
                          ? 'Enter your password.'
                          : null,
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 14),
                      Text(_error!,
                          style: TextStyle(
                              color: Theme.of(context).colorScheme.error)),
                    ],
                    const SizedBox(height: 22),
                    FilledButton(
                      onPressed: _busy ? null : _signIn,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        child: _busy
                            ? const SizedBox(
                                height: 20,
                                width: 20,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Text('Sign in'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class UserProfileGate extends StatelessWidget {
  const UserProfileGate({super.key, required this.profile});

  final Map<String, dynamic> profile;

  @override
  Widget build(BuildContext context) {
    return AppShell(profile: profile);
  }
}

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.profile});

  final Map<String, dynamic> profile;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _index = 0;
  Timer? _sessionTimer;
  Timer? _syncTimer;

  @override
  void initState() {
    super.initState();
    _resetSessionTimer();
    RecordDatabase.revision.addListener(_handleRevision);
    unawaited(CloudScanSync.instance.start());
    // Postgres has no client-watch like Firestore, so refresh on a timer.
    _syncTimer = Timer.periodic(const Duration(seconds: 60), (_) {
      unawaited(CloudScanSync.instance.refresh());
    });
  }

  @override
  void dispose() {
    RecordDatabase.revision.removeListener(_handleRevision);
    CloudScanSync.instance.stop();
    _syncTimer?.cancel();
    _sessionTimer?.cancel();
    super.dispose();
  }

  void _handleRevision() {
    if (mounted) setState(() {});
  }

  void _resetSessionTimer() {
    _sessionTimer?.cancel();
    _sessionTimer = Timer(const Duration(minutes: 10), () {
      unawaited(SessionStore.signOut());
    });
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      ScanLandingPage(profile: widget.profile),
      RecordsHomePage(profile: widget.profile),
      DashboardPage(profile: widget.profile),
    ];
    return Listener(
      onPointerDown: (_) => _resetSessionTimer(),
      child: Scaffold(
        drawer: _AppDrawer(
          profile: widget.profile,
          onLogout: _confirmLogout,
        ),
        body: SafeArea(
          child: Stack(
            children: [
              pages[_index],
              Positioned(
                top: 8,
                left: 10,
                child: Builder(
                  builder: (context) => Material(
                    color: Colors.white,
                    shape: const CircleBorder(),
                    elevation: 3,
                    child: IconButton(
                      tooltip: 'Open menu',
                      onPressed: () {
                        _resetSessionTimer();
                        Scaffold.of(context).openDrawer();
                      },
                      icon: const Icon(Icons.menu, color: Color(0xFF101C2B)),
                    ),
                  ),
                ),
              ),

            ],
          ),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: (index) {
            _resetSessionTimer();
            setState(() => _index = index);
          },
          destinations: const [
            NavigationDestination(
              icon: Icon(Icons.qr_code_scanner_outlined),
              selectedIcon: Icon(Icons.qr_code_scanner),
              label: 'Scan',
            ),
            NavigationDestination(
              icon: Icon(Icons.history_outlined),
              selectedIcon: Icon(Icons.history),
              label: 'Records',
            ),
            NavigationDestination(
              icon: Icon(Icons.dashboard_outlined),
              selectedIcon: Icon(Icons.dashboard),
              label: 'Dashboard',
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmLogout() async {
    final shouldLogout = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Log out?'),
        content: const Text('You will need to sign in again to use the app.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFF00000)),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Log out'),
          ),
        ],
      ),
    );
    if (shouldLogout == true) {
      await SessionStore.signOut();
    }
  }
}

class _AppDrawer extends StatelessWidget {
  const _AppDrawer({required this.profile, required this.onLogout});

  final Map<String, dynamic> profile;
  final Future<void> Function() onLogout;

  String _initials() {
    final name = profileText(profile, 'display_name', 'User').trim();
    return name
        .split(RegExp(r'\s+'))
        .where((part) => part.isNotEmpty)
        .map((part) => part[0])
        .take(2)
        .join()
        .toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final name = profileText(profile, 'display_name', 'User');
    final phone = profileText(profile, 'phone', '');
    final role = roleLabel(profileText(profile, 'role', 'sales_rep'));
    final zone = profileText(profile, 'zone_name', '');
    final region = profileText(profile, 'region_name', '');
    final outlet = profileText(profile, 'outlet_name', 'No outlet assigned');

    return Drawer(
      width: MediaQuery.sizeOf(context).width * .82,
      backgroundColor: const Color(0xFFF7F8FC),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.only(
          topRight: Radius.circular(24),
          bottomRight: Radius.circular(24),
        ),
      ),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              margin: const EdgeInsets.fromLTRB(14, 10, 14, 6),
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF155EEF), Color(0xFF1D2671)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 28,
                    backgroundColor: Colors.white.withValues(alpha: 0.2),
                    child: Text(
                      _initials(),
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                color: Colors.white,
                                fontSize: 17,
                                fontWeight: FontWeight.w800)),
                        const SizedBox(height: 2),
                        Text(role,
                            style: TextStyle(
                                color: Colors.white.withValues(alpha: 0.85),
                                fontSize: 12,
                                fontWeight: FontWeight.w600)),
                        if (phone.isNotEmpty)
                          Text(phone,
                              style: TextStyle(
                                  color: Colors.white.withValues(alpha: 0.75),
                                  fontSize: 11)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
                children: [
                  _DrawerItem(
                    icon: Icons.settings_outlined,
                    label: 'Settings',
                    subtitle: 'Account & sync',
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => SettingsPage(profile: profile),
                      ),
                    ),
                  ),
                  _DrawerItem(
                    icon: Icons.support_agent_outlined,
                    label: 'Customer Support',
                    subtitle: 'Call or WhatsApp',
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => const CustomerCarePage(),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),
                  Padding(
                    padding: const EdgeInsets.only(left: 4, bottom: 8),
                    child: Text('YOUR PROFILE',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: const Color(0xFF8A94A6),
                              fontWeight: FontWeight.w800,
                              letterSpacing: 1,
                            )),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: const Color(0xFFE7EBF3)),
                    ),
                    child: Column(
                      children: [
                        _ProfileLine(label: 'Outlet', value: outlet),
                        _ProfileLine(label: 'Region', value: region.isEmpty ? '—' : region),
                        _ProfileLine(label: 'Zone', value: zone.isEmpty ? '—' : zone, last: true),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 10),
              child: Column(
                children: [
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFFD32F2F),
                        side: const BorderSide(color: Color(0xFFF3CFCF)),
                        backgroundColor: Colors.white,
                        minimumSize: const Size.fromHeight(50),
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14)),
                      ),
                      onPressed: () async {
                        Navigator.pop(context);
                        await onLogout();
                      },
                      icon: const Icon(Icons.logout),
                      label: const Text('Log out',
                          style: TextStyle(fontWeight: FontWeight.w700)),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text('SIM Management System · v1.2.0 (Neon)',
                      style: TextStyle(
                          color: Colors.grey.shade600, fontSize: 11)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DrawerItem extends StatelessWidget {
  const _DrawerItem({
    required this.icon,
    required this.label,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            child: Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: const Color(0xFFE8EDFF),
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: Icon(icon, size: 22, color: const Color(0xFF155EEF)),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(label,
                          style: const TextStyle(
                              color: Color(0xFF101C2B),
                              fontSize: 15,
                              fontWeight: FontWeight.w700)),
                      Text(subtitle,
                          style: const TextStyle(
                              color: Color(0xFF7A8494), fontSize: 12)),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, color: Color(0xFFB0B8C4)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ProfileLine extends StatelessWidget {
  const _ProfileLine({required this.label, required this.value, this.last = false});

  final String label;
  final String value;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 11),
      decoration: BoxDecoration(
        border: last ? null : const Border(bottom: BorderSide(color: Color(0xFFF0F2F6))),
      ),
      child: Row(
        children: [
          SizedBox(
              width: 72,
              child: Text(label,
                  style: const TextStyle(
                      color: Color(0xFF8A94A6), fontSize: 12))),
          Expanded(
              child: Text(value,
                  textAlign: TextAlign.right,
                  style: const TextStyle(
                      color: Color(0xFF101C2B),
                      fontSize: 13,
                      fontWeight: FontWeight.w600))),
        ],
      ),
    );
  }
}

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.profile});

  final Map<String, dynamic> profile;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final LocalAuthentication _localAuth = LocalAuthentication();
  bool _biometricEnabled = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadPreference();
  }

  Future<void> _loadPreference() async {
    final preferences = await SharedPreferences.getInstance();
    if (mounted) {
      setState(() {
        _biometricEnabled = preferences.getBool('biometric_enabled') ?? false;
        _loading = false;
      });
    }
  }

  Future<void> _setBiometric(bool value) async {
    if (!value) {
      final preferences = await SharedPreferences.getInstance();
      await preferences.setBool('biometric_enabled', false);
      if (mounted) setState(() => _biometricEnabled = false);
      return;
    }
    try {
      final supported = await _localAuth.isDeviceSupported();
      final available = await _localAuth.canCheckBiometrics;
      if (!supported || !available) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Set up fingerprint or face unlock in Android Settings first.')));
        }
        return;
      }
      final authenticated = await _localAuth.authenticate(
        localizedReason: 'Confirm your identity to enable biometric login',
        options: const AuthenticationOptions(
          biometricOnly: false,
          stickyAuth: true,
          useErrorDialogs: true,
        ),
      );
      if (!authenticated) return;
      final preferences = await SharedPreferences.getInstance();
      await preferences.setBool('biometric_enabled', true);
      if (mounted) {
        setState(() => _biometricEnabled = true);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Biometric login enabled on this device.')));
      }
    } on PlatformException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(
                content: Text(error.message ??
                    'Biometric authentication could not be completed.')));
      }
    }
  }

  Future<void> _showMessage(BuildContext context, String title, String message) {
    return showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          ListTile(
            leading: const Icon(Icons.lock_reset),
            title: const Text('Change password'),
            subtitle: const Text('Update the password you sign in with'),
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => const ChangePasswordPage()),
            ),
          ),
          ListTile(
            leading: const Icon(Icons.email_outlined),
            title: const Text('Change email'),
            subtitle: Text(profileText(widget.profile, 'email', 'No email available')),
            onTap: () => _showMessage(context, 'Change email',
                'Ask your administrator to update the login email from Team Management.'),
          ),
          SwitchListTile(
            secondary: const Icon(Icons.fingerprint),
            title: const Text('Enable biometric login'),
            subtitle: const Text('Use fingerprint, face, or device PIN when reopening the app'),
            value: _biometricEnabled,
            onChanged: _loading ? null : _setBiometric,
          ),
          const Divider(height: 32),
          ListTile(
            leading: const Icon(Icons.logout, color: Color(0xFFD32F2F)),
            title: const Text('Log out', style: TextStyle(color: Color(0xFFD32F2F), fontWeight: FontWeight.w600)),
            subtitle: const Text('Sign out of this account on this phone'),
            onTap: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (context) => AlertDialog(
                  title: const Text('Log out?'),
                  content: const Text('You can sign in again anytime. Your synced scans are backed up online.'),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
                    FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Log out')),
                  ],
                ),
              );
              if (ok == true) {
                await SessionStore.signOut();
              }
            },
          ),
        ],
      ),
    );
  }
}

/// Lets a signed-in user change their own password.
///
/// Neon Auth verifies the current password server-side, so a stolen phone with
/// an open session still cannot silently change the credentials.
class ChangePasswordPage extends StatefulWidget {
  const ChangePasswordPage({super.key});

  @override
  State<ChangePasswordPage> createState() => _ChangePasswordPageState();
}

class _ChangePasswordPageState extends State<ChangePasswordPage> {
  final _formKey = GlobalKey<FormState>();
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _saving = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  String? _required(String? value) =>
      value == null || value.isEmpty ? 'Required' : null;

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await SessionStore.backend.changePassword(
        currentPassword: _current.text,
        newPassword: _next.text,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Password changed.')),
      );
      Navigator.pop(context);
    } on NeonException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not change the password.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Change password')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextFormField(
                  controller: _current,
                  obscureText: _obscure,
                  validator: _required,
                  decoration: const InputDecoration(
                    labelText: 'Current password',
                    prefixIcon: Icon(Icons.lock_outline),
                  ),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _next,
                  obscureText: _obscure,
                  validator: (value) => value == null || value.length < 8
                      ? 'At least 8 characters.'
                      : (value == _current.text ? 'Choose a different password.' : null),
                  decoration: const InputDecoration(
                    labelText: 'New password',
                    prefixIcon: Icon(Icons.password),
                  ),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _confirm,
                  obscureText: _obscure,
                  validator: (value) =>
                      value != _next.text ? 'The passwords do not match.' : null,
                  onFieldSubmitted: (_) => _saving ? null : _save(),
                  decoration: const InputDecoration(
                    labelText: 'Confirm new password',
                    prefixIcon: Icon(Icons.password),
                  ),
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _obscure,
                  onChanged: (value) => setState(() => _obscure = value ?? true),
                  title: const Text('Hide passwords'),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                ],
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: _saving ? null : _save,
                  icon: _saving
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.check),
                  label: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(_saving ? 'Saving…' : 'Change password'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class CustomerCarePage extends StatelessWidget {
  const CustomerCarePage({super.key});

  Future<void> _call(BuildContext context, String number) async {
    final uri = Uri(scheme: 'tel', path: number);
    if (!await launchUrl(uri)) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Could not open phone app.')));
      }
    }
  }

  Future<void> _whatsapp(BuildContext context, String number) async {
    final uri = Uri.parse('https://wa.me/${number.replaceAll(RegExp(r'^0'), '252')}');
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not open WhatsApp.')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    const calls = ['454', '0907102026', '0717102026', '456', '0906408296', '0716408296'];
    const whatsapp = ['0717102026', '0710000404'];
    return Scaffold(
      appBar: AppBar(title: const Text('Customer Care')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text('Call customer care',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          ...calls.map((number) => ListTile(
                leading: const Icon(Icons.phone, color: Color(0xFF155EEF)),
                title: Text(number),
                onTap: () => _call(context, number),
              )),
          const SizedBox(height: 16),
          const Text('WhatsApp',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          ...whatsapp.map((number) => ListTile(
                leading: const Icon(Icons.chat, color: Color(0xFF16A05D)),
                title: Text(number),
                onTap: () => _whatsapp(context, number),
              )),
        ],
      ),
    );
  }
}

class ScanLandingPage extends StatefulWidget {
  const ScanLandingPage({super.key, required this.profile});

  final Map<String, dynamic> profile;

  @override
  State<ScanLandingPage> createState() => _ScanLandingPageState();
}

class _ScanLandingPageState extends State<ScanLandingPage> {
  late Future<List<CustomerRecord>> _todayRecords;

  @override
  void initState() {
    super.initState();
    _reloadToday();
    RecordDatabase.revision.addListener(_handleRevision);
  }

  @override
  void dispose() {
    RecordDatabase.revision.removeListener(_handleRevision);
    super.dispose();
  }

  void _handleRevision() {
    if (!mounted) return;
    setState(_reloadToday);
  }

  void _reloadToday() {
    _todayRecords = RecordDatabase.instance.today();
  }

  Future<void> _openScanner() async {
    if (!mounted) return;
    final value = await Navigator.push<String>(
      context,
      _smoothRoute(const ScannerPage()),
    );
    if (value == null || !mounted) return;
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => RecordFormPage(
          profile: widget.profile,
          scannedIccid: value,
        ),
      ),
    );
    if (mounted) setState(_reloadToday);
  }

  Route<String> _smoothRoute(Widget page) => PageRouteBuilder<String>(
        pageBuilder: (_, __, ___) => page,
        transitionDuration: const Duration(milliseconds: 180),
        reverseTransitionDuration: const Duration(milliseconds: 140),
        transitionsBuilder: (_, animation, __, child) =>
            FadeTransition(opacity: animation, child: child),
      );

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Scan a SIM card',
                      style:
                          TextStyle(fontSize: 26, fontWeight: FontWeight.w800),
                    ),
                    Text(
                      '${profileText(widget.profile, 'outlet_name', 'No outlet assigned')} · '
                      '${profileText(widget.profile, 'region_name', '—')}',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: const Color(0xFF64748B),
                            fontWeight: FontWeight.w600,
                          ),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Refresh today’s scans',
                onPressed: () => setState(_reloadToday),
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
          child: SyncStatusBanner(),
        ),
        Expanded(
          child: FutureBuilder<List<CustomerRecord>>(
            future: _todayRecords,
            builder: (context, snapshot) {
              final records = snapshot.data ?? const <CustomerRecord>[];
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }
              if (records.isEmpty) {
                return const Center(
                  child: Text(
                    'Nothing scanned today yet.',
                    style: TextStyle(color: Color(0xFF6B7280)),
                  ),
                );
              }
              return ListView(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
                children: [
                  Text(
                    'Scanned today (${records.length})',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                  ),
                  const SizedBox(height: 8),
                  ...records.map(
                    (record) => Card(
                      elevation: 0,
                      margin: const EdgeInsets.only(bottom: 8),
                      child: ListTile(
                        leading: const CircleAvatar(
                          child: Icon(Icons.check),
                        ),
                        title: Text(
                          record.fullName,
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        subtitle: Text(
                          '${record.iccId}\n${record.primaryNumber}',
                        ),
                        isThreeLine: true,
                        trailing: Text(
                          DateFormat('hh:mm a').format(record.createdAt),
                          style: Theme.of(context).textTheme.labelSmall,
                        ),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(24),
            elevation: 7,
            shadowColor: const Color(0x66D32F2F),
            child: InkWell(
              onTap: _openScanner,
              borderRadius: BorderRadius.circular(24),
              child: Ink(
                height: 82,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [Color(0xFFE71924), Color(0xFFB91C2B)],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(24),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Row(
                    children: [
                      Container(
                        width: 52,
                        height: 52,
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.18),
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.35),
                          ),
                        ),
                        child: const Icon(
                          Icons.qr_code_scanner_rounded,
                          color: Colors.white,
                          size: 30,
                        ),
                      ),
                      const SizedBox(width: 14),
                      const Expanded(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Scan SIM card',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 20,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            SizedBox(height: 3),
                            Text(
                              'Ready to scan',
                              style: TextStyle(
                                color: Color(0xFFFFD6D9),
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const Icon(
                        Icons.arrow_forward_rounded,
                        color: Colors.white,
                        size: 28,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class SyncStatusBanner extends StatefulWidget {
  const SyncStatusBanner({super.key});

  @override
  State<SyncStatusBanner> createState() => _SyncStatusBannerState();
}

class _SyncStatusBannerState extends State<SyncStatusBanner> {
  bool _syncing = false;

  Future<void> _syncNow() async {
    if (_syncing) return;
    setState(() => _syncing = true);
    try {
      if (!SessionStore.backend.isSignedIn) {
        throw const NeonException('Sign in first to sync.');
      }
      await CloudScanSync.instance.retryNow();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Sync finished. Check the web dashboard.')),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Sync error: $error')),
        );
      }
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<List<ConnectivityResult>>(
      stream: Connectivity().onConnectivityChanged,
      initialData: const [ConnectivityResult.none],
      builder: (context, snapshot) {
        final online =
            snapshot.data?.any((result) => result != ConnectivityResult.none) ??
                false;
        return Card(
          margin: EdgeInsets.zero,
          color: online ? Colors.green.shade50 : Colors.orange.shade50,
          child: ListTile(
            dense: true,
            leading: Icon(
              online ? Icons.cloud_done_outlined : Icons.cloud_off_outlined,
              color: online ? Colors.green.shade800 : Colors.orange.shade900,
            ),
            title: Text(online
                ? 'Online - scans backup to the website'
                : 'Offline - scans saved on this phone'),
            subtitle: Text(online
                ? 'Tap Sync now if a scan is missing on the website.'
                : 'Connect to internet to backup and sync.'),
            trailing: online
                ? TextButton(
                    onPressed: _syncing ? null : _syncNow,
                    child: _syncing
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Sync now'),
                  )
                : null,
          ),
        );
      },
    );
  }
}

class DashboardPage extends StatelessWidget {
  const DashboardPage({super.key, required this.profile});

  final Map<String, dynamic> profile;

  Future<int> _count() async => (await RecordDatabase.instance.today()).length;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<int>(
      future: _count(),
      builder: (context, snapshot) {
        final count = snapshot.data ?? 0;
        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              'Today’s field shift',
              style: Theme.of(context)
                  .textTheme
                  .headlineSmall
                  ?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Text(
              profileText(profile, 'display_name', 'Sales representative')
                  .toUpperCase(),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            Text(
              '${profileText(profile, 'outlet_name', 'No outlet assigned')} · '
              '${profileText(profile, 'region_name', '—')} · '
              '${profileText(profile, 'zone_name', '—')}',
              style: const TextStyle(color: Color(0xFF64748B)),
            ),
            const SizedBox(height: 24),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF1D2671), Color(0xFF2B32B2)],
                ),
                borderRadius: BorderRadius.circular(22),
              ),
              child: Row(
                children: [
                  const Icon(Icons.today, color: Colors.white, size: 32),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Scans saved today',
                            style: TextStyle(color: Colors.white70)),
                        Text('$count SIMs',
                            style: const TextStyle(
                                color: Colors.white,
                                fontSize: 30,
                                fontWeight: FontWeight.w800)),
                      ],
                    ),
                  ),
                  const Icon(Icons.offline_bolt_outlined,
                      color: Colors.white70),
                ],
              ),
            ),
            const SizedBox(height: 12),
            const SyncStatusBanner(),
          ],
        );
      },
    );
  }
}

class CustomerRecord {
  final int? id;
  final String iccId;
  final String fullName;
  final String primaryNumber;
  final String secondaryNumber;
  final DateTime createdAt;
  final String syncStatus;

  const CustomerRecord({
    this.id,
    required this.iccId,
    required this.fullName,
    required this.primaryNumber,
    required this.secondaryNumber,
    required this.createdAt,
    this.syncStatus = 'pending',
  });

  Map<String, Object?> toMap() => {
        'id': id,
        'icc_id': iccId,
        'full_name': fullName,
        'primary_number': primaryNumber,
        'secondary_number': secondaryNumber,
        'created_at': createdAt.toIso8601String(),
        'sync_status': syncStatus,
      };

  factory CustomerRecord.fromMap(Map<String, Object?> map) => CustomerRecord(
        id: map['id'] as int,
        iccId: map['icc_id'] as String,
        fullName: map['full_name'] as String,
        primaryNumber: map['primary_number'] as String,
        secondaryNumber: map['secondary_number'] as String,
        createdAt: DateTime.parse(map['created_at'] as String),
        syncStatus: (map['sync_status'] as String?) ?? 'pending',
      );
}

class RecordDatabase {
  RecordDatabase._();
  static final instance = RecordDatabase._();
  Database? _db;

  Future<Database> get database async {
    if (_db != null) return _db!;
    final path = p.join(await getDatabasesPath(), 'icc_records.db');
    _db = await openDatabase(
      path,
      version: 3,
      onCreate: (db, _) => db.execute('''
        CREATE TABLE records(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          icc_id TEXT NOT NULL UNIQUE,
          full_name TEXT NOT NULL,
          primary_number TEXT NOT NULL,
          secondary_number TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sync_status TEXT NOT NULL DEFAULT 'pending'
        )
      ''').then((_) => db.execute(
            'CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC)',
          )),
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute(
            'CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC)',
          );
        }
        if (oldVersion < 3) {
          await db.execute(
            "ALTER TABLE records ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending'",
          );
        }
      },
    );
    return _db!;
  }

  Future<List<CustomerRecord>> all() async {
    final db = await database;
    final rows = await db.query('records', orderBy: 'created_at DESC');
    return rows.map(CustomerRecord.fromMap).toList();
  }

  Future<List<CustomerRecord>> today() async {
    final db = await database;
    final now = DateTime.now();
    final start = DateTime(now.year, now.month, now.day).toIso8601String();
    final end = DateTime(now.year, now.month, now.day + 1).toIso8601String();
    final rows = await db.query(
      'records',
      where: 'created_at >= ? AND created_at < ?',
      whereArgs: [start, end],
      orderBy: 'created_at DESC',
    );
    return rows.map(CustomerRecord.fromMap).toList();
  }

  Future<int> insert(CustomerRecord record) async {
    final db = await database;
    return db.insert('records', record.toMap(),
        conflictAlgorithm: ConflictAlgorithm.abort);
  }

  Future<void> update(CustomerRecord record) async {
    final db = await database;
    await db.update('records', record.toMap(),
        where: 'id = ?', whereArgs: [record.id]);
  }

  Future<void> setSyncStatus(int id, String status) async {
    final db = await database;
    await db.update(
      'records',
      {'sync_status': status},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Future<void> deleteIds(Iterable<int> ids) async {
    final db = await database;
    final batch = db.batch();
    for (final id in ids) {
      batch.delete('records', where: 'id = ?', whereArgs: [id]);
    }
    await batch.commit(noResult: true);
  }

  /// Bumped whenever cloud sync changes the local table so open screens can
  /// refresh without polling.
  static final ValueNotifier<int> revision = ValueNotifier<int>(0);

  Future<List<CustomerRecord>> pendingSync() async {
    final db = await database;
    final rows = await db.query(
      'records',
      where: "sync_status != 'synced'",
      orderBy: 'created_at ASC',
    );
    return rows.map(CustomerRecord.fromMap).toList();
  }

  /// Mirrors the server's view into SQLite in one pass: upserts every visible
  /// scan, then drops local rows the server no longer returns, so a deletion
  /// made on the web dashboard also disappears from this phone.
  Future<int> applyCloudRows(List<Map<String, dynamic>> rows) async {
    final db = await database;
    var changed = 0;
    final seen = <String>{};
    await db.transaction((txn) async {
      for (final row in rows) {
        final iccId = '${row['iccid'] ?? ''}'.trim();
        if (iccId.isEmpty) continue;
        seen.add(iccId);
        final createdAt =
            DateTime.tryParse('${row['created_at'] ?? ''}') ?? DateTime.now();
        final values = <String, Object?>{
          'icc_id': iccId,
          'full_name': '${row['customer_name'] ?? ''}',
          'primary_number': '${row['primary_number'] ?? ''}',
          'secondary_number': '${row['secondary_number'] ?? ''}',
          'created_at': createdAt.toIso8601String(),
          'sync_status': 'synced',
        };
        // Compare first: a value-equal UPDATE is a no-op, so a plain poll
        // never bumps the revision and never rebuilds the screens.
        final existing = await txn.query(
          'records',
          columns: const [
            'full_name',
            'primary_number',
            'secondary_number',
            'created_at',
          ],
          where: 'icc_id = ?',
          whereArgs: [iccId],
          limit: 1,
        );
        if (existing.isNotEmpty) {
          final current = existing.first;
          final same = current['full_name'] == values['full_name'] &&
              current['primary_number'] == values['primary_number'] &&
              current['secondary_number'] == values['secondary_number'] &&
              DateTime.tryParse('${current['created_at']}') == createdAt;
          if (same) continue;
          await txn.update('records', values,
              where: 'icc_id = ?', whereArgs: [iccId]);
        } else {
          await txn.insert('records', values,
              conflictAlgorithm: ConflictAlgorithm.replace);
        }
        changed++;
      }
      final local = await txn.query('records', columns: ['id', 'icc_id']);
      for (final row in local) {
        final iccId = '${row['icc_id']}';
        if (!seen.contains(iccId)) {
          await txn.delete('records', where: 'id = ?', whereArgs: [row['id']]);
          changed++;
        }
      }
    });
    if (changed > 0) revision.value++;
    return changed;
  }
}

/// Pushes a locally created record to Postgres. Safe to retry: a duplicate
/// ICCID is reported as "already exists" and never double-counted.
Future<void> pushRecordToCloud(CustomerRecord record) async {
  final backend = SessionStore.backend;
  if (!backend.isSignedIn) {
    throw const NeonException('Sign in to send this record to the server.');
  }
  await backend.insertScan(record);
}

/// Pushes customer edits. Ownership and location columns are derived on the
/// server from the signed-in user, so they cannot be spoofed from a phone.
Future<void> pushRecordUpdateToCloud(CustomerRecord record) async {
  await SessionStore.backend.updateScan(record);
}

/// Keeps the local SQLite records in step with the Neon database. Sales reps
/// see only their own outlet's records; supervisors see their region. The
/// server enforces this through row-level security on v_scan_records.
class CloudScanSync {
  CloudScanSync._();

  static final CloudScanSync instance = CloudScanSync._();

  Timer? _timer;
  bool _running = false;

  Future<void> start() async {
    await refresh();
    // Safety net: retry anything still pending even if the app never rebuilds.
    // The shell also calls refresh() on its own timer while signed in.
    _timer ??= Timer.periodic(const Duration(seconds: 60), (_) {
      unawaited(refresh());
    });
  }

  /// Explicit "Sync now" from the banner.
  Future<void> retryNow() => refresh();

  /// Uploads anything still pending, then pulls the server's current view.
  Future<void> refresh() async {
    if (_running) return;
    if (!SessionStore.backend.isSignedIn) return;
    _running = true;
    try {
      final pending = await RecordDatabase.instance.pendingSync();
      for (final record in pending) {
        try {
          await pushRecordToCloud(record);
          if (record.id != null) {
            await RecordDatabase.instance.setSyncStatus(record.id!, 'synced');
          }
        } catch (error) {
          if (error is NeonException && error.message.contains('already exists')) {
            // The row is already on the server; treat it as synced.
            if (record.id != null) {
              await RecordDatabase.instance.setSyncStatus(record.id!, 'synced');
            }
          } else {
            debugPrint('Retry failed for ${record.iccId}: $error');
            return;
          }
        }
      }
      await SessionStore.backend.syncInto(RecordDatabase.instance);
    } catch (error) {
      debugPrint('Cloud sync error: $error');
    } finally {
      _running = false;
    }
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }
}
sealed class _RecordListItem {
  const _RecordListItem();
}

class _DayHeaderItem extends _RecordListItem {
  final DateTime day;
  const _DayHeaderItem(this.day);
}

class _MinuteHeaderItem extends _RecordListItem {
  final DateTime minute;
  final int count;
  const _MinuteHeaderItem(this.minute, this.count);
}

class _RecordItem extends _RecordListItem {
  final CustomerRecord record;
  const _RecordItem(this.record);
}

class RecordsHomePage extends StatefulWidget {
  const RecordsHomePage({super.key, required this.profile});

  final Map<String, dynamic> profile;

  @override
  State<RecordsHomePage> createState() => _RecordsHomePageState();
}

class _RecordsHomePageState extends State<RecordsHomePage> {
  final _search = TextEditingController();
  List<CustomerRecord> _records = [];
  final Set<int> _selected = {};
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
    RecordDatabase.revision.addListener(_handleRevision);
  }

  @override
  void dispose() {
    RecordDatabase.revision.removeListener(_handleRevision);
    _search.dispose();
    super.dispose();
  }

  void _handleRevision() {
    unawaited(_load());
  }

  Future<void> _load() async {
    final data = await RecordDatabase.instance.all();
    if (!mounted) return;
    setState(() {
      _records = data;
      _selected.removeWhere((id) => !data.any((r) => r.id == id));
      _loading = false;
    });
  }

  List<CustomerRecord> get _filtered {
    final q = _search.text.trim().toLowerCase();
    if (q.isEmpty) return _records;
    return _records
        .where((r) =>
            r.iccId.toLowerCase().contains(q) ||
            r.fullName.toLowerCase().contains(q) ||
            r.primaryNumber.toLowerCase().contains(q) ||
            r.secondaryNumber.toLowerCase().contains(q))
        .toList();
  }

  DateTime _dayOnly(DateTime value) =>
      DateTime(value.year, value.month, value.day);

  DateTime _minuteOnly(DateTime value) =>
      DateTime(value.year, value.month, value.day, value.hour, value.minute);

  String _dayLabel(DateTime day) {
    final today = _dayOnly(DateTime.now());
    final difference = today.difference(_dayOnly(day)).inDays;
    if (difference == 0) return 'Today';
    if (difference == 1) return 'Yesterday';
    return DateFormat('EEEE, dd MMMM yyyy').format(day);
  }

  List<_RecordListItem> _groupedItems(List<CustomerRecord> records) {
    final items = <_RecordListItem>[];
    DateTime? currentDay;
    DateTime? currentMinute;

    for (var index = 0; index < records.length; index++) {
      final record = records[index];
      final day = _dayOnly(record.createdAt);
      final minute = _minuteOnly(record.createdAt);

      if (currentDay != day) {
        currentDay = day;
        currentMinute = null;
        items.add(_DayHeaderItem(day));
      }

      if (currentMinute != minute) {
        currentMinute = minute;
        var count = 0;
        for (var next = index; next < records.length; next++) {
          if (_minuteOnly(records[next].createdAt) == minute) {
            count++;
          } else {
            break;
          }
        }
        items.add(_MinuteHeaderItem(minute, count));
      }

      items.add(_RecordItem(record));
    }
    return items;
  }

  List<CustomerRecord> get _selectedRecords =>
      _records.where((r) => r.id != null && _selected.contains(r.id)).toList();

  Future<void> _openForm([CustomerRecord? existing]) async {
    final saved = await Navigator.push<bool>(
      context,
      MaterialPageRoute(
        builder: (_) =>
            RecordFormPage(existing: existing, profile: widget.profile),
      ),
    );
    if (saved == true) await _load();
  }

  Future<void> _shareText() async {
    final list = _selectedRecords;
    if (list.isEmpty) return;
    final b = StringBuffer();
    for (var i = 0; i < list.length; i++) {
      final r = list[i];
      b
        ..writeln(r.iccId)
        ..writeln(r.fullName)
        ..writeln(r.primaryNumber)
        ..writeln(r.secondaryNumber);
      if (i < list.length - 1) b.writeln();
    }
    await SharePlus.instance.share(ShareParams(text: b.toString().trim()));
  }

  Future<void> _exportExcel() async {
    final list = _selectedRecords;
    if (list.isEmpty) return;
    final book = xl.Excel.createExcel();
    final sheet = book['ICC Records'];
    book.delete('Sheet1');
    sheet.appendRow([
      xl.TextCellValue('No.'),
      xl.TextCellValue('ICC ID'),
      xl.TextCellValue('Full Name'),
      xl.TextCellValue('Primary Number'),
      xl.TextCellValue('Secondary Number'),
      xl.TextCellValue('Date'),
      xl.TextCellValue('Time'),
    ]);
    for (var i = 0; i < list.length; i++) {
      final r = list[i];
      sheet.appendRow([
        xl.IntCellValue(i + 1),
        xl.TextCellValue(r.iccId),
        xl.TextCellValue(r.fullName),
        xl.TextCellValue(r.primaryNumber),
        xl.TextCellValue(r.secondaryNumber),
        xl.TextCellValue(DateFormat('dd/MM/yyyy').format(r.createdAt)),
        xl.TextCellValue(DateFormat('HH:mm').format(r.createdAt)),
      ]);
    }
    final bytes = book.encode();
    if (bytes == null) return;
    final dir = await getTemporaryDirectory();
    final filename =
        'ICC_ID_Records_${DateFormat('dd-MM-yyyy').format(DateTime.now())}.xlsx';
    final file = File(p.join(dir.path, filename));
    await file.writeAsBytes(bytes, flush: true);
    await SharePlus.instance.share(
      ShareParams(
        files: [XFile(file.path)],
        text: 'ICC ID records Excel report',
      ),
    );
  }

  Future<void> _deleteSelected() async {
    if (_selected.isEmpty) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Delete selected records?'),
        content:
            Text('This will permanently delete ${_selected.length} record(s).'),
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
    await RecordDatabase.instance.deleteIds(_selected);
    _selected.clear();
    await _load();
  }

  Future<void> _showCustomerActions(CustomerRecord record) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                record.fullName,
                style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
              ),
              const SizedBox(height: 4),
              Text('ICC ID: ${record.iccId}'),
              const SizedBox(height: 14),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton.icon(
                    onPressed: () => _callNumber(record.primaryNumber),
                    icon: const Icon(Icons.call, size: 18),
                    label: const Text('Primary'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => _callNumber(record.secondaryNumber),
                    icon: const Icon(Icons.call, size: 18),
                    label: const Text('Secondary'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () async {
                      await Clipboard.setData(
                          ClipboardData(text: record.iccId));
                      if (sheetContext.mounted) Navigator.pop(sheetContext);
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('ICC ID copied.')),
                        );
                      }
                    },
                    icon: const Icon(Icons.copy, size: 18),
                    label: const Text('Copy ICC ID'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _callNumber(String number) async {
    final uri = Uri(scheme: 'tel', path: number);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Unable to open the phone app.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _filtered;
    final groupedItems = _groupedItems(filtered);
    final selecting = _selected.isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: Text(selecting ? '${_selected.length} selected' : 'ICC Records'),
        leading: selecting
            ? IconButton(
                icon: const Icon(Icons.close),
                onPressed: () => setState(_selected.clear))
            : null,
        actions: selecting
            ? [
                IconButton(
                    tooltip: 'Select all',
                    icon: const Icon(Icons.select_all),
                    onPressed: () => setState(() {
                          _selected.addAll(filtered
                              .where((r) => r.id != null)
                              .map((r) => r.id!));
                        })),
                IconButton(
                    tooltip: 'Share',
                    icon: const Icon(Icons.share),
                    onPressed: _shareText),
                IconButton(
                    tooltip: 'Excel',
                    icon: const Icon(Icons.table_view),
                    onPressed: _exportExcel),
                IconButton(
                    tooltip: 'Delete',
                    icon: const Icon(Icons.delete_outline),
                    onPressed: _deleteSelected),
              ]
            : [],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: CustomScrollView(slivers: [
                SliverToBoxAdapter(
                    child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Card(
                          elevation: 0,
                          child: Padding(
                            padding: const EdgeInsets.all(18),
                            child: Row(children: [
                              Container(
                                  padding: const EdgeInsets.all(13),
                                  decoration: BoxDecoration(
                                      color: const Color(0xFFFFE8E8),
                                      borderRadius: BorderRadius.circular(16)),
                                  child: const Icon(Icons.sim_card_outlined,
                                      size: 30, color: Color(0xFFD32F2F))),
                              const SizedBox(width: 14),
                              Expanded(
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                    Text('${_records.length}',
                                        style: Theme.of(context)
                                            .textTheme
                                            .headlineMedium
                                            ?.copyWith(
                                                fontWeight: FontWeight.bold)),
                                    const Text('Total saved records'),
                                  ])),
                              FilledButton.icon(
                                style: FilledButton.styleFrom(
                                    backgroundColor: const Color(0xFFD32F2F),
                                    foregroundColor: Colors.white),
                                onPressed: () => _openForm(),
                                icon: const Icon(Icons.qr_code_scanner),
                                label: const Text('Scan'),
                              ),
                            ]),
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: _search,
                          onChanged: (_) => setState(() {}),
                          decoration: const InputDecoration(
                              prefixIcon: Icon(Icons.search),
                              hintText: 'Search name, ICC ID or number'),
                        ),
                      ]),
                )),
                if (filtered.isEmpty)
                  const SliverFillRemaining(
                      hasScrollBody: false,
                      child: Center(
                          child:
                              Text('No records found. Tap Scan to add one.')))
                else
                  SliverList.builder(
                    itemCount: groupedItems.length,
                    itemBuilder: (context, index) {
                      final item = groupedItems[index];

                      if (item is _DayHeaderItem) {
                        return Padding(
                          padding: const EdgeInsets.fromLTRB(16, 18, 16, 7),
                          child: Row(children: [
                            Expanded(
                                child: Divider(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .outlineVariant)),
                            Padding(
                              padding:
                                  const EdgeInsets.symmetric(horizontal: 12),
                              child: Text(
                                _dayLabel(item.day),
                                style: Theme.of(context)
                                    .textTheme
                                    .titleSmall
                                    ?.copyWith(
                                      fontWeight: FontWeight.w800,
                                      color: const Color(0xFFD32F2F),
                                    ),
                              ),
                            ),
                            Expanded(
                                child: Divider(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .outlineVariant)),
                          ]),
                        );
                      }

                      if (item is _MinuteHeaderItem) {
                        return Padding(
                          padding: const EdgeInsets.fromLTRB(20, 8, 20, 2),
                          child: Row(children: [
                            const Icon(Icons.schedule,
                                size: 14, color: Color(0xFF6B7280)),
                            const SizedBox(width: 5),
                            Text(
                              DateFormat('hh:mm a').format(item.minute),
                              style: Theme.of(context)
                                  .textTheme
                                  .labelMedium
                                  ?.copyWith(
                                    color: const Color(0xFF6B7280),
                                    fontWeight: FontWeight.w600,
                                  ),
                            ),
                            if (item.count > 1) ...[
                              const SizedBox(width: 7),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 7, vertical: 2),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFFFE8E8),
                                  borderRadius: BorderRadius.circular(20),
                                ),
                                child: Text(
                                  '${item.count} records',
                                  style: Theme.of(context)
                                      .textTheme
                                      .labelSmall
                                      ?.copyWith(
                                        color: const Color(0xFFD32F2F),
                                        fontWeight: FontWeight.w700,
                                      ),
                                ),
                              ),
                            ],
                          ]),
                        );
                      }

                      final r = (item as _RecordItem).record;
                      final checked = r.id != null && _selected.contains(r.id);
                      return Padding(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 16, vertical: 5),
                        child: Card(
                          elevation: 0,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Padding(
                                padding:
                                    const EdgeInsets.fromLTRB(16, 9, 16, 0),
                                child: Text(
                                  DateFormat('dd MMM yyyy • hh:mm:ss a')
                                      .format(r.createdAt),
                                  style: Theme.of(context)
                                      .textTheme
                                      .labelSmall
                                      ?.copyWith(
                                        color: const Color(0xFF8A8F98),
                                      ),
                                ),
                              ),
                              ListTile(
                                contentPadding:
                                    const EdgeInsets.fromLTRB(14, 2, 14, 8),
                                leading: selecting
                                    ? Checkbox(
                                        value: checked,
                                        onChanged: (_) => setState(() => checked
                                            ? _selected.remove(r.id)
                                            : _selected.add(r.id!)),
                                      )
                                    : CircleAvatar(
                                        child: Text(r.fullName.isEmpty
                                            ? '?'
                                            : r.fullName[0].toUpperCase()),
                                      ),
                                title: Text(
                                  r.fullName,
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700),
                                ),
                                subtitle: Text(
                                  'ICC ID: ${r.iccId}\n${r.primaryNumber}  •  ${r.secondaryNumber}',
                                ),
                                isThreeLine: true,
                                trailing: selecting
                                    ? null
                                    : IconButton(
                                        icon: const Icon(Icons.edit_outlined),
                                        onPressed: () => _openForm(r),
                                      ),
                                onLongPress: () =>
                                    setState(() => _selected.add(r.id!)),
                                onTap: selecting
                                    ? () => setState(() => checked
                                        ? _selected.remove(r.id)
                                        : _selected.add(r.id!))
                                    : () => _showCustomerActions(r),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                const SliverToBoxAdapter(child: SizedBox(height: 100)),
              ]),
            ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: const Color(0xFFD32F2F),
        foregroundColor: Colors.white,
        onPressed: () => _openForm(),
        icon: const Icon(Icons.add),
        label: const Text('New record'),
      ),
    );
  }
}

class RecordFormPage extends StatefulWidget {
  final CustomerRecord? existing;
  final Map<String, dynamic> profile;
  final String? scannedIccid;

  const RecordFormPage({
    super.key,
    this.existing,
    required this.profile,
    this.scannedIccid,
  });

  @override
  State<RecordFormPage> createState() => _RecordFormPageState();
}

class _RecordFormPageState extends State<RecordFormPage> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _icc;
  late final TextEditingController _name;
  late final TextEditingController _primary;
  late final TextEditingController _secondary;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final r = widget.existing;
    _icc = TextEditingController(text: r?.iccId ?? widget.scannedIccid ?? '');
    _name = TextEditingController(text: r?.fullName ?? '');
    _primary = TextEditingController(text: r?.primaryNumber ?? '');
    _secondary = TextEditingController(text: r?.secondaryNumber ?? '');
  }

  @override
  void dispose() {
    _icc.dispose();
    _name.dispose();
    _primary.dispose();
    _secondary.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final value = await Navigator.push<String>(
      context,
      PageRouteBuilder<String>(
        pageBuilder: (_, __, ___) => const ScannerPage(),
        transitionDuration: const Duration(milliseconds: 180),
        reverseTransitionDuration: const Duration(milliseconds: 140),
        transitionsBuilder: (_, animation, __, child) =>
            FadeTransition(opacity: animation, child: child),
      ),
    );
    if (value != null && value.isNotEmpty) setState(() => _icc.text = value);
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    final record = CustomerRecord(
      id: widget.existing?.id,
      iccId: _icc.text.trim(),
      fullName: _name.text.trim(),
      primaryNumber: _primary.text.trim(),
      secondaryNumber: _secondary.text.trim(),
      createdAt: widget.existing?.createdAt ?? DateTime.now(),
      syncStatus: widget.existing?.syncStatus ?? 'pending',
    );
    try {
      if (widget.existing == null) {
        final localId = await RecordDatabase.instance.insert(record);
        final localRecord = CustomerRecord(
          id: localId,
          iccId: record.iccId,
          fullName: record.fullName,
          primaryNumber: record.primaryNumber,
          secondaryNumber: record.secondaryNumber,
          createdAt: record.createdAt,
        );
        if (SessionStore.backend.isSignedIn) {
          unawaited(_syncRecord(localRecord));
        }
      } else {
        await RecordDatabase.instance.update(record);
        if (SessionStore.backend.isSignedIn) {
          unawaited(_syncEdit(record));
        }
      }

      if (mounted) Navigator.pop(context, true);
    } on DatabaseException catch (e) {
      if (!mounted) return;
      final duplicate = e.toString().toLowerCase().contains('unique');
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(duplicate
              ? 'This ICC ID already exists.'
              : 'Could not save the record.')));
      setState(() => _saving = false);
    }
  }

  Future<void> _syncRecord(CustomerRecord record) async {
    try {
      await pushRecordToCloud(record);
      await RecordDatabase.instance.setSyncStatus(record.id!, 'synced');
    } catch (error) {
      await RecordDatabase.instance.setSyncStatus(record.id!, 'failed');
      debugPrint('Cloud sync queued/failed for ${record.iccId}: $error');
    }
  }

  Future<void> _syncEdit(CustomerRecord record) async {
    try {
      await pushRecordUpdateToCloud(record);
      await RecordDatabase.instance.setSyncStatus(record.id!, 'synced');
    } catch (error) {
      await RecordDatabase.instance.setSyncStatus(record.id!, 'failed');
      debugPrint('Cloud edit queued/failed for ${record.iccId}: $error');
    }
  }

  String? _required(String? value) =>
      value == null || value.trim().isEmpty ? 'Required' : null;

  String? _iccidValidator(String? value) {
    final normalized = (value ?? '').replaceAll(RegExp(r'\s+'), '');
    return isValidIccid(normalized)
        ? null
        : 'Enter exactly 20 digits starting with 892526379.';
  }

  String? _phoneValidator(String? value) {
    return isValidPhone((value ?? '').trim())
        ? null
        : 'Enter exactly 10 digits.';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
          title: Text(widget.existing == null ? 'Add record' : 'Edit record')),
      body: SafeArea(
          child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Form(
            key: _formKey,
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FilledButton.tonalIcon(
                      onPressed: _scan,
                      icon: const Icon(Icons.qr_code_scanner, size: 28),
                      label: const Padding(
                          padding: EdgeInsets.symmetric(vertical: 14),
                          child: Text('Scan ICC ID with camera'))),
                  const SizedBox(height: 18),
                  TextFormField(
                      controller: _icc,
                      validator: _iccidValidator,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                          labelText: 'ICC ID',
                          prefixIcon: Icon(Icons.sim_card_outlined))),
                  const SizedBox(height: 12),
                  TextFormField(
                      controller: _name,
                      validator: _required,
                      autofocus: widget.scannedIccid != null,
                      textInputAction: TextInputAction.next,
                      textCapitalization: TextCapitalization.words,
                      decoration: const InputDecoration(
                          labelText: 'Full name',
                          prefixIcon: Icon(Icons.person_outline))),
                  const SizedBox(height: 12),
                  TextFormField(
                      controller: _primary,
                      validator: _phoneValidator,
                      keyboardType: TextInputType.phone,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                          labelText: 'Primary number',
                          prefixIcon: Icon(Icons.phone_outlined))),
                  const SizedBox(height: 12),
                  TextFormField(
                      controller: _secondary,
                      validator: _phoneValidator,
                      keyboardType: TextInputType.phone,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _saving ? null : _save(),
                      decoration: const InputDecoration(
                          labelText: 'Secondary number',
                          prefixIcon: Icon(Icons.phone_android_outlined))),
                  const SizedBox(height: 24),
                  FilledButton.icon(
                      onPressed: _saving ? null : _save,
                      icon: _saving
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.save_outlined),
                      label: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          child: Text(_saving ? 'Saving…' : 'Save record'))),
                ])),
      )),
    );
  }
}

class ScannerPage extends StatefulWidget {
  const ScannerPage({super.key});
  @override
  State<ScannerPage> createState() => _ScannerPageState();
}

class _ScannerPageState extends State<ScannerPage> {
  final MobileScannerController _controller = MobileScannerController(
    cameraResolution: Size(1280, 720),
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [
      BarcodeFormat.code128,
      BarcodeFormat.code39,
      BarcodeFormat.ean13,
      BarcodeFormat.itf14,
      BarcodeFormat.qrCode,
    ],
  );
  bool _handled = false;
  bool _torchOn = false;
  bool _scanFeedbackVisible = false;

  @override
  void dispose() {
    if (_torchOn) {
      unawaited(_controller.toggleTorch());
    }
    _controller.dispose();
    super.dispose();
  }

  Future<void> _toggleTorch() async {
    await _controller.toggleTorch();
    if (!mounted) return;
    setState(() => _torchOn = !_torchOn);
  }

  Future<void> _showScanFeedback() async {
    await SystemSound.play(SystemSoundType.click);
    await HapticFeedback.mediumImpact();
    if (!mounted) return;
    setState(() => _scanFeedbackVisible = true);
    await Future<void>.delayed(const Duration(milliseconds: 180));
    if (mounted) setState(() => _scanFeedbackVisible = false);
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_handled || capture.barcodes.isEmpty) return;
    final raw = capture.barcodes.first.rawValue?.trim();
    if (raw == null || raw.isEmpty) return;
    final normalized = raw.replaceAll(RegExp(r'\s+'), '');
    if (!isValidIccid(normalized)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text(
                  'Invalid ICC ID. It must be 20 digits and start with 892526379.')),
        );
      }
      await _controller.stop();
      await _controller.start();
      return;
    }
    _handled = true;
    unawaited(_showScanFeedback());
    await _controller.stop();
    if (!mounted) return;
    if (!mounted) return;
    Navigator.pop(context, normalized);
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final scannerHeight = (size.height * .58).clamp(300.0, 510.0);
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 16, 18),
              child: Row(
                children: [
                  Material(
                    color: const Color(0xFFE8E8E8),
                    borderRadius: BorderRadius.circular(10),
                    child: IconButton(
                      tooltip: 'Back',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.arrow_back, color: Colors.grey),
                    ),
                  ),
                  const SizedBox(width: 14),
                  const Expanded(
                    child: Text(
                      'Scan Outlet QR',
                      style: TextStyle(
                        color: Color(0xFF101C2B),
                        fontSize: 26,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Switch camera',
                    onPressed: () => _controller.switchCamera(),
                    icon: const Icon(Icons.cameraswitch_outlined,
                        color: Color(0xFF16A05D)),
                  ),
                ],
              ),
            ),
            Container(
              width: size.width - 60,
              height: scannerHeight,
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                border: Border.all(color: const Color(0xFFF00000), width: 3),
                borderRadius: BorderRadius.circular(18),
              ),
              child: MobileScanner(controller: _controller, onDetect: _onDetect),
            ),
            const SizedBox(height: 18),
            const Text(
              'Scan ICC ID',
              style: TextStyle(
                  color: Color(0xFF111111),
                  fontSize: 20,
                  fontWeight: FontWeight.w400),
            ),
            const SizedBox(height: 16),
            AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              curve: Curves.easeOut,
              decoration: BoxDecoration(
                color: _torchOn
                    ? const Color(0xFFF00000)
                    : const Color(0xFFF1F1F1),
                borderRadius: BorderRadius.circular(14),
              ),
              child: TextButton.icon(
                onPressed: _toggleTorch,
                icon: Icon(_torchOn ? Icons.flash_on : Icons.flash_off,
                    color: _torchOn
                        ? Colors.white
                        : const Color(0xFF101C2B)),
                label: Text(_torchOn ? 'Flash On' : 'Flash Off',
                    style: TextStyle(
                        color: _torchOn
                            ? Colors.white
                            : const Color(0xFF101C2B),
                        fontWeight: FontWeight.w700)),
                style: TextButton.styleFrom(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 24, vertical: 13),
                ),
              ),
            ),
            Expanded(
              child: IgnorePointer(
                child: AnimatedOpacity(
                  opacity: _scanFeedbackVisible ? 1 : 0,
                  duration: const Duration(milliseconds: 80),
                  child: const Center(
                    child: Icon(Icons.check_circle,
                        color: Color(0xFF16A05D), size: 72),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
