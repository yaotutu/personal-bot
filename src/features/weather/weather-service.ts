import type {
  WeatherReport,
  WeatherResult,
  WeatherService,
  WeatherTransport,
} from "./types.js";

const weatherText = (code: number) => {
  if (code === 0) return "晴";
  if (code === 1) return "大致晴";
  if (code === 2) return "局部多云";
  if (code === 3) return "阴";
  if (code === 45 || code === 48) return "雾";
  if (code >= 51 && code <= 55) return "毛毛雨";
  if (code === 56 || code === 57) return "冻毛毛雨";
  if (code >= 61 && code <= 65) return "雨";
  if (code === 66 || code === 67) return "冻雨";
  if (code >= 71 && code <= 77) return "雪";
  if (code >= 80 && code <= 82) return "阵雨";
  if (code === 85 || code === 86) return "阵雪";
  if (code === 95) return "雷雨";
  if (code === 96 || code === 99) return "雷雨伴冰雹";
  return "未知天气";
};

const windDirection = (degrees: number) => {
  const points = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return points[Math.round(((degrees % 360) / 45)) % 8]!;
};

const numberText = (value: number, digits = 1) =>
  Number.isInteger(value) ? String(value) : value.toFixed(digits);

const formatReport = (report: WeatherReport) => {
  const place = [report.location.name, report.location.admin1, report.location.country]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(", ");
  const lines = [
    `${place} · ${weatherText(report.weatherCode)}`,
    `当前 ${numberText(report.temperatureC)}°C，体感 ${numberText(report.apparentTemperatureC)}°C`,
    `湿度 ${numberText(report.humidityPercent)}%，降水 ${numberText(report.precipitationMm)} mm`,
    `风 ${numberText(report.windSpeedKmh)} km/h（${windDirection(report.windDirectionDegrees)}）`,
    `今日 ${numberText(report.dailyMinC)}–${numberText(report.dailyMaxC)}°C，${weatherText(report.dailyWeatherCode)}` +
      (report.precipitationProbabilityPercent === null
        ? ""
        : `，降水概率 ${numberText(report.precipitationProbabilityPercent)}%`),
    `观测时间 ${report.observedAt.replace("T", " ")}（${report.location.timezone ?? "供应商时区"}）`,
    "数据源 Open-Meteo",
  ];
  return lines.join("\n");
};

/**
 * 天气 feature 只负责默认城市、受控错误和紧凑投影。
 * Geocoding/Forecast 供应商细节留在 adapter，便于以后更换数据源。
 */
export const createWeatherService = (
  transport: WeatherTransport,
  defaults: { defaultCity?: string },
): WeatherService => ({
  getWeather: async (city) => {
    const target = city?.trim() || defaults.defaultCity?.trim();
    if (!target)
      return {
        text: "No default weather city is configured. Ask the user for a city.",
        isError: true,
      };
    if (target.length > 100)
      return { text: "Weather city is too long.", isError: true };
    try {
      const location = await transport.locate(target);
      return { text: formatReport(await transport.forecast(location)), isError: false };
    } catch {
      // 地理位置、DNS 和供应商错误都可能包含内部信息；统一脱敏。
      return { text: "Weather lookup failed. Try another city name.", isError: true };
    }
  },
});
