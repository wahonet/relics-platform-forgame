import { apiClient } from "./client";

export interface WeatherHour {
  time: string;
  weather_code: number | null;
  text: string;
  temperature_c: number | null;
  humidity_percent: number | null;
  precipitation_probability: number | null;
  precipitation_mm: number | null;
  wind_speed_ms: number | null;
  wind_gusts_ms: number | null;
}

export interface WeatherDay {
  date: string;
  weather_code: number | null;
  text: string;
  temp_max_c: number | null;
  temp_min_c: number | null;
  precipitation_probability_max: number | null;
  precipitation_mm: number | null;
  wind_speed_max_ms: number | null;
  wind_gusts_max_ms: number | null;
  risk_level: "normal" | "watch" | "alert";
  risk_tags: string[];
  hours: WeatherHour[];
}

export interface WeatherForecastResponse {
  provider: string;
  source_url: string;
  license: string;
  location: {
    name: string;
    latitude: number;
    longitude: number;
  };
  timezone: string;
  updated_at: string;
  days: WeatherDay[];
  cached: boolean;
  stale: boolean;
  warning?: string;
}

export async function fetchWeatherForecast(): Promise<WeatherForecastResponse> {
  const { data } = await apiClient.get<WeatherForecastResponse>("/api/weather/forecast");
  return data;
}
