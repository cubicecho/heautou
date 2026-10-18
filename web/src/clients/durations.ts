/** The units a lifetime may be typed in, largest first, with their length in seconds. */
const UNITS = [
  { suffix: 'd', seconds: 86_400 },
  { suffix: 'h', seconds: 3600 },
  { suffix: 'm', seconds: 60 },
  { suffix: 's', seconds: 1 },
] as const;

/** One part of a typed duration, such as `90m` or `2 h`. */
const PART = /(\d+)\s*([dhms])/gy;

/**
 * Writes a lifetime as the field shows it: whole days, hours, minutes and seconds, largest first.
 *
 * @param seconds - The lifetime.
 * @returns Text such as `1h 30m` or `14d`, which `secondsIn` reads back to the same number.
 */
export function durationText(seconds: number): string {
  let left = seconds;
  const parts: string[] = [];
  for (const unit of UNITS) {
    const count = Math.floor(left / unit.seconds);
    if (count > 0) {
      parts.push(`${count}${unit.suffix}`);
      left -= count * unit.seconds;
    }
  }
  return parts.length === 0 ? '0s' : parts.join(' ');
}

/**
 * Reads a typed lifetime.
 *
 * @param text - What was typed: parts such as `1h 30m`, `14d` or `90s`.
 * @returns The seconds, null for a blank field, or undefined when the text is not a duration.
 */
export function secondsIn(text: string): number | null | undefined {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '') {
    return null;
  }
  const compact = trimmed.replace(/\s+(?=\d)/g, '');
  let total = 0;
  let read = 0;
  PART.lastIndex = 0;
  for (let match = PART.exec(compact); match !== null; match = PART.exec(compact)) {
    const unit = UNITS.find((each) => each.suffix === match[2]);
    total += Number(match[1]) * (unit?.seconds ?? 0);
    read = PART.lastIndex;
  }
  return read === compact.length ? total : undefined;
}
