// Number and date formatting for the views. en-GB, UTC dates (the bars are calendar days).

const nf = (digits: number) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const n2 = nf(2);

export const num = (x: number | null | undefined, digits = 2) => (x == null || !Number.isFinite(x) ? '–' : digits === 2 ? n2.format(x) : nf(digits).format(x));

export const signed = (x: number | null | undefined, digits = 2) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${num(Math.abs(x), digits)}`);

export const pct = (x: number | null | undefined, digits = 2) => (x == null || !Number.isFinite(x) ? '–' : `${signed(x, digits)} %`);

export const plainPct = (x: number | null | undefined, digits = 1) => (x == null || !Number.isFinite(x) ? '–' : `${num(x, digits)} %`);

export function compact(x: number | null | undefined) {
  if (x == null || !Number.isFinite(x)) return '–';
  return new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(x);
}

export const day = (t: number | string | null | undefined) => {
  if (t == null) return '–';
  const d = typeof t === 'string' ? new Date(`${t}T00:00:00Z`) : new Date(t);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

export function age(days: number | null | undefined) {
  if (days == null) return '–';
  if (days < 1) return 'today';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'} old`;
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30.4);
  const parts = [years ? `${years} year${years === 1 ? '' : 's'}` : '', months ? `${months} month${months === 1 ? '' : 's'}` : ''].filter(Boolean);
  return `${parts.join(' ')} old (${days} days)`;
}

export const tone = (x: number | null | undefined) => (x == null || x === 0 ? 'flat' : x > 0 ? 'up' : 'down');
