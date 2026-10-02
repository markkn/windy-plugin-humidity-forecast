import assert from 'node:assert/strict';
import test from 'node:test';
import { dayKey, deriveForecastView, formatHour, transformForecast } from '../src/weather.ts';

const hour = 60 * 60 * 1000;
const start = Date.parse('2026-10-01T00:00:00Z');
const point = (timestamp, humidityPercent, temperatureC = 20, dewPointC = 10) => ({
  timestamp: typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp,
  humidityPercent,
  temperatureC,
  dewPointC,
});

test('hourly preserves every transformed point, values, and chronological order', () => {
  const points = transformForecast({
    data: { ts: [start + hour, start], temperature: [295.15, 293.15] },
    meteogram: { ts: [start, start + hour], dewPoint: [283.15, 284.15] },
    sounding: { ts: [start + hour, start], 'rh-surface': [60, 80] },
  }, start);
  assert.equal(deriveForecastView(points, 'hourly', 'UTC'), points);
  assert.deepEqual(points.map(p => [p.timestamp, p.humidityPercent]), [[start, 80], [start + hour, 60]]);
});

test('3-hour displays every native forecast point without resampling', () => {
  const points = [1, 4, 7, 10].map(offset => point(start + offset * hour, 50));
  assert.equal(deriveForecastView(points, '3-hour', 'Asia/Kathmandu'), points);
});

test('daily labels humidity extrema and orders their actual points by time', () => {
  const points = [
    point('2026-10-01T01:00:00Z', 45, 24, 11),
    point('2026-10-01T06:00:00Z', 91, 14, 13),
    point('2026-10-01T15:00:00Z', 43, 26, 12),
    point('2026-10-02T07:00:00Z', 46, 25, 12),
    point('2026-10-02T12:00:00Z', 65, 21, 14),
    point('2026-10-02T16:00:00Z', 88, 16, 14),
  ];
  assert.deepEqual(deriveForecastView(points, 'daily', 'UTC'), [
    { ...points[1], humidityExtreme: 'High' },
    { ...points[2], humidityExtreme: 'Low' },
    { ...points[3], humidityExtreme: 'Low' },
    { ...points[5], humidityExtreme: 'High' },
  ]);
});

test('daily groups by location midnight, including fractional-hour timezones', () => {
  for (const [zone, midnightUtc] of [
    ['America/New_York', '2026-10-02T04:00:00Z'],
    ['Asia/Kolkata', '2026-10-01T18:30:00Z'],
    ['Asia/Kathmandu', '2026-10-01T18:15:00Z'],
  ]) {
    const midnight = Date.parse(midnightUtc);
    const points = [point(midnight - hour, 80), point(midnight, 20), point(midnight + hour, 90)];
    const selected = deriveForecastView(points, 'daily', zone);
    assert.deepEqual(selected.map(p => [dayKey(p.timestamp, zone), p.humidityExtreme]), [
      ['2026-10-01', 'High/Low'],
      ['2026-10-02', 'Low'],
      ['2026-10-02', 'High'],
    ], zone);
  }
  assert.equal(formatHour(start, 'Asia/Kolkata'), '5:30am');
  assert.equal(formatHour(start, 'Asia/Kathmandu'), '5:45am');
});

test('daily preserves timestamp ordering across a repeated hour at DST fall-back', () => {
  const points = [
    point('2026-11-01T05:00:00Z', 20),
    point('2026-11-01T06:00:00Z', 90),
    point('2026-11-01T07:00:00Z', 50),
  ];
  const selected = deriveForecastView(points, 'daily', 'America/New_York');
  assert.deepEqual(selected, [
    { ...points[0], humidityExtreme: 'Low' },
    { ...points[1], humidityExtreme: 'High' },
  ]);
  assert.equal(formatHour(selected[0].timestamp, 'America/New_York'), '1am');
  assert.equal(formatHour(selected[1].timestamp, 'America/New_York'), '1am');
});

test('daily excludes missing/nonfinite humidity and omits days without valid RH', () => {
  const points = [
    point(start, null),
    point(start + hour, NaN),
    point(start + 24 * hour, null),
    point(start + 25 * hour, 0, null, null),
    point(start + 26 * hour, null),
  ];
  assert.deepEqual(deriveForecastView(points, 'daily', 'UTC'), [{ ...points[3], humidityExtreme: 'High/Low' }]);
  assert.deepEqual(deriveForecastView(points.slice(0, 2), 'daily', 'UTC'), []);
  assert.deepEqual(deriveForecastView([], 'daily', 'UTC'), []);
});

test('daily uses the earliest tied extrema and collapses constant humidity to one point', () => {
  const points = [80, 80, 40, 40].map((rh, i) => point(start + i * hour, rh));
  assert.deepEqual(deriveForecastView(points, 'daily', 'UTC'), [
    { ...points[0], humidityExtreme: 'High' },
    { ...points[2], humidityExtreme: 'Low' },
  ]);
  const equal = [point(start, 50, 14, 4), point(start + hour, 50, 22, 12)];
  assert.deepEqual(deriveForecastView(equal, 'daily', 'UTC'), [{ ...equal[0], humidityExtreme: 'High/Low' }]);
});

test('switching views leaves the hourly dataset intact', () => {
  const points = Object.freeze([point(start, 80), point(start + hour, 40)].map(Object.freeze));
  const original = structuredClone(points);
  for (const view of ['daily', '3-hour', 'hourly', 'daily']) {
    deriveForecastView(points, view, 'UTC');
  }
  assert.deepEqual(points, original);
});
