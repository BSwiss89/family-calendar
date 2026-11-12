import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchHomeForecast, HomeForecastError } from '../src/homeWeatherFetch.ts'

const position = { latitude: 30.08, longitude: -95.65 }
function successResponse(overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        current: {
          temperature_2m: 71.1,
          apparent_temperature: 69.4,
          weather_code: 3,
          is_day: 1,
        },
        daily: {
          temperature_2m_max: [73.6],
          temperature_2m_min: [61.3],
          precipitation_probability_max: [20],
        },
        ...overrides,
      }
    },
  }
}

test('normal Open-Meteo request keeps coordinates, current condition and daily values', async () => {
  let url = ''
  const result = await fetchHomeForecast(position, {
    fetchFn: async (input) => { url=String(input); return successResponse() },
    retryDelayMs: 0,
  })
  assert.equal(result.temperature, 71.1)
  assert.equal(result.feelsLike, 69.4)
  assert.equal(result.weatherCode, 3)
  assert.equal(result.high, 73.6)
  assert.equal(result.low, 61.3)
  assert.equal(result.precipitationChance, 20)
  assert.equal(result.isDay, true)
  assert.ok(url.includes('latitude=30.08&longitude=-95.65'))
  assert.ok(url.includes('current=temperature_2m,apparent_temperature,weather_code,is_day'))
})

test('incomplete daily data does not hide valid current weather', async () => {
  const result = await fetchHomeForecast(position, {
    fetchFn: async () => successResponse({ daily: {} }),
    retryDelayMs: 0,
  })
  assert.equal(result.temperature, 71.1)
  assert.equal(result.high, null)
  assert.equal(result.low, null)
  assert.equal(result.precipitationChance, null)
})

test('transient network failure retries once then displays successful weather', async () => {
  let calls = 0
  const result = await fetchHomeForecast(position, {
    fetchFn: async () => {
      calls += 1
      if (calls === 1) throw new TypeError('Failed to fetch')
      return successResponse()
    },
    retryDelayMs: 0,
  })
  assert.equal(calls, 2)
  assert.equal(result.weatherCode, 3)
})

test('request timeout aborts and returns a typed error after bounded retries', async () => {
  let calls = 0
  const fetchFn = (_url, init) => new Promise((_resolve, reject) => {
    calls += 1
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  await assert.rejects(
    fetchHomeForecast(position, { fetchFn, timeoutMs: 15, retryDelayMs: 0 }),
    (err) => err instanceof HomeForecastError && err.reason === 'timeout',
  )
  assert.equal(calls, 2)
})

test('HTTP 400 and 429 do not hammer a rejected weather endpoint', async () => {
  for (const status of [400, 429]) {
    let calls = 0
    const fetchFn = async () => { calls += 1; return { ok: false, status } }
    await assert.rejects(
      fetchHomeForecast(position, { fetchFn, retryDelayMs: 0 }),
      (err) => err instanceof HomeForecastError && err.reason === 'http',
    )
    assert.equal(calls, 1)
  }
})

test('bad current conditions return an explicit invalid-data error, never an endless spinner', async () => {
  const fetchFn = async () => successResponse({ current: { temperature_2m: null, weather_code: null } })
  await assert.rejects(
    fetchHomeForecast(position, { fetchFn, retryDelayMs: 0 }),
    (err) => err instanceof HomeForecastError && err.reason === 'invalid',
  )
})
