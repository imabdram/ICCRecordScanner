// The merge rule for records downloaded from the server.
//
// The case that matters: a rep edited a scan on the phone and has not uploaded
// it yet. If a pull blindly took the server's values, that edit would vanish.
import 'package:flutter_test/flutter_test.dart';
import 'package:icc_record_scanner/main.dart';

void main() {
  group('decideMerge', () {
    test('unknown record is inserted', () {
      expect(
        decideMerge(existsLocally: false, localState: SyncState.pending),
        MergeOutcome.insert,
      );
      expect(
        decideMerge(existsLocally: false, localState: SyncState.synced),
        MergeOutcome.insert,
      );
    });

    test('a synced local record adopts the server values', () {
      expect(
        decideMerge(existsLocally: true, localState: SyncState.synced),
        MergeOutcome.adoptRemote,
      );
    });

    test('an unsent local edit is never overwritten', () {
      for (final state in [
        SyncState.pending,
        SyncState.failed,
        SyncState.duplicate,
      ]) {
        expect(
          decideMerge(existsLocally: true, localState: state),
          MergeOutcome.linkOnly,
          reason: 'state $state must not be overwritten by a pull',
        );
      }
    });
  });
}
