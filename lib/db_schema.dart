// The local database schema, in one place.
//
// Records and vouchers live in the same SQLite file, so the version and the
// migrations have to be shared: two openDatabase() calls with different versions
// on the same path would fight over upgrades.
import 'package:sqflite/sqflite.dart';

/// Bump together with [migrateSchema] whenever a table changes.
const int kDatabaseVersion = 6;

Future<void> createSchema(Database db) async {
  await db.execute('''
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
  ''');
  await _createVouchers(db);
}

Future<void> migrateSchema(Database db, int from) async {
  if (from < 4) {
    final cols = await db.rawQuery('pragma table_info(records)');
    if (!cols.any((c) => c['name'] == 'server_id')) {
      await db.execute('alter table records add column server_id text');
    }
  }
  if (from < 5) {
    await _createVouchers(db);
  }
  if (from < 6) {
    // v6: vouchers can be uploaded to the website, so they need a sent flag.
    final cols = await db.rawQuery('pragma table_info(vouchers)');
    if (!cols.any((c) => c['name'] == 'synced')) {
      await db.execute(
        'alter table vouchers add column synced integer not null default 0',
      );
    }
  }
}

Future<void> _createVouchers(Database db) async {
  await db.execute('''
    create table if not exists vouchers(
      message_id text primary key,
      amount real not null,
      received_at text not null,
      synced integer not null default 0
    )
  ''');
  await db.execute(
    'create index if not exists vouchers_received_idx on vouchers(received_at)',
  );
}
