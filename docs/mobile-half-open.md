# Mobile half-open implementation and verification

Investigated against installed `@windycom/plugin-devtools` **3.0.4**. Automatic phone-only initial half-open is verified working on a real phone and remains enabled in the private 0.1.11 release candidate, independently of diagnostics. `mobileUI: 'fullscreen'`, desktop/tablet layout, and subsequent normal dragging remain unchanged.

## Documented support

Windy's [layout guide](https://docs.windy-plugins.com/getting-started/plugin-layouts.html) explicitly supports manually dragging fullscreen external plugins to half height. The [external configuration interface](https://docs.windy-plugins.com/api/interfaces/ExternalPluginConfig.html) has no initial-half-open setting. The inspected opening/lifecycle declarations likewise expose no external-plugin initial-position option.

The [broadcast API](https://docs.windy-plugins.com/api/interfaces/broadcast.BasicBcastTypes.html) distinguishes these events:

| Event | Role | Identifier contract |
| --- | --- | --- |
| `rqstOpen` / `rqstClose` | Open/close request | Explicitly allows external strings |
| `pluginOpened` | Open notification | Allows external strings |
| `rqstHalfOpen` | BottomSlide position request | `keyof Plugins` |
| `pluginHalfOpened` | BottomSlide position notification | `keyof Plugins` |

This narrower contract does **not** establish a runtime rejection. No documented external-plugin half-open example was found.

## Installed declarations and compiler evidence

- `types/client/BottomSlide.d.ts`: constructor `pluginName` is `keyof Plugins`; `setHalfOpen` and `onRqstPluginHalfOpen` are private. There is no public position method to call through the slider instance.
- `types/client/WindowPlugin.d.ts`: the slider instance is protected; no external lifecycle position setter is exposed.
- `types/client/ExternalSveltePlugin.d.ts`: the external host is declared as `SveltePlugin<'windy-external-plugin'>`, with `ident: 'windy-external-plugin'`. That host identifier is included in `Plugins`, but real-phone notifications now show that this plugin's actual slider uses its external name. The experiment does **not** target the generic host identifier.
- An in-memory TypeScript probe verified that a closed `[keyof Plugins, boolean, boolean]` tuple rejects `windy-plugin-humidity-forecast` and accepts `windy-external-plugin`.
- Importantly, direct `bcast.emit('rqstHalfOpen', identifier, true, true)` calls compile for **both** identifiers with the installed generic emitter/typings and current compiler configuration. Thus this repository does not need a cast simply to send the external-name test request. Compiler acceptance is not runtime evidence either; it must not be treated as official support.

The installed devtools runtime (`index.mjs`) validates plugin configuration and rewrites Windy imports to host `W` modules. It neither supplies BottomSlide's runtime implementation nor adds an identifier check to broadcast calls. The decision to handle/ignore an identifier therefore lives in Windy's host-side event listener, whose implementation was not available in the installed package or reviewed public sources. There is no inspected runtime code proving that it rejects external names.

## Examples reviewed

The current [official template](https://github.com/windycom/windy-plugin-template/tree/main/examples), its main component, all seven example components/configurations, and the Foehn chart helper contain no `rqstHalfOpen`, `pluginHalfOpened`, or BottomSlide usage. Public code searches found declarations, not a current external-plugin half-open request example.

The older [external radiosonde plugin](https://github.com/rittels/windy-plugin-radiosonde/blob/main/plugin.html) attaches a legacy `BottomSlide.instance` using its plugin's identifier and overrides drag behavior. This shows historical external-slider integration, but is neither a current Svelte example nor evidence for today's event routing. Its direct slider/drag customization is not adopted here.

## Real-phone runtime evidence

The user observed these actual notifications while opening/manually dragging the external plugin:

```text
pluginOpened: windy-plugin-humidity-forecast
pluginHalfOpened: windy-plugin-humidity-forecast halfOpen=true
```

This established the external slider's notification identifier despite the narrower declared contract. Subsequent native-phone testing confirmed that the programmatic `rqstHalfOpen` request opens this external plugin at half height and that normal dragging remains available. This is runtime verification for the tested phone, not a broader officially documented identifier contract or a guarantee for every device/runtime.

## Implemented phone opening behavior

1. Subscribe on phones only to the documented open/close/half-open notifications. Wait for `pluginOpened` with this plugin's exact external identifier, then await Svelte `tick()` before dispatch.
2. Reserve the request before awaiting, so duplicate open events cannot schedule duplicates. Emit `rqstHalfOpen` with `windy-plugin-humidity-forecast`, `value: true`, and `emit: true` only once per mounted component. Never reassert half height on dragging, map clicks, model/view changes, redraws, or later `onopen()` calls. A newly mounted lifecycle gets a fresh initial request.
3. Check mount/close state after the tick and cancel if this instance closed or was destroyed. Remove listeners on destruction. Exceptions are contained without failing the forecast, and no automatic request retry occurs.
4. Use the installed generic emitter directly: no assertions, `any`, declaration augmentation, forged built-in identifier, or weakened global types.
5. Reusable diagnostics are disabled by default. A private troubleshooting build can enable `TEMPORARY_TIMEZONE_DIAGNOSTICS` to observe dispatch, cancellation/failure, and matching `pluginHalfOpened=true` notifications. The event does not carry a request ID; a later manual half-open event cannot be distinguished from a programmatic result solely by its payload.

The automatic opening behavior no longer awaits its first real-phone verification. Continue regression checks of initial half height and half → full → closed dragging while testing [intentional phone location selection](mobile-location-selection.md), with broader device coverage still useful. No confirmation triggers polling, repeated requests or DOM/CSS workarounds; manual half-height dragging remains available.

The implementation uses the public broadcast mechanism only. It requires no DOM/CSS manipulation, slider-instance access, saved-setting changes or private Windy methods. Half-open is a convenience, not a requirement: manually lowering the panel is equally usable. Before selection, actual `pluginHalfOpened` notifications switch the instruction between **Move the map to choose a forecast location.** and **Drag this panel down halfway, then move the map to choose a forecast location.** Diagnostic helpers remain in source for opt-in private troubleshooting, with UI/history/console output disabled by default.
