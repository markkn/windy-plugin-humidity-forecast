# Forecast behavior

## Views and models

All views use Windy's 5-day point-forecast data and support ECMWF, GFS and ICON.
The table keeps the same Time, Temp, Humidity and Dew pt. rows.

- **Hourly:** every available point from native `step: 1`.
- **3-hour:** every returned point from native `step: 3`, without client-side sampling.
- **Daily:** humidity extrema selected from native hourly `step: 1` data, not averages or a separately requested daily forecast.

View selection changes the displayed columns. Model selection changes the forecast source.

## Daily extrema

Points are grouped by the selected location's local calendar day using the resolved
timezone. For each day, Daily selects the actual hourly points with the highest
and lowest relative humidity. Temperature and dew point come from those same
points; forecast values are not altered.

Columns are ordered by timestamp, not High-first or Low-first. The header's
**High** or **Low** label describes humidity, while the Time row shows when it
occurred. Timestamp ordering remains correct across repeated hours at daylight
saving transitions.

- Tied extrema use the earliest matching point.
- Missing or nonfinite humidity is excluded from selection.
- Days with no valid humidity points are omitted.
- A day with one valid point or constant humidity has one **High/Low** column,
  avoiding duplicate extrema.
- The first and last days may cover only part of a calendar day; extrema reflect
  only the available forecast points.

The raw transformed forecast remains intact. Display datasets are derived from it,
so switching between Hourly and Daily does not discard hourly points.

## Requests and lifecycle

Hourly and Daily share loaded data or an ongoing hourly request when location and
model are unchanged. Switching into or out of 3-hour requests the required native
resolution. Changing model or forecast location also requests fresh data.

Superseded forecast requests are aborted, and request identity checks prevent stale
responses from replacing current data. Destruction cancels in-flight work. On a
phone awaiting its first location, model/view changes make no location requests.

Forecast and timezone lookups run concurrently. Friendly-name lookup is independent;
name failure does not block the table. A manual timezone retry does not refetch the
forecast. See [location names and timezones](location-and-timezone.md).

## Data sources

The point-forecast request includes meteogram and sounding data:

- `data.temperature` — air temperature
- `meteogram.dewPoint` — dew point
- `sounding['rh-surface']` — relative humidity

Series are aligned by forecast timestamp before display. The plugin uses Windy's
own APIs and data rather than an external weather service.

Regression tests cover resolution changes, request reuse/cancellation and stale
responses, extrema/ties/missing data, timezone boundaries, chronological ordering
and preservation of forecast values.
