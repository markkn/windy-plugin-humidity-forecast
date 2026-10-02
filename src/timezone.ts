/** Remove Windy's nautical display prefix, not arbitrary timezone prefixes. */
export const normalizeTimeZoneName = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const info = value as { TZname?: unknown; TZtype?: unknown };
  if (typeof info.TZname !== 'string' || !info.TZname.trim()) return null;
  const name = info.TZname.trim();
  if (info.TZtype === 'n') {
    const nautical = /^Nautical:\s*(Etc\/GMT(?:[+-]\d{1,2})?)$/.exec(name);
    if (nautical) return nautical[1];
  }
  return name;
};
