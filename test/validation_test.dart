// Validation rules shared by the app, the website and the database.
//
// Number formats changed in v8:
//   primary   071 + 7 digits (10 total)      0716736063
//   backup    10 digits starting 090/061/063 0905736063
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
      expect(Validators.iccid('89252637990000'), isNotNull);
      expect(Validators.iccid('89252637990000001234567'), isNotNull);
      expect(Validators.iccid(''), isNotNull);
    });
  });

  group('primary number', () {
    test('must be 071 followed by 7 digits', () {
      expect(Validators.primary('0716736063'), isNull);
      expect(Validators.primary('0710000000'), isNull);
    });

    test('rejects the old 9-digit form and other prefixes', () {
      expect(Validators.primary('717386043'), isNotNull);
      expect(Validators.primary('0723456789'), isNotNull);
      expect(Validators.primary('071673606'), isNotNull); // 9 digits
      expect(Validators.primary('07167360631'), isNotNull); // 11 digits
    });
  });

  group('backup number', () {
    test('accepts 10 digits starting 090, 061 or 063', () {
      expect(Validators.secondary('0905736063'), isNull);
      expect(Validators.secondary('0612345678'), isNull);
      expect(Validators.secondary('0631234567'), isNull);
    });

    test('rejects other prefixes and wrong lengths', () {
      expect(Validators.secondary('0912345678'), isNotNull);
      expect(Validators.secondary('090573606'), isNotNull); // 9 digits
      expect(Validators.secondary('09057360631'), isNotNull); // 11 digits
      expect(Validators.secondary('061234567'), isNotNull); // 9 digits
    });
  });

  group('share text', () {
    test('is four unlabelled lines: ICCID, name, primary, backup', () {
      final record = ScanRecord(
        iccid: '89252637900011195321',
        fullName: 'Cisman Cabdulaahi Abubaka',
        primary: '0716736063',
        secondary: '0905736063',
        createdAt: DateTime(2026, 11, 22, 10),
      );

      expect(
        buildShareText(record),
        '89252637900011195321\n'
        'Cisman Cabdulaahi Abubaka\n'
        '0716736063\n'
        '0905736063',
      );

      // No labels, no bullets, nothing before the ICCID.
      expect(buildShareText(record).startsWith('8925'), isTrue);
      expect(buildShareText(record).contains(':'), isFalse);
    });
  });

  group('username to email', () {
    test('maps to the internal domain and lower-cases', () {
      expect(AppConfig.emailFor('Hodan.Ali'), 'hodan.ali@sim.local');
      expect(AppConfig.emailFor('  yacquub '), 'yacquub@sim.local');
    });
  });
}
