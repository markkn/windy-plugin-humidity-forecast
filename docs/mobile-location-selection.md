# Intentional phone location selection

The drag-first implementation uses explicit opening coordinates or user-driven
crosshair selection on phones. Desktop/tablet uses click-to-select.

## Why the plugin waits

Real-phone testing found that HOME initially uses map center, while SEARCH can
position its intended location underneath Windy's vertically offset crosshair.
The current external-plugin APIs tested expose no reliable synchronous signal
identifying which location is authoritative. Valid picker coordinates alone do
not establish that the picker is active.

Inspection and runtime testing found no usable initial-location signal in the
current URL/router data, picker-mobile open state or detail state. Selection
therefore does not depend on DOM inspection, screen geometry heuristics,
private component state or undocumented guesses.

## Opening and waiting

Only parameters passed directly to this plugin's `onopen` can initialize a phone
forecast immediately. They must contain their own `lat` and `lon` as finite
numbers or decimal strings, with latitude in range; wrapped longitudes use the
existing normalization. Only optional string `source`, `name` and `poiType`
metadata are also accepted. Unknown fields, viewport-shaped objects, nested
coordinate candidates, URL strings and `lng`-only aliases are rejected rather
than guessed. Source values are not used to infer HOME or SEARCH.

Without such coordinates, selected location stays unset. No forecast, timezone,
reverse-name request or plugin URL write occurs. Controls remain available.
The normal waiting instruction follows `pluginHalfOpened` for this plugin:

- Half-open: **Move the map to choose a forecast location.**
- Fullscreen: **Drag this panel down halfway, then move the map to choose a forecast location.**

Automatic half-open is a convenience only. Manually lowering the panel works
equally well; returning to fullscreen updates the instruction. See
[Windy integration](plugin-integration.md#initial-phone-half-height) for the panel
event handling and runtime support. No misleading coordinates, empty forecast
table or request-error message is shown while waiting.

## First movement and ongoing selection

Mount records map-center and picker baselines without selecting either. A public
Leaflet `dragstart` marks a user pan; its settled `moveend` must change map center
by more than the existing 0.00001-degree coordinate tolerance before activating
picker mode. Initial layout and non-drag moveends cannot activate selection.
Public `resize` notifications and map-size changes rebaseline without fetching;
picker-only changes and tiny jitter do not activate selection either.

After activation, valid normalized `pickerDot.getLatLon()` coordinates select the
forecast, update the plugin URL and start normal forecast/timezone/name lookups.
Picker selection remains authoritative until component destruction, including
across later `onopen` calls. Duplicate coordinates do not refetch. Unavailable
picker coordinates preserve the previous selection or leave the plugin waiting,
never select map center, and do not crash.

This deliberately conservative implementation may require another pan if a
resize overlaps the first drag or a valid map baseline is unavailable. Only
settled movement fetches data. Cancellation and stale-result guards remain intact.
All map and broadcast listeners are removed on destroy.

## Regression verification

Optional troubleshooting diagnostics are described in
[Windy integration](plugin-integration.md#optional-troubleshooting-and-verification).

Test HOME and SEARCH without dragging: both should wait with no location
requests unless explicit plugin coordinates were provided. Test automatic and
manual half-open, returning to fullscreen, resizing and jitter before selection.
Then pan once and verify that selected coordinates match pickerDot rather than
map center, subsequent pans follow the picker, and sheet changes alone do not
restart forecasts.
