// The 913 message parser and the day/month totals.
//
// Uses the two real message formats from the operator, plus the cases that would
// silently inflate a total if they were parsed wrong (commission line, balance
// line, unrelated sender text).
import 'package:flutter_test/flutter_test.dart';
import 'package:icc_record_scanner/vouchers.dart';

const sample1 =
    'You received Airtime from 252710000040 - mfsuser on 22/11/2026 18:46:41, '
    'TransactionID is 04343000000029593460; Amount is \$+6.00. And you received '
    'commission \$+0.00. Now your balance is \$+6.15.';

const sample2 =
    'You received Airtime from 252710000040 - mfsuser on 22/11/2026 19:34:54, '
    'TransactionID is 04343200000029596192; Amount is \$+10.00. And you received '
    'commission \$+0.00. Now your balance is \$+14.15.';

void main() {
  group('parseVoucherMessage', () {
    test('reads the amount and the timestamp', () {
      final v = parseVoucherMessage(sample1, messageId: '1')!;
      expect(v.amount, 6.00);
      expect(v.receivedAt, DateTime(2026, 11, 22, 18, 46, 41));
      expect(v.messageId, '1');
    });

    test('sums only Amount, never commission or balance', () {
      final a = parseVoucherMessage(sample1)!;
      final b = parseVoucherMessage(sample2)!;
      // 6.00 + 10.00; the balances (6.15, 14.15) and commissions (0.00) are out.
      expect(a.amount + b.amount, 16.00);
    });

    test('second sample parses to 10.00', () {
      final v = parseVoucherMessage(sample2)!;
      expect(v.amount, 10.00);
      expect(v.receivedAt, DateTime(2026, 11, 22, 19, 34, 54));
    });

    test('handles whole numbers and larger amounts', () {
      final v = parseVoucherMessage(
        'You received Airtime ... on 01/12/2026 08:00:00, TransactionID is 1; '
        'Amount is \$+25. And you received commission \$+0.00.',
      )!;
      expect(v.amount, 25.0);
    });

    test('returns null for messages that are not vouchers', () {
      expect(parseVoucherMessage('Your balance is \$+4.00.'), isNull);
      expect(parseVoucherMessage('You received Airtime, no amount here'), isNull);
      expect(parseVoucherMessage(''), isNull);
    });
  });

  group('summariseVouchers', () {
    final now = DateTime(2026, 11, 22, 20, 0);

    List<Voucher> build() => [
          // today
          Voucher(
              messageId: 'a',
              amount: 6,
              receivedAt: DateTime(2026, 11, 22, 18, 46)),
          Voucher(
              messageId: 'b',
              amount: 10,
              receivedAt: DateTime(2026, 11, 22, 19, 34)),
          // earlier this month
          Voucher(
              messageId: 'c',
              amount: 5,
              receivedAt: DateTime(2026, 11, 3, 9, 0)),
          // midnight today counts as today
          Voucher(
              messageId: 'd',
              amount: 2,
              receivedAt: DateTime(2026, 11, 22, 0, 0)),
          // last month, must be excluded
          Voucher(
              messageId: 'e',
              amount: 100,
              receivedAt: DateTime(2026, 10, 31, 23, 59)),
        ];

    test('today total and count', () {
      final s = summariseVouchers(build(), now: now);
      expect(s.today, 18.0); // 6 + 10 + 2
      expect(s.todayCount, 3);
    });

    test('month total excludes other months', () {
      final s = summariseVouchers(build(), now: now);
      expect(s.month, 23.0); // 6 + 10 + 5 + 2, not the 100 from October
      expect(s.monthCount, 4);
    });

    test('per-day map is ready for the chart', () {
      final s = summariseVouchers(build(), now: now);
      expect(s.byDay[22], 18.0);
      expect(s.byDay[3], 5.0);
      expect(s.byDay.containsKey(31), isFalse);
    });

    test('empty list gives zeros', () {
      final s = summariseVouchers(const [], now: now);
      expect(s.today, 0);
      expect(s.month, 0);
      expect(s.byDay, isEmpty);
    });
  });

  group('money', () {
    test('always two decimals', () {
      expect(money(6), '\$6.00');
      expect(money(245.5), '\$245.50');
      expect(money(0), '\$0.00');
    });
  });
}
