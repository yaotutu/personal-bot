import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeatherService } from "../../src/features/weather/weather-service.js";
import type { WeatherReport, WeatherTransport } from "../../src/features/weather/types.js";

const report: WeatherReport = {
  location: {
    id: 1,
    name: "上海",
    admin1: "上海市",
    country: "中国",
    latitude: 31.2,
    longitude: 121.4,
    timezone: "Asia/Shanghai",
  },
  observedAt: "2026-10-12T15:30",
  temperatureC: 24.8,
  apparentTemperatureC: 26.4,
  humidityPercent: 68,
  precipitationMm: 0,
  weatherCode: 3,
  windSpeedKmh: 10.1,
  windDirectionDegrees: 341,
  dailyDate: "2026-10-12",
  dailyWeatherCode: 3,
  dailyMaxC: 24.9,
  dailyMinC: 17.1,
  precipitationProbabilityPercent: 4,
};

const transport: WeatherTransport = {
  locate: async (city) => {
    if (city === "not-found") throw new Error("No city");
    return report.location;
  },
  forecast: async () => report,
};

test("weather service uses a default city and formats a concise report", async () => {
  const weather = createWeatherService(transport, { defaultCity: "上海" });
  const result = await weather.getWeather();
  assert.equal(result.isError, false);
  assert.match(result.text, /上海, 上海市, 中国 · 阴/);
  assert.match(result.text, /当前 24\.8°C，体感 26\.4°C/);
  assert.match(result.text, /湿度 68%/);
  assert.match(result.text, /今日 17\.1–24\.9°C/);
  assert.match(result.text, /数据源 Open-Meteo/);
});

test("weather service asks for a city or returns a controlled failure", async () => {
  const noDefault = createWeatherService(transport, {});
  assert.deepEqual(await noDefault.getWeather(), {
    text: "No default weather city is configured. Ask the user for a city.",
    isError: true,
  });
  const failed = await createWeatherService(transport, {}).getWeather("not-found");
  assert.deepEqual(failed, {
    text: "Weather lookup failed. Try another city name.",
    isError: true,
  });
});
