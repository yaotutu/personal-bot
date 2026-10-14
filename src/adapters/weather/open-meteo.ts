import { safePublicGet } from "../web/http-transport.js";
import type {
  WeatherLocation,
  WeatherReport,
  WeatherTransport,
} from "../../features/weather/types.js";

type HttpConfig = {
  timeoutMs: number;
  maxResponseBytes: number;
  userAgent?: string;
};

const geocodingEndpoint = "https://geocoding-api.open-meteo.com/v1/search";
const forecastEndpoint = "https://api.open-meteo.com/v1/forecast";

const numberOrUndefined = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** 固定字段解析，不把供应商新增字段透传进模型上下文。 */
const parseLocation = (value: unknown): WeatherLocation | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const id = numberOrUndefined(item.id);
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const latitude = numberOrUndefined(item.latitude);
  const longitude = numberOrUndefined(item.longitude);
  if (!id || !name || latitude === undefined || longitude === undefined)
    return undefined;
  return {
    id,
    name,
    admin1: typeof item.admin1 === "string" ? item.admin1 : undefined,
    country: typeof item.country === "string" ? item.country : undefined,
    latitude,
    longitude,
    timezone: typeof item.timezone === "string" ? item.timezone : undefined,
  };
};

const requiredNumber = (value: unknown): number => {
  const number = numberOrUndefined(value);
  if (number === undefined) throw new Error("Invalid weather response");
  return number;
};

const jsonObject = (body: string) => {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid weather response");
  return value as Record<string, unknown>;
};

const section = (value: unknown, key: string): Record<string, unknown> => {
  const parent = jsonObject(JSON.stringify(value ?? {}));
  const child = parent[key];
  return child && typeof child === "object" && !Array.isArray(child)
    ? child as Record<string, unknown>
    : {};
};

const firstNumber = (value: unknown): number | null => {
  if (!Array.isArray(value) || numberOrUndefined(value[0]) === undefined)
    return null;
  return value[0] as number;
};

/** Open-Meteo 无需密钥；继续复用 Web transport 的公网 DNS 校验和固定连接。 */
export const createOpenMeteoTransport = (config: HttpConfig): WeatherTransport => ({
  locate: async (city) => {
    const url = new URL(geocodingEndpoint);
    url.searchParams.set("name", city);
    url.searchParams.set("count", "1");
    url.searchParams.set("language", "zh");
    url.searchParams.set("format", "json");
    const page = await safePublicGet(url.toString(), config);
    const data = jsonObject(page.body);
    const results = Array.isArray(data.results) ? data.results : [];
    const location = parseLocation(results[0]);
    if (!location) throw new Error("City not found");
    return location;
  },
  forecast: async (location) => {
    const url = new URL(forecastEndpoint);
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));
    url.searchParams.set(
      "current",
      [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "precipitation",
        "weather_code",
        "wind_speed_10m",
        "wind_direction_10m",
      ].join(","),
    );
    url.searchParams.set(
      "daily",
      [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
      ].join(","),
    );
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("timezone", "auto");
    const page = await safePublicGet(url.toString(), config);
    const root = jsonObject(page.body);
    const current = section(root, "current");
    const daily = section(root, "daily");
    const observedAt = typeof current.time === "string" ? current.time : "";
    const dailyDate = Array.isArray(daily.time) && typeof daily.time[0] === "string"
      ? daily.time[0]
      : "";
    if (!observedAt || !dailyDate) throw new Error("Invalid weather response");
    return {
      location,
      observedAt,
      temperatureC: requiredNumber(current.temperature_2m),
      apparentTemperatureC: requiredNumber(current.apparent_temperature),
      humidityPercent: requiredNumber(current.relative_humidity_2m),
      precipitationMm: requiredNumber(current.precipitation),
      weatherCode: requiredNumber(current.weather_code),
      windSpeedKmh: requiredNumber(current.wind_speed_10m),
      windDirectionDegrees: requiredNumber(current.wind_direction_10m),
      dailyDate,
      dailyWeatherCode: requiredNumber(firstNumber(daily.weather_code)),
      dailyMaxC: requiredNumber(firstNumber(daily.temperature_2m_max)),
      dailyMinC: requiredNumber(firstNumber(daily.temperature_2m_min)),
      precipitationProbabilityPercent: firstNumber(
        daily.precipitation_probability_max,
      ),
    };
  },
});
