import type { LatLon } from '@windy/interfaces';

const coordinate = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Accept route/map coordinates, including longitudes in another wrapped map world. */
export const parseLatLon = (value: unknown): LatLon | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { lat?: unknown; lon?: unknown; lng?: unknown };
  const lat = coordinate(candidate.lat);
  const lon = coordinate(candidate.lon ?? candidate.lng);
  if (lat === null || lon === null || Math.abs(lat) > 90) return null;
  return { lat, lon: Math.abs(lon) <= 180 ? lon : ((lon % 360 + 540) % 360) - 180 };
};

/** Only direct plugin onopen parameters are opening evidence, never host URLs
 * or viewport/startup objects. Be conservative about extra/ambiguous fields.
 */
export const explicitPluginLocation = (value: unknown): LatLon | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const params = value as Record<string, unknown>;
  if (!Object.hasOwn(params, 'lat') || !Object.hasOwn(params, 'lon')) return null;
  if (Object.keys(params).some(key => !['lat', 'lon', 'source', 'name', 'poiType'].includes(key))) return null;
  if (['source', 'name', 'poiType'].some(key => params[key] != null && typeof params[key] !== 'string')) return null;
  const decimal = (coordinate: unknown) => typeof coordinate === 'number'
    || typeof coordinate === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(coordinate.trim());
  return decimal(params.lat) && decimal(params.lon) ? parseLatLon(params) : null;
};

/** Ignore metre-scale jitter and treat equivalent wrapped longitudes alike. */
export const sameLocation = (a: LatLon | null, b: LatLon | null): boolean => {
  if (!a || !b) return false;
  const longitudeDifference = Math.abs(a.lon - b.lon) % 360;
  return Math.abs(a.lat - b.lat) <= 0.00001
    && Math.min(longitudeDifference, 360 - longitudeDifference) <= 0.00001;
};

const usefulName = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name && !/^[\s\d.,+−°-]+$/.test(name)
    && !(/\d/.test(name) && /^[\s\d.,+−°NSEW-]+$/i.test(name)) ? name : '';
};

const nameComponents = (text: string): string[] => {
  const parts = text.split(',').map(usefulName).filter(Boolean);
  return parts.filter((part, index) => parts.findIndex(candidate => candidate.toLowerCase() === part.toLowerCase()) === index);
};
const nameLabel = (...parts: string[]): string => nameComponents(parts.join(', ')).join(', ');
// Generic administrative markers, not a list of counties or states.
const isSubregion = (name: string): boolean => /\b(county|district|parish|borough)\b/i.test(name);

type LocationNameParts = {
  name: string;
  region: string;
  country: string;
  countryCode: string;
};

/** Extract only useful scalar localized components. */
const locationNameParts = (value: unknown): LocationNameParts => {
  const result = value && typeof value === 'object'
    ? value as { name?: unknown; nameValid?: unknown; region?: unknown; country?: unknown; cc?: unknown } : {};
  const name = result.nameValid === false ? '' : nameLabel(usefulName(result.name));
  const region = nameLabel(usefulName(result.region));
  const country = nameLabel(usefulName(result.country));
  const countryCode = typeof result.cc === 'string' && /^[a-z]{2}$/i.test(result.cc) ? result.cc.toUpperCase() : '';
  return { name, region, country, countryCode };
};

const broadRegionName = (parts: LocationNameParts): string => {
  const usefulRegion = (value: string, repeated = false) => nameComponents(value).find(part =>
    (repeated || !isSubregion(part)) && !nameComponents(parts.country).some(country => country.toLowerCase() === part.toLowerCase())) ?? '';
  // Repeated name/region is strongest. Otherwise use a useful region, then name,
  // conservatively at the fixed broad zoom; never infer a state from zoom 8.
  if (parts.name && parts.name.toLowerCase() === parts.region.toLowerCase()) return usefulRegion(parts.name, true);
  return usefulRegion(parts.region) || usefulRegion(parts.name);
};

/** Inputs are always forced zoom 5 (orientation) and 8 (locality), respectively. */
export const formatLocationName = (broadValue: unknown, localityValue: unknown): string => {
  const coarse = locationNameParts(broadValue);
  const fine = locationNameParts(localityValue);
  const countryConflict = !!coarse.country && !!fine.country && coarse.country.toLowerCase() !== fine.country.toLowerCase()
    || !!coarse.countryCode && !!fine.countryCode && coarse.countryCode !== fine.countryCode;
  const sameCountry = !!coarse.country && !!fine.country && coarse.country.toLowerCase() === fine.country.toLowerCase()
    || !!coarse.countryCode && !!fine.countryCode && coarse.countryCode === fine.countryCode;
  const broadRegion = broadRegionName(coarse);
  const locality = nameComponents(fine.name).find(part =>
    !nameComponents(fine.country).some(country => country.toLowerCase() === part.toLowerCase())
    && (countryConflict || part.toLowerCase() !== broadRegion.toLowerCase())) ?? '';
  // On conflict the fine locality + its own country is a safe single-response
  // fallback. If it has no locality, keep the coarse orientation by itself.
  if (countryConflict) return locality ? nameLabel(locality, fine.country) : broadRegion || fine.country || coarse.country;
  if (locality) return nameLabel(locality, sameCountry ? broadRegion || fine.country || coarse.country : fine.country);
  return broadRegion || coarse.country || fine.country;
};
