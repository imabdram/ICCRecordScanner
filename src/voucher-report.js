// Pure report building for the Daily E-Voucher Reports page.
//
// Kept free of DOM and Supabase so the arithmetic — which is what people will
// check against the phone — can be tested directly.

/** 'YYYY-MM-DD' for a Date, without timezone drift. */
export function isoDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Every day from `from` to `to` inclusive. Empty when the range is invalid. */
export function eachDay(from, to) {
  if (!from || !to || from > to) return [];
  const out = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end) {
    out.push(isoDay(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);

/**
 * One rep, one row per day in the range, zeros included so a missing day is
 * visible rather than absent.
 */
export function buildIndividual(daily, repId, from, to) {
  const days = eachDay(from, to);
  const byDay = new Map();
  for (const row of daily) {
    if (repId && row.sales_rep_id !== repId) continue;
    if (!repId) continue;
    const day = String(row.day).slice(0, 10);
    byDay.set(day, {
      amount: (byDay.get(day)?.amount ?? 0) + Number(row.amount ?? 0),
      vouchers: (byDay.get(day)?.vouchers ?? 0) + Number(row.vouchers ?? 0),
    });
  }

  const rows = days.map((day) => ({
    day,
    amount: byDay.get(day)?.amount ?? 0,
    vouchers: byDay.get(day)?.vouchers ?? 0,
  }));

  return {
    rows,
    totals: { amount: sum(rows, 'amount'), vouchers: sum(rows, 'vouchers') },
  };
}

/**
 * Whole team: one row per day, each carrying who contributed, so a day can be
 * expanded without another query.
 */
export function buildTeam(daily, from, to) {
  const days = eachDay(from, to);
  const byDay = new Map(days.map((day) => [day, new Map()]));

  for (const row of daily) {
    const day = String(row.day).slice(0, 10);
    const bucket = byDay.get(day);
    if (!bucket) continue; // outside the range
    const current = bucket.get(row.sales_rep_id) ?? {
      sales_rep_id: row.sales_rep_id,
      sales_rep_name: row.sales_rep_name,
      outlet_name: row.outlet_name,
      amount: 0,
      vouchers: 0,
    };
    current.amount += Number(row.amount ?? 0);
    current.vouchers += Number(row.vouchers ?? 0);
    bucket.set(row.sales_rep_id, current);
  }

  const rows = days.map((day) => {
    const byRep = [...(byDay.get(day)?.values() ?? [])].sort((a, b) => b.amount - a.amount);
    return {
      day,
      amount: sum(byRep, 'amount'),
      vouchers: sum(byRep, 'vouchers'),
      byRep,
    };
  });

  return {
    rows,
    totals: { amount: sum(rows, 'amount'), vouchers: sum(rows, 'vouchers') },
  };
}

/** The four summary cards. Average is per day of the selected range. */
export function summariseTeam(team, from, to, { activeReps } = {}) {
  const days = eachDay(from, to).length;
  const reps =
    activeReps ??
    new Set(
      team.rows.flatMap((row) => row.byRep.filter((r) => r.vouchers > 0).map((r) => r.sales_rep_id)),
    ).size;

  return {
    amount: team.totals.amount,
    vouchers: team.totals.vouchers,
    activeReps: reps,
    averagePerDay: days ? team.totals.amount / days : 0,
    days,
  };
}
