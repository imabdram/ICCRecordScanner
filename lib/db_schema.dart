// The local database schema, in one place.
//
// Records and vouchers live in the same SQLite file, so the version and the
// migrations have to be shared: two openDatabase() calls with different versions
// on the same path would fight over upgrades.
import 'package:sqflite/sqflite.dart';

/// Bump together with [_migrate] whenever a table changes.
const int kDatabaseVersion = 5;

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
}

Future<void> _createVouchers(Database db) async {
  await db.execute('''
    create table if not exists vouchers(
      message_id text primary key,
      amount real not null,
      received_at text not null
    )
  ''');
  await db.execute(
    'create index if not exists vouchers_received_idx on vouchers(received_at)',
  );
}
