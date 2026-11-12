// Browser-side Home forecast resilience. No new server or paid weather provider.
// Keep the Open-Meteo request fields and location behavior unchanged.
export type HomeForecast = {
  temperature: number
  feelsLike: number | null
  weatherCode: number
  isDay: boolean
  high: number | null
  low: number | null
  precipitationChance: number | null
}

export class HomeForecastError extends Error {
  readonly reason: 'http' | 'timeout' | 'network' | 'invalid'
  constructor(reason: 'http' | 'timeout' | 'network' | 'invalid', message: string) {
    super(message)
    this.reason = reason
    this.name = 'HomeForecastError'
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function fetchHomeForecast(
  coordinates: { latitude: number; longitude: number },
  options: {
    fetchFn?: typeof fetch
    timeoutMs?: number
    retryDelayMs?: number
  } = {},
): Promise<HomeForecast> {
  const { fetchFn = fetch, timeoutMs = 8000, retryDelayMs = 400 } = options
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coordinates.latitude}&longitude=${coordinates.longitude}&current=temperature_2m,apparent_temperature,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchFn(url, { signal: controller.signal })
      if (!response.ok) {
        const status = response.status
        const error = new HomeForecastError('http', `Forecast HTTP ${status}`)
        // A rejected request or a rate limit won't improve with an immediate retry.
        if ((status >= 400 && status < 500) || attempt === 1) throw error
        throw error
      }

      const data: {
        current?: Record<string, unknown>
        daily?: Record<string, unknown>
      } = await response.json()

      const temperature = finiteNumber(data?.current?.temperature_2m)
      const weatherCode = finiteNumber(data?.current?.weather_code)
      if (temperature === null || weatherCode === null) {
        throw new HomeForecastError('invalid', 'Forecast missing current temperature or condition')
      }

      function firstNumber(key: string) {
        const values = data.daily?.[key]
        return Array.isArray(values) ? finiteNumber(values[0]) : null
      }

      return {
        temperature,
        feelsLike: finiteNumber(data?.current?.apparent_temperature),
        weatherCode,
        isDay: data.current?.is_day !== 0,
        high: firstNumber('temperature_2m_max'),
        low: firstNumber('temperature_2m_min'),
        precipitationChance: firstNumber('precipitation_probability_max'),
      }
    } catch (error) {
      const failure = controller.signal.aborted
        ? new HomeForecastError('timeout', 'Forecast request timed out')
        : error instanceof HomeForecastError
          ? error
          : new HomeForecastError('network', 'Forecast connection failed')
      if (attempt === 1) throw failure
      if (failure.reason === 'http' && /^Forecast HTTP (4\d\d)/.test(failure.message)) {
        throw failure
      }
    } finally {
      clearTimeout(timer)
    }

    // Retry a transient network error, timeout, invalid reply, or server failure once.
    if (retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, retryDelayMs))
  }
  throw new HomeForecastError('network', 'Forecast not available')
}
