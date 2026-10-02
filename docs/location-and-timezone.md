# Location names and timezones

Naming and timezone lookup use the selected forecast coordinates. Friendly naming
does not block forecast loading. Coordinates remain visible even when a friendly
name is available.

## Fixed-zoom friendly names

Each selected location requests exactly two Windy `@windy/reverseName` lookups:

- **Forced zoom 5:** broad region/state/province
- **Forced zoom 8:** municipality/locality

No unforced lookup is used, so the label for the same coordinates is independent
of the current map zoom. There is no external geocoder.

Only useful scalar name, region, country and country-code fields are considered.
Empty/numeric/coordinate-looking names are rejected, as are names explicitly
marked `nameValid === false`. Components are deduplicated case-insensitively.

### Broad region

Zoom 5 supplies broad orientation. Its strongest evidence is a valid name and
region that match case-insensitively, such as **Washington / Washington**.
Otherwise a useful zoom-5 region, then name, may provide orientation; generic
county/district/parish/borough components are conservatively excluded from that
fallback. Country duplicates are excluded.

The zoom-8 county/district field is not treated as a state/province.

### Locality and composition

Zoom 8 supplies a useful locality name that does not merely duplicate the country
or broad region. For example, zoom 5 **Washington / Washington / United States**
and zoom 8 **Seattle / King County / United States** produce **Seattle, Washington**.

The preferred output is:

1. Locality + broad region
2. Locality + country
3. Broad region alone
4. Country alone
5. Coordinates only

Combining locality and broad region requires matching country names or country
codes, with no conflicting country evidence. If countries conflict, use the fine
locality with its own country rather than mixing responses; without a fine
locality, retain safe broad orientation or country information. Unknown country
agreement does not justify cross-response composition.

Both lookups complete or fail before the final name is assigned once. Failed
lookups leave whatever safe information remains; if both fail, the friendly name
is empty and coordinates are shown alone. Request identity and selected-location
checks prevent older results from overwriting a newer location.

## Selected-location time

`getTimezoneInfo` resolves the forecast location's timezone. Map/route coordinates
are normalized first, including wrapped longitudes. The resulting timezone is
validated with `Intl.DateTimeFormat` and used for dates, times and Daily calendar-day
grouping, not the browser/device timezone. Fractional-hour offsets are preserved.

The footnote keeps source/step on its first line and time information on a second:

```text
Windy forecast data · hourly step
Time displayed is for selected location · America/New_York
```

The actual IANA zone is shown rather than a single EST/EDT-style abbreviation.

### Nautical normalization

For a structured Windy response with `TZtype === 'n'`, a nautical display name
such as `Nautical: Etc/GMT+6` is normalized to `Etc/GMT+6` before Intl validation.
Ordinary zones such as `America/New_York` are unchanged. Arbitrary display prefixes
are not stripped, and genuinely invalid zones still fail validation.

### Retry and UTC fallback

If resolution is unavailable, UTC is the final fallback and the second footnote
line reads:

```text
Time unavailable for selected location · Using UTC
```

The **Retry timezone** action retries only timezone lookup without refetching the
weather forecast. Abort-state and stale-result checks prevent superseded lookups
from affecting another location.
