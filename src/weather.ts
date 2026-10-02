export type Model = 'ecmwf' | 'gfs' | 'icon';
export type TemperatureUnit = 'F' | 'C';
export type ForecastView = 'hourly' | '3-hour' | 'daily';

export const forecastStepForView = (view: ForecastView): 1 | 3 =>
  view === '3-hour' ? 3 : 1;

type NumericArray = Array<number | null | undefined>;

export interface ForecastPayload {
  data: {
    ts: number[];
    temperature: NumericArray;
  };
  meteogram?: {
    ts: number[];
    dewPoint?: NumericArray;
    [key: string]: NumericArray | number[] | undefined;
  };
  sounding?: {
    ts: number[];
    [key: string]: NumericArray | number[] | undefined;
  };
}

export interface ForecastPoint {
  timestamp: number;
  temperatureC: number | null;
  dewPointC: number | null;
  humidityPercent: number | null;
}

export interface ForecastDisplayPoint extends ForecastPoint {
  humidityExtreme?: 'High' | 'Low' | 'High/Low';
}

const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const kelvinToC = (value: number | null): number | null =>
  value === null ? null : value - 273.15;

const indexByTimestamp = (timestamps: number[] | undefined): Map<number, number> =>
  new Map((timestamps ?? []).map((timestamp, index) => [timestamp, index]));

const valueAt = (
  series: Record<string, NumericArray | number[] | undefined> | undefined,
  index: Map<number, number>,
  key: string,
  timestamp: number,
): number | null => {
  if (!series) return null;
  const i = index.get(timestamp);
  if (i === undefined) return null;
  const values = series[key];
  return Array.isArray(values) ? finite(values[i]) : null;
};

export const transformForecast = (payload: ForecastPayload, now = Date.now()): ForecastPoint[] => {
  const earliest = now - 60 * 60 * 1000;
  const meteogramIndex = indexByTimestamp(payload.meteogram?.ts);
  const soundingIndex = indexByTimestamp(payload.sounding?.ts);

  return payload.data.ts
    .map((timestamp, i): ForecastPoint | null => {
      if (!Number.isFinite(timestamp) || timestamp < earliest) return null;
      const tempK = finite(payload.data.temperature[i]);
      const dewK = valueAt(payload.meteogram, meteogramIndex, 'dewPoint', timestamp);
      const rh = valueAt(payload.sounding, soundingIndex, 'rh-surface', timestamp);

      return {
        timestamp,
        temperatureC: kelvinToC(tempK),
        dewPointC: kelvinToC(dewK),
        humidityPercent: rh === null ? null : Math.round(Math.max(0, Math.min(100, rh))),
      };
    })
    .filter((point): point is ForecastPoint => point !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
};

export const formatTemperature = (valueC: number | null, unit: TemperatureUnit): string => {
  if (valueC === null) return '—';
  const value = unit === 'F' ? valueC * 9 / 5 + 32 : valueC;
  return `${Math.round(value)}°`;
};

export const formatHumidity = (value: number | null): string =>
  value === null ? '—' : `${Math.round(value)}%`;

export const formatHour = (timestamp: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(timestamp).replace(':00', '').replace(/\s/g, '').toLowerCase();

export const formatDay = (timestamp: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
  }).format(timestamp);

export const dayKey = (timestamp: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

// Input is the chronological dataset returned by transformForecast.
// Hourly and 3-hour display all fetched points; Daily requires step: 1 data.
export const deriveForecastView = (
  points: ForecastPoint[],
  view: ForecastView,
  timeZone: string,
): ForecastDisplayPoint[] => {
  if (view !== 'daily') return points;

  const days = new Map<string, { high: ForecastPoint; low: ForecastPoint }>();
  for (const point of points) {
    const humidity = point.humidityPercent;
    if (humidity === null || !Number.isFinite(humidity)) continue;
    const key = dayKey(point.timestamp, timeZone);
    const extremes = days.get(key);
    if (!extremes) {
      days.set(key, { high: point, low: point });
    } else {
      // Strict comparisons preserve the earliest point when extrema tie.
      if (humidity > extremes.high.humidityPercent!) extremes.high = point;
      if (humidity < extremes.low.humidityPercent!) extremes.low = point;
    }
  }

  return [...days.values()].flatMap(({ high, low }): ForecastDisplayPoint[] => {
    // One valid point or constant RH gets one unambiguous column.
    if (high.timestamp === low.timestamp) return [{ ...high, humidityExtreme: 'High/Low' }];
    return [
      { ...high, humidityExtreme: 'High' as const },
      { ...low, humidityExtreme: 'Low' as const },
    ].sort((a, b) => a.timestamp - b.timestamp);
  });
};
