# Windy Humidity Forecast

A compact Windy.com plugin for hourly, native 3-hour, and daily humidity high/low forecasts, with temperature and dew point. It uses Windy's own 5-day point-forecast data, with no external weather service or separate API key.

## Forecast views

- **Hourly:** every available point from Windy's native `step: 1` forecast.
- **3-hour:** every returned point from Windy's native `step: 3` forecast, without client-side sampling.
- **Daily:** each local calendar day's humidity high and low, selected from the hourly forecast. Columns show the actual time, temperature, humidity, and dew point of those points, in chronological order. High/Low labels describe humidity extrema.

All views support ECMWF, GFS, and ICON. Hourly and Daily share loaded data or an ongoing hourly request. Switching into or out of 3-hour, changing the model, or moving the forecast location requests fresh data at the required resolution. Superseded requests are cancelled and stale responses ignored.

Daily ties select the earliest point. A day with only one valid humidity point, or constant humidity, has one column labeled **High/Low**. Missing humidity is excluded; days without valid humidity are omitted. The first and last days may cover only part of a calendar day.

Dates and times use the selected location's timezone, including fractional-hour offsets, not device time. The first footnote line shows the forecast source/step. The second reads **Time displayed is for selected location · America/New_York** (with the actual IANA zone used for formatting). For a structured nautical response (`TZtype: 'n'`), Windy's `Nautical: Etc/GMT…` display label is normalized to its `Etc/GMT…` IANA timezone before Intl validation; ordinary IANA zones are unchanged. The fallback line is **Time unavailable for selected location · Using UTC**; **Retry timezone** retries only that lookup, without fetching forecasts again. Coordinates are validated and wrapped longitudes normalized before location API calls.

The location line shows Windy's localized reverse-geocoded place name and coordinates. Each new selected location gets exactly two naming lookups at fixed `forcedZoom` values: **5** for state/province/broad orientation and **8** for municipality/locality. No unforced lookup is used, so map zoom does not choose the naming resolution. Zoom 5 prefers repeated `name == region` evidence, otherwise a useful region/name; weak county/district evidence and country-only names are not promoted to broad regions. Zoom 8 supplies a valid non-numeric locality, not its county/district field. With matching country names or codes and no conflicting evidence, the label combines locality and broad region, such as **Seattle, Washington** or **Winnipeg, Manitoba**. Otherwise it falls back to locality + country, broad region alone, country alone, or coordinates only. Conflicting responses are never combined; a safe single-response fallback is used. Components are deduplicated case-insensitively. Both lookups settle before the final label is displayed once; naming never blocks forecasts, and stale/destroyed results are ignored. Coordinates always remain visible. The temporary multi-zoom console probe has been removed.

On desktop/tablet, ordinary map clicks update the forecast while the plugin stays open. Opening Windy's named city/place forecast can replace the desktop right-hand pane; this is normal `rhpane` behavior.

On phones, Windy can initially make either map center (HOME) or its offset crosshair (SEARCH) authoritative. The current external-plugin APIs tested do not expose a reliable synchronous way to distinguish them. Therefore, without valid explicit coordinates passed directly to this plugin's `onopen`, the plugin intentionally waits for the user to move the map. It makes no forecast, timezone or reverse-name requests, and does not change the URL while waiting. Model/view controls remain usable without requesting a location.

While waiting, a half-open panel says **Move the map to choose a forecast location.** Fullscreen says **Drag this panel down halfway, then move the map to choose a forecast location.** These instructions follow actual half-open notifications, including manual sheet dragging, and disappear after selection. The first material user pan activates `pickerDot.getLatLon()` permanently for the mounted lifecycle. Only settled movement requests data; a 0.00001-degree tolerance and layout/resize guards suppress jitter and incidental refreshes. An unavailable picker leaves the plugin waiting or retains its last selected location—never substitutes map center. See [mobile location selection](docs/mobile-location-selection.md).

Mobile remains `fullscreen`, preserving full-height capability and normal dragging. The phone-only, one-shot `rqstHalfOpen` request is verified working on a real phone. It never repeats within the same mounted lifecycle and is cancelled if the plugin closes/destroys before dispatch. Desktop/tablet is unchanged. See [the half-open implementation and verification](docs/mobile-half-open.md).

Reusable diagnostic infrastructure remains in source but is **disabled by default** (`TEMPORARY_TIMEZONE_DIAGNOSTICS = false` in `src/timezoneDiagnostics.ts`). The release candidate shows no private diagnostic panel, accumulates no diagnostic history, and prints no routine plugin console messages. A private troubleshooting build can set the flag to `true` to enable compact phone state/history and gated console output, with at most 12 recent events. Diagnostics do not control selection or half-open behavior. The abandoned inference experiments and multi-zoom naming probe are removed.

## Windy preferences

On mount, the plugin inherits Windy's saved `detailDefault1h` choice (true = Hourly, false = 3-hour) only when `detailRememberLast` is true ("Always open"). Otherwise it starts at 3-hour. `detailDefaultEnabled` does not control this forecast-step decision.

Temperature and dew-point units follow Windy's current °F/°C temperature preference, read from `metrics.temp.metric` once on mount. There is no plugin-local unit toggle. That snapshot stays fixed for the mounted instance, even if Windy's preference changes afterward.

Forecast view changes stay local to the plugin and never modify Windy's saved settings. Later `onopen()` calls preserve the local view and inherited unit snapshot. After destruction, a newly mounted instance reads Windy's settings again.

## Screenshots

The supplied desktop screenshot shows the Hourly view. Additional Daily or fullscreen mobile screenshots can be added after capture.

![Humidity Forecast desktop Hourly view in Windy](src/screenshot.jpg)

## Current status and remaining release steps

Version `0.1.11` is a private (`private: true`) release candidate. It uses fixed-zoom friendly naming and preserves the validated 0.1.10 drag-first selection behavior. The desktop right-hand pane (`desktopUI: 'rhpane'`) has been tested in Windy Developer Mode on Windows. Native-phone testing has confirmed automatic half-open behavior with `mobileUI: 'fullscreen'` and the offset crosshair getter after panning. Diagnostics are disabled by default; broader device/layout coverage remains useful.

Remaining release steps:

- Continue broader device/layout regression testing as needed.
- Review the supplied screenshot and gallery metadata; capture additional screenshots as needed.
- When publication is explicitly authorized, deliberately choose the public/private setting and submit for gallery review.

A manual-only GitHub Actions [publishing workflow](.github/workflows/publish-plugin.yml) is included. It uses `npm ci`, builds the plugin, adds repository/commit metadata, and uploads the archive to Windy using the repository secret `WINDY_API_KEY`. It fails clearly if that secret is missing. It does not change the version or `private` setting. Do not dispatch it without explicit publishing authorization. Keep the plugin focused on humidity, temperature, and dew point.

## Development

Requires Node.js and npm. The existing tests run with Node.js `22.23.2`, which supports importing the TypeScript helpers directly.

```bash
npm install
npm start
```

Then open Windy Developer Mode and load:

```text
https://localhost:9999/plugin.js
```

Windy's local development server uses the certificate supplied by `@windycom/plugin-devtools`, so the browser may require accepting the local certificate once.

### Tests

```bash
node tests/forecast-requests.test.mjs
node tests/weather.test.mjs
npx tsc --noEmit
git diff --check
```

The tests cover forecast resolution changes, cancellation/stale responses, preference snapshots, daily extrema and ordering, timezone boundaries/retries, conservative explicit opening coordinates, drag-first waiting and sheet instructions, layout/jitter guards, mobile movement and listener cleanup, asynchronous place naming, and preservation of forecast values. Native-phone verification remains necessary for actual Windy/Leaflet event ordering.

### Production build

macOS/Linux:

```bash
npm run build
```

Windows:

```powershell
npm run build:win
```

Production files are written to `dist/`; dependencies and build output are ignored by git.

## Data path

The plugin requests Windy's point forecast with both meteogram and sounding data:

- `data.temperature` — air temperature
- `meteogram.dewPoint` — dew point
- `sounding['rh-surface']` — relative humidity

The series are aligned by forecast timestamp before display. Daily selects actual hourly points rather than averages or separately requested daily data.

## License

[MIT](LICENSE) · Copyright (c) 2026 markkn.
