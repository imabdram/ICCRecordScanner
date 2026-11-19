import 'package:flutter_test/flutter_test.dart';

import 'package:icc_record_scanner/main.dart';

void main() {
  test('validates ICCID and phone formats', () {
    expect(isValidIccid('89252637900011410043'), isTrue);
    expect(isValidIccid('8925263790001141004'), isFalse);
    expect(isValidIccid('89252637800011410043'), isFalse);
    expect(isValidPhone('0123456789'), isTrue);
    expect(isValidPhone('012345678'), isFalse);
  });
}
