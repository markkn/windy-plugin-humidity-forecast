# Windy integration

## Preferences and lifecycle

On mount, the plugin inherits Windy's saved `detailDefault1h` choice only when
`detailRememberLast === true` ("Always open"):

- `detailDefault1h === true`: Hourly
- Otherwise: 3-hour

When saved inheritance is disabled, the plugin starts at 3-hour.
`detailDefaultEnabled` is not used for this decision.

Temperature and dew-point units are read from `metrics.temp.metric` once per
mount. There is no plugin-local unit toggle. The unit snapshot remains fixed even
if Windy's preference changes while the component is mounted.

View changes stay local and never modify Windy's settings. Later `onopen()`
calls preserve the local view and unit snapshot; a new component lifecycle reads
the preferences again. Listeners and in-flight requests are cleaned up on destroy.

## Layout and desktop interaction

Desktop uses `desktopUI: 'rhpane'`; phone layout retains
`mobileUI: 'fullscreen'` and normal BottomSlide dragging. Desktop/tablet map
clicks move the forecast location. Opening Windy's named-place forecast can
replace the desktop pane; that is expected Windy behavior.

Phone selection is intentionally drag-first unless explicit opening coordinates
are supplied. See [mobile location selection](mobile-location-selection.md).

## Initial phone half-height

Automatic half-open has been verified in the native phone app. It is a convenience,
not a selection requirement: manually lowering the panel works equally well.
Support is not guaranteed across every Windy runtime/device, so broader layout
testing remains welcome.

The plugin listens for `pluginOpened` with its external identifier,
`windy-plugin-humidity-forecast`, then awaits Svelte `tick()` and emits:

```ts
bcast.emit('rqstHalfOpen', 'windy-plugin-humidity-forecast', true, true);
```

The request is reserved before awaiting, preventing duplicate scheduling. It is
sent only once per mounted component, on phones only. Close/destruction checks
cancel pending dispatch. Later `onopen()` calls, map movement, model/view changes
and manual dragging do not reassert half height. Exceptions do not fail the
forecast, and no automatic request retry or polling occurs.

Actual `pluginHalfOpened` notifications drive the waiting instruction and sheet
state. A missing automatic confirmation leaves manual dragging available. These
notifications contain no request ID, so their payload alone cannot distinguish
an automatic half-open from a later manual one.

## API contract and runtime evidence

The declaration evidence here is from `@windycom/plugin-devtools` **3.0.4**.
Windy's [layout guide](https://docs.windy-plugins.com/getting-started/plugin-layouts.html)
supports manual half-height dragging for fullscreen external plugins. The
[configuration interface](https://docs.windy-plugins.com/api/interfaces/ExternalPluginConfig.html)
has no initial-position option.

The [broadcast API](https://docs.windy-plugins.com/api/interfaces/broadcast.BasicBcastTypes.html)
allows external strings for `rqstOpen`, `rqstClose` and `pluginOpened`, but
declares `rqstHalfOpen` and `pluginHalfOpened` with `keyof Plugins`.

Relevant installed declarations:

- `BottomSlide.d.ts`: constructor identifier is `keyof Plugins`; position
  methods are private.
- `WindowPlugin.d.ts`: the slider instance is protected; no public external
  lifecycle position setter is exposed.
- `ExternalSveltePlugin.d.ts`: the generic host identifier is
  `windy-external-plugin`, which is not this plugin's observed slider identifier.

A closed `[keyof Plugins, boolean, boolean]` tuple rejects the external plugin
name. However, the installed generic broadcast emitter accepts the direct call
above with the repository's compiler configuration, without casts, `any`,
declaration augmentation or weakened global types. Compiler acceptance is not
itself an official external-identifier guarantee.

The installed devtools validates configuration and maps imports to host `W`
modules; it does not provide the host BottomSlide implementation or impose an
identifier check on broadcast calls. Native-phone runtime evidence supplies the
additional confirmation:

```text
pluginOpened: windy-plugin-humidity-forecast
pluginHalfOpened: windy-plugin-humidity-forecast halfOpen=true
```

Both programmatic half-opening and continued manual dragging have been verified.
The implementation uses the public event mechanism, with no slider-instance
access, DOM/CSS manipulation, saved-setting writes or private Windy methods.

## Optional troubleshooting and verification

Reusable diagnostics are disabled by default. Normal builds show no diagnostic
panel, accumulate no diagnostic history and produce no routine plugin console
output.

For troubleshooting, set `TEMPORARY_TIMEZONE_DIAGNOSTICS` to `true` in
`src/timezoneDiagnostics.ts` and rebuild. It enables compact awaiting state,
mount baselines, movement decisions, sheet state, half-open request status and
selected coordinates, with history bounded to 12 events. It does not change
selection or half-open behavior. Keep it `false` for normal builds.

Regression tests exercise preferences, lifecycle cleanup, cancellation, request
dispatch and diagnostics gating. Device testing complements them for real
Windy/Leaflet event ordering. Test half → full → closed dragging, waiting
instructions, and initial selection on multiple layouts. A resize overlapping
the first pan can require another pan; see the movement guards in the mobile doc.
