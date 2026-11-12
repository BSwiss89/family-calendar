// Open-Meteo / WMO present-weather codes, kept separate from time of day.
// "sleet" here is a visual icy-precipitation scene: freezing rain/drizzle
// (56, 57, 66, 67) and ice pellets (79), not a claim of measured ice pellets.
export type HomeWeatherCondition =
  | 'sunny'
  | 'cloudy'
  | 'fog'
  | 'rain'
  | 'storm'
  | 'snow'
  | 'sleet'
  | 'night'

export type HomeWeatherPeriod = 'day' | 'night'

export function getHomeWeatherScene(weatherCode: number, isDay: boolean): {
  theme: `weather-theme-${HomeWeatherCondition}`
  period: HomeWeatherPeriod
} {
  const period: HomeWeatherPeriod = isDay ? 'day' : 'night'
  if (weatherCode === 0) {
    return { theme: isDay ? 'weather-theme-sunny' : 'weather-theme-night', period }
  }
  if ([1, 2, 3].includes(weatherCode)) return { theme: 'weather-theme-cloudy', period }
  if ([45, 48].includes(weatherCode)) return { theme: 'weather-theme-fog', period }
  if ([56, 57, 66, 67, 79].includes(weatherCode)) return { theme: 'weather-theme-sleet', period }
  if ((weatherCode >= 71 && weatherCode <= 77) || [85, 86].includes(weatherCode)) {
    return { theme: 'weather-theme-snow', period }
  }
  if (weatherCode >= 95 && weatherCode <= 99) return { theme: 'weather-theme-storm', period }
  if ((weatherCode >= 51 && weatherCode <= 55) ||
      (weatherCode >= 61 && weatherCode <= 65) ||
      (weatherCode >= 80 && weatherCode <= 82)) {
    return { theme: 'weather-theme-rain', period }
  }
  return { theme: 'weather-theme-cloudy', period }
}
