# Development guidance

Keep the plugin focused on humidity, temperature, and dew point. Prefer Windy's own APIs and forecast data. Do not add unrelated weather features without an intentional scope change.

## Forecast and preferences

- Use native `step: 1` for Hourly/Daily and `step: 3` for 3-hour. Reuse data between Hourly and Daily; refetch when the required resolution changes.
- Daily displays actual hourly humidity extrema in chronological order, grouped by the forecast location's local calendar day. Preserve timezone fallback and fractional-hour offsets.
- On mount, inherit `detailDefault1h` only when `detailRememberLast === true`; otherwise start at 3-hour. Do not use `detailDefaultEnabled` for this decision.
- Snapshot temperature units from `metrics.temp.metric` once per mount for temperature and dew point. Do not add a plugin-local unit toggle or modify Windy's saved settings.
- Keep view choices local and preserve them, along with the unit snapshot, across `onopen()` calls. Read defaults again only for a new component lifecycle; do not subscribe to preference changes.

## Development rules

- Preserve forecast cancellation, stale-response checks, listener cleanup, and map-click routing.
- Named-place clicks can replace the desktop pane with Windy's normal forecast; this is expected behavior, not a bug to fix.
- Keep changes small and reviewable.
- Do not commit `node_modules/`, `dist/`, credentials, API keys, local paths, or editor-specific files.
- Change version/visibility or publish only when explicitly requested.
- For code changes, run the existing tests, `npm run build`, and `git diff --check`. See README for commands and release/testing status; use source and tests for detailed behavior.
