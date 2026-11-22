/**
 * Pure filtering for the Scan Records table.
 *
 * Kept out of the view so it can be tested without a browser: the date-range
 * boundary is exactly the kind of thing that is easy to get wrong silently
 * (off-by-one on the end date, timezone drift, rows on the boundary day).
 *
 * Inputs are plain objects as returned by v_scan_records:
 *   { created_at, sales_rep_id, sales_rep_name, outlet_name, customer_name,
 *     iccid, primary_number, secondary_number }
 */

/** Midnight at the start of an ISO date (yyyy-mm-dd), in local time. */
function startOfDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 23:59:59.999 of an ISO date, in local time -- so "to" includes that day. */
function endOfDay(isoDate) {
  const d = new Date(`${isoDate}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function filterScans(rows, { from = '', to = '', rep = '', outlet = '', query = '' } = {}) {  const fromDate = from ? startOfDay(from) : null;
  const toDate = to ? endOfDay(to) : null;
  const q = String(query ?? '').trim().toLowerCase();

  return (rows ?? []).filter((s) => {
    if (fromDate || toDate) {
      const when = new Date(s.created_at);
      if (Number.isNaN(when.getTime())) return false;
      if (fromDate && when < fromDate) return false;
      if (toDate && when > toDate) return false;
    }

    if (rep && s.sales_rep_id !== rep) return false;
    if (outlet && s.outlet_name !== outlet) return false;

    if (q) {
      const hay = [
        s.customer_name,
        s.iccid,
        s.outlet_name,
        s.sales_rep_name,
        s.primary_number,
        s.secondary_number,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });
}

/**
 * Filtering for the Users & Team table.
 *
 * `outletName(id)` is injected so this module stays free of data lookups; the
 * caller passes its own outlet lookup (which already respects RLS).
 */
export function filterUsers(
  rows,
  { role = '', status = '', outlet = '', query = '', outletName = () => '' } = {},
) {
  const q = String(query ?? '').trim().toLowerCase();

  return (rows ?? []).filter((u) => {
    if (role && u.role !== role) return false;
    if (status === 'active' && !u.active) return false;
    if (status === 'disabled' && u.active) return false;
    if (outlet && u.outlet_id !== outlet) return false;

    if (q) {
      const hay = [u.full_name, u.username, outletName(u.outlet_id)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}