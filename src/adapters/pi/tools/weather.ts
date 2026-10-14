import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { WeatherService } from "../../../features/weather/types.js";

// 只读天气工具。城市可省略；未配置默认城市时由模型向用户追问。
export const weatherTool = (weather: WeatherService) =>
  defineTool({
    name: "get_weather",
    label: "Current weather",
    description:
      "Get current conditions and today's summary for a city from Open-Meteo. " +
      "Use this for weather questions instead of search_web. Omit city to use the configured default.",
    parameters: Type.Object(
      {
        city: Type.Optional(
          Type.String({ description: "City name. Omit to use the configured default city." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      const result = await weather.getWeather(params.city);
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: { source: "open-meteo" },
        isError: result.isError,
      };
    },
  });
