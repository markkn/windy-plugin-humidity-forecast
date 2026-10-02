// Reusable, opt-in diagnostics. Disabled by default for release builds.
// Set true only for private troubleshooting; retain these helpers in source.
export const TEMPORARY_TIMEZONE_DIAGNOSTICS = false;
export const MAX_TIMEZONE_DEBUG_LINES = 12;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

const safeText = (value: string): string => value
  .replace(/https?:\/\/\S+/gi, '[URL omitted]')
  .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/\b(api[_-]?key|token|authorization|password|secret|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
  .replace(/[\r\n\t]+/g, ' ')
  .slice(0, 180);

const scalar = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(safeText(value));
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === undefined ? 'missing' : '[non-scalar]';
};

export const rawCoordinateSummary = (value: unknown): string => {
  const candidate = object(value);
  return ['lat', 'lon', 'lng'].filter(key => key !== 'lng' || key in candidate).map(key => {
    const raw = candidate[key];
    // Preserve numeric route strings, but never print arbitrary parameter text.
    const text = typeof raw === 'string' && raw.trim() && !Number.isFinite(Number(raw))
      ? '[non-numeric string]' : scalar(raw);
    return `${key}=${text}`;
  }).join(' ');
};

export const timezoneResponseSummary = (value: unknown): string => {
  if (value === null || value === undefined) return `response=${scalar(value)}`;
  const response = object(value);
  const data = object(response.data);
  // Explicit allowlist: never include headers, request URLs, tokens, or a payload dump.
  return `HTTP status=${typeof response.status === 'number' ? response.status : 'unavailable'}; data=${
    response.data === null ? 'null' : typeof response.data
  }; ` + ['TZname', 'TZabbrev', 'TZoffset', 'TZoffsetMin', 'TZoffsetFormatted', 'TZtype']
    .map(key => `${key}=${scalar(data[key])}`).join(' ');
};

/** TEMPORARY: localized name fields only, never a full reverse-geocoding payload. */
export const reverseNameSummary = (value: unknown): string => {
  const result = object(value);
  return ['name', 'nameValid', 'region', 'country', 'cc']
    .map(key => `${key}=${scalar(result[key])}`).join(' ');
};

export const timezoneErrorSummary = (value: unknown): string => {
  if (typeof value === 'string') return safeText(value);
  const error = object(value);
  return `${typeof error.name === 'string' ? safeText(error.name) : 'Error'}: ${
    typeof error.message === 'string' ? safeText(error.message) : 'No error message provided'
  }`;
};

export const appendTimezoneDebug = (lines: string[], line: string): string[] =>
  [...lines, line].slice(-MAX_TIMEZONE_DEBUG_LINES);
