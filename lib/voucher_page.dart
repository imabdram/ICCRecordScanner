// E-voucher as a full page: totals, a month chart you can tap, and the messages
// behind whichever day is selected.
import 'dart:async';

import 'package:flutter/material.dart';

import 'main.dart' show AppConfig, SyncService;
import 'vouchers.dart';

class VoucherPage extends StatefulWidget {
  const VoucherPage({super.key});

  @override
  State<VoucherPage> createState() => _VoucherPageState();
}

class _VoucherPageState extends State<VoucherPage> {
  bool _loading = true;
  bool _denied = false;
  String? _error;
  int _messagesRead = 0;
  List<Voucher> _vouchers = const [];
  VoucherSummary _summary = const VoucherSummary(
    today: 0,
    month: 0,
    todayCount: 0,
    monthCount: 0,
    byDay: {},
  );
  DateTime _checkedAt = DateTime.now();

  /// Which day the message list below the chart is showing. Starts on today;
  /// tapping a bar changes it.
  int _selectedDay = DateTime.now().day;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final granted = await SmsInbox.instance.ensurePermission();
      if (!granted) {
        if (!mounted) return;
        setState(() {
          _denied = true;
          _loading = false;
        });
        return;
      }

      // Reads every 913 message still in the inbox, parses what is new, stores it.
      final read = await SmsInbox.instance.sync();
      // Then sends whatever the website has not seen yet.
      unawaited(SyncService.instance.pushVouchers());

      final all = await VoucherStore.instance.all();
      if (!mounted) return;
      setState(() {
        _denied = false;
        _messagesRead = read;
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
    final selectedAmount = _summary.byDay[_selectedDay] ?? 0;

    return Scaffold(
      backgroundColor: AppConfig.pageBg,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        elevation: 0,
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('E-voucher', style: TextStyle(fontSize: 19)),
            Text('From SMS - sender 913',
                style: TextStyle(fontSize: 11.5, color: AppConfig.muted)),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: _denied
          ? _deniedBody()
          : _error != null
              ? _errorBody()
              : _loading
                  ? const Center(child: CircularProgressIndicator())
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
                        children: [
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
                          Row(
                            children: [
                              Text(
                                '${_monthName(now.month).toUpperCase()} BY DAY',
                                style: const TextStyle(
                                    fontSize: 10.5,
                                    letterSpacing: .5,
                                    fontWeight: FontWeight.w700,
                                    color: AppConfig.muted),
                              ),
                              const Spacer(),
                              const Text('tap a bar',
                                  style: TextStyle(
                                      fontSize: 10.5,
                                      color: AppConfig.muted)),
                            ],
                          ),
                          const SizedBox(height: 10),
                          Container(
                            padding: const EdgeInsets.fromLTRB(8, 8, 8, 4),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: SizedBox(
                              height: 190,
                              child: LayoutBuilder(
                                builder: (context, constraints) {
                                  final slot = constraints.maxWidth / daysInMonth;
                                  return GestureDetector(
                                    behavior: HitTestBehavior.opaque,
                                    onTapDown: (details) {
                                      final day =
                                          (details.localPosition.dx / slot).floor() + 1;
                                      if (day >= 1 && day <= daysInMonth) {
                                        setState(() => _selectedDay = day);
                                      }
                                    },
                                    child: CustomPaint(
                                      size: Size.infinite,
                                      painter: _MonthBarsPainter(
                                        daysInMonth: daysInMonth,
                                        today: now.day,
                                        selected: _selectedDay,
                                        byDay: _summary.byDay,
                                      ),
                                    ),
                                  );
                                },
                              ),
                            ),
                          ),
                          const SizedBox(height: 18),
                          // The selected day, so tapping a bar answers "how much
                          // was that day?" without leaving the page.
                          Row(
                            children: [
                              Text(
                                '$_selectedDay ${_monthName(now.month).toUpperCase()}',
                                style: const TextStyle(
                                    fontSize: 10.5,
                                    letterSpacing: .5,
                                    fontWeight: FontWeight.w700,
                                    color: AppConfig.muted),
                              ),
                              const Spacer(),
                              Text(
                                money(selectedAmount),
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                  color: _selectedDay == now.day
                                      ? AppConfig.brandRed
                                      : AppConfig.ink,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          _dayMessages(now),
                          const SizedBox(height: 18),
                          // Showing the message count makes the total checkable:
                          // if it is 0, the permission or the sender string is the
                          // problem, not the arithmetic.
                          Text(
                            'Read $_messagesRead message${_messagesRead == 1 ? '' : 's'} from 913 '
                            '· last checked ${_hhmm(_checkedAt)}',
                            style: const TextStyle(
                                fontSize: 11, color: AppConfig.muted),
                          ),
                        ],
                      ),
                    ),
    );
  }

  Widget _dayMessages(DateTime now) {
    final day = DateTime(now.year, now.month, _selectedDay);
    final onDay = _vouchers
        .where((v) =>
            v.receivedAt.year == day.year &&
            v.receivedAt.month == day.month &&
            v.receivedAt.day == day.day)
        .toList()
      ..sort((a, b) => b.receivedAt.compareTo(a.receivedAt));

    if (onDay.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          'No vouchers on $_selectedDay ${_monthName(now.month)}.',
          style: const TextStyle(fontSize: 12.5, color: AppConfig.muted),
        ),
      );
    }

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        children: [
          for (final v in onDay)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
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
      ),
    );
  }

  Widget _deniedBody() => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
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
                const SizedBox(height: 8),
                const Text(
                  'The totals are read from the 913 messages on this phone. '
                  'Without permission the app cannot see them.',
                  style: TextStyle(fontSize: 12.5, color: AppConfig.muted),
                ),
                const SizedBox(height: 12),
                FilledButton(
                  style: FilledButton.styleFrom(
                      backgroundColor: AppConfig.brandRed),
                  onPressed: _load,
                  child: const Text('Allow'),
                ),
              ],
            ),
          ),
        ],
      );

  Widget _errorBody() => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
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
                TextButton(onPressed: _load, child: const Text('Try again')),
              ],
            ),
          ),
        ],
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
          color: Colors.white,
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
                style:
                    const TextStyle(fontSize: 11, color: AppConfig.muted)),
          ],
        ),
      );
}

/// One bar per day of the current month. Today is solid red; the tapped day gets
/// a ring so it is obvious which day the list below belongs to.
class _MonthBarsPainter extends CustomPainter {
  _MonthBarsPainter({
    required this.daysInMonth,
    required this.today,
    required this.selected,
    required this.byDay,
  });

  final int daysInMonth;
  final int today;
  final int selected;
  final Map<int, double> byDay;

  @override
  void paint(Canvas canvas, Size size) {
    const labelSpace = 20.0;
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
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTWH(left, plotHeight - h, barWidth, h),
            const Radius.circular(3),
          ),
          Paint()
            ..color = isToday ? AppConfig.brandRed : const Color(0xFFE89198),
        );
      }

      if (day == selected) {
        // Ring around the selected day's column.
        final top = 0.0;
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTRB(
              (day - 1) * slot + 1,
              top,
              day * slot - 1,
              plotHeight,
            ),
            const Radius.circular(6),
          ),
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.5
            ..color = AppConfig.brandRed.withValues(alpha: .55),
        );
      }

      if (day == 1 || day % 5 == 0 || isToday || day == selected) {
        final painter = TextPainter(
          text: TextSpan(
            text: '$day',
            style: TextStyle(
              fontSize: 9,
              color: isToday || day == selected
                  ? AppConfig.brandRed
                  : AppConfig.muted,
              fontWeight: isToday || day == selected
                  ? FontWeight.w700
                  : FontWeight.w400,
            ),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        painter.paint(
          canvas,
          Offset(left + barWidth / 2 - painter.width / 2, plotHeight + 5),
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant _MonthBarsPainter old) =>
      old.today != today ||
      old.selected != selected ||
      old.daysInMonth != daysInMonth ||
      old.byDay != byDay;
}

String _monthName(int month) => const [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ][month - 1];

String _hhmm(DateTime t) =>
    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
