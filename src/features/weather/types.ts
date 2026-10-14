/** Open-Meteo geocoding 归一化后的地点；不向 feature 暴露供应商原始响应。 */
export type WeatherLocation = {
  id: number;
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
};

/** 只保留当前天气和今日概览，避免把供应商大响应塞进模型上下文。 */
export type WeatherReport = {
  location: WeatherLocation;
  observedAt: string;
  temperatureC: number;
  apparentTemperatureC: number;
  humidityPercent: number;
  precipitationMm: number;
  weatherCode: number;
  windSpeedKmh: number;
  windDirectionDegrees: number;
  dailyDate: string;
  dailyWeatherCode: number;
  dailyMaxC: number;
  dailyMinC: number;
  precipitationProbabilityPercent: number | null;
};

export type WeatherTransport = {
  locate: (city: string) => Promise<WeatherLocation>;
  forecast: (location: WeatherLocation) => Promise<WeatherReport>;
};

export type WeatherResult = {
  text: string;
  isError: boolean;
};

export type WeatherService = {
  getWeather: (city?: string) => Promise<WeatherResult>;
};
