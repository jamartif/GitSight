/* Date helpers. Pure module. */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

let rtf: Intl.RelativeTimeFormat | undefined;

export function fromNow(unixSeconds: number, now: number = Date.now() / 1000, locale?: string): string {
  if (!rtf || locale) rtf = new Intl.RelativeTimeFormat(locale ?? 'en', { numeric: 'auto' });
  const diff = unixSeconds - now;
  const abs = Math.abs(diff);
  for (const [unit, secs] of UNITS) {
    if (abs >= secs || unit === 'second') {
      if (unit === 'second' && abs < 45) return rtf.format(0, 'second') === 'now' ? 'just now' : rtf.format(0, 'second');
      return rtf.format(Math.round(diff / secs), unit);
    }
  }
  return '';
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(unixSeconds: number, format?: string): string {
  const d = new Date(unixSeconds * 1000);
  if (!format) {
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return format
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()));
}

/** Linear interpolation between two hex colors. t=0 → a, t=1 → b */
export function mixColors(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.min(1, Math.max(0, t))));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.substring(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
