import { useEffect, useState } from "react";
import type { WeatherDay } from "../api/weather";
import { useWeatherStore } from "../stores/weatherStore";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function weatherIcon(code: number | null): string {
  if (code === 0 || code === 1) return "☀";
  if (code === 2) return "⛅";
  if (code === 3) return "☁";
  if (code === 45 || code === 48) return "🌫";
  if (code != null && code >= 51 && code <= 67) return "🌧";
  if (code != null && code >= 71 && code <= 77) return "🌨";
  if (code != null && code >= 80 && code <= 82) return "🌦";
  if (code === 85 || code === 86) return "🌨";
  if (code != null && code >= 95) return "⛈";
  return "◌";
}

function dateParts(date: string): { short: string; weekday: string } {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(year, Math.max(0, month - 1), day);
  return {
    short: `${month}.${String(day).padStart(2, "0")}`,
    weekday: WEEKDAYS[parsed.getDay()] || "",
  };
}

function dateInTimezone(timezone: string, offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dayName(day: WeatherDay, timezone: string): string {
  if (day.date === dateInTimezone(timezone)) return "今天";
  if (day.date === dateInTimezone(timezone, 1)) return "明天";
  return dateParts(day.date).weekday;
}

function numberText(value: number | null, suffix = ""): string {
  return value == null ? "—" : `${value}${suffix}`;
}

/** UTC ISO 时间 → 本地 HH:MM。 */
function updateTimeLabel(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
}

export function WeatherForecast() {
  const forecast = useWeatherStore((s) => s.forecast);
  const loading = useWeatherStore((s) => s.loading);
  const error = useWeatherStore((s) => s.error);
  const refresh = useWeatherStore((s) => s.refresh);
  const start = useWeatherStore((s) => s.start);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    start();
  }, [start]);

  const days = forecast?.days || [];
  const selected = days[Math.min(selectedIndex, Math.max(0, days.length - 1))] || null;

  if (loading && !forecast) {
    return (
      <section className="weather-panel dash-sec" aria-label="天气预报">
        <h4>天气预报</h4>
        <div className="weather-loading">正在获取未来 7 天天气…</div>
      </section>
    );
  }

  if (!selected || !forecast) {
    return (
      <section className="weather-panel dash-sec" aria-label="天气预报">
        <h4>天气预报</h4>
        <div className="weather-error">
          <span>{error || "暂无天气数据"}</span>
          <button type="button" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      </section>
    );
  }

  const selectedDate = dateParts(selected.date);
  const risk = selected.risk_tags.length > 0;
  const precipitation =
    selected.precipitation_probability_max != null && selected.precipitation_probability_max > 0
      ? ` · 降水 ${selected.precipitation_probability_max}%`
      : "";

  return (
    <section className="weather-panel dash-sec" aria-label="天气预报">
      <div className="weather-heading">
        <h4>天气预报</h4>
        <span>{forecast.location.name}</span>
      </div>

      <div className="weather-day-main">
        <span className="weather-main-icon" aria-hidden="true">
          {weatherIcon(selected.weather_code)}
        </span>
        <div>
          <b>{dayName(selected, forecast.timezone)} · {selectedDate.short}</b>
          <em>{selected.text}{precipitation}</em>
        </div>
        <strong>
          {numberText(selected.temp_max_c, "°")}
          <small> / {numberText(selected.temp_min_c, "°")}</small>
        </strong>
      </div>

      <div className="weather-week" aria-label="未来七天">
        {days.map((day, index) => (
          <button
            key={day.date}
            type="button"
            className={index === selectedIndex ? "on" : ""}
            aria-pressed={index === selectedIndex}
            aria-label={`${day.date} ${day.text}，最高 ${numberText(day.temp_max_c, "度")}，最低 ${numberText(day.temp_min_c, "度")}`}
            title={`${day.date} ${day.text}`}
            onClick={() => setSelectedIndex(index)}
          >
            <span>{dayName(day, forecast.timezone)}</span>
            <b aria-hidden="true">{weatherIcon(day.weather_code)}</b>
            <em>{numberText(day.temp_max_c, "°")}</em>
          </button>
        ))}
      </div>

      {risk ? (
        <div className={`weather-risk ${selected.risk_level}`}>
          <b>防护提示</b>
          <span>{selected.risk_tags.join("、")}天气，注意关注易损文物点</span>
        </div>
      ) : null}

      <div className="weather-source">
        {error
          ? <span>更新失败：{error}</span>
          : forecast.stale
          ? <span>{forecast.warning || "缓存天气"}</span>
          : <span>{updateTimeLabel(forecast.updated_at)} 更新</span>}
        <a href={forecast.source_url} target="_blank" rel="noreferrer">
          {forecast.provider} · {forecast.license}
        </a>
      </div>
    </section>
  );
}
