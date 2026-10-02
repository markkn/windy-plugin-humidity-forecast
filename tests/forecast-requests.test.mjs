import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import config from '../src/pluginConfig.ts';
import * as weather from '../src/weather.ts';
import * as location from '../src/location.ts';
import * as timezoneDiagnostics from '../src/timezoneDiagnostics.ts';
import * as timezone from '../src/timezone.ts';


// Exercise the component's actual request handlers without a browser or Windy host.
const source = readFileSync(new URL('../src/plugin.svelte', import.meta.url), 'utf8');
const script = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
const diagnosticPanelCondition = source.match(/\{#if (TEMPORARY_TIMEZONE_DIAGNOSTICS[^}]+)\}/)[1];
const parsed = ts.createSourceFile('plugin.ts', script, ts.ScriptTarget.ES2022, true);
const reactiveStatements = parsed.statements
  .filter(statement => ts.isLabeledStatement(statement) && statement.label.text === '$')
  .map(statement => statement.statement.getText(parsed)).join('\n');
const { outputText } = ts.transpileModule(`
  let displayPoints, viewLabel, locationLabel, timezoneDebugText, awaitingLocation, waitingMessage;
  ${script}
  exports.testApi = {
    changeView, refresh, handleMapClick, handleMapMoveEnd, handleMapDragStart, handleMapResize, onopen, retryTimeZone, recordTimezoneDebug,
    changeModel(nextModel) { model = nextModel; return refresh(); },
    state() {
      ${reactiveStatements}
      return { view, temperatureUnit, status, points, displayPoints, timeZone, timeZoneFallback, timeZoneRetrying, errorMessage, locationLabel, locationName, selectedLocation, isDesktopOrTablet, timezoneDebugText, timezoneDebugLines, halfOpenRequestStatus, halfOpenConfirmed, awaitingLocation, waitingMessage, phoneMapMoved, panelHalfOpen, diagnosticPanelVisible: ${diagnosticPanelCondition} };
    },
  };
`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });

const createForecast = (rh) => {
  const timestamp = Date.now();
  return { data: {
    data: { ts: [timestamp], temperature: [293.15] },
    meteogram: { ts: [timestamp], dewPoint: [283.15] },
    sounding: { ts: [timestamp], 'rh-surface': [rh] },
  } };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const initialSettingReads = ['detailDefault1h', 'detailRememberLast', 'temperatureMetric'];
const createPlugin = (zone = 'Asia/Kathmandu', settings = { detailRememberLast: true, detailDefault1h: true, temperatureMetric: '°F' }, host = {}) => {
  const requests = [];
  const timezoneRequests = [];
  const nameRequests = [];
  const logs = [];
  const routes = [];
  const settingReads = [];
  const listeners = new Map();
  const mapListeners = new Map();
  const broadcastListeners = new Map();
  const broadcastEmits = [];
  const suppliedPicker = Object.hasOwn(host, 'picker') ? host.picker : {
    pickerDot: { getLatLon: () => ({ lat: 20, lon: 40 }) },
  };
  let mount;
  let destroy;
  const modules = {
    '@windy/broadcast': {
      emit: (...args) => {
        broadcastEmits.push(args);
        host.emit?.(...args);
      },
      on: (topic, handler) => broadcastListeners.set(topic, handler),
      off: (topic, handler) => {
        assert.equal(broadcastListeners.get(topic), handler);
        broadcastListeners.delete(topic);
      },
    },
    '@windy/fetch': {
      getPointForecastData: (model, options, includes, httpOptions) => new Promise((resolve, reject) => {
        requests.push({ model, options, includes, signal: httpOptions.abortSignal, resolve, reject });
      }),
      getTimezoneInfo: (location, datetime) => {
        timezoneRequests.push({ location, datetime });
        return host.getTimezoneInfo ? host.getTimezoneInfo(location, datetime) : Promise.resolve({ data: { TZname: zone } });
      },
    },
    '@windy/location': {
      setUrl: (...args) => { routes.push(args); host.onSetUrl?.(...args); },
      getURL: () => assert.fail('Must not read current URL for selection'),
    },
    '@windy/map': { map: {
      getCenter: () => host.center ?? { lat: 20, lng: 40 },
      getSize: () => host.mapSize ?? { x: 400, y: 800 },
      on: (topic, handler) => mapListeners.set(topic, handler),
      off: (topic, handler) => {
        assert.equal(mapListeners.get(topic), handler);
        mapListeners.delete(topic);
      },
    } },
    '@windy/picker': suppliedPicker,
    '@windy/rootScope': { isDesktopOrTablet: !host.isMobile || host.isTablet === true },
    '@windy/reverseName': {
      get: (location, forcedZoom) => new Promise((resolve, reject) => nameRequests.push({ location, forcedZoom, resolve, reject })),
    },
    '@windy/metrics': { temp: {
      get metric() {
        settingReads.push('temperatureMetric');
        return settings.temperatureMetric;
      },
      set metric(value) { assert.fail('Plugin must not modify Windy temperature units'); },
      setMetric() { assert.fail('Plugin must not modify Windy temperature units'); },
    } },
    '@windy/singleclick': { singleclick: {
      on: (name, handler) => listeners.set(name, handler),
      off: name => listeners.delete(name),
    } },
    '@windy/store': {
      get: key => {
        assert.ok(['detailDefault1h', 'detailRememberLast'].includes(key), 'No experimental store reads');
        settingReads.push(key);
        return settings[key];
      },
      set() { assert.fail('Plugin must not modify Windy saved settings'); },
      on() { assert.fail('No store subscriptions'); },
    },
    svelte: {
      onMount: handler => { mount = handler; }, onDestroy: handler => { destroy = handler; },
      tick: host.tick ?? (() => Promise.resolve()),
    },
    './pluginConfig': host.config ?? config,
    './weather': weather,
    './location': location,
    './timezoneDiagnostics': { ...timezoneDiagnostics,
      TEMPORARY_TIMEZONE_DIAGNOSTICS: host.diagnostics ?? timezoneDiagnostics.TEMPORARY_TIMEZONE_DIAGNOSTICS,
    },
    './timezone': timezone,
  };
  const exports = {};
  runInNewContext(outputText, {
    exports, AbortController, Intl, URL,
    console: Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, args })])),
    require: name => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
      return modules[name];
    },
  });
  host.afterSetup?.();
  if (Object.hasOwn(host, 'openParams')) exports.testApi.onopen(host.openParams);
  host.afterOnopen?.();
  mount();
  return { ...exports.testApi, requests, timezoneRequests, nameRequests, logs, routes, listeners, mapListeners, broadcastListeners, broadcastEmits, settingReads, destroy };
};

test('Hourly and Daily share loaded data and an in-flight step: 1 request', async () => {
  const plugin = createPlugin();
  assert.equal(plugin.requests[0].options.step, 1);
  plugin.changeView('daily');
  plugin.changeView('hourly');
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.requests[0].signal.aborted, false);
  plugin.requests[0].resolve(createForecast(80));
  await settle();
  const points = plugin.state().points;
  plugin.changeView('daily');
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.state().points, points);
  assert.equal(plugin.state().displayPoints[0].humidityExtreme, 'High/Low');
  assert.equal(weather.formatHour(Date.UTC(2026, 9, 1), plugin.state().timeZone), '5:45am');
  assert.equal(plugin.state().timeZoneFallback, false);
  plugin.destroy();
});

test('resolution changes cancel previous requests and ignore out-of-order responses', async () => {
  const plugin = createPlugin();
  plugin.changeView('3-hour');
  plugin.changeView('daily');
  assert.deepEqual(plugin.requests.map(request => request.options.step), [1, 3, 1]);
  assert.equal(plugin.requests[0].signal.aborted, true);
  assert.equal(plugin.requests[1].signal.aborted, true);
  assert.equal(plugin.requests[2].signal.aborted, false);
  assert.equal(plugin.state().status, 'loading');
  assert.equal(plugin.state().displayPoints.length, 0);
  plugin.requests[2].resolve(createForecast(90));
  await settle();
  plugin.requests[1].resolve(createForecast(30));
  plugin.requests[0].reject(new Error('Superseded request failed'));
  await settle();
  assert.equal(plugin.state().status, 'ready');
  assert.equal(plugin.state().points[0].humidityPercent, 90);
  assert.equal(plugin.state().displayPoints[0].humidityPercent, 90);
  assert.equal(plugin.state().errorMessage, '');
  plugin.destroy();
});

test('native 3-hour data stays hidden when Daily begins loading hourly replacement data', async () => {
  const plugin = createPlugin();
  plugin.changeView('3-hour');
  plugin.requests[1].resolve(createForecast(40));
  await settle();
  assert.equal(plugin.state().status, 'ready');
  assert.equal(plugin.state().displayPoints, plugin.state().points);
  plugin.changeView('daily');
  assert.equal(plugin.requests[2].options.step, 1);
  assert.equal(plugin.state().displayPoints.length, 0);
  plugin.changeView('hourly');
  assert.equal(plugin.requests.length, 3);
  plugin.requests[2].resolve(createForecast(95));
  await settle();
  assert.equal(plugin.state().points[0].humidityPercent, 95);
  plugin.destroy();
});

test('location/model changes and retry use the selected step; teardown cancels and removes listeners', async () => {
  const plugin = createPlugin(null);
  plugin.changeView('3-hour');
  plugin.listeners.get(config.name)({ lat: 40, lon: -20 });
  assert.equal(plugin.routes[0][0], config.name);
  assert.equal(plugin.routes[0][1].lat, 40);
  assert.equal(plugin.routes[0][1].lon, -20);
  const modelRequest = plugin.changeModel('gfs');
  assert.deepEqual(plugin.requests.map(request => request.options.step), [1, 3, 3, 3]);
  const request = plugin.requests[3];
  assert.equal(request.model, 'gfs');
  assert.equal(request.options.lat, 40);
  assert.equal(request.options.lon, -20);
  assert.equal(request.options.days, 5);
  request.reject(new Error('Forecast unavailable'));
  await modelRequest;
  assert.equal(plugin.state().status, 'error');
  const retry = plugin.refresh();
  assert.equal(plugin.requests[4].options.step, 3);
  plugin.requests[4].resolve(createForecast(70));
  await retry;
  assert.equal(plugin.state().timeZone, 'UTC');
  assert.equal(plugin.state().timeZoneFallback, true);
  const pending = plugin.refresh();
  plugin.destroy();
  assert.equal(plugin.requests[5].signal.aborted, true);
  assert.equal(plugin.listeners.size, 0);
  plugin.requests[5].resolve(createForecast(10));
  await pending;
  assert.equal(plugin.state().points[0].humidityPercent, 70);
});

test('remember-last enabled inherits the saved step regardless of detailDefaultEnabled and snapshots temperature units', () => {
  for (const detailDefault1h of [true, false]) {
    for (const detailDefaultEnabled of [true, false]) {
      for (const temperatureMetric of ['°F', '°C']) {
        const plugin = createPlugin('UTC', {
          detailRememberLast: true, detailDefault1h, detailDefaultEnabled, temperatureMetric,
        });
        assert.equal(plugin.state().view, detailDefault1h ? 'hourly' : '3-hour');
        assert.equal(plugin.state().temperatureUnit, temperatureMetric === '°F' ? 'F' : 'C');
        assert.equal(plugin.requests.length, 1);
        assert.equal(plugin.requests[0].options.step, detailDefault1h ? 1 : 3);
        assert.deepEqual(plugin.settingReads, initialSettingReads);
        plugin.destroy();
      }
    }
  }
});

test('remember-last disabled starts at 3-hour regardless of saved step or detailDefaultEnabled', () => {
  for (const detailDefault1h of [true, false]) {
    for (const detailDefaultEnabled of [true, false]) {
      const settings = { detailRememberLast: false, detailDefault1h, detailDefaultEnabled, temperatureMetric: '°C' };
      const original = { ...settings };
      const plugin = createPlugin('UTC', settings);
      assert.equal(plugin.state().view, '3-hour');
      assert.equal(plugin.state().temperatureUnit, 'C');
      assert.equal(plugin.requests.length, 1);
      assert.equal(plugin.requests[0].options.step, 3);
      assert.deepEqual(plugin.settingReads, initialSettingReads);
      assert.deepEqual(settings, original);
      plugin.destroy();
    }
  }
});

test('an unavailable remember-last flag does not activate a saved hourly step', () => {
  const plugin = createPlugin('UTC', { detailDefault1h: true, temperatureMetric: '°F' });
  assert.equal(plugin.state().view, '3-hour');
  assert.equal(plugin.requests[0].options.step, 3);
  plugin.destroy();
});

test('local view overrides and the inherited temperature snapshot survive settings changes and onopen', () => {
  const settings = { detailRememberLast: false, detailDefault1h: true, temperatureMetric: '°C' };
  const plugin = createPlugin('UTC', settings);
  plugin.changeView('hourly');
  assert.equal(settings.detailRememberLast, false);
  assert.equal(settings.detailDefault1h, true);
  assert.equal(settings.temperatureMetric, '°C');
  plugin.onopen({ lat: 40, lon: -20 });
  assert.equal(plugin.state().view, 'hourly');
  assert.equal(plugin.state().temperatureUnit, 'C');
  plugin.changeView('daily');
  settings.detailRememberLast = true;
  settings.temperatureMetric = '°F';
  assert.equal(plugin.requests.length, 3);
  plugin.onopen({ lat: 41, lon: -21 });
  plugin.onopen();
  assert.equal(plugin.state().view, 'daily');
  assert.equal(plugin.state().temperatureUnit, 'C');
  assert.deepEqual(plugin.requests.map(request => request.options.step), [3, 1, 1, 1]);
  assert.deepEqual(plugin.settingReads, initialSettingReads);
  plugin.destroy();
});

test('a new component resnapshots Windy view defaults and temperature metric', () => {
  const settings = { detailRememberLast: true, detailDefault1h: true, temperatureMetric: '°F' };
  const first = createPlugin('UTC', settings);
  first.changeView('daily');
  assert.equal(first.state().temperatureUnit, 'F');
  first.destroy();
  settings.detailRememberLast = false;
  settings.temperatureMetric = '°C';
  const reopened = createPlugin('UTC', settings);
  assert.equal(reopened.state().view, '3-hour');
  assert.equal(reopened.state().temperatureUnit, 'C');
  assert.equal(reopened.requests[0].options.step, 3);
  assert.deepEqual(reopened.settingReads, initialSettingReads);
  assert.deepEqual(first.settingReads, initialSettingReads);
  reopened.destroy();
});

test('coordinates reject empty/coerced/invalid latitudes and normalize wrapped longitudes', () => {
  assert.deepEqual(location.parseLatLon({ lat: '47.606', lon: '-122.332' }), { lat: 47.606, lon: -122.332 });
  assert.deepEqual(location.parseLatLon({ lat: 0, lng: 720 }), { lat: 0, lon: 0 });
  assert.deepEqual(location.parseLatLon({ lat: 12.25, lng: 410.1 }), { lat: 12.25, lon: 50.10000000000002 });
  assert.deepEqual(location.parseLatLon({ lat: 0, lon: -540 }), { lat: 0, lon: -180 });
  for (const input of [null, {}, { lat: null, lon: 0 }, { lat: '', lon: 0 }, { lat: false, lon: 0 },
    { lat: 91, lon: 0 }, { lat: -91, lon: 0 }, { lat: 0, lon: Infinity }, { lat: 0, lon: ' ' }]) {
    assert.equal(location.parseLatLon(input), null);
  }
});

test('wrapped startup coordinates reach every location API normalized', () => {
  const plugin = createPlugin('UTC', undefined, { center: { lat: 47.606, lng: 237.668 } });
  assert.ok(Math.abs(plugin.timezoneRequests[0].location.lon + 122.332) < 1e-10);
  assert.equal(plugin.requests[0].options.lon, plugin.timezoneRequests[0].location.lon);
  assert.equal(plugin.nameRequests[0].location.lon, plugin.timezoneRequests[0].location.lon);
  plugin.onopen({ lat: '47.606', lon: '237.668' });
  assert.equal(plugin.requests[1].options.lon, plugin.requests[0].options.lon);
  plugin.destroy();
});

test('invalid startup coordinates do not issue location API requests', () => {
  const plugin = createPlugin('UTC', undefined, { center: { lat: NaN, lng: 0 } });
  assert.equal(plugin.state().status, 'error');
  assert.match(plugin.state().errorMessage, /coordinates are unavailable/);
  assert.equal(plugin.requests.length, 0);
  assert.equal(plugin.timezoneRequests.length, 0);
  assert.equal(plugin.nameRequests.length, 0);
  plugin.onopen({ lat: 47.606, lon: -122.332 });
  assert.equal(plugin.requests.length, 1);
  plugin.destroy();
});

test('timezone API errors and unusable names retain UTC as final fallback', async () => {
  for (const outcome of ['missing', 'invalid', 'error']) {
    const error = new Error('Timezone service unavailable');
    const response = { data: { TZname: outcome === 'invalid' ? 'Invalid/Timezone' : '' } };
    const plugin = createPlugin('UTC', undefined, {
      getTimezoneInfo: async () => { if (outcome === 'error') throw error; return response; },
    });
    plugin.requests[0].resolve(createForecast(70));
    await settle();
    assert.equal(plugin.state().status, 'ready');
    assert.equal(plugin.state().timeZone, 'UTC');
    assert.equal(plugin.state().timeZoneFallback, true);
    plugin.destroy();
  }
});

test('timezone-only retry recovers without forecasts or naming requests and retains Daily data', async () => {
  let zone = null;
  const plugin = createPlugin('UTC', undefined, {
    getTimezoneInfo: async () => ({ data: { TZname: zone } }),
  });
  plugin.changeView('daily');
  plugin.requests[0].resolve(createForecast(85));
  await settle();
  const points = plugin.state().points;
  assert.equal(plugin.state().timeZoneFallback, true);
  zone = 'Asia/Kathmandu';
  await plugin.retryTimeZone();
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.nameRequests.length, 2);
  assert.equal(plugin.timezoneRequests.length, 2);
  assert.equal(plugin.state().points, points);
  assert.equal(plugin.state().timeZoneFallback, false);
  assert.equal(weather.formatHour(Date.UTC(2026, 9, 1), plugin.state().timeZone), '5:45am');
  assert.equal(plugin.state().displayPoints[0].humidityExtreme, 'High/Low');
  plugin.destroy();
});

test('stale timezone retries and startup responses cannot replace a newer location timezone', async () => {
  const lookups = [];
  const plugin = createPlugin('UTC', undefined, {
    getTimezoneInfo: () => new Promise(resolve => lookups.push(resolve)),
  });
  lookups[0]({ data: {} });
  plugin.requests[0].resolve(createForecast(75));
  await settle();
  const retry = plugin.retryTimeZone();
  assert.equal(plugin.state().timeZoneRetrying, true);
  await plugin.retryTimeZone();
  assert.equal(lookups.length, 2);
  plugin.onopen({ lat: 47.606, lon: -122.332 });
  lookups[2]({ data: { TZname: 'America/New_York' } });
  plugin.requests[1].resolve(createForecast(80));
  await settle();
  lookups[1]({ data: { TZname: 'Asia/Kathmandu' } });
  await retry;
  assert.equal(plugin.state().timeZone, 'America/New_York');
  assert.equal(plugin.state().timeZoneRetrying, false);
  plugin.onopen({ lat: 40, lon: -20 });
  plugin.onopen({ lat: 51, lon: 0 });
  lookups[4]({ data: { TZname: 'Europe/London' } });
  plugin.requests[3].resolve(createForecast(90));
  await settle();
  lookups[3]({ data: { TZname: 'America/New_York' } });
  plugin.requests[2].resolve(createForecast(10));
  await settle();
  assert.equal(plugin.state().timeZone, 'Europe/London');
  assert.equal(plugin.state().points[0].humidityPercent, 90);
  plugin.destroy();
});

test('destroy ignores an outstanding timezone-only retry', async () => {
  let resolveRetry;
  let calls = 0;
  const plugin = createPlugin('UTC', undefined, {
    getTimezoneInfo: () => ++calls === 1 ? Promise.resolve({ data: {} }) : new Promise(resolve => { resolveRetry = resolve; }),
  });
  plugin.requests[0].resolve(createForecast(75));
  await settle();
  const retry = plugin.retryTimeZone();
  plugin.destroy();
  resolveRetry({ data: { TZname: 'Asia/Kathmandu' } });
  await retry;
  assert.equal(plugin.state().timeZoneFallback, true);
  assert.equal(plugin.state().timeZone, 'UTC');
});


test('map helper is conditional on the documented desktop/tablet flag, not shown on mobile', () => {
  const desktop = createPlugin();
  const mobile = createPlugin('UTC', undefined, { isMobile: true });
  assert.equal(desktop.state().isDesktopOrTablet, true);
  assert.equal(mobile.state().isDesktopOrTablet, false);
  assert.match(source, /\{#if isDesktopOrTablet\}\s*<span>Click the map to move this forecast\.<\/span>\s*\{\/if\}/);
  assert.ok(!source.includes('Tap the map'));
  assert.ok(source.includes('Time displayed is for selected location · {timeZone}'));
  assert.ok(source.includes('Time unavailable for selected location · Using UTC'));
  assert.ok(!source.includes('forecast location time'));
  assert.ok(!source.includes('local time for forecast location'));
  assert.equal(config.mobileUI, 'fullscreen');
  assert.equal(config.desktopUI, 'rhpane');
  desktop.destroy();
  mobile.destroy();
});

const broadName = (name, country = 'United States', cc = 'US') =>
  ({ name, region: name, country, cc, nameValid: true });
const localityName = (name, region, country = 'United States', cc = 'US') =>
  ({ name, region, country, cc, nameValid: true });

test('fixed zooms compose municipality with state/province rather than county/subregion', () => {
  for (const [state, city, region, country, cc] of [
    ['Washington', 'Seattle', 'King County', 'United States', 'US'],
    ['Wisconsin', 'Sun Prairie', 'Dane', 'United States', 'US'],
    ['California', 'Sacramento', 'Sacramento County', 'United States', 'US'],
    ['Wisconsin', 'Madison', 'Dane County', 'United States', 'US'],
    ['Manitoba', 'Winnipeg', 'Winnipeg Metropolitan Region', 'Canada', 'CA'],
    ['Québec', 'Québec City', 'Capitale-Nationale', 'Canada', 'CA'],
    ['British Columbia', 'Vancouver', 'Metro Vancouver', 'Canada', 'CA'],
    ['Colorado', 'Boulder', 'Boulder', 'United States', 'US'],
    ['Oregon', 'Portland', 'Multnomah County', 'United States', 'US'],
  ]) assert.equal(location.formatLocationName(broadName(state, country, cc),
    localityName(city, region, country, cc)), city + ', ' + state);
});

test('zoom-5 orientation prefers repeated region, then useful region/name; zoom-8 region never supplies orientation', () => {
  for (const [coarse, expected] of [
    [broadName('Washington'), 'Seattle, Washington'],
    [{ name: 'Pacific Northwest', region: 'Washington', country: 'United States' }, 'Seattle, Washington'],
    [{ name: 'Washington', country: 'United States' }, 'Seattle, Washington'],
    [{ name: 'Unknown', nameValid: false, region: 'Washington', country: 'United States' }, 'Seattle, Washington'],
    [{ name: 'United States', region: 'King County', country: 'United States' }, 'Seattle, United States'],
    [{ country: 'United States' }, 'Seattle, United States'],
    [null, 'Seattle, United States'],
  ]) assert.equal(location.formatLocationName(coarse, localityName('Seattle', 'King County')), expected);
  assert.equal(location.formatLocationName(null, localityName('Winnipeg', 'Manitoba', 'Canada', 'CA')), 'Winnipeg, Canada');
  assert.equal(location.formatLocationName(broadName('District of Columbia'),
    localityName('Washington', 'Washington County')), 'Washington, District of Columbia');
});

test('fixed naming uses locality/country, broad-region-only, country-only and coordinate-only fallbacks', () => {
  for (const [coarse, fine, expected] of [
    [null, localityName('Lyon', undefined, 'France', 'FR'), 'Lyon, France'],
    [broadName('California'), null, 'California'],
    [broadName('Manitoba', 'Canada', 'CA'), { nameValid: false, country: 'Canada' }, 'Manitoba'],
    [{ country: 'Canada' }, null, 'Canada'],
    [null, { country: 'Canada' }, 'Canada'],
    [null, { region: 'Manitoba' }, ''],
    [null, { name: 'United States', country: 'United States' }, 'United States'],
    [null, null, ''],
    [{ cc: 'US' }, {}, ''],
  ]) assert.equal(location.formatLocationName(coarse, fine), expected);
});

test('numeric/coordinate names and invalid locality names are rejected while safe region/country fields survive', () => {
  for (const name of ['', ' ', '12.34, -56.78', '12.34° N, 56.78° W', '123', 123, {}, null]) {
    assert.equal(location.formatLocationName(broadName('Wisconsin'), localityName(name, 'Dane County')), 'Wisconsin');
    assert.equal(location.formatLocationName({ name, region: name, country: 'United States' },
      localityName('Madison', 'Dane County')), 'Madison, United States');
  }
  assert.equal(location.formatLocationName(broadName('Wisconsin'),
    { name: 'Madison', nameValid: false, region: 'Dane County', country: 'United States' }), 'Wisconsin');
});

test('fixed naming deduplicates components case-insensitively and excludes broad/country names as localities', () => {
  for (const [coarse, fine, expected] of [
    [broadName('Washington'), localityName('Seattle, Washington, washington', 'King County'), 'Seattle, Washington'],
    [broadName('Washington, WASHINGTON'), localityName('Washington', 'Washington'), 'Washington'],
    [broadName('Québec', 'Canada', 'CA'), localityName('QUÉBEC', 'Québec', 'Canada', 'CA'), 'Québec'],
    [broadName('Paris', 'France', 'FR'), localityName('Paris, PARIS', 'Paris', 'France', 'FR'), 'Paris'],
    [{ country: 'France' }, localityName('France', undefined, 'France', 'FR'), 'France'],
    [broadName('Washington'), localityName('Seattle, United States, UNITED STATES', 'King County'), 'Seattle, Washington'],
  ]) assert.equal(location.formatLocationName(coarse, fine), expected);
});

test('cross-response orientation requires affirmative country agreement without conflicts', () => {
  const fine = localityName('Madison', 'Dane County');
  assert.equal(location.formatLocationName({ name: 'Wisconsin', region: 'Wisconsin' }, fine), 'Madison, United States');
  assert.equal(location.formatLocationName({ name: 'Wisconsin', region: 'Wisconsin', cc: 'us' }, fine), 'Madison, Wisconsin');
  assert.equal(location.formatLocationName(broadName('Wisconsin'),
    { ...fine, country: 'united states', cc: 'us' }), 'Madison, Wisconsin');
  for (const fine of [
    localityName('Winnipeg', 'Manitoba', 'Canada', 'CA'),
    localityName('Winnipeg', 'Manitoba', 'Canada', 'US'),
    localityName('Winnipeg', 'Manitoba', 'United States', 'CA'),
  ]) assert.equal(location.formatLocationName(broadName('Wisconsin'), fine), 'Winnipeg, ' + fine.country);
  assert.equal(location.formatLocationName(broadName('Wisconsin'),
    { nameValid: false, country: 'Canada' }), 'Wisconsin');
});

test('each selected location gets exactly zoom 5 and 8, independent of forecast/model/view/map zoom', async () => {
  const plugin = createPlugin();
  assert.deepEqual(plugin.nameRequests.map(request => request.forcedZoom), [5, 8]);
  plugin.nameRequests[0].resolve(broadName('California'));
  plugin.nameRequests[1].resolve(localityName('Sacramento', 'Sacramento County'));
  await settle();
  assert.equal(plugin.state().locationLabel, 'Sacramento, California · 20.000, 40.000');
  assert.equal(plugin.state().status, 'loading'); // name does not wait for forecast
  plugin.changeView('3-hour');
  void plugin.changeModel('icon');
  plugin.onopen({ lat: 20, lon: 40 });
  assert.equal(plugin.nameRequests.length, 2);
  assert.equal(plugin.mapListeners.has('zoomend'), false); // zoom alone never requests names
  assert.ok(!source.includes('reverseNameProbe'));
  plugin.handleMapClick({ lat: 35, lon: 21 });
  assert.deepEqual(plugin.nameRequests.map(request => request.forcedZoom), [5, 8, 5, 8]);
  plugin.destroy();
});

test('final fixed name is atomic in either completion order and never holds up forecast rendering', async () => {
  for (const first of [0, 1]) {
    const plugin = createPlugin();
    plugin.requests[0].resolve(createForecast(80));
    await settle();
    assert.equal(plugin.state().status, 'ready');
    const results = [broadName('Wisconsin'), localityName('Madison', 'Dane County')];
    plugin.nameRequests[first].resolve(results[first]);
    await settle();
    assert.equal(plugin.state().locationName, '');
    assert.equal(plugin.state().locationLabel, '20.000, 40.000');
    plugin.nameRequests[1 - first].resolve(results[1 - first]);
    await settle();
    assert.equal(plugin.state().locationName, 'Madison, Wisconsin');
    assert.equal(plugin.requests.length, 1);
    assert.equal(plugin.timezoneRequests.length, 1);
    plugin.destroy();
  }
});

test('either fixed lookup failing keeps the other safe result; both failures leave coordinates only', async () => {
  for (const failures of [[true, false], [false, true], [true, true]]) {
    const plugin = createPlugin();
    const results = [broadName('Washington'), localityName('Seattle', 'King County')];
    plugin.nameRequests.forEach((request, i) => failures[i]
      ? request.reject(new Error('Name unavailable')) : request.resolve(results[i]));
    plugin.requests[0].resolve(createForecast(80));
    await settle();
    const expected = failures[0] ? failures[1] ? '' : 'Seattle, United States' : 'Washington';
    assert.equal(plugin.state().locationName, expected);
    assert.equal(plugin.state().locationLabel, expected ? expected + ' · 20.000, 40.000' : '20.000, 40.000');
    assert.equal(plugin.state().status, 'ready');
    assert.equal(plugin.nameRequests.length, 2);
    plugin.destroy();
  }
});

test('localized fixed names preserve Windy language and are reused across model/resolution changes', async () => {
  const plugin = createPlugin();
  plugin.nameRequests[0].resolve(broadName('Québec', 'Canada', 'CA'));
  plugin.nameRequests[1].resolve(localityName('Montréal', 'Montréal', 'Canada', 'CA'));
  await settle();
  assert.equal(plugin.state().locationLabel, 'Montréal, Québec · 20.000, 40.000');
  plugin.changeView('daily');
  void plugin.changeModel('gfs');
  assert.equal(plugin.nameRequests.length, 2);
  plugin.destroy();
});

test('old fixed results cannot overwrite a newer picker location or update a destroyed component', async () => {
  const host = { isMobile: true, openParams: { lat: 33, lon: 20 }, center: { lat: 29, lng: 20 },
    picker: { pickerDot: { getLatLon: () => ({ lat: 34, lon: 21 }) } } };
  const plugin = createPlugin('UTC', undefined, host);
  plugin.nameRequests[0].resolve(broadName('California'));
  await settle();
  plugin.handleMapDragStart();
  host.center = { lat: 30, lng: 21 };
  plugin.handleMapMoveEnd();
  assert.equal(plugin.state().locationName, '');
  plugin.nameRequests[3].resolve(localityName('Portland', 'Multnomah County'));
  await settle();
  assert.equal(plugin.state().locationName, '');
  plugin.nameRequests[2].resolve(broadName('Oregon'));
  await settle();
  assert.equal(plugin.state().locationName, 'Portland, Oregon');
  plugin.nameRequests[1].resolve(localityName('Sacramento', 'Sacramento County'));
  await settle();
  assert.equal(plugin.state().locationName, 'Portland, Oregon');
  host.center = { lat: 31, lng: 22 };
  plugin.handleMapMoveEnd(); // same picker reuses both name results
  assert.equal(plugin.nameRequests.length, 4);
  plugin.destroy();

  const destroyed = createPlugin();
  destroyed.destroy();
  destroyed.nameRequests[0].resolve(broadName('California'));
  destroyed.nameRequests[1].resolve(localityName('Sacramento', 'Sacramento County'));
  await settle();
  assert.equal(destroyed.state().locationName, '');
});

test('coordinate tolerance ignores floating-point jitter and equivalent longitude worlds', () => {
  assert.equal(location.sameLocation(null, null), false);
  assert.equal(location.sameLocation({ lat: 30, lon: 180 }, { lat: 30.000005, lon: -180 }), true);
  assert.equal(location.sameLocation({ lat: 30, lon: 237.668 }, { lat: 30, lon: -122.332 }), true);
  assert.equal(location.sameLocation({ lat: 30, lon: 20 }, { lat: 30.00002, lon: 20 }), false);
  assert.equal(location.sameLocation({ lat: 30, lon: 20 }, { lat: 30, lon: 20.00002 }), false);
});

const waitingPhone = (overrides = {}) => {
  const dot = { lat: 10.125, lon: 20.25 };
  const host = { isMobile: true, center: { lat: 5.5, lng: 20.25 },
    picker: { pickerDot: { getLatLon: () => dot } }, ...overrides,
  };
  return { plugin: createPlugin('UTC', undefined, host), host, dot };
};
const assertNoLocationRequests = plugin => {
  assert.equal(plugin.requests.length, 0);
  assert.equal(plugin.timezoneRequests.length, 0);
  assert.equal(plugin.nameRequests.length, 0);
};

test('phone HOME and SEARCH mounts without explicit parameters wait with no location requests or route changes', () => {
  for (const center of [{ lat: 10.125, lng: 20.25 }, { lat: 5.5, lng: 20.25 }]) {
    const { plugin } = waitingPhone({ center });
    assertNoLocationRequests(plugin);
    const state = plugin.state();
    assert.equal(state.selectedLocation, null);
    assert.equal(state.awaitingLocation, true);
    assert.equal(state.status, 'idle');
    assert.equal(state.errorMessage, '');
    assert.equal(state.points.length, 0);
    assert.equal(state.displayPoints.length, 0);
    assert.equal(plugin.routes.length, 0);
    assert.deepEqual(plugin.settingReads, initialSettingReads);
    assert.match(source, /\{#if selectedLocation \|\| isDesktopOrTablet\}/);
    assert.match(source, /\{#if awaitingLocation\}\s*<div class="state">\{waitingMessage\}<\/div>/);
    plugin.destroy();
  }
});

test('waiting instruction follows actual half-open/fullscreen events, including manual opening after request failure', async () => {
  const { plugin } = waitingPhone({ emit: () => { throw new Error('Half-open rejected'); } });
  const full = 'Drag this panel down halfway, then move the map to choose a forecast location.';
  const half = 'Move the map to choose a forecast location.';
  assert.equal(plugin.state().waitingMessage, full);
  plugin.broadcastListeners.get('pluginOpened')(config.name);
  await settle();
  assert.equal(plugin.state().halfOpenRequestStatus, 'failed');
  assert.equal(plugin.state().waitingMessage, full);
  plugin.broadcastListeners.get('pluginHalfOpened')('detail', true);
  assert.equal(plugin.state().waitingMessage, full);
  plugin.broadcastListeners.get('pluginHalfOpened')(config.name, true);
  assert.equal(plugin.state().waitingMessage, half);
  assert.equal(plugin.state().panelHalfOpen, true);
  plugin.broadcastListeners.get('pluginHalfOpened')(config.name, false);
  assert.equal(plugin.state().waitingMessage, full);
  assert.equal(plugin.state().panelHalfOpen, false);
  assertNoLocationRequests(plugin);
  plugin.destroy();
});

test('automatic half-open, programmatic layout movement, resize and picker-only changes cannot activate selection', async () => {
  const { plugin, host, dot } = waitingPhone();
  plugin.broadcastListeners.get('pluginOpened')(config.name);
  await settle();
  plugin.broadcastListeners.get('pluginHalfOpened')(config.name, true);
  host.center = { lat: 30, lng: 20 }; // programmatic layout pan, not a user gesture
  dot.lat = 35;
  plugin.handleMapMoveEnd();
  plugin.broadcastListeners.get('pluginHalfOpened')(config.name, false);
  dot.lat = 36; // picker moves with viewport/zoom, map center stays fixed
  plugin.handleMapMoveEnd();
  host.mapSize = { x: 400, y: 500 };
  host.center = { lat: 31, lng: 20 };
  plugin.handleMapMoveEnd(); // Leaflet may emit moveend before resize
  plugin.mapListeners.get('resize')();
  plugin.handleMapMoveEnd();
  assertNoLocationRequests(plugin);
  assert.equal(plugin.state().selectedLocation, null);
  assert.equal(plugin.state().phoneMapMoved, false);
  assert.equal(plugin.routes.length, 0);
  plugin.destroy();
});

test('a drag with insignificant coordinate jitter does not choose a location', () => {
  const { plugin, host, dot } = waitingPhone();
  plugin.handleMapDragStart();
  host.center = { lat: host.center.lat + 0.000005, lng: host.center.lng + 0.000005 };
  dot.lat += 0.000005;
  dot.lon += 0.000005;
  plugin.handleMapMoveEnd();
  assertNoLocationRequests(plugin);
  assert.equal(plugin.state().phoneMapMoved, false);
  assert.equal(plugin.state().awaitingLocation, true);
  plugin.destroy();
});

test('first material user movement selects the picker, starts all lookups, and later movement preserves stale-response protections', async () => {
  const { plugin, host, dot } = waitingPhone();
  plugin.handleMapDragStart();
  host.center = { lat: 30, lng: 20 };
  dot.lat = 34;
  dot.lon = 380; // wrapped world normalizes to 20
  assertNoLocationRequests(plugin); // never fetch continuously during drag
  plugin.handleMapMoveEnd();
  assert.equal(plugin.state().selectedLocation.lat, 34);
  assert.equal(plugin.state().selectedLocation.lon, 20);
  assert.equal(plugin.state().awaitingLocation, false);
  assert.equal(plugin.state().phoneMapMoved, true);
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.timezoneRequests.length, 1);
  assert.equal(plugin.nameRequests.length, 2);
  assert.equal(plugin.requests[0].options.lat, 34);
  assert.equal(plugin.timezoneRequests[0].location.lat, 34);
  assert.equal(plugin.nameRequests[0].location.lat, 34);
  assert.equal(plugin.routes[0][1].lat, 34);
  plugin.handleMapMoveEnd();
  plugin.onopen({ lat: 10, lon: 20 }); // later routing cannot override active picker
  plugin.broadcastListeners.get('pluginHalfOpened')(config.name, false);
  plugin.broadcastListeners.get('pluginHalfOpened')(config.name, true);
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.state().selectedLocation.lat, 34);
  assert.equal(plugin.routes.length, 1);
  host.center = { lat: 31, lng: 21 };
  dot.lat = 35;
  dot.lon = 21;
  plugin.handleMapMoveEnd();
  assert.equal(plugin.requests.length, 2);
  assert.equal(plugin.requests[0].signal.aborted, true);
  assert.equal(plugin.state().selectedLocation.lat, 35);
  assert.equal(plugin.routes[1][1].lat, 35);
  plugin.requests[1].resolve(createForecast(90));
  await settle();
  plugin.requests[0].resolve(createForecast(10));
  await settle();
  assert.equal(plugin.state().status, 'ready');
  assert.equal(plugin.state().points[0].humidityPercent, 90);
  plugin.destroy();
});

test('direct explicit plugin coordinates initialize immediately, including decimals and documented metadata', () => {
  for (const params of [{ lat: 47.606, lon: -122.332 },
    { lat: '47.606', lon: '237.668', source: 'contextmenu', name: 'Seattle', poiType: 'city' }]) {
    const { plugin } = waitingPhone({ openParams: params });
    assert.equal(plugin.requests.length, 1);
    assert.equal(plugin.timezoneRequests.length, 1);
    assert.equal(plugin.nameRequests.length, 2);
    assert.equal(plugin.state().selectedLocation.lat, 47.606);
    assert.ok(Math.abs(plugin.state().selectedLocation.lon + 122.332) < 1e-10);
    assert.equal(plugin.state().awaitingLocation, false);
    plugin.onopen(params); // normalized route echo reuses the request
    assert.equal(plugin.requests.length, 1);
    plugin.handleMapMoveEnd();
    assert.equal(plugin.requests.length, 1); // baseline picker does not override explicit coordinates
    plugin.destroy();
  }
});

test('invalid or ambiguous opening parameters wait; neither current URLs nor startup/picker evidence is recovered', () => {
  for (const openParams of [undefined, null, {}, [], '/10.125/20.25',
    { lat: 91, lon: 0 }, { lat: '', lon: 0 }, { lat: false, lon: 0 }, { lat: 0, lon: Infinity },
    { lat: '0x21', lon: 20 }, { lat: 10.125, lng: 20.25 },
    { lat: 10.125, lon: 20.25, zoom: 5 }, { lat: 10.125, lon: 20.25, query: 'picker' },
    { pickerCoords: { lat: 10.125, lon: 20.25 } }, { lat: 33, lon: 20, source: {} },
    Object.create({ lat: 10.125, lon: 20.25 })]) {
    assert.equal(location.explicitPluginLocation(openParams), null);
    const { plugin } = waitingPhone({ openParams });
    assertNoLocationRequests(plugin);
    assert.equal(plugin.state().awaitingLocation, true);
    assert.equal(plugin.state().status, 'idle');
    assert.equal(plugin.routes.length, 0);
    assert.ok(!plugin.broadcastListeners.has('routerParsed'));
    plugin.destroy();
  }
});

test('model/view/retry changes while waiting issue no requests; a later explicit opening uses the current local choices', async () => {
  const { plugin } = waitingPhone();
  plugin.changeView('daily');
  plugin.changeView('3-hour');
  await plugin.changeModel('gfs');
  await plugin.refresh();
  await plugin.retryTimeZone();
  assertNoLocationRequests(plugin);
  assert.equal(plugin.state().status, 'idle');
  assert.equal(plugin.state().errorMessage, '');
  plugin.onopen({ lat: 10.125, lon: 20.25 });
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.requests[0].model, 'gfs');
  assert.equal(plugin.requests[0].options.step, 3);
  assert.equal(plugin.state().awaitingLocation, false);
  assert.deepEqual(plugin.settingReads, initialSettingReads);
  plugin.destroy();
});

test('unavailable/invalid picker stays waiting after movement and never selects map center', () => {
  for (const picker of [undefined, {}, { pickerDot: { getLatLon: () => ({ lat: NaN, lon: 0 }) } },
    { pickerDot: { getLatLon() { throw new Error('Unavailable token=SECRET'); } } }]) {
    const { plugin, host } = waitingPhone({ picker });
    plugin.handleMapDragStart();
    host.center = { lat: 34, lng: 20 };
    plugin.handleMapMoveEnd();
    assertNoLocationRequests(plugin);
    assert.equal(plugin.state().selectedLocation, null);
    assert.equal(plugin.state().awaitingLocation, true);
    assert.equal(plugin.state().status, 'idle');
    assert.ok(!plugin.state().timezoneDebugText.includes('SECRET'));
    assert.equal(plugin.routes.length, 0);
    plugin.destroy();
  }
});

test('picker failure after selection retains the last location/data without switching to map center', async () => {
  const { plugin, host, dot } = waitingPhone();
  plugin.handleMapDragStart();
  host.center = { lat: 30, lng: 20 };
  dot.lat = 34;
  plugin.handleMapMoveEnd();
  plugin.requests[0].resolve(createForecast(80));
  await settle();
  host.picker.pickerDot.getLatLon = () => ({ lat: NaN, lon: 0 });
  host.center = { lat: 40, lng: -20 };
  plugin.handleMapMoveEnd();
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.state().selectedLocation.lat, 34);
  assert.equal(plugin.state().status, 'ready');
  assert.equal(plugin.state().points[0].humidityPercent, 80);
  plugin.destroy();
});

test('release defaults leave diagnostics inert through normal phone opening, dragging and fixed naming', async () => {
  assert.equal(timezoneDiagnostics.TEMPORARY_TIMEZONE_DIAGNOSTICS, false);
  assert.equal(existsSync(new URL('../src/reverseNameProbe.ts', import.meta.url)), false);
  const { plugin, host, dot } = waitingPhone(); // actual default, no flag override
  const history = plugin.state().timezoneDebugLines;
  for (let i = 0; i < 30; i++) plugin.recordTimezoneDebug('disabled event ' + i);
  assert.equal(plugin.state().timezoneDebugLines, history);
  assert.equal(history.length, 0);
  assert.equal(plugin.state().timezoneDebugText, '');
  assert.equal(plugin.state().diagnosticPanelVisible, false);
  assert.equal(plugin.logs.length, 0);
  assertNoLocationRequests(plugin);
  plugin.broadcastListeners.get('pluginOpened')(config.name);
  await settle();
  assert.equal(plugin.broadcastEmits.length, 1); // half-open unaffected
  plugin.broadcastListeners.get('pluginHalfOpened')(config.name, true);
  assert.equal(plugin.state().waitingMessage, 'Move the map to choose a forecast location.');
  plugin.handleMapDragStart();
  host.center = { lat: 30, lng: 20 };
  dot.lat = 34;
  plugin.handleMapMoveEnd();
  assert.equal(plugin.state().selectedLocation.lat, dot.lat);
  assert.equal(plugin.routes.length, 1);
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.timezoneRequests.length, 1);
  assert.deepEqual(plugin.nameRequests.map(request => request.forcedZoom), [5, 8]);
  plugin.nameRequests[0].resolve(broadName('Wisconsin'));
  plugin.nameRequests[1].resolve(localityName('Madison', 'Dane County'));
  plugin.requests[0].resolve(createForecast(80));
  await settle();
  assert.equal(plugin.state().status, 'ready');
  assert.equal(plugin.state().locationName, 'Madison, Wisconsin');
  plugin.broadcastListeners.get('pluginHalfOpened')(config.name, false);
  plugin.handleMapMoveEnd(); // duplicate movement doesn't refresh
  plugin.changeView('daily');
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.nameRequests.length, 2);
  assert.equal(plugin.state().timezoneDebugLines, history);
  assert.equal(plugin.state().timezoneDebugText, '');
  assert.equal(plugin.state().diagnosticPanelVisible, false);
  assert.equal(plugin.logs.length, 0); // catches log/info/debug/warn/error, including naming
  plugin.destroy();
  plugin.recordTimezoneDebug('after destroy');
  assert.equal(plugin.logs.length, 0);
});

test('troubleshooting opt-in retains compact history/panel/logging and stops recording after destroy', () => {
  const { plugin } = waitingPhone({ diagnostics: true });
  for (let i = 0; i < 40; i++) plugin.recordTimezoneDebug('private event ' + i);
  assert.equal(plugin.state().diagnosticPanelVisible, true);
  assert.equal(plugin.state().timezoneDebugLines.length, timezoneDiagnostics.MAX_TIMEZONE_DEBUG_LINES);
  assert.equal(plugin.state().timezoneDebugLines.at(-1), 'private event 39');
  assert.match(plugin.state().timezoneDebugText, /Awaiting location: true/);
  assert.ok(plugin.logs.every(log => log.level === 'info' && log.args[0] === '[humidity] phone diagnostic'));
  assert.ok(plugin.logs.some(log => log.args[1] === 'private event 39'));
  const history = plugin.state().timezoneDebugLines;
  const count = plugin.logs.length;
  plugin.destroy();
  plugin.recordTimezoneDebug('after destroy');
  assert.equal(plugin.state().timezoneDebugLines, history);
  assert.equal(plugin.logs.length, count);
});

test('compact diagnostics can be disabled without changing waiting, panel instruction, or picker activation', () => {
  for (const diagnostics of [false, true]) {
    const { plugin, host, dot } = waitingPhone({ diagnostics });
    if (diagnostics) {
      assert.match(plugin.state().timezoneDebugText, /Awaiting location: true/);
      assert.match(plugin.state().timezoneDebugText, /Map-center baseline: lat=5\.5/);
      assert.match(plugin.state().timezoneDebugText, /PickerDot baseline: lat=10\.125/);
      assert.equal(plugin.state().diagnosticPanelVisible, true);
    } else {
      assert.equal(plugin.state().timezoneDebugText, '');
      assert.equal(plugin.state().diagnosticPanelVisible, false);
    }
    plugin.broadcastListeners.get('pluginHalfOpened')(config.name, true);
    assert.equal(plugin.state().waitingMessage, 'Move the map to choose a forecast location.');
    plugin.handleMapDragStart();
    host.center = { lat: 30, lng: 20 };
    dot.lat = 34;
    plugin.handleMapMoveEnd();
    assert.equal(plugin.requests.length, 1);
    assert.equal(plugin.state().selectedLocation.lat, 34);
    if (!diagnostics) {
      assert.equal(plugin.state().timezoneDebugLines.length, 0);
      assert.equal(plugin.state().timezoneDebugText, '');
      assert.equal(plugin.logs.length, 0);
    } else {
      assert.ok(plugin.logs.some(log => log.level === 'info' && log.args[0] === '[humidity] phone diagnostic'));
    }
    assert.ok(plugin.state().timezoneDebugLines.length <= timezoneDiagnostics.MAX_TIMEZONE_DEBUG_LINES);
    plugin.destroy();
  }
  assert.ok(!source.includes('detailLocation'));
  assert.ok(!source.includes('routerParsed'));
  assert.ok(!source.includes('picker-mobile'));
  assert.ok(!source.includes('getURL'));
  assert.ok(!source.includes('picker.emitter'));
});

test('all phone map/broadcast listeners are cleaned up and queued callbacks cannot select after destruction', () => {
  for (const selected of [false, true]) {
    const { plugin } = waitingPhone(selected ? { openParams: { lat: 33, lon: 20 } } : {});
    assert.deepEqual([...plugin.mapListeners.keys()], ['moveend', 'resize', 'dragstart']);
    assert.deepEqual([...plugin.broadcastListeners.keys()], ['pluginOpened', 'pluginHalfOpened', 'pluginClosed']);
    const callbacks = [...plugin.mapListeners.values()];
    const requestCount = plugin.requests.length;
    const snapshot = plugin.state().timezoneDebugText;
    plugin.destroy();
    assert.equal(plugin.mapListeners.size, 0);
    assert.equal(plugin.broadcastListeners.size, 0);
    assert.equal(plugin.listeners.size, 0);
    for (const callback of callbacks) callback();
    assert.equal(plugin.requests.length, requestCount);
    assert.equal(plugin.state().timezoneDebugText, snapshot);
    if (selected) assert.equal(plugin.requests[0].signal.aborted, true);
  }
});

test('desktop/tablet keep click selection and never follow moveend', () => {
  for (const host of [{}, { isMobile: true, isTablet: true }]) {
    const plugin = createPlugin('UTC', undefined, host);
    assert.equal(plugin.mapListeners.size, 0);
    assert.equal(plugin.listeners.size, 1);
    plugin.handleMapMoveEnd();
    assert.equal(plugin.requests.length, 1);
    plugin.listeners.get(config.name)({ lat: 47.606, lon: -122.332 });
    assert.equal(plugin.requests.length, 2);
    assert.equal(plugin.routes.length, 1);
    plugin.destroy();
    assert.equal(plugin.listeners.size, 0);
  }
});

test('timezone footnote has separate source and IANA/fallback lines and public release metadata is consistent', () => {
  const footnote = source.match(/<div class="footnote">([\s\S]*?)\n    <\/div>/)[1];
  const firstLine = footnote.match(/<div>(.*?)<\/div>/)[1];
  assert.match(firstLine, /^Windy forecast data · /);
  assert.ok(!firstLine.includes('timeZone'));
  assert.match(footnote, /Time displayed is for selected location · \{timeZone\}/);
  assert.match(footnote, /Time unavailable for selected location · Using UTC/);
  assert.ok(!footnote.includes('TZabbrev'));
  assert.equal(config.version, '0.1.12');
  assert.equal(config.private, false);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  assert.equal(config.title, 'Humidity Forecast');
  assert.equal(config.author, 'markkn');
  assert.equal(pkg.author, config.author);
  assert.equal(pkg.description, config.description);
  assert.equal(pkg.repository.url, 'git+' + config.repository + '.git');
  assert.equal(timezoneDiagnostics.TEMPORARY_TIMEZONE_DIAGNOSTICS, false);
  assert.equal(existsSync(new URL('../src/screenshot.jpg', import.meta.url)), true);
  assert.equal(pkg.version, config.version);
  assert.equal(lock.version, config.version);
  assert.equal(lock.packages[''].version, config.version);
});

test('diagnostic summaries allowlist scalar values, redact messages/URLs and bound history', () => {
  assert.equal(timezoneDiagnostics.rawCoordinateSummary({ lat: 'SECRET', lon: { token: 'SECRET' }, token: 'SECRET' }), 'lat=[non-numeric string] lon=[non-scalar]');
  const summary = timezoneDiagnostics.timezoneResponseSummary({ status: 200,
    headers: { Authorization: 'SECRET' }, data: { TZname: 'UTC', token: 'SECRET', large: new Array(10000).fill('SECRET') },
  });
  assert.ok(!summary.includes('SECRET'));
  assert.ok(summary.length < 250);
  assert.equal(timezoneDiagnostics.timezoneResponseSummary(null), 'response=null');
  assert.equal(timezoneDiagnostics.timezoneErrorSummary('failure'), 'failure');
  assert.equal(timezoneDiagnostics.timezoneErrorSummary(null), 'Error: No error message provided');
  assert.ok(!timezoneDiagnostics.timezoneErrorSummary({ name: 'Error', message: 'https://user:SECRET@host/path?key=SECRET Bearer SECRET token=SECRET password:SECRET' }).includes('SECRET'));
  assert.ok(timezoneDiagnostics.timezoneErrorSummary({ message: 'x'.repeat(10000) }).length < 220);
  let lines = [];
  for (let i = 0; i < 100; i++) lines = timezoneDiagnostics.appendTimezoneDebug(lines, `line ${i}`);
  assert.equal(lines.length, timezoneDiagnostics.MAX_TIMEZONE_DEBUG_LINES);
  assert.equal(lines[0], 'line ' + (100 - timezoneDiagnostics.MAX_TIMEZONE_DEBUG_LINES));
  assert.equal(lines.at(-1), 'line 99');
});

test('phone requests half-open once for its own opened event and preserves subsequent user dragging', async () => {
  const desktop = createPlugin();
  assert.equal(desktop.broadcastListeners.size, 0);
  desktop.destroy();
  const mobile = createPlugin('UTC', undefined, { isMobile: true });
  assert.deepEqual([...mobile.broadcastListeners.keys()], ['pluginOpened', 'pluginHalfOpened', 'pluginClosed']);
  const opened = mobile.broadcastListeners.get('pluginOpened');
  const halfOpened = mobile.broadcastListeners.get('pluginHalfOpened');
  opened('windy-external-plugin');
  opened('detail');
  await settle();
  assert.equal(mobile.broadcastEmits.length, 0);
  assert.equal(mobile.state().halfOpenRequestStatus, 'not requested');
  opened(config.name);
  opened(config.name);
  assert.equal(mobile.broadcastEmits.length, 0);
  assert.equal(mobile.state().halfOpenRequestStatus, 'scheduled');
  await settle();
  assert.deepEqual(Array.from(mobile.broadcastEmits[0]), ['rqstHalfOpen', config.name, true, true]);
  assert.equal(mobile.broadcastEmits.length, 1);
  assert.equal(mobile.state().halfOpenRequestStatus, 'sent');
  assert.equal(mobile.state().halfOpenConfirmed, false);
  halfOpened('windy-external-plugin', true);
  assert.equal(mobile.state().halfOpenConfirmed, false);
  halfOpened(config.name, true);
  assert.equal(mobile.state().halfOpenConfirmed, true);
  halfOpened(config.name, false);
  opened(config.name);
  mobile.onopen({ lat: 29, lon: 20 });
  mobile.changeView('daily');
  mobile.handleMapClick({ lat: 30, lon: 20 });
  await settle();
  assert.equal(mobile.broadcastEmits.length, 1);
  mobile.destroy();
  assert.equal(mobile.broadcastListeners.size, 0);
});

test('half-open request tolerates synchronous confirmation and a new lifecycle gets its own one request', async () => {
  let mobile;
  mobile = createPlugin('UTC', undefined, { isMobile: true,
    emit: topic => {
      if (topic === 'rqstHalfOpen') mobile.broadcastListeners.get('pluginHalfOpened')(config.name, true);
    },
  });
  mobile.broadcastListeners.get('pluginOpened')(config.name);
  await settle();
  assert.equal(mobile.state().halfOpenConfirmed, true);
  assert.equal(mobile.broadcastEmits.length, 1);
  mobile.destroy();
  const reopened = createPlugin('UTC', undefined, { isMobile: true });
  reopened.broadcastListeners.get('pluginOpened')(config.name);
  await settle();
  assert.equal(reopened.broadcastEmits.length, 1);
  assert.equal(reopened.state().halfOpenConfirmed, false);
  reopened.destroy();
});

test('disabled troubleshooting diagnostics do not disable the phone half-open request', async () => {
  const mobile = createPlugin('UTC', undefined, { isMobile: true, diagnostics: false });
  mobile.broadcastListeners.get('pluginOpened')(config.name);
  await settle();
  assert.equal(mobile.broadcastEmits.length, 1);
  assert.equal(mobile.state().halfOpenRequestStatus, 'sent');
  assert.equal(mobile.state().timezoneDebugLines.length, 0);
  mobile.destroy();
  assert.equal(mobile.broadcastListeners.size, 0);
});

test('pending half-open is cancelled on close or destruction and cannot be revived by another open', async () => {
  for (const destroy of [false, true]) {
    let releaseTick;
    const mobile = createPlugin('UTC', undefined, { isMobile: true,
      tick: () => new Promise(resolve => { releaseTick = resolve; }),
    });
    mobile.broadcastListeners.get('pluginOpened')(config.name);
    if (destroy) mobile.destroy();
    else {
      mobile.broadcastListeners.get('pluginClosed')(config.name);
      mobile.broadcastListeners.get('pluginOpened')(config.name);
    }
    releaseTick();
    await settle();
    assert.equal(mobile.broadcastEmits.length, 0);
    assert.equal(mobile.state().halfOpenRequestStatus, 'cancelled');
    if (!destroy) {
      mobile.broadcastListeners.get('pluginOpened')(config.name);
      await settle();
      assert.equal(mobile.broadcastEmits.length, 0);
      mobile.destroy();
    }
  }
});

test('desktop/tablet never subscribe to or request half-open; failures remain isolated from forecasts', async () => {
  for (const host of [{}, { isMobile: true, isTablet: true }]) {
    const plugin = createPlugin('UTC', undefined, host);
    plugin.onopen({ lat: 30, lon: 20 });
    await settle();
    assert.equal(plugin.broadcastListeners.size, 0);
    assert.equal(plugin.broadcastEmits.length, 0);
    plugin.destroy();
  }
  const mobile = createPlugin('UTC', undefined, { isMobile: true, openParams: { lat: 20, lon: 40 },
    emit: () => { throw new Error('Half-open request rejected'); },
  });
  mobile.broadcastListeners.get('pluginOpened')(config.name);
  mobile.requests[0].resolve(createForecast(90));
  await settle();
  assert.equal(mobile.state().status, 'ready');
  assert.equal(mobile.state().halfOpenRequestStatus, 'failed');
  assert.equal(mobile.state().halfOpenConfirmed, false);
  mobile.broadcastListeners.get('pluginOpened')(config.name);
  await settle();
  assert.equal(mobile.broadcastEmits.length, 1);
  mobile.destroy();
});

const nauticalResponse = { status: 200, data: {
  TZname: 'Nautical: Etc/GMT+6', TZabbrev: 'GMT-6', TZoffset: -6,
  TZoffsetMin: -360, TZoffsetFormatted: '-06:00', TZtype: 'n',
} };

test('structured nautical normalization removes only the known display prefix and preserves normal zones', () => {
  assert.equal(timezone.normalizeTimeZoneName(nauticalResponse.data), 'Etc/GMT+6');
  assert.equal(timezone.normalizeTimeZoneName({ TZname: 'America/New_York', TZtype: 't' }), 'America/New_York');
  assert.equal(timezone.normalizeTimeZoneName({ TZname: 'Etc/GMT+6', TZtype: 'n' }), 'Etc/GMT+6');
  assert.equal(timezone.normalizeTimeZoneName({ TZname: 'Nautical: Etc/GMT-5', TZtype: 'n' }), 'Etc/GMT-5');
  for (const TZtype of ['t', undefined, 'unknown']) {
    assert.equal(timezone.normalizeTimeZoneName({ TZname: nauticalResponse.data.TZname, TZtype }), 'Nautical: Etc/GMT+6');
  }
  assert.equal(timezone.normalizeTimeZoneName({ TZname: 'Arbitrary: Etc/GMT+6', TZtype: 'n' }), 'Arbitrary: Etc/GMT+6');
  assert.equal(timezone.normalizeTimeZoneName({ TZname: 'Nautical: America/New_York', TZtype: 'n' }), 'Nautical: America/New_York');
  for (const value of [null, undefined, {}, { TZname: 42 }, { TZname: '   ' }]) {
    assert.equal(timezone.normalizeTimeZoneName(value), null);
  }
});

test('structured nautical response succeeds on the first lookup and retains UTC-minus-six semantics', async () => {
  const plugin = createPlugin('UTC', undefined, {
    center: { lat: 0, lng: -90 },
    getTimezoneInfo: async () => nauticalResponse,
  });
  plugin.changeView('daily');
  plugin.requests[0].resolve(createForecast(90));
  await settle();
  assert.equal(plugin.state().status, 'ready');
  assert.equal(plugin.state().timeZone, 'Etc/GMT+6');
  assert.equal(plugin.state().timeZoneFallback, false);
  assert.equal(plugin.timezoneRequests.length, 1);
  assert.equal(plugin.requests.length, 1);
  assert.equal(plugin.state().displayPoints[0].humidityExtreme, 'High/Low');
  assert.equal(weather.formatHour(Date.UTC(2026, 9, 1, 12), plugin.state().timeZone), '6am');
  assert.equal(weather.dayKey(Date.UTC(2026, 9, 1, 2), plugin.state().timeZone), '2026-09-30');
  plugin.destroy();
});

test('normal IANA responses stay unchanged and unusable nautical responses still use UTC fallback', async () => {
  for (const data of [
    { TZname: 'America/New_York', TZtype: 't' },
    { TZname: 'Nautical: Etc/GMT+99', TZtype: 'n' },
    { TZname: 'Nautical: Etc/GMT+6', TZtype: 't' },
  ]) {
    const plugin = createPlugin('UTC', undefined, { getTimezoneInfo: async () => ({ status: 200, data }) });
    plugin.requests[0].resolve(createForecast(80));
    await settle();
    const valid = data.TZname === 'America/New_York';
    assert.equal(plugin.state().timeZone, valid ? 'America/New_York' : 'UTC');
    assert.equal(plugin.state().timeZoneFallback, !valid);
    assert.equal(plugin.timezoneRequests.length, 1);
    assert.equal(plugin.requests.length, 1);
    plugin.destroy();
  }
});
