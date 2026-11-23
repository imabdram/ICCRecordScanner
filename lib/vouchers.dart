// E-voucher totals read from the operator's "913" SMS messages.
//
// The message format is fixed:
//
//   You received Airtime from 252710000040 - mfsuser on 22/11/2026 18:46:41,
//   TransactionID is 04343000000029593460; Amount is $+6.00.
//   And you received commission $+0.00. Now your balance is $+6.15.
//
// Only "Amount is $+..." is summed. The commission line and the balance line are
// deliberately ignored: adding either would inflate the total.
import 'dart:async';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:permission_handler/permission_handler.dart';
import 'package:sqflite/sqflite.dart';

import 'db_schema.dart';

/// Formats an amount the way the vouchers are written: $245.00
String money(double value) => '\$${value.toStringAsFixed(2)}';

/// One airtime voucher, parsed out of a single SMS.
class Voucher {
  final String messageId;
  final double amount;
  final DateTime receivedAt;

  /// True once the website has this voucher. Local totals never depend on it —
  /// the phone shows what it read, upload or not.
  final bool synced;

  const Voucher({
    required this.messageId,
    required this.amount,
    required this.receivedAt,
    this.synced = false,
  });
}

/// Parses one 913 message. Returns null when the text is not a voucher message,
/// so unrelated messages from the same sender are skipped rather than counted.
Voucher? parseVoucherMessage(String body, {String messageId = ''}) {
  final date = RegExp(
    r'on\s+(\d{2})/(\d{2})/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})',
  ).firstMatch(body);
  final amount = RegExp(
    r'Amount\s+is\s+\$([+-]?[0-9]+(?:\.[0-9]+)?)',
    caseSensitive: false,
  ).firstMatch(body);

  if (date == null || amount == null) return null;

  final day = int.parse(date.group(1)!);
  final month = int.parse(date.group(2)!);
  final year = int.parse(date.group(3)!);
  final hour = int.parse(date.group(4)!);
  final minute = int.parse(date.group(5)!);
  final second = int.parse(date.group(6)!);

  final value = double.tryParse(amount.group(1)!);
  if (value == null) return null;

  return Voucher(
    messageId: messageId,
    amount: value,
    // The timestamp inside the message is local time on the handset.
    receivedAt: DateTime(year, month, day, hour, minute, second),
  );
}

/// Local cache of parsed vouchers, keyed by the SMS id so re-reading the inbox
/// can never double-count a message.
class VoucherStore {
  VoucherStore._();
  static final VoucherStore instance = VoucherStore._();

  Database? _db;

  Future<Database> get db async {
    if (_db != null) return _db!;
    final dir = await getDatabasesPath();
    // Same file and version as RecordStore: the schema is shared (db_schema.dart)
    // so the two stores cannot fight over upgrades.
    _db = await openDatabase(
      p.join(dir, 'icc_records.db'),
      version: kDatabaseVersion,
      onCreate: (database, _) => createSchema(database),
      onUpgrade: (database, from, _) => migrateSchema(database, from),
    );
    return _db!;
  }

  /// Stores a voucher unless its message was already seen.
  Future<void> save(Voucher voucher) async {
    await (await db).insert(
      'vouchers',
      {
        'message_id': voucher.messageId,
        'amount': voucher.amount,
        'received_at': voucher.receivedAt.toIso8601String(),
      },
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
  }

  /// Vouchers the website has not seen yet.
  Future<List<Voucher>> pending() async {
    final rows = await (await db).query(
      'vouchers',
      where: 'synced = 0',
      orderBy: 'received_at asc',
    );
    return rows
        .map((r) => Voucher(
              messageId: (r['message_id'] ?? '') as String,
              amount: (r['amount'] as num?)?.toDouble() ?? 0,
              receivedAt: DateTime.tryParse((r['received_at'] ?? '') as String) ??
                  DateTime.now(),
            ))
        .toList();
  }

  Future<void> markSynced(String messageId) async {
    await (await db).update(
      'vouchers',
      {'synced': 1},
      where: 'message_id = ?',
      whereArgs: [messageId],
    );
  }

  Future<int> unsentCount() async {
    final r = await (await db).rawQuery('select count(*) as n from vouchers where synced = 0');
    return (r.first['n'] as int?) ?? 0;
  }

  Future<List<Voucher>> all() async {
    final rows = await (await db).query('vouchers', orderBy: 'received_at desc');
    return rows
        .map((r) => Voucher(
              messageId: (r['message_id'] ?? '') as String,
              amount: (r['amount'] as num?)?.toDouble() ?? 0,
              receivedAt: DateTime.tryParse((r['received_at'] ?? '') as String) ??
                  DateTime.now(),
              synced: (r['synced'] as int? ?? 0) == 1,
            ))
        .toList();
  }
}

/// Totals for the sheet: today, this month, and per-day amounts for the chart.
class VoucherSummary {
  final double today;
  final double month;
  final int todayCount;
  final int monthCount;
  final Map<int, double> byDay; // day of month -> amount

  const VoucherSummary({
    required this.today,
    required this.month,
    required this.todayCount,
    required this.monthCount,
    required this.byDay,
  });
}

VoucherSummary summariseVouchers(List<Voucher> vouchers, {DateTime? now}) {
  final today = now ?? DateTime.now();
  final startOfToday = DateTime(today.year, today.month, today.day);

  var todayTotal = 0.0;
  var monthTotal = 0.0;
  var todayCount = 0;
  var monthCount = 0;
  final byDay = <int, double>{};

  for (final v in vouchers) {
    if (v.receivedAt.year != today.year || v.receivedAt.month != today.month) {
      continue;
    }
    monthTotal += v.amount;
    monthCount += 1;
    byDay[v.receivedAt.day] = (byDay[v.receivedAt.day] ?? 0) + v.amount;

    if (!v.receivedAt.isBefore(startOfToday) &&
        v.receivedAt.isBefore(startOfToday.add(const Duration(days: 1)))) {
      todayTotal += v.amount;
      todayCount += 1;
    }
  }

  return VoucherSummary(
    today: todayTotal,
    month: monthTotal,
    todayCount: todayCount,
    monthCount: monthCount,
    byDay: byDay,
  );
}

/// Reads the inbox through the native channel in MainActivity.
class SmsInbox {
  SmsInbox._();
  static final SmsInbox instance = SmsInbox._();

  static const _channel = MethodChannel('icc_record_scanner/sms');

  /// Asks for READ_SMS. Android rates it high-trust, so this is only called when
  /// the user actually opens the E-voucher sheet.
  Future<bool> ensurePermission() async {
    final status = await Permission.sms.status;
    if (status.isGranted) return true;
    if (status.isPermanentlyDenied) return false;
    final result = await Permission.sms.request();
    return result.isGranted;
  }

  /// Every message from [sender] still in the inbox, newest first.
  Future<List<Map<String, dynamic>>> read({String sender = '913', int limit = 2000}) async {
    final rows = await _channel.invokeMethod<List<dynamic>>('readSender', {
      'sender': sender,
      'limit': limit,
    });
    return (rows ?? [])
        .map((e) => Map<String, dynamic>.from(e as Map))
        .toList();
  }

  /// Reads, parses and caches. Returns how many new vouchers were stored.
  Future<int> sync({String sender = '913'}) async {
    final messages = await read(sender: sender);
    var added = 0;
    for (final m in messages) {
      final voucher = parseVoucherMessage(
        (m['body'] ?? '') as String,
        messageId: (m['id'] ?? '').toString(),
      );
      if (voucher == null) continue;
      await VoucherStore.instance.save(voucher);
      added += 1;
    }
    return added;
  }
}
