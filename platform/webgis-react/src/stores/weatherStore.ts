import { create } from "zustand";
import {
  fetchWeatherForecast,
  type WeatherForecastResponse,
} from "../api/weather";

/** 地图天气氛围类型：对应天气时在地图上叠加一层极淡的效果。 */
export type WeatherAmbience = "rain" | "snow" | "overcast";

interface WeatherState {
  forecast: WeatherForecastResponse | null;
  loading: boolean;
  error: string;
  /** 今日天气氛围（null = 晴/少云，不叠加效果）。 */
  ambience: WeatherAmbience | null;
  /** 启动定时加载(幂等,App 挂载时调用;每 30 分钟自动刷新)。 */
  start: () => void;
  refresh: () => Promise<void>;
}

/** Open-Meteo weather code → 地图氛围类型（晴/多云返回 null）。 */
export function ambienceFromCode(code: number | null): WeatherAmbience | null {
  if (code == null) return null;
  // 3=阴，45/48=雾:统一按"阴"处理,只做轻微压灰
  if (code === 3 || code === 45 || code === 48) return "overcast";
  // 51-67=毛毛雨/雨/冻雨，80-82=阵雨，95+=雷暴
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return "rain";
  // 71-77=雪，85/86=阵雪
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  return null;
}

function todayInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

let timer: number | null = null;

export const useWeatherStore = create<WeatherState>((set, get) => ({
  forecast: null,
  loading: false,
  error: "",
  ambience: null,

  start() {
    if (timer != null) return;
    void get().refresh();
    timer = window.setInterval(() => void get().refresh(), 30 * 60 * 1000);
  },

  async refresh() {
    set({ loading: true });
    try {
      const data = await fetchWeatherForecast();
      const today = data.days.find((day) => day.date === todayInTimezone(data.timezone));
      set({
        forecast: data,
        error: "",
        loading: false,
        ambience: ambienceFromCode(today?.weather_code ?? null),
      });
    } catch (reason) {
      const detail = (reason as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      set({
        error: detail || "天气预报暂时无法加载",
        loading: false,
        ambience: null,
      });
    }
  },
}));

// 验收/调试用:控制台执行 __setWeatherFx('rain'|'snow'|'overcast'|null) 强制预览地图氛围。
// (下次天气自动刷新时会被真实数据覆盖)
declare global {
  interface Window {
    __setWeatherFx?: (ambience: WeatherAmbience | null) => void;
  }
}
if (typeof window !== "undefined") {
  window.__setWeatherFx = (ambience) => useWeatherStore.setState({ ambience });
}
