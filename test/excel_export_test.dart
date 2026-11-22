// The Excel export is the deliverable a supervisor actually opens, so its shape
// is checked here rather than by eye: the file is written to disk and then read
// back by tools/verify-export.py, which inspects the real workbook XML.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:icc_record_scanner/main.dart';

void main() {
  test('builds the customers workbook with the expected rows', () {
    final rows = [
      ScanRecord(
        iccid: '89252637990000001234',
        fullName: 'Muse khalid muse',
        primary: '717738604',
        secondary: '0907738604',
        createdAt: DateTime(2026, 11, 21, 9, 30),
      ),
      ScanRecord(
        iccid: '89252637990000005678',
        fullName: 'Laylo maxmuud maxmed',
        primary: '716441526',
        secondary: '0905441526',
        createdAt: DateTime(2026, 11, 21, 10, 15),
      ),
    ];

    final bytes = buildCustomersWorkbook(rows, 'Abdikariim salax');
    expect(bytes, isNotNull);
    expect(bytes!.length, greaterThan(1000));

    // Written for tools/verify-export.py, which opens it with openpyxl.
    final out = File('tools/.out/customers_test.xlsx');
    out.parent.createSync(recursive: true);
    out.writeAsBytesSync(bytes);
    expect(out.existsSync(), isTrue);
  });
}
