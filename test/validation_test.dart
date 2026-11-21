// Validation rules that the app, the website and the database all share.
//
// These are pure functions, so they need no widget or database setup.
import 'package:flutter_test/flutter_test.dart';
import 'package:icc_record_scanner/main.dart';

void main() {
  group('ICCID', () {
    test('accepts 89 + 16-20 digits', () {
      expect(Validators.iccid('89252637990000001234'), isNull);
      expect(Validators.iccid('892526379900000012'), isNull); // 18 total
      expect(Validators.iccid('8925263799000000123456'), isNull); // 22 total
    });

    test('strips separators before checking', () {
      expect(Validators.iccid('89 2526 3799 0000 0012 34'), isNull);
    });

    test('rejects the wrong prefix, wrong length and letters', () {
      expect(Validators.iccid('71252637990000001234'), isNotNull);
      expect(Validators.iccid('89252637990000'), isNotNull); // too short
      expect(Validators.iccid('89252637990000001234567'), isNotNull); // too long
      expect(Validators.iccid(''), isNotNull);
    });
  });

  group('primary number', () {
    test('must be 71 followed by 7 digits', () {
      expect(Validators.primary('712345678'), isNull);
      expect(Validators.primary('719999999'), isNull);
    });

    test('rejects other prefixes and lengths', () {
      expect(Validators.primary('722345678'), isNotNull);
      expect(Validators.primary('71234567'), isNotNull);
      expect(Validators.primary('7123456789'), isNotNull);
    });
  });

  group('backup number', () {
    test('accepts any 7-12 digits', () {
      expect(Validators.secondary('6155550'), isNull);
      expect(Validators.secondary('615555001234'), isNull);
      expect(Validators.secondary('712345678'), isNull);
    });

    test('rejects too short or too long', () {
      expect(Validators.secondary('12345'), isNotNull);
      expect(Validators.secondary('1234567890123'), isNotNull);
    });
  });

  group('username to email', () {
    test('maps to the internal domain and lower-cases', () {
      expect(AppConfig.emailFor('Hodan.Ali'), 'hodan.ali@sim.local');
      expect(AppConfig.emailFor('  yacquub '), 'yacquub@sim.local');
    });
  });
}
