// The E-voucher sheet: today + this month totals, a bar per day of the month,
// and the messages that were counted.
import 'dart:async';

import 'package:flutter/material.dart';

import 'main.dart' show AppConfig;
import 'vouchers.dart';

class VoucherSheet extends StatefulWidget {
  const VoucherSheet({super.key});

  @override
  State<VoucherSheet> createState() => _VoucherSheetState();
}

class _VoucherSheetState extends State<VoucherSheet> {
  bool _loading = true;
  bool _denied = false;
  String? _error;
  List<Voucher> _vouchers = const [];
  VoucherSummary _summary = const VoucherSummary(
    today: 0,
    month: 0,
    todayCount: 0,
    monthCount: 0,
    byDay: {},
  );
  DateTime _checkedAt = DateTime.now();

  @override
  void initState() {
    super.initState();
    unawaited(_load(requestPermission: true));
  }

  Future<void> _load({bool requestPermission = false}) async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final granted = requestPermission
          ? await SmsInbox.instance.ensurePermission()
          : await SmsInbox.instance.ensurePermission();

      if (!granted) {
        if (!mounted) return;
        setState(() {
          _denied = true;
          _loading = false;
        });
        return;
      }

      // Reads the inbox, parses, and stores anything new (dedup by SMS id).
      await SmsInbox.instance.sync();
      final all = await VoucherStore.instance.all();
      if (!mounted) return;
      setState(() {
        _denied = false;
        _vouchers = all;
        _summary = summariseVouchers(all);
        _checkedAt = DateTime.now();
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final daysInMonth = DateTime(now.year, now.month + 1, 0).day;

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 44,
                height: 5,
                margin: const EdgeInsets.only(bottom: 14),
                decoration: BoxDecoration(
                  color: const Color(0xFFD6DCE4),
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: const [
                      Text('E-voucher',
                          style: TextStyle(
                              fontSize: 21, fontWeight: FontWeight.w700)),
                      SizedBox(height: 2),
                      Text('From SMS - sender 913',
                          style: TextStyle(
                              fontSize: 11.5, color: AppConfig.muted)),
                    ],
                  ),
                ),
                Text('${_monthName(now.month)} ${now.year}',
                    style: const TextStyle(
                        fontSize: 12, color: AppConfig.muted)),
              ],
            ),
            const SizedBox(height: 14),
            if (_denied)
              _deniedBox(context)
            else if (_error != null)
              _errorBox(context)
            else if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 40),
                child: Center(child: CircularProgressIndicator()),
              )
            else ...[
              Row(
                children: [
                  Expanded(
                    child: _TotalCard(
                      label: 'TODAY',
                      amount: money(_summary.today),
                      caption:
                          '${_summary.todayCount} voucher${_summary.todayCount == 1 ? '' : 's'}',
                      accent: AppConfig.brandRed,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _TotalCard(
                      label: 'THIS MONTH',
                      amount: money(_summary.month),
                      caption:
                          '${_summary.monthCount} voucher${_summary.monthCount == 1 ? '' : 's'}',
                      accent: AppConfig.ink,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              Text('${_monthName(now.month).toUpperCase()} BY DAY',
                  style: const TextStyle(
                      fontSize: 10.5,
                      letterSpacing: .5,
                      fontWeight: FontWeight.w700,
                      color: AppConfig.muted)),
              const SizedBox(height: 10),
              SizedBox(
                height: 130,
                child: CustomPaint(
                  size: Size.infinite,
                  painter: _MonthBarsPainter(
                    daysInMonth: daysInMonth,
                    today: now.day,
                    byDay: _summary.byDay,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text("TODAY'S MESSAGES",
                  style: const TextStyle(
                      fontSize: 10.5,
                      letterSpacing: .5,
                      fontWeight: FontWeight.w700,
                      color: AppConfig.muted)),
              const SizedBox(height: 6),
              _todayMessages(now),
              const SizedBox(height: 10),
              Row(
                children: [
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF8F9FB),
                      borderRadius: BorderRadius.circular(11),
                    ),
                    child: Text(
                      'Last checked ${_hhmm(_checkedAt)}',
                      style: const TextStyle(
                          fontSize: 11, color: AppConfig.muted),
                    ),
                  ),
                  const Spacer(),
                  TextButton.icon(
                    onPressed: _loading ? null : () => _load(),
                    icon: const Icon(Icons.refresh, size: 16,
                        color: AppConfig.brandRed),
                    label: const Text('Refresh',
                        style: TextStyle(color: AppConfig.brandRed)),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _todayMessages(DateTime now) {
    final today = _vouchers
        .where((v) =>
            v.receivedAt.year == now.year &&
            v.receivedAt.month == now.month &&
            v.receivedAt.day == now.day)
        .toList()
      ..sort((a, b) => b.receivedAt.compareTo(a.receivedAt));

    if (today.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 14),
        child: Text('No voucher messages today.',
            style: TextStyle(fontSize: 12.5, color: AppConfig.muted)),
      );
    }

    return Column(
      children: [
        for (final v in today.take(4))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: [
                SizedBox(
                  width: 46,
                  child: Text(_hhmm(v.receivedAt),
                      style: const TextStyle(
                          fontSize: 12, color: AppConfig.muted)),
                ),
                const Expanded(
                  child: Text('Airtime received',
                      style: TextStyle(fontSize: 13)),
                ),
                Text('+${money(v.amount)}',
                    style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: AppConfig.okGreen)),
              ],
            ),
          ),
      ],
    );
  }

  Widget _deniedBox(BuildContext context) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: const Color(0xFFFFF7E6),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('SMS access is off',
                style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            const Text(
              'The E-voucher totals are read from the 913 messages on this phone. '
              'Without permission the app cannot see them.',
              style: TextStyle(fontSize: 12.5, color: AppConfig.muted),
            ),
            const SizedBox(height: 10),
            FilledButton(
              style: FilledButton.styleFrom(
                  backgroundColor: AppConfig.brandRed),
              onPressed: () => _load(requestPermission: true),
              child: const Text('Allow'),
            ),
          ],
        ),
      );

  Widget _errorBox(BuildContext context) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: const Color(0xFFFDECEE),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_error ?? 'Could not read SMS',
                style: const TextStyle(color: Color(0xFFB3261E))),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => _load(),
              child: const Text('Try again'),
            ),
          ],
        ),
      );
}

class _TotalCard extends StatelessWidget {
  const _TotalCard({
    required this.label,
    required this.amount,
    required this.caption,
    required this.accent,
  });

  final String label;
  final String amount;
  final String caption;
  final Color accent;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: const Color(0xFFF8F9FB),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style: const TextStyle(
                    fontSize: 10,
                    letterSpacing: .5,
                    fontWeight: FontWeight.w700,
                    color: AppConfig.muted)),
            const SizedBox(height: 4),
            Text(amount,
                style: TextStyle(
                    fontSize: 25,
                    fontWeight: FontWeight.w700,
                    color: accent)),
            const SizedBox(height: 2),
            Text(caption,
                style: const TextStyle(
                    fontSize: 11, color: AppConfig.muted)),
          ],
        ),
      );
}

/// One bar per day of the current month. Days with no voucher get a thin tick,
/// so gaps are visible rather than the chart silently skipping them.
class _MonthBarsPainter extends CustomPainter {
  _MonthBarsPainter({
    required this.daysInMonth,
    required this.today,
    required this.byDay,
  });

  final int daysInMonth;
  final int today;
  final Map<int, double> byDay;

  @override
  void paint(Canvas canvas, Size size) {
    const labelSpace = 18.0;
    final plotHeight = size.height - labelSpace;
    final slot = size.width / daysInMonth;
    final barWidth = slot * 0.62;

    final maxValue = byDay.values.fold<double>(0, (m, v) => v > m ? v : m);

    final grid = Paint()
      ..color = const Color(0xFFEEF1F5)
      ..strokeWidth = 1;
    for (final frac in [0.0, 0.5, 1.0]) {
      final y = plotHeight - plotHeight * frac;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }

    for (var day = 1; day <= daysInMonth; day++) {
      final value = byDay[day] ?? 0;
      final left = (day - 1) * slot + (slot - barWidth) / 2;
      final isToday = day == today;

      if (value <= 0) {
        canvas.drawLine(
          Offset(left, plotHeight - 2),
          Offset(left + barWidth, plotHeight - 2),
          Paint()
            ..color = const Color(0xFFF0F3F7)
            ..strokeWidth = 3,
        );
      } else {
        final h = maxValue == 0 ? 0.0 : (value / maxValue) * (plotHeight - 6);
        final paint = Paint()
          ..color = isToday
              ? AppConfig.brandRed
              : const Color(0xFFE89198);
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTWH(left, plotHeight - h, barWidth, h),
            const Radius.circular(3),
          ),
          paint,
        );
      }

      // day numbers, every fifth day plus today
      if (day == 1 || day % 5 == 0 || isToday) {
        final painter = TextPainter(
          text: TextSpan(
            text: '$day',
            style: TextStyle(
              fontSize: 9,
              color: isToday ? AppConfig.brandRed : AppConfig.muted,
              fontWeight: isToday ? FontWeight.w700 : FontWeight.w400,
            ),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        painter.paint(
          canvas,
          Offset(left + barWidth / 2 - painter.width / 2, plotHeight + 4),
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant _MonthBarsPainter old) =>
      old.today != today ||
      old.daysInMonth != daysInMonth ||
      old.byDay != byDay;
}

String _monthName(int month) => const [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ][month - 1];

String _hhmm(DateTime t) =>
    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
