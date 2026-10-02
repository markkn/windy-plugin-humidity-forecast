<div class="plugin__mobile-header">{title}</div>

<section class="plugin__content humidity-plugin">
  <div
    class="plugin__title plugin__title--chevron-back"
    role="button"
    tabindex="0"
    on:click={openMenu}
    on:keydown={handleTitleKeydown}
  >
    {title}
  </div>

  <div class="toolbar">
    <label>
      <span>Model</span>
      <select bind:value={model} on:change={refresh}>
        <option value="ecmwf">ECMWF</option>
        <option value="gfs">GFS</option>
        <option value="icon">ICON</option>
      </select>
    </label>

    <div class="view-toggle" role="group" aria-label="Forecast view">
      <button class:active={view === 'hourly'} aria-pressed={view === 'hourly'} on:click={() => changeView('hourly')}>Hourly</button>
      <button class:active={view === '3-hour'} aria-pressed={view === '3-hour'} on:click={() => changeView('3-hour')}>3-hour</button>
      <button class:active={view === 'daily'} aria-pressed={view === 'daily'} on:click={() => changeView('daily')}>Daily</button>
    </div>

  </div>

  {#if selectedLocation || isDesktopOrTablet}
  <div class="location-line">
    <strong>{locationLabel}</strong>
    {#if isDesktopOrTablet}
      <span>Click the map to move this forecast.</span>
    {/if}
  </div>
  {/if}

  {#if awaitingLocation}
    <div class="state">{waitingMessage}</div>
  {:else if status === 'loading'}
    <div class="state">Loading {view === '3-hour' ? '3-hour' : 'hourly'} forecast…</div>
  {:else if status === 'error'}
    <div class="state error">
      <div>{errorMessage}</div>
      <button on:click={refresh}>Retry</button>
    </div>
  {:else if points.length === 0}
    <div class="state">No forecast data returned for this location/model.</div>
  {:else if displayPoints.length === 0}
    <div class="state">No valid humidity data available for daily highs/lows.</div>
  {:else}
    <div
      class="forecast-wrap"
      role="region"
      aria-label={`${viewLabel} humidity forecast table`}
      use:enableKeyboardScrolling
    >
      <div class="forecast-grid" class:daily={view === 'daily'} style={`--cols:${displayPoints.length}`}>
        <div class="label header-label">Date</div>
        {#each displayPoints as point, i}
          <div class="cell date-cell">
            {#if point.humidityExtreme}
              <span>{formatDay(point.timestamp, timeZone)} {point.humidityExtreme}</span>
            {:else}
              {isNewDay(i, displayPoints, timeZone) ? formatDay(point.timestamp, timeZone) : ''}
            {/if}
          </div>
        {/each}

        <div class="label">Time</div>
        {#each displayPoints as point}
          <div class="cell time-cell">{formatHour(point.timestamp, timeZone)}</div>
        {/each}

        <div class="label">Temp</div>
        {#each displayPoints as point}
          <div class="cell temp-cell">{formatTemperature(point.temperatureC, temperatureUnit)}</div>
        {/each}

        <div class="label humidity-label">Humidity</div>
        {#each displayPoints as point}
          <div class="cell humidity-cell" style={`--rh:${point.humidityPercent ?? 0}%`}>
            {formatHumidity(point.humidityPercent)}
          </div>
        {/each}

        <div class="label">Dew pt.</div>
        {#each displayPoints as point}
          <div class="cell dew-cell">{formatTemperature(point.dewPointC, temperatureUnit)}</div>
        {/each}
      </div>
    </div>

    <div class="footnote">
      <div>Windy forecast data · {view === 'hourly' ? 'hourly step' : view === '3-hour' ? '3-hour step' : 'daily humidity highs/lows'}</div>
      <div>
        {#if timeZoneFallback}
          Time unavailable for selected location · Using UTC
          <button on:click={retryTimeZone} disabled={timeZoneRetrying}>{timeZoneRetrying ? 'Retrying timezone…' : 'Retry timezone'}</button>
        {:else}
          Time displayed is for selected location · {timeZone}
        {/if}
      </div>
      {#if view === 'daily'}
        <div>High/Low = one valid point or equal humidity. Days without valid humidity are omitted.</div>
      {/if}
    </div>
  {/if}

  <!-- Opt-in private diagnostics; disabled by default, helpers retained. -->
  {#if TEMPORARY_TIMEZONE_DIAGNOSTICS && !isDesktopOrTablet && timezoneDebugLines.length > 0}
    <details class="timezone-debug">
      <summary>Private phone diagnostics</summary>
      <textarea aria-label="Private phone diagnostics" readonly rows="8" spellcheck="false" value={timezoneDebugText}></textarea>
    </details>
  {/if}
</section>

<script lang="ts">
  import bcast from '@windy/broadcast';
  import { getPointForecastData, getTimezoneInfo } from '@windy/fetch';
  import { setUrl } from '@windy/location';
  import { map } from '@windy/map';
  import metrics from '@windy/metrics';
  import * as picker from '@windy/picker';
  import { get as getReverseName } from '@windy/reverseName';
  import { isDesktopOrTablet } from '@windy/rootScope';
  import { singleclick } from '@windy/singleclick';
  import store from '@windy/store';
  import { onDestroy, onMount, tick } from 'svelte';
  import type { LatLon } from '@windy/interfaces';

  import config from './pluginConfig';
  import { formatLocationName, parseLatLon, sameLocation, explicitPluginLocation } from './location';
  import { normalizeTimeZoneName } from './timezone';
  // Optional troubleshooting diagnostics are independent of behavior.
  import {
    TEMPORARY_TIMEZONE_DIAGNOSTICS, MAX_TIMEZONE_DEBUG_LINES, appendTimezoneDebug,
    rawCoordinateSummary, timezoneErrorSummary,
  } from './timezoneDiagnostics';
  import {
    dayKey,
    deriveForecastView,
    formatDay,
    formatHour,
    formatHumidity,
    formatTemperature,
    forecastStepForView,
    transformForecast,
    type ForecastPayload,
    type ForecastPoint,
    type ForecastView,
    type Model,
    type TemperatureUnit,
  } from './weather';

  const { title, name } = config;
  const BROAD_REGION_ZOOM = 5;
  const LOCALITY_ZOOM = 8;

  const openMenu = () => bcast.emit('rqstOpen', 'menu');

  const handleTitleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
    }
  };

  const enableKeyboardScrolling = (node: HTMLDivElement) => {
    // Keep the labeled region in the tab order for native arrow-key scrolling.
    // Svelte 4 rejects declarative tabindex on this valid non-widget region.
    node.tabIndex = 0;
  };

  let model: Model = 'ecmwf';
  let temperatureUnit: TemperatureUnit = 'F';
  let view: ForecastView = 'hourly';
  let points: ForecastPoint[] = [];
  let selectedLocation: LatLon | null = null;
  let locationName = '';
  let nameLocation: LatLon | null = null;
  let nameRequestId = 0;
  let timeZone = 'UTC';
  let timeZoneFallback = true;
  let timeZoneRetrying = false;
  let status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let errorMessage = '';
  let mounted = false;
  let requestId = 0;
  let abortController: AbortController | null = null;
  let halfOpenRequestStatus: 'not requested' | 'scheduled' | 'sent' | 'cancelled' | 'failed' = 'not requested';
  let halfOpenConfirmed = false;
  let openingClosed = false;
  let panelHalfOpen = false;
  let phoneMapMoved = false;
  let phoneDragPending = false;
  let pendingPhoneRoute: LatLon | null = null;
  let initialPhoneMapCenter: LatLon | null = null;
  let initialPhonePickerLocation: LatLon | null = null;
  let lastPhoneMapCenter: LatLon | null = null;
  let lastPhonePickerLocation: LatLon | null = null;
  let lastPhoneMapSize = '';
  let lastMovement = 'not detected';
  let timezoneDebugLines: string[] = [];
  const recordTimezoneDebug = (line: string) => {
    if (TEMPORARY_TIMEZONE_DIAGNOSTICS && mounted && !isDesktopOrTablet) {
      timezoneDebugLines = appendTimezoneDebug(timezoneDebugLines, line);
      console.info('[humidity] phone diagnostic', line);
    }
  };
  const requestInitialHalfOpen = async () => {
    if (!mounted || isDesktopOrTablet || halfOpenRequestStatus !== 'not requested') return;
    // Claim this lifecycle's one request before awaiting, so duplicate open events
    // cannot schedule it twice. Later user drags and onopen calls never reset it.
    halfOpenRequestStatus = 'scheduled';
    try {
      await tick();
      if (!mounted || openingClosed) {
        halfOpenRequestStatus = 'cancelled';
        recordTimezoneDebug('rqstHalfOpen cancelled: plugin closed before initial request');
        return;
      }
      halfOpenRequestStatus = 'sent';
      // Set sent before emit for synchronous confirmation; logging is opt-in.
      recordTimezoneDebug(`rqstHalfOpen sent: ${name} value=true emit=true`);
      bcast.emit('rqstHalfOpen', name, true, true);
    } catch (error) {
      halfOpenRequestStatus = 'failed';
      recordTimezoneDebug(`rqstHalfOpen failed: ${timezoneErrorSummary(error)}`);
    }
  };

  const recordHalfOpen = (ident: string, halfOpen: boolean) => {
    if (!mounted || ident !== name) return;
    panelHalfOpen = halfOpen;
    if (halfOpen && halfOpenRequestStatus === 'sent') halfOpenConfirmed = true;
    recordTimezoneDebug('pluginHalfOpened: halfOpen=' + halfOpen);
  };
  const recordPluginOpen = (ident: string) => {
    if (ident !== name || !mounted) return;
    if (halfOpenRequestStatus === 'not requested') openingClosed = false;
    recordTimezoneDebug('pluginOpened');
    void requestInitialHalfOpen();
  };
  const recordPluginClose = (ident: string) => {
    if (ident !== name) return;
    openingClosed = true;
    recordTimezoneDebug('pluginClosed');
  };
  $: awaitingLocation = !isDesktopOrTablet && !selectedLocation;
  $: waitingMessage = panelHalfOpen
    ? 'Move the map to choose a forecast location.'
    : 'Drag this panel down halfway, then move the map to choose a forecast location.';
  $: timezoneDebugText = TEMPORARY_TIMEZONE_DIAGNOSTICS ? [
    'Awaiting location: ' + awaitingLocation + '; picker movement mode: ' + phoneMapMoved,
    'Map-center baseline: ' + rawCoordinateSummary(initialPhoneMapCenter),
    'PickerDot baseline: ' + rawCoordinateSummary(initialPhonePickerLocation),
    'Last movement: ' + lastMovement,
    'Panel state: ' + (panelHalfOpen ? 'half-open' : 'fullscreen'),
    'Half-open request: ' + halfOpenRequestStatus + '; confirmation received: ' + halfOpenConfirmed,
    'Selected: ' + rawCoordinateSummary(selectedLocation),
    'Recent events (last ' + MAX_TIMEZONE_DEBUG_LINES + '):',
    ...timezoneDebugLines,
  ].join('\n') : '';

  // Keep previous-resolution data out of the display while its replacement loads.
  $: displayPoints = status === 'ready' ? deriveForecastView(points, view, timeZone) : [];
  $: viewLabel = view === 'hourly' ? 'Hourly' : view === '3-hour' ? '3-hour' : 'Daily';

  $: locationLabel = selectedLocation
    ? `${locationName ? `${locationName} · ` : ''}${selectedLocation.lat.toFixed(3)}, ${selectedLocation.lon.toFixed(3)}`
    : isDesktopOrTablet ? 'Map center' : 'No forecast location selected';

  const mapCenter = (): LatLon | null => parseLatLon(map.getCenter());

  const phoneLocation = (): LatLon | null => {
    try {
      const location = parseLatLon(picker?.pickerDot?.getLatLon?.());
      if (!location) recordTimezoneDebug('Picker unavailable/invalid; retaining selected location or waiting');
      return location;
    } catch (error) {
      recordTimezoneDebug('Picker unavailable: ' + timezoneErrorSummary(error));
      return null;
    }
  };

  const phoneMapCenter = (): LatLon | null => {
    try { return mapCenter(); } catch { return null; }
  };
  const phoneMapSize = (): string => {
    try {
      const { x, y } = map.getSize();
      return Number.isFinite(x) && Number.isFinite(y) ? x + ',' + y : '';
    } catch { return ''; }
  };
  const handleMapResize = () => {
    if (!mounted || isDesktopOrTablet) return;
    // Public Leaflet resize notifications establish a new layout baseline only.
    lastPhoneMapCenter = phoneMapCenter();
    lastPhonePickerLocation = phoneLocation();
    lastPhoneMapSize = phoneMapSize();
    phoneDragPending = false;
    lastMovement = 'resize ignored';
    recordTimezoneDebug(lastMovement);
  };

  const handleMapDragStart = () => {
    if (!mounted || isDesktopOrTablet) return;
    phoneDragPending = true;
    if (!phoneMapMoved) {
      lastPhoneMapCenter = phoneMapCenter() ?? lastPhoneMapCenter;
      lastPhonePickerLocation = phoneLocation();
      lastPhoneMapSize = phoneMapSize();
    }
    recordTimezoneDebug('Map drag started');
  };

  const setLocation = (latLon: LatLon) => {
    const location = parseLatLon(latLon);
    if (!location) return;
    selectedLocation = location;
    if (mounted) void refresh();
  };

  const resolveLocationName = async (location: LatLon) => {
    if (nameLocation?.lat === location.lat && nameLocation.lon === location.lon) return;
    nameLocation = { ...location };
    locationName = '';
    const currentRequest = ++nameRequestId;
    // Fixed zooms are independent of the user's map zoom. Settle both before
    // publishing once; either lookup can fail without discarding the other.
    const [broad, locality] = await Promise.allSettled(
      [BROAD_REGION_ZOOM, LOCALITY_ZOOM].map(async zoom => getReverseName(location, zoom)),
    );
    if (!mounted || currentRequest !== nameRequestId) return;
    locationName = formatLocationName(
      broad.status === 'fulfilled' ? broad.value : undefined,
      locality.status === 'fulfilled' ? locality.value : undefined,
    );
  };

  const resolveTimeZone = async (latLon: LatLon, signal: AbortSignal): Promise<string | null> => {
    try {
      const response = await getTimezoneInfo(latLon, new Date().toISOString());
      if (signal.aborted) return null;
      const name = normalizeTimeZoneName(response.data);
      if (!name) return null;
      return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
    } catch {
      return null;
    }
  };

  const retryTimeZone = async () => {
    if (!mounted || status !== 'ready' || !selectedLocation || !abortController || timeZoneRetrying) return;
    const currentRequest = requestId;
    const signal = abortController.signal;
    timeZoneRetrying = true;
    const zone = await resolveTimeZone(selectedLocation, signal);
    if (signal.aborted || currentRequest !== requestId) return;
    timeZoneRetrying = false;
    timeZone = zone ?? 'UTC';
    timeZoneFallback = zone === null;
  };

  const refresh = async () => {
    if (!mounted || !isDesktopOrTablet && !selectedLocation) return;
    const location = selectedLocation ?? (isDesktopOrTablet ? mapCenter() : null);
    selectedLocation = location;

    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    const currentRequest = ++requestId;
    timeZoneRetrying = false;

    if (!location) {
      points = [];
      status = isDesktopOrTablet ? 'error' : 'idle';
      errorMessage = isDesktopOrTablet ? 'Forecast location coordinates are unavailable.' : '';
      return;
    }

    // Independent of forecast/timezone fetching; never holds up the forecast table.
    void resolveLocationName(location);

    status = 'loading';
    errorMessage = '';

    try {
      const [forecast, zone] = await Promise.all([
        getPointForecastData(
          model,
          {
            lat: location.lat,
            lon: location.lon,
            days: 5,
            step: forecastStepForView(view),
            source: 'detail',
          },
          {
            header: true,
            meteogram: true,
            sounding: true,
          },
          { abortSignal: controller.signal },
        ),
        resolveTimeZone(location, controller.signal),
      ]);

      if (controller.signal.aborted || currentRequest !== requestId) return;

      timeZone = zone ?? 'UTC';
      timeZoneFallback = zone === null;
      points = transformForecast(forecast.data as ForecastPayload);
      status = 'ready';
    } catch (error) {
      if (controller.signal.aborted || currentRequest !== requestId) return;
      points = [];
      status = 'error';
      errorMessage = error instanceof Error ? error.message : 'Unable to load forecast data.';
    }
  };

  const changeView = (nextView: ForecastView) => {
    const previousStep = forecastStepForView(view);
    view = nextView;
    // Hourly and Daily share loaded data and any in-flight hourly request.
    if (mounted && forecastStepForView(view) !== previousStep) void refresh();
  };

  const handleMapClick = (latLon: LatLon) => {
    if (!mounted || !isDesktopOrTablet) return;
    const location = parseLatLon(latLon);
    if (!location) return;
    setLocation(location);
    setUrl(name, location);
  };

  const handleMapMoveEnd = () => {
    if (!mounted || isDesktopOrTablet) return;
    const center = phoneMapCenter();
    const dot = phoneLocation();
    const size = phoneMapSize();
    const userDrag = phoneDragPending;
    phoneDragPending = false;
    // Leaflet can emit moveend before resize. Size changes are layout events,
    // not selection; rebaseline both signals without fetching anything.
    if (size && lastPhoneMapSize && size !== lastPhoneMapSize) {
      handleMapResize();
      return;
    }
    if (!phoneMapMoved && !userDrag) {
      lastPhoneMapCenter = center ?? lastPhoneMapCenter;
      lastPhonePickerLocation = dot ?? lastPhonePickerLocation;
      lastPhoneMapSize = size;
      lastMovement = 'non-drag/layout moveend ignored';
      recordTimezoneDebug(lastMovement);
      return;
    }
    // An unavailable initial center is not evidence of movement. Wait for a
    // valid baseline and a subsequent real change, rather than guessing.
    if (!lastPhoneMapCenter && center) {
      lastPhoneMapCenter = center;
      lastPhonePickerLocation = dot;
      lastPhoneMapSize = size;
      lastMovement = 'baseline established; no movement selected';
      recordTimezoneDebug(lastMovement);
      return;
    }
    const centerChanged = !!center && !!lastPhoneMapCenter && !sameLocation(center, lastPhoneMapCenter);
    const pickerChanged = !!dot && !!lastPhonePickerLocation && !sameLocation(dot, lastPhonePickerLocation);
    lastMovement = 'center changed=' + centerChanged + '; picker changed=' + pickerChanged;
    recordTimezoneDebug('moveend: ' + lastMovement);
    // Before activation, a picker-only change could be layout/zoom rather than
    // user movement. It must not select the initially ambiguous crosshair.
    if (!phoneMapMoved && !centerChanged) return;
    if (centerChanged) phoneMapMoved = true;
    if (centerChanged || pickerChanged) {
      lastPhoneMapCenter = center ?? lastPhoneMapCenter;
      lastPhonePickerLocation = dot ?? lastPhonePickerLocation;
      lastPhoneMapSize = size;
    }
    if (!dot || sameLocation(dot, selectedLocation)) return;
    setLocation(dot);
    setUrl(name, dot);
    recordTimezoneDebug('Selected picker after movement: ' + rawCoordinateSummary(dot));
  };

  const isNewDay = (index: number, columns: ForecastPoint[], zone: string): boolean =>
    index === 0 || dayKey(columns[index].timestamp, zone) !== dayKey(columns[index - 1].timestamp, zone);

  export const onopen = (params: unknown) => {
    const parsed = isDesktopOrTablet ? parseLatLon(params) : explicitPluginLocation(params);
    if (isDesktopOrTablet) {
      if (parsed) setLocation(parsed);
      return;
    }
    // Only this plugin's direct opening parameters are explicit evidence.
    // After movement, route echoes/reopens never override the active crosshair.
    if (phoneMapMoved) return;
    if (!mounted) {
      pendingPhoneRoute = parsed;
      return;
    }
    if (parsed && !sameLocation(parsed, selectedLocation)) setLocation(parsed);
    recordTimezoneDebug(parsed ? 'Explicit plugin opening accepted' : 'No explicit location; awaiting movement if unset');
  };

  onMount(() => {
    // Snapshot Windy's current defaults once per component lifecycle.
    // Local view choices and the inherited unit snapshot survive onopen calls.
    const detailDefault1h = store.get('detailDefault1h');
    const detailRememberLast = store.get('detailRememberLast');
    // Inherit Windy's saved 1h/3h choice only when "Always open" is enabled.
    view = detailRememberLast === true && detailDefault1h === true ? 'hourly' : '3-hour';
    const currentTemperatureMetric = metrics.temp.metric;
    if (currentTemperatureMetric === '°F' || currentTemperatureMetric === '°C') {
      temperatureUnit = currentTemperatureMetric === '°F' ? 'F' : 'C';
    }
    mounted = true;
    if (!isDesktopOrTablet) {
      bcast.on('pluginOpened', recordPluginOpen);
      bcast.on('pluginHalfOpened', recordHalfOpen);
      bcast.on('pluginClosed', recordPluginClose);
    }
    if (isDesktopOrTablet) {
      singleclick.on(name, handleMapClick);
      if (!selectedLocation) selectedLocation = mapCenter();
    } else {
      initialPhoneMapCenter = lastPhoneMapCenter = phoneMapCenter();
      initialPhonePickerLocation = lastPhonePickerLocation = phoneLocation();
      lastPhoneMapSize = phoneMapSize();
      // Baselines are observations, not selected-location candidates.
      selectedLocation = pendingPhoneRoute;
      recordTimezoneDebug(selectedLocation ? 'Mount: explicit plugin location accepted' : 'Mount: awaiting map movement');
      map.on('moveend', handleMapMoveEnd);
      map.on('resize', handleMapResize);
      map.on('dragstart', handleMapDragStart);
      if (selectedLocation) setUrl(name, selectedLocation);
    }
    if (isDesktopOrTablet || selectedLocation) void refresh();
  });

  onDestroy(() => {
    mounted = false;
    abortController?.abort();
    if (isDesktopOrTablet) singleclick.off(name, handleMapClick);
    else {
      map.off('moveend', handleMapMoveEnd);
      map.off('resize', handleMapResize);
      map.off('dragstart', handleMapDragStart);
      bcast.off('pluginOpened', recordPluginOpen);
      bcast.off('pluginHalfOpened', recordHalfOpen);
      bcast.off('pluginClosed', recordPluginClose);
    }
  });
</script>

<style lang="less">
  .humidity-plugin {
    padding-bottom: 18px;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    justify-content: space-between;
    gap: 12px;
    margin: 10px 0 8px;
  }

  .toolbar label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }

  .toolbar select,
  .view-toggle button,
  .state button,
  .footnote button {
    border: 1px solid rgba(127, 127, 127, 0.45);
    border-radius: 5px;
    background: rgba(127, 127, 127, 0.12);
    color: inherit;
    padding: 6px 9px;
  }

  .view-toggle {
    display: flex;
    gap: 4px;
  }

  .toolbar select option {
    // Use a matching native menu palette instead of inheriting the pane's text color.
    background: Canvas;
    color: CanvasText;
  }

  .view-toggle button.active {
    font-weight: 700;
    outline: 2px solid rgba(127, 127, 127, 0.35);
  }

  .location-line {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    align-items: baseline;
    margin-bottom: 10px;
    font-size: 12px;
    opacity: 0.9;
  }

  .location-line span,
  .footnote {
    opacity: 0.7;
  }

  // Optional private-test diagnostic block; no changes to Windy's sheet/layout.
  .timezone-debug {
    margin-top: 10px;
    font-size: 11px;
  }

  .timezone-debug textarea {
    box-sizing: border-box;
    width: 100%;
    margin-top: 5px;
    padding: 6px;
    background: transparent;
    color: inherit;
    border: 1px solid rgba(127, 127, 127, 0.45);
    border-radius: 5px;
    font: 11px/1.4 monospace;
  }

  .state {
    padding: 22px 4px;
  }

  .state.error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .forecast-wrap {
    width: 100%;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    border: 1px solid rgba(127, 127, 127, 0.25);
    border-radius: 6px;
  }

  .forecast-grid {
    display: grid;
    grid-template-columns: 76px repeat(var(--cols), 58px);
    width: max-content;
    min-width: 100%;
  }

  .forecast-grid.daily {
    grid-template-columns: 76px repeat(var(--cols), max-content);
  }

  .label,
  .cell {
    min-height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-right: 1px solid rgba(127, 127, 127, 0.16);
    border-bottom: 1px solid rgba(127, 127, 127, 0.16);
    font-size: 12px;
  }

  .label {
    position: sticky;
    left: 0;
    z-index: 3;
    justify-content: flex-start;
    padding: 0 8px;
    font-weight: 650;
    background: var(--color-bg, #fff);
  }

  .header-label,
  .date-cell {
    min-height: 30px;
    font-size: 11px;
    font-weight: 650;
  }

  .date-cell {
    justify-content: flex-start;
    padding-left: 4px;
    white-space: nowrap;
    overflow: visible;
  }

  .daily .date-cell {
    padding: 0 6px;
  }

  .time-cell {
    font-size: 11px;
    opacity: 0.8;
  }

  .humidity-label,
  .humidity-cell {
    font-weight: 700;
  }

  .humidity-cell {
    background: linear-gradient(
      to top,
      rgba(90, 155, 220, 0.20) 0,
      rgba(90, 155, 220, 0.20) var(--rh),
      transparent var(--rh),
      transparent 100%
    );
  }

  .footnote {
    font-size: 11px;
    margin-top: 7px;
  }

  @media (prefers-color-scheme: dark) {
    .label {
      background: #252525;
    }
  }
</style>
