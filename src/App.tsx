import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import './App.css'
import { ListIcon, LIST_ICON_OPTIONS, getListIconOption } from './ListIcons'
import { makeEventDuplicateDraft } from './duplicateEvent.mjs'
import {
  suggestListCategory,
  SUGGESTED_LIST_CATEGORIES,
} from '../Server/list-features.mjs'


import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  useDndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'

import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'

import { CSS } from '@dnd-kit/utilities'

type Person = {
  id: number
  name: string
  color: string
  image: string | null
}
type CalendarEvent = {
  id: number
  date: string
  endDate: string | null
  title: string
 time: string | null
endTime: string | null
person: string | null
  notes: string | null
location: string | null
batchId: string | null
  people: Person[]
  repeatUnit: string | null
  repeatInterval: number | null
  repeatEndType: string | null
  repeatEndDate: string | null
  repeatCount: number | null
  exceptions: string[]
}

type EventWeatherData = {
  icon: string
  temperature: number
}

type ZipCoordinates = {
  latitude: number
  longitude: number
}

const zipCoordinateCache = new Map<
  string,
  Promise<ZipCoordinates | null>
>()

const eventWeatherCache = new Map<
  string,
  Promise<EventWeatherData | null>
>()

function getZipCode(location: string | null) {
  if (!location) return null

  const match = location.match(
    /\b(\d{5})(?:-\d{4})?\b/
  )

  return match?.[1] ?? null
}

function getForecastDayOffset(dateKey: string) {
  const [year, month, day] =
    dateKey.split('-').map(Number)

  const today = new Date()

  const todayUtc = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  )

  const eventUtc = Date.UTC(
    year,
    month - 1,
    day
  )

  return Math.round(
    (eventUtc - todayUtc) /
      (1000 * 60 * 60 * 24)
  )
}

function getWeatherIcon(
  weatherCode: number,
  isDay = true
) {
  if (weatherCode === 0) {
    return isDay ? '☀️' : '🌙'
  }

  if (weatherCode === 1) {
    return isDay ? '🌤️' : '☁️'
  }

  if (
    weatherCode === 2 ||
    weatherCode === 3
  ) {
    return '☁️'
  }

  if (
    weatherCode === 45 ||
    weatherCode === 48
  ) {
    return '🌫️'
  }

  if (
    weatherCode >= 51 &&
    weatherCode <= 57
  ) {
    return '🌦️'
  }

  if (
    weatherCode >= 61 &&
    weatherCode <= 67
  ) {
    return '🌧️'
  }

  if (
    weatherCode >= 71 &&
    weatherCode <= 77
  ) {
    return '❄️'
  }

  if (
    weatherCode >= 80 &&
    weatherCode <= 82
  ) {
    return '🌧️'
  }

  if (
    weatherCode === 85 ||
    weatherCode === 86
  ) {
    return '🌨️'
  }

  if (
    weatherCode >= 95 &&
    weatherCode <= 99
  ) {
    return '⛈️'
  }

  return '🌡️'
}

async function getCoordinatesForZip(
  zipCode: string
) {
  const cached =
    zipCoordinateCache.get(zipCode)

  if (cached) {
    return cached
  }

  const request = (async () => {
    try {
      const response = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
          zipCode
        )}&count=1&language=en&format=json&countryCode=US`
      )

      if (!response.ok) {
        return null
      }

      const data = await response.json()
      const result = data.results?.[0]

      if (
        !result ||
        typeof result.latitude !== 'number' ||
        typeof result.longitude !== 'number'
      ) {
        return null
      }

      return {
        latitude: result.latitude,
        longitude: result.longitude,
      }
    } catch {
      return null
    }
  })()

  zipCoordinateCache.set(
    zipCode,
    request
  )

  return request
}

async function getEventWeather(
  location: string,
  date: string,
  time: string | null
) {
  const zipCode =
    getZipCode(location)

  if (!zipCode) {
    return null
  }

  const dayOffset =
    getForecastDayOffset(date)

  if (
    dayOffset < 0 ||
    dayOffset > 15
  ) {
    return null
  }

  const cacheKey =
    `${zipCode}-${date}-${time ?? 'all-day'}`

  const cached =
    eventWeatherCache.get(cacheKey)

  if (cached) {
    return cached
  }

  const request = (async () => {
    const coordinates =
      await getCoordinatesForZip(
        zipCode
      )

    if (!coordinates) {
      return null
    }

    try {
      if (!time) {
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${coordinates.latitude}&longitude=${coordinates.longitude}&daily=weather_code,temperature_2m_max&temperature_unit=fahrenheit&timezone=auto&start_date=${date}&end_date=${date}`
        )

        if (!response.ok) {
          return null
        }

        const data =
          await response.json()

        const temperature =
          data.daily
            ?.temperature_2m_max?.[0]

        const weatherCode =
          data.daily
            ?.weather_code?.[0]

        if (
          typeof temperature !==
            'number' ||
          typeof weatherCode !==
            'number'
        ) {
          return null
        }

        return {
          icon:
            getWeatherIcon(
              weatherCode
            ),
          temperature:
            Math.round(temperature),
        }
      }

      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${coordinates.latitude}&longitude=${coordinates.longitude}&hourly=temperature_2m,weather_code,is_day&temperature_unit=fahrenheit&timezone=auto&start_date=${date}&end_date=${date}`
      )

      if (!response.ok) {
        return null
      }

      const data =
        await response.json()

      const times: string[] =
        data.hourly?.time ?? []

      const [targetHour, targetMinute] =
        time.split(':').map(Number)

      const targetMinutes =
        targetHour * 60 +
        targetMinute

      let closestIndex = -1
      let closestDifference =
        Number.POSITIVE_INFINITY

      times.forEach(
        (
          forecastTime,
          index
        ) => {
          const timeMatch =
            forecastTime.match(
              /T(\d{2}):(\d{2})/
            )

          if (!timeMatch) return

          const forecastMinutes =
            Number(timeMatch[1]) *
              60 +
            Number(timeMatch[2])

          const difference =
            Math.abs(
              forecastMinutes -
                targetMinutes
            )

          if (
            difference <
            closestDifference
          ) {
            closestDifference =
              difference

            closestIndex = index
          }
        }
      )

      if (closestIndex < 0) {
        return null
      }

      const temperature =
        data.hourly
          ?.temperature_2m?.[
          closestIndex
        ]

      const weatherCode =
        data.hourly
          ?.weather_code?.[
          closestIndex
        ]

      const isDay =
        data.hourly
          ?.is_day?.[
          closestIndex
        ] !== 0

      if (
        typeof temperature !==
          'number' ||
        typeof weatherCode !==
          'number'
      ) {
        return null
      }

      return {
        icon:
          getWeatherIcon(
            weatherCode,
            isDay
          ),
        temperature:
          Math.round(temperature),
      }
    } catch {
      return null
    }
  })()

  eventWeatherCache.set(
    cacheKey,
    request
  )

  return request
}

function EventWeather({
  location,
  date,
  time,
}: {
  location: string | null
  date: string | null
  time: string | null
}) {
  const [weather, setWeather] =
    useState<EventWeatherData | null>(
      null
    )

  useEffect(() => {
    let active = true

    setWeather(null)

    if (!location || !date) {
      return () => {
        active = false
      }
    }

    getEventWeather(
      location,
      date,
      time
    ).then((result) => {
      if (active) {
        setWeather(result)
      }
    })

    return () => {
      active = false
    }
  }, [location, date, time])

  if (!weather) {
    return null
  }

  return (
    <div className="event-details-row">
      <span className="event-details-row-label">
        Weather
      </span>

      <strong>
        {weather.icon}{' '}
        {weather.temperature}°
      </strong>
    </div>
  )
}

function CompactEventWeather({
  location,
  date,
  time,
}: {
  location: string | null
  date: string
  time: string | null
}) {
  const [weather, setWeather] =
    useState<EventWeatherData | null>(
      null
    )

  useEffect(() => {
    let active = true

    setWeather(null)

    if (!location) {
      return () => {
        active = false
      }
    }

    getEventWeather(
      location,
      date,
      time
    ).then((result) => {
      if (active) {
        setWeather(result)
      }
    })

    return () => {
      active = false
    }
  }, [location, date, time])

  if (!weather) {
    return null
  }

  return (
    <span className="event-weather-compact">
      {weather.icon}
      <span>
        {weather.temperature}°
      </span>
    </span>
  )
}

type HomeWeatherData = {
  icon: string
  temperature: number
  feelsLike: number
  high: number
  low: number
  precipitationChance: number
  theme: string
}

function getHomeWeatherTheme(
  weatherCode: number,
  isDay: boolean
) {
  if (weatherCode === 0) {
    return isDay
      ? 'weather-theme-sunny'
      : 'weather-theme-night'
  }

  if (
    weatherCode === 1 ||
    weatherCode === 2 ||
    weatherCode === 3
  ) {
    return 'weather-theme-cloudy'
  }

  if (
    weatherCode === 45 ||
    weatherCode === 48
  ) {
    return 'weather-theme-fog'
  }

  if (
    (weatherCode >= 51 &&
      weatherCode <= 67) ||
    (weatherCode >= 80 &&
      weatherCode <= 82)
  ) {
    return 'weather-theme-rain'
  }

  if (
    (weatherCode >= 71 &&
      weatherCode <= 77) ||
    weatherCode === 85 ||
    weatherCode === 86
  ) {
    return 'weather-theme-snow'
  }

  if (
    weatherCode >= 95 &&
    weatherCode <= 99
  ) {
    return 'weather-theme-storm'
  }

  return 'weather-theme-cloudy'
}

function HomeWeatherArtwork({
  theme,
}: {
  theme: string
}) {
  return (
    <div
      className={`home-weather-artwork ${theme}`}
      aria-hidden="true"
    >
      {theme === 'weather-theme-sunny' && (
        <>
          <div className="weather-art-sun" />
        </>
      )}

      {theme === 'weather-theme-night' && (
        <>
          <div className="weather-art-moon" />
          <div className="weather-art-cloud weather-art-cloud-small" />
        </>
      )}

      {theme === 'weather-theme-cloudy' && (
        <>
          <div className="weather-art-sun weather-art-sun-behind" />
          <div className="weather-art-cloud weather-art-cloud-main" />
        </>
      )}

      {theme === 'weather-theme-rain' && (
        <>
          <div className="weather-art-cloud weather-art-cloud-main" />

          <div className="weather-art-rain">
            <span />
            <span />
            <span />
            <span />
          </div>
        </>
      )}

      {theme === 'weather-theme-storm' && (
        <>
          <div className="weather-art-cloud weather-art-cloud-main" />

          <div className="weather-art-lightning">
            ⚡
          </div>

          <div className="weather-art-rain">
            <span />
            <span />
            <span />
          </div>
        </>
      )}

      {theme === 'weather-theme-snow' && (
        <>
          <div className="weather-art-cloud weather-art-cloud-main" />

          <div className="weather-art-snow">
            <span>❄</span>
            <span>❄</span>
            <span>❄</span>
          </div>
        </>
      )}

      {theme === 'weather-theme-fog' && (
        <div className="weather-art-fog">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  )
}
function DayWeather({
  date,
}: {
  date: string
}) {
  const [weather, setWeather] =
    useState<{
      icon: string
      high: number
      low: number
      precipitationChance: number
    } | null>(null)

  const [isLoading, setIsLoading] =
    useState(false)

  const [weatherError, setWeatherError] =
    useState('')

  useEffect(() => {
    let active = true

    setWeather(null)
    setWeatherError('')

    const zipCode =
      window.localStorage.getItem(
        'family-calendar-home-zip'
      ) ?? ''

    if (!/^\d{5}$/.test(zipCode)) {
      setWeatherError(
        'Set your home ZIP on the Home screen.'
      )

      return () => {
        active = false
      }
    }

    const dayOffset =
      getForecastDayOffset(date)

    if (
      dayOffset < 0 ||
      dayOffset > 15
    ) {
      setWeatherError(
        'Forecast unavailable for this date.'
      )

      return () => {
        active = false
      }
    }

    setIsLoading(true)

    const loadWeather = async () => {
      const coordinates =
        await getCoordinatesForZip(
          zipCode
        )

      if (!coordinates) {
        if (active) {
          setWeatherError(
            'Weather is unavailable right now.'
          )

          setIsLoading(false)
        }

        return
      }

      try {
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${coordinates.latitude}&longitude=${coordinates.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&start_date=${date}&end_date=${date}`
        )

        if (!response.ok) {
          throw new Error(
            'Weather request failed.'
          )
        }

        const data =
          await response.json()

        const weatherCode =
          data.daily
            ?.weather_code?.[0]

        const high =
          data.daily
            ?.temperature_2m_max?.[0]

        const low =
          data.daily
            ?.temperature_2m_min?.[0]

        const precipitationChance =
          data.daily
            ?.precipitation_probability_max?.[0]

        if (
          typeof weatherCode !==
            'number' ||
          typeof high !== 'number' ||
          typeof low !== 'number'
        ) {
          throw new Error(
            'Weather data was incomplete.'
          )
        }

        if (!active) {
          return
        }

        setWeather({
          icon:
            getWeatherIcon(
              weatherCode
            ),
          high: Math.round(high),
          low: Math.round(low),
          precipitationChance:
            typeof precipitationChance ===
            'number'
              ? Math.round(
                  precipitationChance
                )
              : 0,
        })

        setIsLoading(false)
      } catch {
        if (active) {
          setWeatherError(
            'Weather is unavailable right now.'
          )

          setIsLoading(false)
        }
      }
    }

    loadWeather()

    return () => {
      active = false
    }
  }, [date])

  return (
    <section className="day-weather-card">
      <div className="day-weather-heading">
        <strong>Weather</strong>

        <span>
          {new Date(
            `${date}T12:00:00`
          ).toLocaleDateString(
            'en-US',
            {
              weekday: 'short',
            }
          )}
        </span>
      </div>

      {isLoading && (
        <div className="day-weather-status">
          Loading weather…
        </div>
      )}

      {!isLoading &&
        weatherError && (
          <div className="day-weather-status">
            {weatherError}
          </div>
        )}

      {!isLoading &&
        !weatherError &&
        weather && (
          <div className="day-weather-content">
            <div className="day-weather-main">
              <span className="day-weather-icon">
                {weather.icon}
              </span>

              <strong>
                {weather.high}
                {'\u00B0'}
              </strong>
            </div>

            <div className="day-weather-details">
              <span>
                High {weather.high}
                {'\u00B0'}
              </span>

              <span>
                Low {weather.low}
                {'\u00B0'}
              </span>

              <span>
                Rain{' '}
                {
                  weather.precipitationChance
                }
                %
              </span>
            </div>
          </div>
        )}
    </section>
  )
}
function HomeWeather() {
  const [zipCode, setZipCode] =
    useState(() => {
      return (
        window.localStorage.getItem(
          'family-calendar-home-zip'
        ) ?? ''
      )
    })

  const [draftZipCode, setDraftZipCode] =
    useState(zipCode)

  const [weather, setWeather] =
    useState<HomeWeatherData | null>(null)

  const [isLoading, setIsLoading] =
    useState(false)

  const [weatherError, setWeatherError] =
    useState('')

  const [isEditingZip, setIsEditingZip] =
    useState(zipCode === '')

  useEffect(() => {
    let active = true

    setWeather(null)
    setWeatherError('')

    if (!/^\d{5}$/.test(zipCode)) {
      setIsLoading(false)

      return () => {
        active = false
      }
    }

    setIsLoading(true)

    const loadWeather = async () => {
      const coordinates =
        await getCoordinatesForZip(
          zipCode
        )

      if (!coordinates) {
        if (active) {
          setWeatherError(
            'Unable to find that ZIP code.'
          )
          setIsLoading(false)
        }

        return
      }

      try {
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${coordinates.latitude}&longitude=${coordinates.longitude}&current=temperature_2m,apparent_temperature,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`
        )

        if (!response.ok) {
          throw new Error(
            'Weather request failed.'
          )
        }

        const data =
          await response.json()

        const temperature =
          data.current?.temperature_2m

        const feelsLike =
          data.current
            ?.apparent_temperature

        const weatherCode =
          data.current?.weather_code

        const isDay =
          data.current?.is_day !== 0

        const high =
          data.daily
            ?.temperature_2m_max?.[0]

        const low =
          data.daily
            ?.temperature_2m_min?.[0]

        const precipitationChance =
          data.daily
            ?.precipitation_probability_max?.[0]

        if (
          typeof temperature !==
            'number' ||
          typeof feelsLike !==
            'number' ||
          typeof weatherCode !==
            'number' ||
          typeof high !== 'number' ||
          typeof low !== 'number'
        ) {
          throw new Error(
            'Weather data was incomplete.'
          )
        }

        if (!active) {
          return
        }

        setWeather({
          icon: getWeatherIcon(
            weatherCode,
            isDay
          ),
          theme: getHomeWeatherTheme(
  weatherCode,
  isDay
),
          temperature:
            Math.round(temperature),
          feelsLike:
            Math.round(feelsLike),
          high: Math.round(high),
          low: Math.round(low),
          precipitationChance:
            typeof precipitationChance ===
            'number'
              ? Math.round(
                  precipitationChance
                )
              : 0,
        })

        setIsLoading(false)
      } catch {
        if (active) {
          setWeatherError(
            'Weather is unavailable right now.'
          )
          setIsLoading(false)
        }
      }
    }

    loadWeather()

    return () => {
      active = false
    }
  }, [zipCode])

  function saveHomeZipCode() {
    const cleanZipCode =
      draftZipCode.trim()

    if (!/^\d{5}$/.test(cleanZipCode)) {
      setWeatherError(
        'Enter a 5-digit ZIP code.'
      )
      return
    }

    window.localStorage.setItem(
      'family-calendar-home-zip',
      cleanZipCode
    )

    setZipCode(cleanZipCode)
    setWeatherError('')
    setIsEditingZip(false)
  }

  return (
    <div
  className={`home-weather ${
    zipCode && !isEditingZip
      ? `home-weather-active ${
          weather?.theme ??
          'weather-theme-cloudy'
        }`
      : 'home-weather-setup'
  }`}
>
      <div className="home-weather-title">
  Weather
</div>
      <button
        type="button"
        className="home-weather-settings-button"
        aria-label="Edit weather ZIP code"
        title="Weather settings"
        onClick={() => {
          if (isEditingZip && zipCode) {
            setDraftZipCode(zipCode)
            setWeatherError('')
            setIsEditingZip(false)
            return
          }

          setDraftZipCode(zipCode)
          setWeatherError('')
          setIsEditingZip(true)
        }}
      >
        ⚙
      </button>

      {(!zipCode || isEditingZip) && (
        <div className="home-weather-zip-row">
          <input
            className="home-weather-zip-input"
            type="text"
            inputMode="numeric"
            maxLength={5}
            placeholder="Home ZIP"
            value={draftZipCode}
            onChange={(event) => {
              setDraftZipCode(
                event.target.value.replace(
                  /\D/g,
                  ''
                )
              )
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                saveHomeZipCode()
              }
            }}
          />

          <button
            type="button"
            className="home-weather-zip-button"
            onClick={saveHomeZipCode}
          >
            Save
          </button>
        </div>
      )}

      {weatherError && (
        <div className="home-weather-message">
          {weatherError}
        </div>
      )}

      {!weatherError &&
        !zipCode && (
          <div className="home-weather-message">
            Enter your home ZIP code.
          </div>
        )}

      {!isEditingZip &&
        isLoading && (
          <div className="home-weather-message">
            Loading weather...
          </div>
        )}

      {!isEditingZip &&
        !isLoading &&
        weather && (
          <div className="home-weather-current">
            <div className="home-weather-location">
              Home · {zipCode}
            </div>

            <div className="home-weather-main">
              <HomeWeatherArtwork
  theme={weather.theme}
/>

              <strong className="home-weather-temperature">
                {weather.temperature}
                {'\u00B0'}
              </strong>
            </div>

            <div className="home-weather-details">
              <span>
                Feels like{' '}
                {weather.feelsLike}
                {'\u00B0'}
              </span>

              <span>
                H {weather.high}
                {'\u00B0'} · L{' '}
                {weather.low}
                {'\u00B0'}
              </span>

              <span>
                Rain{' '}
                {weather.precipitationChance}%
              </span>
            </div>
          </div>
        )}

      <a
        className="home-weather-source"
        href="https://open-meteo.com/"
        target="_blank"
        rel="noreferrer"
      >
        Weather by Open-Meteo
      </a>
    </div>
  )
}

type ListItem = {
  id: number
  list_id: number
  text: string
  completed: boolean
  category?: string
  store_id?: number | null
  store_manual?: boolean
  created_at?: string
}

type ShoppingStore = {
  id: number
  name: string
  enabled: boolean
  sort_order: number
}

type CalendarList = {
  id: number
  name: string
  icon?: string | null
  store_enabled?: boolean
  created_at?: string
  items: ListItem[]
}

type CaptureInboxItem = {
  id: number
  image: string
  originalName: string | null
  mimeType: string | null
  note: string | null
  status: string
  captureType:
    | 'event'
    | 'recipe'
    | 'list'
    | 'other'
    | null
  analysisStatus: string
  analysisJson: string | null
  createdAt: string
  updatedAt: string
}

type CaptureAnalysis = {
  captureType:
    | 'event'
    | 'recipe'
    | 'list'
    | 'other'

  summary?: string
sourceImage?: string | null
  dateContext?: {
    dateText?: string
    yearVisible?: boolean
    year?: number | null
    month?: number | null
    day?: number | null
    weekday?: string
  }

  events?: Array<{
    title?: string
    startTime?: string
    endTime?: string
    allDay?: boolean
    location?: string
    notes?: string
  }>

  recipe?: {
    title?: string
    servings?: string
    prepTime?: string
    cookTime?: string
    ingredients?: string[]
    instructions?: string[]
    tags?: string[]
  }

  list?: {
    name?: string
    items?: string[]
  }
}

function getCaptureAnalysis(
  capture: CaptureInboxItem
): CaptureAnalysis | null {
  if (!capture.analysisJson) {
    return null
  }

  try {
    return JSON.parse(
      capture.analysisJson
    ) as CaptureAnalysis
  } catch {
    return null
  }
}

function CaptureAnalysisPreview({
  capture,
}: {
  capture: CaptureInboxItem
}) {
  const analysis =
    getCaptureAnalysis(capture)

  if (!analysis) {
    return (
      <div className="capture-analysis-panel">
        <div className="capture-analysis-heading">
          <strong>AI Analysis</strong>

          <span className="capture-analysis-status">
            Ready
          </span>
        </div>

        <p className="capture-analysis-empty">
          This item is ready to be analyzed.
          Extracted details will appear here
          before anything is added to the
          calendar.
        </p>
      </div>
    )
  }

  return (
    <div className="capture-analysis-panel">
      <div className="capture-analysis-heading">
        <strong>AI Analysis</strong>

        <span className="capture-analysis-status">
          {capture.analysisStatus ===
          'complete'
            ? 'Complete'
            : capture.analysisStatus}
        </span>
      </div>

      {analysis.summary && (
        <p className="capture-analysis-summary">
          {analysis.summary}
        </p>
      )}

      {analysis.captureType ===
  'event' && (
  <div className="capture-analysis-details">
    {analysis.dateContext && (
      <div>
        <span>Visible Date</span>

        <strong>
          {analysis.dateContext.dateText ||
            'Not found'}
        </strong>
      </div>
    )}

    {analysis.events?.length ? (
      analysis.events.map(
        (event, index) => (
          <div
            className="capture-analysis-event"
            key={`${event.title}-${index}`}
          >
            <div>
              <span>
                Event {index + 1}
              </span>

              <strong>
                {event.title ||
                  'Untitled Event'}
              </strong>
            </div>

            <div>
              <span>Time</span>

              <strong>
                {event.allDay
                  ? 'All day'
                  : [
                      event.startTime,
                      event.endTime,
                    ]
                      .filter(Boolean)
                      .join(' – ') ||
                    'Not found'}
              </strong>
            </div>

            {event.location && (
              <div>
                <span>Location</span>

                <strong>
                  {event.location}
                </strong>
              </div>
            )}

            {event.notes && (
              <div>
                <span>Notes</span>

                <strong>
                  {event.notes}
                </strong>
              </div>
            )}
          </div>
        )
      )
    ) : (
      <div>
        <strong>
          No events found
        </strong>
      </div>
    )}
  </div>
)}

      {analysis.captureType ===
        'recipe' &&
        analysis.recipe && (
          <div className="capture-analysis-details">
            <div>
              <span>Recipe</span>
              <strong>
                {analysis.recipe.title ||
                  'Not found'}
              </strong>
            </div>

            <div>
              <span>Servings</span>
              <strong>
                {analysis.recipe.servings ||
                  'Not found'}
              </strong>
            </div>

            <div>
              <span>Ingredients</span>

              {analysis.recipe.ingredients
                ?.length ? (
                <ul>
                  {analysis.recipe.ingredients.map(
                    (
                      ingredient,
                      index
                    ) => (
                      <li
                        key={`${ingredient}-${index}`}
                      >
                        {ingredient}
                      </li>
                    )
                  )}
                </ul>
              ) : (
                <strong>
                  Not found
                </strong>
              )}
            </div>
          </div>
        )}

      {analysis.captureType ===
        'list' &&
        analysis.list && (
          <div className="capture-analysis-details">
            <div>
              <span>List</span>
              <strong>
                {analysis.list.name ||
                  'Untitled List'}
              </strong>
            </div>

            <div>
              <span>Items</span>

              {analysis.list.items
                ?.length ? (
                <ul>
                  {analysis.list.items.map(
                    (item, index) => (
                      <li
                        key={`${item}-${index}`}
                      >
                        {item}
                      </li>
                    )
                  )}
                </ul>
              ) : (
                <strong>
                  No items found
                </strong>
              )}
            </div>
          </div>
        )}

      {analysis.captureType ===
        'other' && (
        <p className="capture-analysis-empty">
          This capture did not match an
          Event, Recipe, or List.
        </p>
      )}
    </div>
  )
}

type MealPlan = {
  id: number
  date: string
  dinner: string
  notes: string | null
}

type MealPlanItem = {
  id: number
  date: string
  mealType:
    | 'breakfast'
    | 'lunch'
    | 'dinner'
    | 'snack'
  recipeId: number | null
  title: string
  notes: string | null
  createdAt: string
  recipeImage: string | null
}

type Recipe = {
  id: number
  name: string
  image: string | null
  sourceImage: string | null
  servings: number | null
  prepTime: string | null
  cookTime: string | null
  ingredients: string
  instructions: string
  notes: string | null
  tags: string | null
  favorite: boolean
  sourceUrl: string | null
  createdAt: string
  updatedAt: string
}
type SortableListItemProps = {
  item: ListItem
  isEditing: boolean
  editingText: string
  editingCategory?: string
  editingStoreId?: number | null
  showStore?: boolean
  stores?: ShoppingStore[]
  canDrag?: boolean
  onEditingTextChange: (text: string) => void
  onEditingCategoryChange?: (category: string) => void
  onEditingStoreChange?: (storeId: number | null) => void
  onStartEdit: (item: ListItem) => void
  onSaveEdit: (itemId: number) => void
  onCancelEdit: () => void
  onToggle: (item: ListItem) => void
  onDelete: (itemId: number) => void
  swipeSide: 'edit' | 'delete' | null
  onSwipeChange: (side: 'edit' | 'delete' | null) => void
}

type HomeWidgetId =
  | 'weather'
  | 'today'
  | 'upcoming'
  | 'notes'
  | 'meals'
  | 'lists'

type SortableHomeWidgetProps = {
  id: HomeWidgetId
  enabled: boolean
  order: number
  className: string
  children: import('react').ReactNode
}

function SortableHomeWidget({
  id,
  enabled,
  order,
  className,
  children,
}: SortableHomeWidgetProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: !enabled,
  })

  return (
    <section
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={className}
      style={{
        order,
        transform:
          CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.72 : 1,
        zIndex: isDragging ? 30 : undefined,
        touchAction: enabled
          ? 'none'
          : undefined,
      }}
    >
      {children}
    </section>
  )
}

function SortableListItem({
  item,
  isEditing,
  editingText,
  editingCategory = 'General',
  editingStoreId = null,
  showStore = false,
  stores = [],
  canDrag = true,
  onEditingTextChange,
  onEditingCategoryChange = () => {},
  onEditingStoreChange = () => {},
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onToggle,
  onDelete,
  swipeSide,
  onSwipeChange,
}: SortableListItemProps) {
  const { active } = useDndContext()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: item.id,
      disabled: !canDrag,
      // Reordering should only move rows during a gesture. Layout animations
      // on first render can leave stale dnd-kit offsets in iPhone Safari.
      animateLayoutChanges: () => false,
    })
  const moveDuringDrag = canDrag && active !== null

  // Signed offset: positive = Edit on the left, negative = Delete on the right.
  const [swipeOffset, setSwipeOffset] = useState(0)
  // A new badge node after a swipe prevents stale iOS Safari text layers.
  const [badgeRevision, setBadgeRevision] = useState(0)
  const offsetRef = useRef(0)
  const suppressClickRef = useRef(0)
  const gestureRef = useRef({
    pointerId: -1, startX: 0, startY: 0, originalOffset: 0, dragging: false,
  })
  function setOffset(next: number) {
    offsetRef.current = next
    setSwipeOffset(next)
  }
  useEffect(() => {
    if (gestureRef.current.pointerId !== -1) return
    setOffset(swipeSide === 'edit' ? 94 : swipeSide === 'delete' ? -94 : 0)
    setBadgeRevision(value => value + 1)
  }, [swipeSide])
  function swipeStart(event: PointerEvent<HTMLDivElement>) {
    if (window.innerWidth > 760 || event.pointerType === 'mouse' || isEditing || isDragging) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, .list-item-grip, .list-item-swipe-action')) return
    gestureRef.current = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      originalOffset: offsetRef.current, dragging: false,
    }
  }
  function swipeMove(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (gesture.pointerId !== event.pointerId) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (!gesture.dragging) {
      // Vertical scroll always wins; never hijack a normal scroll gesture.
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
        gesture.pointerId = -1
        return
      }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return
      gesture.dragging = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setOffset(Math.max(-94, Math.min(94, gesture.originalOffset + dx)))
  }
  function swipeEnd(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const gesture = gestureRef.current
    if (gesture.pointerId !== event.pointerId) return
    gesture.pointerId = -1
    if (!gesture.dragging) return
    suppressClickRef.current = performance.now() + 450
    const next = cancelled ? gesture.originalOffset : offsetRef.current
    const side = next >= 44 ? 'edit' : next <= -44 ? 'delete' : null
    onSwipeChange(side)
    setOffset(side === 'edit' ? 94 : side === 'delete' ? -94 : 0)
    setBadgeRevision(value => value + 1)
  }

  return (
    <div ref={setNodeRef}
      style={{
        // dnd-kit must not transform rows when no drag is active.
        // This avoids clipping the first grips until the initial drag remeasures them.
        transform: moveDuringDrag && transform ? CSS.Transform.toString(transform) : undefined,
        transition: moveDuringDrag ? transition : undefined,
        opacity: isDragging ? .6 : 1,
      }}
      className="list-item-swipe-shell"
      data-list-item-id={item.id}
      onPointerDown={swipeStart}
      onPointerMove={swipeMove}
      onPointerUp={swipeEnd}
      onPointerCancel={event => swipeEnd(event, true)}
      onClickCapture={event => {
        if ((event.target as HTMLElement).closest('.list-item-swipe-action')) return
        if (performance.now() < suppressClickRef.current) {
          event.preventDefault()
          event.stopPropagation()
        } else if (swipeSide !== null) {
          onSwipeChange(null)
          if (!(event.target as HTMLElement).closest('input[type="checkbox"]')) {
            event.preventDefault()
            event.stopPropagation()
          }
        }
      }}>
      <button type="button" className="list-item-swipe-action list-item-swipe-edit"
        style={{opacity: swipeOffset > 0 ? 1 : 0, pointerEvents: swipeOffset > 0 ? 'auto' : 'none'}}
        aria-label={`Edit ${item.text}`}
        onFocus={() => { if (window.innerWidth <= 760) onSwipeChange('edit') }}
        onClick={() => {onSwipeChange(null);onStartEdit(item)}}>Edit</button>
      <button type="button" className="list-item-swipe-action list-item-swipe-delete"
        style={{opacity: swipeOffset < 0 ? 1 : 0, pointerEvents: swipeOffset < 0 ? 'auto' : 'none'}}
        aria-label={`Delete ${item.text}`}
        onFocus={() => { if (window.innerWidth <= 760) onSwipeChange('delete') }}
        onClick={() => {onSwipeChange(null);onDelete(item.id)}}>Delete</button>
      <div className={`list-item-row list-item-swipe-foreground ${item.completed ? 'list-item-completed' : ''}`}
        style={{ left: swipeOffset === 0 ? undefined : `${swipeOffset}px`,
          transition: gestureRef.current.dragging ? 'none' : 'left 175ms ease-out' }}>
        <label className="list-item-checkbox-zone">
          <input type="checkbox" checked={item.completed}
            onChange={() => onToggle(item)}
            aria-label={`${item.completed ? 'Uncheck' : 'Check off'} ${item.text}`} />
        </label>
        {isEditing ? (
          <div className="list-item-edit-area">
            <div className="list-item-edit-fields">
              <input className="event-input" type="text" aria-label="Item name"
                maxLength={200} value={editingText}
                onChange={event => onEditingTextChange(event.target.value)} />
              <input className="event-input" type="text" aria-label="Item category"
                list="list-category-suggestions" maxLength={40}
                placeholder="Category (e.g. Produce)" value={editingCategory}
                onChange={event => onEditingCategoryChange(event.target.value)} />
              {showStore && <label className="list-store-edit-label">Store
                <select className="event-input" value={editingStoreId ?? ''}
                  onChange={event => onEditingStoreChange(event.target.value ? Number(event.target.value) : null)}>
                  <option value="">Unsorted</option>
                  {stores.map(store => <option key={store.id} value={store.id}>
                    {store.name}{!store.enabled ? ' (hidden)' : ''}
                  </option>)}
                </select>
              </label>}
            </div>
            <button type="button" onClick={() => onSaveEdit(item.id)}>Save</button>
            <button type="button" onClick={onCancelEdit}>Cancel</button>
          </div>
        ) : <>
          <button className="list-item-complete-text" type="button"
            aria-label={`${item.completed ? 'Uncheck' : 'Check off'} ${item.text}`}
            onClick={() => onToggle(item)}>
            <span className="list-item-name">{item.text}</span>
          </button>
          {item.category && item.category !== 'General' && (
            <span
              key={`${item.id}-${badgeRevision}`}
              className="list-category-pill list-item-category-tag"
              title={item.category}
              aria-label={`Category: ${item.category}`}
            >{item.category}</span>
          )}
          {canDrag && <button className="list-item-grip" type="button"
            aria-label={`Reorder ${item.text}`} title="Drag to reorder"
            {...attributes} {...listeners}>
            <span className="list-item-grip-face" aria-hidden="true">
              <svg className="list-item-grip-icon" viewBox="0 0 24 24"
                width="18" height="18" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round">
                <path d="M5 7h14M5 12h14M5 17h14" />
              </svg>
            </span>
          </button>}
          <button className="list-item-edit-button" type="button"
            onClick={() => onStartEdit(item)}>Edit</button>
          <button className="list-item-delete" type="button"
            onClick={() => onDelete(item.id)}>Delete</button>
        </>}
      </div>
    </div>
  )
}

async function prepareCaptureImage(
  file: File
): Promise<File> {
  try {
    const image =
      await createImageBitmap(file)

    const maxDimension = 1280
    const longestSide = Math.max(
      image.width,
      image.height
    )

    const scale =
      longestSide > maxDimension
        ? maxDimension / longestSide
        : 1

    const width = Math.max(
      1,
      Math.round(
        image.width * scale
      )
    )

    const height = Math.max(
      1,
      Math.round(
        image.height * scale
      )
    )

    const canvas =
      document.createElement('canvas')

    canvas.width = width
    canvas.height = height

    const context =
      canvas.getContext('2d')

    if (!context) {
      image.close()
      return file
    }

    context.drawImage(
      image,
      0,
      0,
      width,
      height
    )

    image.close()

    const blob =
      await new Promise<Blob | null>(
        (resolve) => {
          canvas.toBlob(
            resolve,
            'image/webp',
            0.83
          )
        }
      )

    if (!blob) {
      return file
    }

    const baseName =
      file.name.replace(
        /\.[^/.]+$/,
        ''
      ) || 'capture'

    return new File(
      [blob],
      `${baseName}.webp`,
      {
        type: 'image/webp',
        lastModified: Date.now(),
      }
    )
  } catch {
    return file
  }
}

function App() {
  const today = new Date()

const [page, setPage] =
  useState<
    'home' |
    'calendar' |
    'meals' |
    'people' |
    'lists' |
    'capture'
  >('home')

const [isEditingHome, setIsEditingHome] =
  useState(false)
const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false)
const [familyAuthEnabled, setFamilyAuthEnabled] = useState(false)

useEffect(() => {
  let cancelled = false
  fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => response.ok ? response.json() : null)
    .then((status) => {
      if (!cancelled) setFamilyAuthEnabled(status?.enabled === true)
    })
    .catch(() => {
      if (!cancelled) setFamilyAuthEnabled(false)
    })
  return () => { cancelled = true }
}, [])

  const [homeWeatherSize, setHomeWeatherSize] =
  useState<'small' | 'medium' | 'large'>(
    'medium'
  )

  const [homeTodaySize, setHomeTodaySize] =
  useState<'small' | 'medium' | 'large'>(
    'medium'
  )

const [homeUpcomingSize, setHomeUpcomingSize] =
  useState<'small' | 'medium' | 'large'>(
    'small'
  )

const [homeNotesSize, setHomeNotesSize] =
  useState<'small' | 'medium' | 'large'>(
    'medium'
  )

const [homeMealsSize, setHomeMealsSize] =
  useState<'small' | 'medium' | 'large'>(
    'medium'
  )

const [homeListsSize, setHomeListsSize] =
  useState<'small' | 'medium' | 'large'>(
    'large'
  )

const [homeWidgetOrder, setHomeWidgetOrder] =
  useState<HomeWidgetId[]>([
    'weather',
    'today',
    'upcoming',
    'notes',
    'meals',
    'lists',
  ])

  const homeEditHoldRef = useRef({
  timer: null as number | null,
  startX: 0,
  startY: 0,
})

const [mealsView, setMealsView] =
  useState<'recipes' | 'planner'>(() =>
    window.innerWidth <= 760
      ? 'planner'
      : 'recipes'
  )
  const [
  mealPlannerWeekStart,
  setMealPlannerWeekStart,
] = useState(() => {
  const today = new Date()

  today.setHours(12, 0, 0, 0)
  today.setDate(
    today.getDate() - today.getDay()
  )

  return today
})

const [
  mobileMealsDate,
  setMobileMealsDate,
] = useState(() => {
  const date = new Date()

  date.setHours(12, 0, 0, 0)

  return date
})

useEffect(() => {
  if (page === 'meals') {
    return
  }

  const currentDate =
    new Date()

  currentDate.setHours(
    12,
    0,
    0,
    0
  )

  setMobileMealsDate(
    currentDate
  )

  const currentWeekStart =
    new Date(currentDate)

  currentWeekStart.setDate(
    currentWeekStart.getDate() -
      currentWeekStart.getDay()
  )

  setMealPlannerWeekStart(
    currentWeekStart
  )
}, [page])

const [
  mobileMealsDragX,
  setMobileMealsDragX,
] = useState(0)

const [
  mobileMealsSettling,
  setMobileMealsSettling,
] = useState(false)

const mobileMealsPagerRef =
  useRef<HTMLDivElement | null>(null)

const mobileMealsSettleTimerRef =
  useRef<number | null>(null)

const mobileMealsSuppressClickUntilRef =
  useRef(0)

const mobileMealsGestureRef = useRef({
  pointerId: -1,
  startX: 0,
  startY: 0,
  horizontal: false,
})

const [
  mealPlannerListPickerOpen,
  setMealPlannerListPickerOpen,
] = useState(false)
const mealPlannerScrollRef =
  useRef<HTMLDivElement | null>(null)

const mealPlannerSwipeStartXRef =
  useRef<number | null>(null)

const mealPlannerSwipeStartYRef =
  useRef<number | null>(null)

function resetMealPlannerScroll() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      mealPlannerScrollRef.current?.scrollTo({
        left: 0,
        behavior: 'smooth',
      })
    })
  })
}

const [mealPlanFormOpen, setMealPlanFormOpen] =
  useState(false)
  const [
  mealPlanFormSource,
  setMealPlanFormSource,
] = useState<'planner' | 'recipe'>(
  'planner'
)
const [
  editingMealPlanItemId,
  setEditingMealPlanItemId,
] = useState<number | null>(null)

const [
  mealPlanDeleteConfirmOpen,
  setMealPlanDeleteConfirmOpen,
] = useState(false)
const [mealPlanFormDate, setMealPlanFormDate] =
  useState('')

const [
  mealPlanFormMealType,
  setMealPlanFormMealType,
] = useState<MealPlanItem['mealType']>(
  'dinner'
)

const [
  mealPlanEntryMode,
  setMealPlanEntryMode,
] = useState<'recipe' | 'custom'>(
  'recipe'
)

const [
  mealPlanRecipeId,
  setMealPlanRecipeId,
] = useState('')

const [
  mealPlanCustomTitle,
  setMealPlanCustomTitle,
] = useState('')

const [
  mealPlanNotes,
  setMealPlanNotes,
] = useState('')
const [mealPickerSearch, setMealPickerSearch] = useState('')

const [
  mealPickerKeyboardOpen,
  setMealPickerKeyboardOpen,
] = useState(false)
const [calendarView, setCalendarView] = useState<'month' | 'week' | 'day' | 'schedule'>('month')
const mobileNavItems = [
  {
    id: 'today',
    label: 'Home',
  },
  {
    id: 'calendar',
    label: 'Calendar',
  },
  {
    id: 'schedule',
    label: 'Schedule',
  },
  {
    id: 'meals',
    label: 'Meals',
  },
  {
    id: 'lists',
    label: 'Lists',
  },
] as const

type MobileNavId =
  (typeof mobileNavItems)[number]['id']

const mobileNavSliderWidth = 148

const [mobileNavDragX, setMobileNavDragX] =
  useState(0)

const [
  mobileNavSettling,
  setMobileNavSettling,
] = useState(false)

const mobileNavGestureRef = useRef({
  pointerId: -1,
  startX: 0,
  startY: 0,
  deltaX: 0,
  horizontal: false,
  vertical: false,
})

const mobileNavSettleTimerRef =
  useRef<number | null>(null)

const mobileNavActiveId: MobileNavId =
  page === 'home'
    ? 'today'
    : page === 'calendar' &&
        calendarView === 'schedule'
      ? 'schedule'
      : page === 'calendar'
        ? 'calendar'
        : page === 'meals'
          ? 'meals'
          : page === 'lists'
            ? 'lists'
            : 'today'

const mobileNavActiveIndex =
  mobileNavItems.findIndex(
    (item) =>
      item.id === mobileNavActiveId
  )

const mobileNavPreviousIndex =
  (
    mobileNavActiveIndex -
    1 +
    mobileNavItems.length
  ) % mobileNavItems.length

const mobileNavNextIndex =
  (
    mobileNavActiveIndex +
    1
  ) % mobileNavItems.length

const mobileNavPreviousItem =
  mobileNavItems[
    mobileNavPreviousIndex
  ]

const mobileNavActiveItem =
  mobileNavItems[
    mobileNavActiveIndex
  ]

const mobileNavNextItem =
  mobileNavItems[
    mobileNavNextIndex
  ]

 useEffect(() => {
  const resetVerticalScroll = () => {
    window.scrollTo({
      top: 0,
      behavior: 'auto',
    })

    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0

    document
  .querySelectorAll<HTMLElement>('*')
  .forEach((element) => {
    if (
      element.classList.contains(
        'schedule-scroll'
      )
    ) {
      return
    }

    if (element.scrollTop !== 0) {
      element.scrollTop = 0
    }
  })
  }

  resetVerticalScroll()

  const firstFrame =
    window.requestAnimationFrame(() => {
      resetVerticalScroll()
    })

  const settleTimer =
    window.setTimeout(() => {
      resetVerticalScroll()
    }, 250)

  return () => {
    window.cancelAnimationFrame(
      firstFrame
    )

    window.clearTimeout(
      settleTimer
    )
  }
}, [page, calendarView])

function openMobileNavItem(
  id: MobileNavId
) {
  if (id === 'today') {
    setPage('home')
    return
  }

  if (id === 'calendar') {
    setCalendarView('month')
    setPage('calendar')
    return
  }

  if (id === 'schedule') {
    setCalendarView('schedule')

    setWeekDate(
      new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      )
    )

    setPage('calendar')
    return
  }

  if (id === 'meals') {
    setPage('meals')
    return
  }

  setPage('lists')
}

function handleMobileNavPointerDown(
  event: PointerEvent<HTMLDivElement>
) {
  if (mobileNavSettling) {
    return
  }

  if (
    mobileNavSettleTimerRef.current !==
    null
  ) {
    window.clearTimeout(
      mobileNavSettleTimerRef.current
    )

    mobileNavSettleTimerRef.current =
      null
  }

  mobileNavGestureRef.current = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    deltaX: 0,
    horizontal: false,
    vertical: false,
  }

  event.currentTarget.setPointerCapture(
    event.pointerId
  )
}

function handleMobileNavPointerMove(
  event: PointerEvent<HTMLDivElement>
) {
  const gesture =
    mobileNavGestureRef.current

  if (
    gesture.pointerId !==
    event.pointerId
  ) {
    return
  }

  const deltaX =
    event.clientX - gesture.startX

  const deltaY =
    event.clientY - gesture.startY

  if (
    !gesture.horizontal &&
    !gesture.vertical
  ) {
    if (
      Math.abs(deltaX) < 7 &&
      Math.abs(deltaY) < 7
    ) {
      return
    }

    if (
      Math.abs(deltaY) >
      Math.abs(deltaX)
    ) {
      gesture.vertical = true
      return
    }

    gesture.horizontal = true
  }

  if (!gesture.horizontal) {
    return
  }

  gesture.deltaX = deltaX

  setMobileNavDragX(
    Math.max(
      -mobileNavSliderWidth,
      Math.min(
        mobileNavSliderWidth,
        deltaX
      )
    )
  )
}

function finishMobileNavGesture(
  event: PointerEvent<HTMLDivElement>
) {
  const gesture =
    mobileNavGestureRef.current

  if (
    gesture.pointerId !==
    event.pointerId
  ) {
    return
  }

  const deltaX =
    gesture.deltaX

  const shouldChange =
    gesture.horizontal &&
    Math.abs(deltaX) >= 42

  mobileNavGestureRef.current = {
    pointerId: -1,
    startX: 0,
    startY: 0,
    deltaX: 0,
    horizontal: false,
    vertical: false,
  }

  if (!shouldChange) {
    setMobileNavSettling(true)
    setMobileNavDragX(0)

    mobileNavSettleTimerRef.current =
      window.setTimeout(() => {
        setMobileNavSettling(false)

        mobileNavSettleTimerRef.current =
          null
      }, 180)

    return
  }

  const targetItem =
    deltaX < 0
      ? mobileNavNextItem
      : mobileNavPreviousItem

  setMobileNavSettling(true)

  setMobileNavDragX(
    deltaX < 0
      ? -mobileNavSliderWidth
      : mobileNavSliderWidth
  )

  mobileNavSettleTimerRef.current =
    window.setTimeout(() => {
      openMobileNavItem(
        targetItem.id
      )

      setMobileNavDragX(0)
      setMobileNavSettling(false)

      mobileNavSettleTimerRef.current =
        null
    }, 180)
}

function cancelMobileNavGesture() {
  mobileNavGestureRef.current = {
    pointerId: -1,
    startX: 0,
    startY: 0,
    deltaX: 0,
    horizontal: false,
    vertical: false,
  }

  setMobileNavSettling(true)
  setMobileNavDragX(0)

  mobileNavSettleTimerRef.current =
    window.setTimeout(() => {
      setMobileNavSettling(false)

      mobileNavSettleTimerRef.current =
        null
    }, 180)
}
  const [viewDate, setViewDate] = useState(
    new Date(today.getFullYear(), today.getMonth(), 1)
  )
const [weekDate, setWeekDate] = useState(
  new Date(today.getFullYear(), today.getMonth(), today.getDate())
)

const [
  mobileScheduleBufferCenterDate,
  setMobileScheduleBufferCenterDate,
] = useState(
  new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  )
)

const mobileSchedulePagerRef =
  useRef<HTMLDivElement | null>(null)



const mobileScheduleScrollEndTimerRef =
  useRef<number | null>(null)

const mobileScheduleEmptyTapRef = useRef({
  time: 0,
  dateKey: '',
  hour: -1,
  x: 0,
  y: 0,
})

const mobileScheduleSuppressClickUntilRef =
  useRef(0)
function resetMobileMealsSwipeGesture() {
  const gesture =
    mobileMealsGestureRef.current

  gesture.pointerId = -1
  gesture.startX = 0
  gesture.startY = 0
  gesture.horizontal = false
}

function springMobileMealsBack() {
  setMobileMealsSettling(true)
  setMobileMealsDragX(0)

  if (
    mobileMealsSettleTimerRef.current !==
    null
  ) {
    window.clearTimeout(
      mobileMealsSettleTimerRef.current
    )
  }

  mobileMealsSettleTimerRef.current =
    window.setTimeout(() => {
      setMobileMealsSettling(false)

      mobileMealsSettleTimerRef.current =
        null
    }, 220)
}

function handleMobileMealsSwipePointerDown(
  event: PointerEvent<HTMLDivElement>
) {
  if (
    window.innerWidth > 760 ||
    mealsView !== 'planner' ||
    mobileMealsSettling
  ) {
    return
  }

  const gesture =
    mobileMealsGestureRef.current

  gesture.pointerId =
    event.pointerId

  gesture.startX =
    event.clientX

  gesture.startY =
    event.clientY

  gesture.horizontal = false
}

function handleMobileMealsSwipePointerMove(
  event: PointerEvent<HTMLDivElement>
) {
  const gesture =
    mobileMealsGestureRef.current

  if (
    gesture.pointerId !==
      event.pointerId ||
    mobileMealsSettling
  ) {
    return
  }

  const movedX =
    event.clientX -
    gesture.startX

  const movedY =
    event.clientY -
    gesture.startY

  if (!gesture.horizontal) {
    if (
      Math.abs(movedX) < 8 &&
      Math.abs(movedY) < 8
    ) {
      return
    }

    if (
      Math.abs(movedY) >=
      Math.abs(movedX)
    ) {
      resetMobileMealsSwipeGesture()
      return
    }

    gesture.horizontal = true

    event.currentTarget.setPointerCapture(
      event.pointerId
    )
  }

  const pagerWidth =
    mobileMealsPagerRef.current
      ?.clientWidth ??
    window.innerWidth

  const maximumDrag =
    pagerWidth * 0.92

  setMobileMealsDragX(
    Math.max(
      -maximumDrag,
      Math.min(
        maximumDrag,
        movedX
      )
    )
  )
}

function finishMobileMealsSwipe(
  event: PointerEvent<HTMLDivElement>
) {
  const gesture =
    mobileMealsGestureRef.current

  if (
    gesture.pointerId !==
    event.pointerId
  ) {
    return
  }

  const movedX =
    event.clientX -
    gesture.startX

  const wasHorizontal =
    gesture.horizontal

  resetMobileMealsSwipeGesture()

  if (!wasHorizontal) {
    return
  }

  mobileMealsSuppressClickUntilRef.current =
    performance.now() + 450

  const pagerWidth =
    mobileMealsPagerRef.current
      ?.clientWidth ??
    window.innerWidth

  const threshold =
    Math.min(
      110,
      Math.max(
        70,
        pagerWidth * 0.22
      )
    )

  if (
    Math.abs(movedX) <
    threshold
  ) {
    springMobileMealsBack()
    return
  }

  const dayChange =
    movedX < 0
      ? 1
      : -1

  setMobileMealsSettling(true)

  setMobileMealsDragX(
    dayChange === 1
      ? -pagerWidth
      : pagerWidth
  )

  if (
    mobileMealsSettleTimerRef.current !==
    null
  ) {
    window.clearTimeout(
      mobileMealsSettleTimerRef.current
    )
  }

  mobileMealsSettleTimerRef.current =
    window.setTimeout(() => {
      setMobileMealsDate(
        (currentDate) => {
          const nextDate =
            new Date(currentDate)

          nextDate.setDate(
            nextDate.getDate() +
              dayChange
          )

          return nextDate
        }
      )

      setMobileMealsSettling(false)
      setMobileMealsDragX(0)

      mobileMealsSettleTimerRef.current =
        null
    }, 220)
}

function cancelMobileMealsSwipe(
  event: PointerEvent<HTMLDivElement>
) {
  const gesture =
    mobileMealsGestureRef.current

  if (
    gesture.pointerId !==
    event.pointerId
  ) {
    return
  }

  const wasHorizontal =
    gesture.horizontal

  resetMobileMealsSwipeGesture()

  if (wasHorizontal) {
    mobileMealsSuppressClickUntilRef.current =
      performance.now() + 450

    springMobileMealsBack()
  }
}

function renderMobileMealPlannerDay(
  targetDate: Date
) {
  const dateKey =
    getDateKeyFromDate(
      targetDate
    )

  const mealTypes = [
    {
      key: 'breakfast',
      label: 'Breakfast',
    },
    {
      key: 'lunch',
      label: 'Lunch',
    },
    {
      key: 'dinner',
      label: 'Dinner',
    },
    {
      key: 'snack',
      label: 'Snack',
    },
  ] as const

  return (
    <div className="mobile-meal-planner-grid">
      {mealTypes.map(
        ({
          key: mealType,
          label,
        }) => {
          const meal =
            mealPlanItems.find(
              (item) =>
                item.date ===
                  dateKey &&
                item.mealType ===
                  mealType
            )

          return (
            <div
              className={`mobile-meal-planner-row mobile-meal-planner-row-${mealType}`}
              key={mealType}
            >
              <div className="mobile-meal-planner-label">
                {label}
              </div>

              <div className="mobile-meal-planner-cell">
                {meal ? (
                  <button
                    type="button"
                    className="meal-planner-meal meal-planner-matrix-meal mobile-meal-planner-meal"
                    onClick={() => {
                      if (
                        performance.now() <
                        mobileMealsSuppressClickUntilRef.current
                      ) {
                        return
                      }

                      openEditMealPlanForm(
                        meal
                      )
                    }}
                  >
                    {meal.recipeImage && (
                      <img
                        className="meal-planner-meal-image mobile-meal-planner-image"
                        src={`/uploads/${meal.recipeImage}`}
                        alt=""
                      />
                    )}

                    <div className="meal-planner-meal-text mobile-meal-planner-text">
                      <strong>
                        {meal.title}
                      </strong>

                      {meal.notes && (
                        <span>
                          {meal.notes}
                        </span>
                      )}
                    </div>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="meal-planner-matrix-empty mobile-meal-planner-empty"
                    onClick={() => {
                      if (
                        performance.now() <
                        mobileMealsSuppressClickUntilRef.current
                      ) {
                        return
                      }

                      openMealPlanForm(
                        dateKey,
                        mealType
                      )
                    }}
                  >
                    + Add meal
                  </button>
                )}
              </div>
            </div>
          )
        }
      )}
    </div>
  )
}

const mobileScheduleMinDate =
  new Date(
    today.getFullYear(),
    today.getMonth() - 3,
    today.getDate()
  )

const mobileScheduleMaxDate =
  new Date(
    today.getFullYear(),
    today.getMonth() + 6,
    today.getDate()
  )

const normalizedMobileScheduleDate =
  new Date(
    weekDate.getFullYear(),
    weekDate.getMonth(),
    weekDate.getDate()
  )

const mobileScheduleDate =
  normalizedMobileScheduleDate <
  mobileScheduleMinDate
    ? mobileScheduleMinDate
    : normalizedMobileScheduleDate >
        mobileScheduleMaxDate
      ? mobileScheduleMaxDate
      : normalizedMobileScheduleDate

const mobileScheduleBufferStartDate =
  new Date(mobileScheduleBufferCenterDate)

mobileScheduleBufferStartDate.setDate(
  mobileScheduleBufferStartDate.getDate() -
    15
)

const mobileScheduleLatestBufferStart =
  new Date(mobileScheduleMaxDate)

mobileScheduleLatestBufferStart.setDate(
  mobileScheduleLatestBufferStart.getDate() -
    30
)

if (
  mobileScheduleBufferStartDate <
  mobileScheduleMinDate
) {
  mobileScheduleBufferStartDate.setTime(
    mobileScheduleMinDate.getTime()
  )
}

if (
  mobileScheduleBufferStartDate >
  mobileScheduleLatestBufferStart
) {
  mobileScheduleBufferStartDate.setTime(
    Math.max(
      mobileScheduleMinDate.getTime(),
      mobileScheduleLatestBufferStart.getTime()
    )
  )
}

const mobileScheduleBufferedDates =
  Array.from(
    {
      length: 31,
    },
    (_, index) => {
      const date =
        new Date(
          mobileScheduleBufferStartDate
        )

      date.setDate(
        date.getDate() + index
      )

      return date
    }
  ).filter(
    (date) =>
      date >= mobileScheduleMinDate &&
      date <= mobileScheduleMaxDate
  )

const mobileScheduleDateKey =
  getDateKeyFromDate(
    mobileScheduleDate
  )

const mobileScheduleSelectedBufferIndex =
  mobileScheduleBufferedDates.findIndex(
    (date) =>
      getDateKeyFromDate(date) ===
      mobileScheduleDateKey
  )

useLayoutEffect(() => {
  if (
    page !== 'calendar' ||
    calendarView !== 'schedule'
  ) {
    return
  }

  const pager =
    mobileSchedulePagerRef.current

  if (
    !pager ||
    mobileScheduleSelectedBufferIndex < 0
  ) {
    return
  }

  pager.scrollLeft =
    mobileScheduleSelectedBufferIndex *
    pager.clientWidth
}, [
  page,
  calendarView,
  mobileScheduleDateKey,
  mobileScheduleBufferCenterDate,
])

useEffect(() => {
  if (
    mobileScheduleSelectedBufferIndex < 0 ||
    mobileScheduleSelectedBufferIndex <= 3 ||
    mobileScheduleSelectedBufferIndex >=
      mobileScheduleBufferedDates.length - 4
  ) {
    const bufferCenterKey =
      getDateKeyFromDate(
        mobileScheduleBufferCenterDate
      )

    if (
      bufferCenterKey !==
      mobileScheduleDateKey
    ) {
      setMobileScheduleBufferCenterDate(
        new Date(mobileScheduleDate)
      )
    }
  }
}, [
  mobileScheduleDateKey,
  mobileScheduleSelectedBufferIndex,
  mobileScheduleBufferedDates.length,
])



  
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
const [monthEventsOpen, setMonthEventsOpen] =
  useState(false)
  const [eventTitle, setEventTitle] = useState('')
  const [eventTitleError, setEventTitleError] = useState(false)
  const [eventTime, setEventTime] = useState('')
  const [eventEndTime, setEventEndTime] = useState('')
  const [eventTimeError, setEventTimeError] = useState(false)
  const [eventStartDateError, setEventStartDateError] = useState(false)
const [eventEndDateError, setEventEndDateError] = useState(false)
  const [eventAllDay, setEventAllDay] = useState(true)
  const [eventStartDateText, setEventStartDateText] = useState('')
  const [eventStartDate, setEventStartDate] = useState('')
  const [eventEndDate, setEventEndDate] = useState('')
  const [eventEndDateText, setEventEndDateText] = useState('')
  const [eventDateMode, setEventDateMode] =
  useState<'single' | 'multiple'>('single')

const [eventMultipleDates, setEventMultipleDates] =
  useState<string[]>([])

  const [multipleDatePickerOpen, setMultipleDatePickerOpen] =
  useState(false)

const [pendingMultipleDates, setPendingMultipleDates] =
  useState<string[]>([])

const [
  multipleDateCalendarMonth,
  setMultipleDateCalendarMonth,
] = useState(
  new Date(
    today.getFullYear(),
    today.getMonth(),
    1
  )
)
  const [eventNotes, setEventNotes] = useState('')
  const [eventLocation, setEventLocation] = useState('')
  const [repeatUnit, setRepeatUnit] = useState('none')
const [repeatInterval, setRepeatInterval] = useState(1)
const [repeatEndType, setRepeatEndType] = useState('never')
const [repeatEndDate, setRepeatEndDate] = useState('')
const [repeatEndDateText, setRepeatEndDateText] = useState('')
const [repeatEndDateError, setRepeatEndDateError] = useState(false)
const [repeatCount, setRepeatCount] = useState(10)
  const [selectedPersonIds, setSelectedPersonIds] = useState<number[]>([])

  const [editingEventId, setEditingEventId] = useState<number | null>(null)
  const [duplicateSourceEventId, setDuplicateSourceEventId] = useState<number | null>(null)
  const [viewingEventId, setViewingEventId] =
  useState<number | null>(null)

const [viewingOccurrenceDate, setViewingOccurrenceDate] =
  useState<string | null>(null)
  const [
  detailsDeleteConfirmOpen,
  setDetailsDeleteConfirmOpen,
] = useState(false)
  const [isAddingEvent, setIsAddingEvent] = useState(false)
const [quickAddOpen, setQuickAddOpen] = useState(false)

const calendarAddHoldTimerRef =
  useRef<number | null>(null)

const calendarAddLongPressRef =
  useRef(false)

const [aiCommandOpen, setAiCommandOpen] =
  useState(false)

const [aiCommandText, setAiCommandText] =
  useState('')

const [aiCommandLoading, setAiCommandLoading] =
  useState(false)

const [aiCommandResult, setAiCommandResult] =
  useState('')

const [
  aiCancellationPreview,
  setAiCancellationPreview,
] = useState<any | null>(null)

const [
  aiReschedulePreview,
  setAiReschedulePreview,
] = useState<any | null>(null)

const [
  aiClarificationAnswer,
  setAiClarificationAnswer,
] = useState('')

const [quickListOpen, setQuickListOpen] = useState(false)
const [quickListId, setQuickListId] = useState<number | null>(null)
const [quickListText, setQuickListText] = useState('')
const [captureOpen, setCaptureOpen] = useState(false)
const [
  multiEventReview,
  setMultiEventReview,
] = useState<{
  analysis: CaptureAnalysis
  note: string
} | null>(null)

const [
  selectedCaptureId,
  setSelectedCaptureId,
] = useState<number | null>(null)
const [
  captureAnalyzingId,
  setCaptureAnalyzingId,
] = useState<number | null>(null)
const [captureFile, setCaptureFile] = useState<File | null>(null)
const [capturePreviewUrl, setCapturePreviewUrl] = useState('')
const [captureNote, setCaptureNote] = useState('')
const [captureSaving, setCaptureSaving] = useState(false)
const [listCreateOpen, setListCreateOpen] = useState(false)
const [newListIcon, setNewListIcon] = useState<string | null>(null)
const [listIconPickerTarget, setListIconPickerTarget] = useState<'create' | number | null>(null)
const [listNameEditing, setListNameEditing] = useState(false)
  const [sidebarContentChanging, setSidebarContentChanging] = useState(false)
  const [calendarViewChanging, setCalendarViewChanging] = useState(false)
  const [eventModalClosing, setEventModalClosing] =
  useState(false)
  const [recurringAction, setRecurringAction] =
  useState<
    'save' | 'delete' | 'batch-save' | null
  >(null)
const [editingOccurrenceDate, setEditingOccurrenceDate] = useState<string | null>(null)
const [appNotification, setAppNotification] = useState<string | null>(null)
const appNotificationTimerRef = useRef<number | null>(null)
const familySliderRef = useRef<HTMLDivElement | null>(null)

const familySliderDragRef = useRef({
  isDragging: false,
  startX: 0,
  startScrollLeft: 0,
})

const familySliderSnapTimerRef =
  useRef<number | null>(null)

const familySliderAnimationRef =
  useRef<number | null>(null)

const familySliderIsSnappingRef =
  useRef(false)
  const familySliderPointerRef = useRef({
  startX: 0,
  startY: 0,
  moved: false,
})

const weekPagerRef =
  useRef<HTMLDivElement | null>(null)
const dayPagerRef =
  useRef<HTMLDivElement | null>(null)
const dayPagerScrollEndTimerRef =
  useRef<number | null>(null)
const dayPagerTrackRef =
  useRef<HTMLDivElement | null>(null)

const [
  scheduleDayWidth,
  setScheduleDayWidth,
] = useState(190)
const [
  expandedScheduleAllDayDates,
  setExpandedScheduleAllDayDates,
] = useState<Set<string>>(
  () => new Set()
)
  const scheduleScrollRef = useRef<HTMLDivElement | null>(null)
const dayTimelineScrollRef =
  useRef<HTMLDivElement | null>(null)
  

  const scheduleScrollSettleTimerRef =
  useRef<number | null>(null)

const scheduleSnapAnimationRef =
  useRef<number | null>(null)

const scheduleLastScrollLeftRef =
  useRef(0)

const scheduleHorizontalMovedRef =
  useRef(false)

const scheduleSnapAnimatingRef =
  useRef(false)

const weekPagerTrackRef =
  useRef<HTMLDivElement | null>(null)
  const monthPagerTrackRef =
  useRef<HTMLDivElement | null>(null)

const weekPagerGestureRef = useRef({
  pointerId: -1,
  startX: 0,
  startY: 0,
  deltaX: 0,
  horizontal: false,
  vertical: false,
})

const weekPagerPendingDirectionRef =
  useRef<-1 | 0 | 1>(0)

const weekPagerTransitioningRef =
  useRef(false)

const weekPagerSuppressClickUntilRef =
  useRef(0)
  const weekDayScrollResetTimersRef =
  useRef<Record<string, number>>({})
  const calendarSwipeAnimatingRef =
  useRef(false)
useLayoutEffect(() => {
  if (calendarView !== 'week') {
    return
  }

  const frame =
    window.requestAnimationFrame(() => {
      const pager = weekPagerRef.current
      const track = weekPagerTrackRef.current

      if (!pager || !track) {
        return
      }

      const width = pager.clientWidth

      track.style.transition = 'none'
      track.style.transform =
        `translate3d(${-width}px, 0, 0)`
    })

  return () => {
    window.cancelAnimationFrame(frame)
  }
}, [calendarView, weekDate])

useLayoutEffect(() => {
  if (calendarView !== 'day') {
    return
  }

  const frame =
    window.requestAnimationFrame(() => {
      const pager = dayPagerRef.current
      const track = dayPagerTrackRef.current

      if (!pager || !track) {
        return
      }

      const width = pager.clientWidth

      if (
        window.matchMedia(
          '(min-width: 761px)'
        ).matches
      ) {
        track.style.transition = 'none'
        track.style.transform = 'none'

        pager.scrollLeft = width
        return
      }

      track.style.transition = 'none'
      track.style.transform =
        `translate3d(${-width}px, 0, 0)`
    })

  return () => {
    window.cancelAnimationFrame(frame)
  }
}, [calendarView, weekDate])
    
useLayoutEffect(() => {
  if (calendarView !== 'month') {
    return
  }

  const track =
    monthPagerTrackRef.current

  const surface =
    track?.parentElement

  if (!track || !surface) {
    return
  }

  const width =
    surface.clientWidth

  track.style.transition = 'none'

  track.style.transform =
    `translate3d(${-width}px, 0, 0)`

  calendarSwipeAnimatingRef.current =
    false
}, [calendarView, viewDate])
const [
  isCompactMonthLayout,
  setIsCompactMonthLayout,
] = useState(
  () => window.innerWidth <= 1200
)
  const [events, setEvents] = useState<CalendarEvent[]>([])

function positionMobileScheduleTimeline(
  targetDate: Date
) {
  const pager =
    mobileSchedulePagerRef.current

  if (!pager) {
    return
  }

  const targetDateKey =
    getDateKeyFromDate(targetDate)

  const targetPage =
    pager.querySelector<HTMLElement>(
      `.mobile-schedule-page[data-mobile-schedule-date="${targetDateKey}"]`
    )

  const timeline =
    targetPage?.querySelector<HTMLElement>(
      '.mobile-schedule-timeline-scroll'
    )

  if (!timeline) {
    return
  }

  const timedLayouts =
    getScheduleTimedEventLayouts(
      targetDate
    )

  const earliestTimedEvent =
    timedLayouts[0]

  if (!earliestTimedEvent) {
    timeline.scrollTop = 0
    return
  }

  const earliestEventTop =
    (earliestTimedEvent.visibleStart /
      60) *
    56

  timeline.scrollTop =
    Math.max(
      0,
      earliestEventTop - 20
    )
}

  const [people, setPeople] = useState<Person[]>([])
  const [draggedPersonId, setDraggedPersonId] =
  useState<number | null>(null)
const [calendarPersonFilterId, setCalendarPersonFilterId] =
  useState<number | null>(null)
const [lists, setLists] = useState<CalendarList[]>([])
const [shoppingStores, setShoppingStores] = useState<ShoppingStore[]>([])
const [storeFilter, setStoreFilter] = useState('all')
const [shoppingStoreSettingsOpen, setShoppingStoreSettingsOpen] = useState(false)
const [newShoppingStoreName, setNewShoppingStoreName] = useState('')
const [storeSortBusy, setStoreSortBusy] = useState(false)
const [listItemAddOpen, setListItemAddOpen] = useState(false)
const [listMoreOpen, setListMoreOpen] = useState(false)
const [openListSwipe, setOpenListSwipe] = useState<{itemId: number; side: 'edit' | 'delete'} | null>(null)
const [captureInbox, setCaptureInbox] =
  useState<CaptureInboxItem[]>([])
const [dayTimelineNow, setDayTimelineNow] =
  useState(() => new Date())
  useEffect(() => {
  const timer =
    window.setInterval(() => {
      setDayTimelineNow(new Date())
    }, 30000)

  return () => {
    window.clearInterval(timer)
  }
}, [])
const [dayNote, setDayNote] =
  useState('')

const [dayNoteLoading, setDayNoteLoading] =
  useState(false)

const [dayNoteSaving, setDayNoteSaving] =
  useState(false)

const [dayNoteError, setDayNoteError] =
  useState('')
const [newListName, setNewListName] = useState('')
const [selectedListId, setSelectedListId] = useState<number | null>(null)
const [newListItemText, setNewListItemText] = useState('')
const [newListItemCategory, setNewListItemCategory] = useState('General')
const [newListCategoryManuallySet, setNewListCategoryManuallySet] = useState(false)
const [listCategoryFilter, setListCategoryFilter] = useState('All')
const [listSortMode, setListSortMode] = useState<'store' | 'category' | 'custom'>('category')
const [isOrganizingList, setIsOrganizingList] = useState(false)
const [editingListItemId, setEditingListItemId] = useState<number | null>(null)
const [editingListItemText, setEditingListItemText] = useState('')
const [editingListItemCategory, setEditingListItemCategory] = useState('General')
const [editingListItemStoreId, setEditingListItemStoreId] = useState<number | null>(null)
const [editingListItemStoreChanged, setEditingListItemStoreChanged] = useState(false)
const listToggleInFlightRef = useRef(new Set<number>())
const [editingListName, setEditingListName] = useState('')
const [mealPlans, setMealPlans] = useState<MealPlan[]>([])
const [mealPlanItems, setMealPlanItems] =
  useState<MealPlanItem[]>([])
const [recipes, setRecipes] = useState<Recipe[]>([])
const [viewingRecipeId, setViewingRecipeId] =
  useState<number | null>(null)
  const [
  recipeDeleteConfirmOpen,
  setRecipeDeleteConfirmOpen,
] = useState(false)
const [
  recipeListPickerOpen,
  setRecipeListPickerOpen,
] = useState(false)
const [editingRecipeId, setEditingRecipeId] =
  useState<number | null>(null)
const [recipeFormOpen, setRecipeFormOpen] = useState(false)
const [recipeFormSource, setRecipeFormSource] =
  useState<'recipes' | 'meal-picker'>('recipes')
const [recipeName, setRecipeName] = useState('')
const [recipeImageFile, setRecipeImageFile] =
  useState<File | null>(null)
const [recipeImagePreview, setRecipeImagePreview] =
  useState('')
const [recipeFileInputKey, setRecipeFileInputKey] =
  useState(0)
const [recipeServings, setRecipeServings] = useState('')
const [recipePrepTime, setRecipePrepTime] = useState('')
const [recipeCookTime, setRecipeCookTime] = useState('')
const [recipeIngredients, setRecipeIngredients] =
  useState('')
const [recipeInstructions, setRecipeInstructions] =
  useState('')
const [recipeNotes, setRecipeNotes] = useState('')
const [recipeTags, setRecipeTags] = useState('')
const [recipeFavorite, setRecipeFavorite] =
  useState(false)
const [recipeSourceUrl, setRecipeSourceUrl] =
  useState('')
  const [
  recipeSourceImage,
  setRecipeSourceImage,
] = useState('')
const [recipeSearch, setRecipeSearch] = useState('')
const [recipeFilter, setRecipeFilter] =
  useState<
    | 'all'
    | 'favorites'
    | 'breakfast'
    | 'lunch'
    | 'dinner'
    | 'quick'
  >('all')

const filteredRecipes = recipes.filter((recipe) => {
  const searchText =
    recipeSearch.trim().toLowerCase()

  const recipeTags = (recipe.tags ?? '')
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag !== '')

  const matchesSearch =
    searchText === '' ||
    recipe.name
      .toLowerCase()
      .includes(searchText) ||
    (recipe.tags ?? '')
      .toLowerCase()
      .includes(searchText) ||
    recipe.ingredients
      .toLowerCase()
      .includes(searchText) ||
    (recipe.notes ?? '')
      .toLowerCase()
      .includes(searchText)

  const matchesFilter =
    recipeFilter === 'all'
      ? true
      : recipeFilter === 'favorites'
        ? recipe.favorite
        : recipeTags.includes(recipeFilter)

  return matchesSearch && matchesFilter
})

const personColorOptions = [
  {
    name: 'Dusty Rose',
    color: '#E7A8B2',
  },
  {
    name: 'Peach',
    color: '#E8B08A',
  },
  {
    name: 'Soft Gold',
    color: '#E4C878',
  },
  {
    name: 'Sage',
    color: '#9FC3A5',
  },
  {
    name: 'Mint',
    color: '#9FD6C5',
  },
  {
    name: 'Sky',
    color: '#9CC7E8',
  },
  {
    name: 'Periwinkle',
    color: '#A8B0E8',
  },
  {
    name: 'Lavender',
    color: '#C0A8E8',
  },
  {
    name: 'Mauve',
    color: '#D3A7C8',
  },
]

const [personName, setPersonName] = useState('')
const [personKeyboardOpen, setPersonKeyboardOpen] =
  useState(false)
  const [personShiftActive, setPersonShiftActive] =
  useState(false)

const [
  personCapsLockActive,
  setPersonCapsLockActive,
] = useState(false)
  const [
  personCursorPosition,
  setPersonCursorPosition,
] = useState(0)
const personCursorPositionRef =
  useRef(0)
  const personNameRef =
  useRef('')
  useEffect(() => {
  personNameRef.current = personName
}, [personName])
  const [personColor, setPersonColor] =
  useState(personColorOptions[0].color)
  const [personImageFile, setPersonImageFile] =
    useState<File | null>(null)
  const [personImagePreview, setPersonImagePreview] = useState('')
  const [personFileInputKey, setPersonFileInputKey] = useState(0)
  const [editingPersonId, setEditingPersonId] = useState<number | null>(null)
  const [
  personDeleteTarget,
  setPersonDeleteTarget,
] = useState<Person | null>(null)
 function getNextUnusedPersonColor(
  peopleToCheck: Person[] = people
) {
  const usedColors = new Set(
    peopleToCheck.map((person) =>
      person.color.toLowerCase()
    )
  )

  return (
    personColorOptions.find(
      (option) =>
        !usedColors.has(
          option.color.toLowerCase()
        )
    )?.color ??
    personColorOptions[0].color
  )
}

useEffect(() => {
  if (editingPersonId !== null) {
    return
  }

  setPersonColor(
    getNextUnusedPersonColor()
  )
}, [people.length, editingPersonId])

async function confirmAiCancellation() {
  const match =
    aiCancellationPreview?.matches?.[0]

  if (!match || aiCommandLoading) {
    return
  }

  setAiCommandLoading(true)

  try {
    const response =
      await fetch(
        '/api/ai/cancel-confirmed',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify({
            confirm: true,
            eventId: match.id,
            matchType:
              match.matchType,
            occurrenceDate:
              match.occurrenceDate,
          }),
        }
      )

    const data =
      await response.json()

    if (!response.ok) {
      throw new Error(
        data.error ??
          'Could not cancel the event.'
      )
    }

    await loadEvents()

    setAiCancellationPreview(null)
    setAiCommandResult('')
    setAiCommandText('')
    setAiCommandOpen(false)

    showAppNotification(
      match.matchType ===
        'recurring_occurrence'
        ? 'Recurring event occurrence canceled.'
        : 'Event canceled.'
    )
  } catch (error) {
    showAppNotification(
      error instanceof Error
        ? error.message
        : 'Could not cancel the event.'
    )
  } finally {
    setAiCommandLoading(false)
  }
}

async function confirmAiReschedule() {
  const preview = aiReschedulePreview
  const match = preview?.matches?.[0]

  if (
    !match ||
    preview?.status !== 'ready_for_confirmation' ||
    preview?.matches?.length !== 1 ||
    preview.eventId !== match.id ||
    match.matchType !== 'event' ||
    aiCommandLoading
  ) {
    return
  }

  const requestBody: {
    eventId: number
    confirm: boolean
    newDate?: string
    newTime?: string
  } = {
    eventId: match.id,
    confirm: true,
  }

  if (typeof preview.criteria?.newDate === 'string') {
    requestBody.newDate = preview.proposed.date
  }

  if (typeof preview.criteria?.newTime === 'string') {
    requestBody.newTime = preview.proposed.time
  }

  if (
    requestBody.newDate === undefined &&
    requestBody.newTime === undefined
  ) {
    showAppNotification('No rescheduling change was provided.')
    return
  }

  setAiCommandLoading(true)

  try {
    const response = await fetch(
      '/api/ai/reschedule-confirmed',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    )

    const data = await response.json()

    if (!response.ok) {
      throw new Error(
        data.error ?? 'Could not reschedule the event.'
      )
    }

    await loadEvents()

    setAiReschedulePreview(null)
    setAiCommandResult('')
    setAiCommandText('')
    setAiCommandOpen(false)

    showAppNotification('Event rescheduled successfully.')
  } catch (error) {
    showAppNotification(
      error instanceof Error
        ? error.message
        : 'Could not reschedule the event.'
    )
  } finally {
    setAiCommandLoading(false)
  }
}

async function chooseAiCancellationPerson(
  personName: string
) {
  const criteria =
    aiCancellationPreview?.criteria

  if (
    !criteria?.title ||
    !criteria?.date ||
    aiCommandLoading
  ) {
    return
  }

  setAiCommandLoading(true)

  try {
    const response = await fetch(
      '/api/ai/cancel-matches',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: criteria.title,
          date: criteria.date,
          startTime: criteria.startTime ?? null,
          person: personName,
        }),
      }
    )

    const data = await response.json()

    if (!response.ok) {
      throw new Error(
        data.error ??
          'Could not find matching events.'
      )
    }

    if (data.count === 0) {
      showAppNotification(
        `No matching event found for ${personName}.`
      )
      return
    }

    const updatedPreview = {
      ...aiCancellationPreview,
      criteria: {
        ...criteria,
        person: personName,
      },
      status:
        data.count === 1
          ? 'ready_for_confirmation'
          : 'needs_clarification',
      count: data.count,
      matches: data.matches,
    }

    setAiCancellationPreview(updatedPreview)

    setAiCommandResult(
      JSON.stringify(
        {
          intent: 'cancel_event',
          preview: updatedPreview,
        },
        null,
        2
      )
    )
  } catch (error) {
    showAppNotification(
      error instanceof Error
        ? error.message
        : 'Could not select the person.'
    )
  } finally {
    setAiCommandLoading(false)
  }
}

function submitAiClarification() {
  const answer =
    aiClarificationAnswer.trim()

  if (
    answer === '' ||
    aiCommandLoading
  ) {
    return
  }

  const updatedCommand =
    `${aiCommandText.trim()} on ${answer}`

  setAiCommandText(updatedCommand)
  setAiClarificationAnswer('')

  void submitAiCommand(updatedCommand)
}

async function submitAiCommand(
  overrideCommand?: string
) {
  const command =
    (overrideCommand ?? aiCommandText).trim()

  if (
    command === '' ||
    aiCommandLoading
  ) {
    return
  }

 setAiCommandLoading(true)
setAiCommandResult('')
setAiCancellationPreview(null)
setAiReschedulePreview(null)

  try {
    const intentResponse =
      await fetch(
        '/api/ai/intent',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify({
            text: command,
          }),
        }
      )

    const intentData =
      await intentResponse.json()

    if (!intentResponse.ok) {
      throw new Error(
        intentData.error ??
          'Could not determine the command.'
      )
    }

        if (
      intentData.intent !== 'cancel_event' &&
      intentData.intent !== 'move_event'
    ) {
      setAiCommandResult(
        JSON.stringify(
          {
            intent:
              intentData.intent,
            status:
              'not_wired_yet',
          },
          null,
          2
        )
      )

      return
    }

        const previewResponse =
      await fetch(
        intentData.intent === 'move_event'
          ? '/api/ai/reschedule-preview'
          : '/api/ai/cancel-preview',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify({
            text: command,
            currentDate:
              getDateKeyFromDate(
                new Date()
              ),
            currentUser:
              'Robert',
          }),
        }
      )

    const previewData =
      await previewResponse.json()

    if (!previewResponse.ok) {
      throw new Error(
        previewData.error ??
          'Could not preview the cancellation.'
      )
    }

          if (intentData.intent === 'cancel_event') {
      setAiCancellationPreview(previewData)
    } else if (intentData.intent === 'move_event') {
      setAiReschedulePreview(previewData)
    } 

setAiCommandResult(
  JSON.stringify(
    {
      intent:
        intentData.intent,
      preview:
        previewData,
    },
    null,
    2
  )
)
  } catch (error) {
    setAiCommandResult(
      JSON.stringify(
        {
          error:
            error instanceof Error
              ? error.message
              : 'AI command failed.',
        },
        null,
        2
      )
    )
  } finally {
    setAiCommandLoading(false)
  }
}


function startCalendarAddHold() {
  calendarAddLongPressRef.current = false

  if (
    calendarAddHoldTimerRef.current !== null
  ) {
    window.clearTimeout(
      calendarAddHoldTimerRef.current
    )
  }

  calendarAddHoldTimerRef.current =
    window.setTimeout(() => {
      calendarAddHoldTimerRef.current = null
      calendarAddLongPressRef.current = true

            setAiCommandText('')
      setQuickAddOpen(false)
      setAiCommandOpen(true)
    }, 800)
}

function cancelCalendarAddHold() {
  if (
    calendarAddHoldTimerRef.current !== null
  ) {
    window.clearTimeout(
      calendarAddHoldTimerRef.current
    )

    calendarAddHoldTimerRef.current = null
  }
}

function consumeCalendarAddLongPress() {
  if (!calendarAddLongPressRef.current) {
    return false
  }

  calendarAddLongPressRef.current = false

  return true
}


 function showAppNotification(
  message: string,
  duration = 3500
) {
  if (appNotificationTimerRef.current !== null) {
    window.clearTimeout(
      appNotificationTimerRef.current
    )
  }

  setAppNotification(message)

  appNotificationTimerRef.current =
    window.setTimeout(() => {
      setAppNotification(null)
      appNotificationTimerRef.current = null
    }, duration)
}

function updatePersonNameAndCursor(
  nextName: string,
  nextPosition: number
) {
  personNameRef.current = nextName
  personCursorPositionRef.current =
    nextPosition

  setPersonName(nextName)
  setPersonCursorPosition(
    nextPosition
  )
}

function insertPersonNameText(text: string) {
  const currentName =
    personNameRef.current

  const safePosition = Math.max(
    0,
    Math.min(
      personCursorPositionRef.current,
      currentName.length
    )
  )

  const nextName =
    currentName.slice(0, safePosition) +
    text +
    currentName.slice(safePosition)

  updatePersonNameAndCursor(
    nextName,
    safePosition + text.length
  )
}

function typePersonLetter(letter: string) {
  const currentName =
    personNameRef.current

  const safePosition = Math.max(
    0,
    Math.min(
      personCursorPositionRef.current,
      currentName.length
    )
  )

  const previousCharacter =
    safePosition > 0
      ? currentName.charAt(
          safePosition - 1
        )
      : ''

  const shouldCapitalize =
    personCapsLockActive ||
    personShiftActive ||
    safePosition === 0 ||
    previousCharacter === ' '

  const nextLetter =
    shouldCapitalize
      ? letter.toUpperCase()
      : letter.toLowerCase()

  const nextName =
    currentName.slice(0, safePosition) +
    nextLetter +
    currentName.slice(safePosition)

  updatePersonNameAndCursor(
    nextName,
    safePosition + 1
  )

  if (personShiftActive) {
    setPersonShiftActive(false)
  }
}



function backspacePersonName() {
  const currentName =
    personNameRef.current

  const safePosition = Math.max(
    0,
    Math.min(
      personCursorPositionRef.current,
      currentName.length
    )
  )

  if (safePosition === 0) {
    return
  }

  const nextName =
    currentName.slice(
      0,
      safePosition - 1
    ) +
    currentName.slice(safePosition)

  updatePersonNameAndCursor(
    nextName,
    safePosition - 1
  )
}

useEffect(() => {
  if (!personKeyboardOpen) {
    return
  }

  function handlePersonPhysicalKeyboard(
    event: globalThis.KeyboardEvent
  ) {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return
    }

    if (
      event.key.length === 1
    ) {
      event.preventDefault()

      insertPersonNameText(
        event.key
      )

      return
    }

    if (event.key === 'Backspace') {
      event.preventDefault()

      backspacePersonName()

      return
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault()

      const nextPosition = Math.max(
        0,
        personCursorPositionRef.current - 1
      )

      personCursorPositionRef.current =
        nextPosition

      setPersonCursorPosition(
        nextPosition
      )

      return
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()

      const nextPosition = Math.min(
        personNameRef.current.length,
        personCursorPositionRef.current + 1
      )

      personCursorPositionRef.current =
        nextPosition

      setPersonCursorPosition(
        nextPosition
      )

      return
    }

    if (event.key === 'Home') {
      event.preventDefault()

      personCursorPositionRef.current = 0
      setPersonCursorPosition(0)

      return
    }

    if (event.key === 'End') {
      event.preventDefault()

      const nextPosition =
        personNameRef.current.length

      personCursorPositionRef.current =
        nextPosition

      setPersonCursorPosition(
        nextPosition
      )

      return
    }

    if (
      event.key === 'Enter' ||
      event.key === 'Escape'
    ) {
      event.preventDefault()

      setPersonKeyboardOpen(false)
    }
  }

  window.addEventListener(
    'keydown',
    handlePersonPhysicalKeyboard
  )

  return () => {
    window.removeEventListener(
      'keydown',
      handlePersonPhysicalKeyboard
    )
  }
}, [personKeyboardOpen])

function startFamilySliderDrag(
  event: PointerEvent<HTMLDivElement>
) {
  if (event.pointerType !== 'mouse') {
    return
  }

  const slider = familySliderRef.current

  if (!slider) {
    return
  }

  familySliderDragRef.current = {
    isDragging: false,
    startX: event.clientX,
    startScrollLeft: slider.scrollLeft,
  }
}



function endFamilySliderDrag(
  event: PointerEvent<HTMLDivElement>
) {
  if (event.pointerType !== 'mouse') {
    return
  }

  const slider = familySliderRef.current

  if (!slider) {
    return
  }

  const wasDragging =
    familySliderDragRef.current.isDragging

  familySliderDragRef.current.isDragging =
    false

  if (
    slider.hasPointerCapture(event.pointerId)
  ) {
    slider.releasePointerCapture(
      event.pointerId
    )
  }

  slider.classList.remove(
    'family-slider-dragging'
  )

  if (wasDragging) {
    window.setTimeout(() => {
      snapFamilySliderToNearest()
    }, 20)
  }
}

function moveFamilySliderDrag(
  event: PointerEvent<HTMLDivElement>
) {
  if (event.pointerType !== 'mouse') {
    return
  }

  if ((event.buttons & 1) !== 1) {
    return
  }

  const slider = familySliderRef.current

  if (!slider) {
    return
  }

  const distance =
    event.clientX -
    familySliderDragRef.current.startX

  if (
    !familySliderDragRef.current.isDragging &&
    Math.abs(distance) > 6
  ) {
    familySliderDragRef.current.isDragging = true

    slider.setPointerCapture(
      event.pointerId
    )

    slider.classList.add(
      'family-slider-dragging'
    )
  }

  if (
    !familySliderDragRef.current.isDragging
  ) {
    return
  }

  slider.scrollLeft =
    familySliderDragRef.current.startScrollLeft -
    distance
}

function handleFamilySliderPointerDown(
  event: PointerEvent<HTMLDivElement>
) {
  familySliderPointerRef.current = {
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  }

  startFamilySliderDrag(event)
}

function handleFamilySliderPointerMove(
  event: PointerEvent<HTMLDivElement>
) {
  if (
    event.pointerType === 'mouse' &&
    (event.buttons & 1) !== 1
  ) {
    return
  }

  const horizontalDistance = Math.abs(
    event.clientX -
      familySliderPointerRef.current.startX
  )

  const verticalDistance = Math.abs(
    event.clientY -
      familySliderPointerRef.current.startY
  )

  if (
    horizontalDistance > 6 ||
    verticalDistance > 6
  ) {
    familySliderPointerRef.current.moved =
      true
  }

  moveFamilySliderDrag(event)
}

function snapFamilySliderToNearest() {
  const slider = familySliderRef.current

  if (
    !slider ||
    familySliderDragRef.current.isDragging
  ) {
    return
  }

  const cards = Array.from(
    slider.querySelectorAll<HTMLElement>(
      '.family-slider-card'
    )
  )

  if (
    cards.length === 0 ||
    slider.scrollWidth <= slider.clientWidth
  ) {
    return
  }

  const sliderRect =
    slider.getBoundingClientRect()

  const maximumScroll =
    slider.scrollWidth - slider.clientWidth

  let targetScroll = slider.scrollLeft
  let closestDistance = Infinity

  cards.forEach((card) => {
    const cardRect =
      card.getBoundingClientRect()

    const cardPosition =
      slider.scrollLeft +
      cardRect.left -
      sliderRect.left

    const clampedPosition = Math.max(
      0,
      Math.min(
        cardPosition,
        maximumScroll
      )
    )

    const distance = Math.abs(
      clampedPosition -
      slider.scrollLeft
    )

    if (distance < closestDistance) {
      closestDistance = distance
      targetScroll = clampedPosition
    }
  })

  if (
    Math.abs(
      targetScroll - slider.scrollLeft
    ) < 1
  ) {
    return
  }

  if (
    familySliderAnimationRef.current !==
    null
  ) {
    window.cancelAnimationFrame(
      familySliderAnimationRef.current
    )
  }

  const startingScroll = slider.scrollLeft
  const distance =
    targetScroll - startingScroll

  const duration = 550
  const startingTime = performance.now()

  familySliderIsSnappingRef.current = true

  function animateSnap(
    currentTime: number
  ) {
    const sliderElement =
      familySliderRef.current

    if (!sliderElement) {
      familySliderIsSnappingRef.current =
        false
      return
    }

    const progress = Math.min(
      (currentTime - startingTime) /
        duration,
      1
    )

    const easedProgress =
      1 - Math.pow(1 - progress, 3)

    sliderElement.scrollLeft =
      startingScroll +
      distance * easedProgress

    if (progress < 1) {
      familySliderAnimationRef.current =
        window.requestAnimationFrame(
          animateSnap
        )

      return
    }

    sliderElement.scrollLeft =
      targetScroll

    familySliderAnimationRef.current =
      null

    familySliderIsSnappingRef.current =
      false
  }

  familySliderAnimationRef.current =
    window.requestAnimationFrame(
      animateSnap
    )
}

function scheduleFamilySliderSnap() {
  if (
    familySliderIsSnappingRef.current ||
    familySliderDragRef.current.isDragging
  ) {
    return
  }

  if (
    familySliderSnapTimerRef.current !==
    null
  ) {
    window.clearTimeout(
      familySliderSnapTimerRef.current
    )
  }

  familySliderSnapTimerRef.current =
    window.setTimeout(() => {
      familySliderSnapTimerRef.current =
        null

      snapFamilySliderToNearest()
    }, 140)
}


function handleWeekPagerPointerDown(
  event: PointerEvent<HTMLDivElement>
) {
 if (
  calendarSwipeAnimatingRef.current ||
  weekPagerTransitioningRef.current
) {
  return
}

  if (
    event.pointerType === 'mouse' &&
    event.button !== 0
  ) {
    return
  }

  weekPagerGestureRef.current = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    deltaX: 0,
    horizontal: false,
    vertical: false,
  }
}

function handleWeekPagerPointerMove(
  event: PointerEvent<HTMLDivElement>
) {
  const gesture = weekPagerGestureRef.current

  if (
    gesture.pointerId !== event.pointerId
  ) {
    return
  }

  if (
    event.pointerType === 'mouse' &&
    (event.buttons & 1) !== 1
  ) {
    return
  }

  const deltaX =
    event.clientX - gesture.startX

  const deltaY =
    event.clientY - gesture.startY

  const absoluteX = Math.abs(deltaX)
  const absoluteY = Math.abs(deltaY)

  if (
    !gesture.horizontal &&
    !gesture.vertical
  ) {
    if (
      absoluteX < 10 &&
      absoluteY < 10
    ) {
      return
    }

    if (absoluteY > absoluteX) {
      gesture.vertical = true
      return
    }

    gesture.horizontal = true

    event.currentTarget.setPointerCapture(
      event.pointerId
    )
  }

  if (
    gesture.vertical ||
    !gesture.horizontal
  ) {
    return
  }

  event.preventDefault()

  const surface = event.currentTarget
  const width = surface.clientWidth

  const maximumDrag = width * 0.95

  const clampedDelta = Math.max(
    -maximumDrag,
    Math.min(maximumDrag, deltaX)
  )

  gesture.deltaX = clampedDelta

  const monthTrack =
    surface.querySelector<HTMLElement>(
      '.month-pager-track'
    )

  if (monthTrack) {
    monthTrack.style.transition = 'none'

    monthTrack.style.transform =
      `translate3d(${
        -width + clampedDelta
      }px, 0, 0)`

    return
  }

  const weekTrack =
    surface.querySelector<HTMLElement>(
      '.week-pager-track'
    )

  if (weekTrack) {
    weekTrack.style.transition = 'none'

    weekTrack.style.transform =
      `translate3d(${
        -width + clampedDelta
      }px, 0, 0)`

    return
  }
    const dayTrack =
    surface.querySelector<HTMLElement>(
      '.day-pager-track'
    )

  if (dayTrack) {
    dayTrack.style.transition = 'none'

    dayTrack.style.transform =
      `translate3d(${
        -width + clampedDelta
      }px, 0, 0)`

    return
  }
}

function handleWeekPagerPointerUp(
  event: PointerEvent<HTMLDivElement>
) {
  const gesture = weekPagerGestureRef.current

  if (
    gesture.pointerId !== event.pointerId
  ) {
    return
  }

  const surface = event.currentTarget

  if (
    surface.hasPointerCapture(
      event.pointerId
    )
  ) {
    surface.releasePointerCapture(
      event.pointerId
    )
  }

  const deltaX = gesture.deltaX

  const deltaY =
    event.clientY - gesture.startY

  const wasHorizontal =
    gesture.horizontal

  weekPagerGestureRef.current = {
    pointerId: -1,
    startX: 0,
    startY: 0,
    deltaX: 0,
    horizontal: false,
    vertical: false,
  }

  if (!wasHorizontal) {
    return
  }

  const width = surface.clientWidth

  const threshold = Math.min(
    110,
    width * 0.14
  )

  weekPagerSuppressClickUntilRef.current =
    performance.now() + 500

  const direction: -1 | 1 =
    deltaX < 0 ? 1 : -1

  const monthTrack =
    surface.querySelector<HTMLElement>(
      '.month-pager-track'
    )

  if (monthTrack) {
    if (
      Math.abs(deltaX) < threshold ||
      Math.abs(deltaX) <=
        Math.abs(deltaY)
    ) {
      monthTrack.style.transition =
        'transform 380ms cubic-bezier(0.16, 1, 0.3, 1)'

      monthTrack.style.transform =
        `translate3d(${-width}px, 0, 0)`

      return
    }

    calendarSwipeAnimatingRef.current =
      true

    const targetPosition =
      direction === 1
        ? -width * 2
        : 0

    monthTrack.style.transition =
      'transform 440ms cubic-bezier(0.16, 1, 0.3, 1)'

    monthTrack.style.transform =
      `translate3d(${targetPosition}px, 0, 0)`

    window.setTimeout(() => {
      setViewDate((currentDate) =>
        new Date(
          currentDate.getFullYear(),
          currentDate.getMonth() +
            direction,
          1
        )
      )

      setSelectedDay(null)
      clearEventForm()
    }, 440)

    return
  }

  const weekTrack =
    surface.querySelector<HTMLElement>(
      '.week-pager-track'
    )

  if (weekTrack) {
    if (
      Math.abs(deltaX) < threshold ||
      Math.abs(deltaX) <=
        Math.abs(deltaY)
    ) {
      weekTrack.style.transition =
        'transform 380ms cubic-bezier(0.16, 1, 0.3, 1)'

      weekTrack.style.transform =
        `translate3d(${-width}px, 0, 0)`

      return
    }

    weekPagerPendingDirectionRef.current =
      direction

    weekPagerTransitioningRef.current =
      true

    const targetPosition =
      direction === 1
        ? -width * 2
        : 0

    weekTrack.style.transition =
      'transform 440ms cubic-bezier(0.16, 1, 0.3, 1)'

    weekTrack.style.transform =
      `translate3d(${targetPosition}px, 0, 0)`

        return
  }

  const dayTrack =
    surface.querySelector<HTMLElement>(
      '.day-pager-track'
    )

  if (dayTrack) {
    if (
      Math.abs(deltaX) < threshold ||
      Math.abs(deltaX) <=
        Math.abs(deltaY)
    ) {
      dayTrack.style.transition =
  'transform 300ms cubic-bezier(0.22, 1, 0.36, 1)'

      dayTrack.style.transform =
        `translate3d(${-width}px, 0, 0)`

      return
    }

    weekPagerPendingDirectionRef.current =
      direction

    weekPagerTransitioningRef.current =
      true

    const targetPosition =
      direction === 1
        ? -width * 2
        : 0

    dayTrack.style.transition =
  'transform 420ms cubic-bezier(0.22, 1, 0.36, 1)'

    dayTrack.style.transform =
      `translate3d(${targetPosition}px, 0, 0)`

    return
  }

  if (
    Math.abs(deltaX) < threshold ||
    Math.abs(deltaX) <=
      Math.abs(deltaY)
  ) {
    return
  }

  transitionCalendarView(() => {
    if (calendarView === 'day') {
      setWeekDate((currentDate) =>
        new Date(
          currentDate.getFullYear(),
          currentDate.getMonth(),
          currentDate.getDate() +
            direction
        )
      )
    }

    setSelectedDay(null)
    clearEventForm()
  })
}

function handleWeekPagerPointerCancel(
  event: PointerEvent<HTMLDivElement>
) {
  const surface = event.currentTarget

  if (
    surface.hasPointerCapture(
      event.pointerId
    )
  ) {
    surface.releasePointerCapture(
      event.pointerId
    )
  }

  weekPagerGestureRef.current = {
    pointerId: -1,
    startX: 0,
    startY: 0,
    deltaX: 0,
    horizontal: false,
    vertical: false,
  }

  const monthTrack =
    surface.querySelector<HTMLElement>(
      '.month-pager-track'
    )

  if (monthTrack) {
    const width = surface.clientWidth

    monthTrack.style.transition =
      'transform 380ms cubic-bezier(0.16, 1, 0.3, 1)'

    monthTrack.style.transform =
      `translate3d(${-width}px, 0, 0)`

    return
  }

    const weekTrack =
    surface.querySelector<HTMLElement>(
      '.week-pager-track'
    )

  if (weekTrack) {
    const width = surface.clientWidth

    weekTrack.style.transition =
      'transform 380ms cubic-bezier(0.16, 1, 0.3, 1)'

    weekTrack.style.transform =
      `translate3d(${-width}px, 0, 0)`

    return
  }

  const dayTrack =
    surface.querySelector<HTMLElement>(
      '.day-pager-track'
    )

  if (dayTrack) {
    const width = surface.clientWidth

    dayTrack.style.transition =
      'transform 380ms cubic-bezier(0.16, 1, 0.3, 1)'

    dayTrack.style.transform =
      `translate3d(${-width}px, 0, 0)`
  }
}

function finishWeekPagerTransition() {
  if (!weekPagerTransitioningRef.current) {
    return
  }

  const direction =
    weekPagerPendingDirectionRef.current

  weekPagerPendingDirectionRef.current = 0
  weekPagerTransitioningRef.current = false

  if (direction === 0) {
    return
  }

    setWeekDate((currentWeekDate) =>
    new Date(
      currentWeekDate.getFullYear(),
      currentWeekDate.getMonth(),
      currentWeekDate.getDate() +
        direction *
          (calendarView === 'day'
            ? 1
            : 7)
    )
  )

  setSelectedDay(null)
  clearEventForm()
}

function suppressWeekPagerClick() {
  return (
    performance.now() <
    weekPagerSuppressClickUntilRef.current
  )
}

const sensors = useSensors(
  useSensor(PointerSensor, {
    activationConstraint: {
      distance: 8,
    },
  }),
  useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  })
)

function handleHomeWidgetDragEnd(
  event: DragEndEvent
) {
  if (!isEditingHome) {
    return
  }

  const { active, over } = event

  if (
    !over ||
    active.id === over.id
  ) {
    return
  }

  setHomeWidgetOrder((current) => {
    const oldIndex =
      current.indexOf(
        active.id as HomeWidgetId
      )

    const newIndex =
      current.indexOf(
        over.id as HomeWidgetId
      )

    if (
      oldIndex === -1 ||
      newIndex === -1
    ) {
      return current
    }

    return arrayMove(
      current,
      oldIndex,
      newIndex
    )
  })
}

  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()

  const monthName = viewDate.toLocaleString('default', {
    month: 'long',
  })

  const fullDate = today.toLocaleDateString('default', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  

function getMonthWeeksForDate(
  targetDate: Date
) {
  const targetYear =
    targetDate.getFullYear()

  const targetMonth =
    targetDate.getMonth()

  const targetDaysInMonth =
    new Date(
      targetYear,
      targetMonth + 1,
      0
    ).getDate()

  const targetFirstDay =
    new Date(
      targetYear,
      targetMonth,
      1
    ).getDay()

  const targetCells: (number | null)[] = [
    ...Array.from(
      { length: targetFirstDay },
      () => null
    ),
    ...Array.from(
      { length: targetDaysInMonth },
      (_, index) => index + 1
    ),
  ]

  const targetTrailingBlankCount =
    (7 - (targetCells.length % 7)) % 7

  const targetCompleteCells:
    (number | null)[] = [
      ...targetCells,
      ...Array.from(
        {
          length:
            targetTrailingBlankCount,
        },
        () => null
      ),
    ]

  return Array.from(
    {
      length:
        targetCompleteCells.length / 7,
    },
    (_, weekIndex) =>
      targetCompleteCells.slice(
        weekIndex * 7,
        weekIndex * 7 + 7
      )
  )
}

useEffect(() => {
  const handleResize = () => {
    setIsCompactMonthLayout(
      window.innerWidth <= 1200
    )
  }

  window.addEventListener(
    'resize',
    handleResize
  )

  return () => {
    window.removeEventListener(
      'resize',
      handleResize
    )
  }
}, [])

useEffect(() => {
  loadEvents()
  loadPeople()
  loadLists()
  void loadShoppingStores()
  loadCaptureInbox()
  loadMealPlans()
  loadMealPlanItems()
  loadRecipes()
}, [])


  async function loadEvents() {
    const response = await fetch('/api/events')
    const data = await response.json()

    setEvents(data)
  }

  async function loadPeople() {
  const response = await fetch('/api/people')
  const data: Person[] = await response.json()

  setPeople(data)

  return data
}

function movePersonDuringDrag(
  draggedId: number,
  targetId: number
) {
  if (draggedId === targetId) {
    return
  }

  setPeople((currentPeople) => {
    const draggedIndex =
      currentPeople.findIndex(
        (person) => person.id === draggedId
      )

    const targetIndex =
      currentPeople.findIndex(
        (person) => person.id === targetId
      )

    if (
      draggedIndex === -1 ||
      targetIndex === -1 ||
      draggedIndex === targetIndex
    ) {
      return currentPeople
    }

    const reorderedPeople =
      [...currentPeople]

    const [draggedPerson] =
      reorderedPeople.splice(
        draggedIndex,
        1
      )

    reorderedPeople.splice(
      targetIndex,
      0,
      draggedPerson
    )

    return reorderedPeople
  })
}

async function savePeopleOrder() {
  const response = await fetch(
    '/api/people/reorder',
    {
      method: 'PUT',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify({
        personIds:
          people.map(
            (person) => person.id
          ),
      }),
    }
  )

  if (!response.ok) {
    await loadPeople()

    showAppNotification(
      'Could not save the new people order.'
    )
  }
}

  async function loadLists() {
  const response = await fetch('/api/lists')
  if (!response.ok) {
    showAppNotification('Could not load lists.')
    return
  }
  // SQLite stores booleans as INTEGER 0/1. Normalize at the API boundary:
  // rendering a numeric zero with {value && <Control />} prints "0" in React.
  const data: Array<Omit<CalendarList, 'store_enabled'> & {
    store_enabled?: number | boolean
  }> = await response.json()
  setLists(data.map(list => ({
    ...list,
    store_enabled: list.store_enabled === true || list.store_enabled === 1,
  })))
}

async function loadShoppingStores() {
  const response = await fetch('/api/shopping-stores')
  if (!response.ok) return
  const data: ShoppingStore[] = await response.json()
  setShoppingStores(data)
}
async function updateShoppingStore(id: number, change: {enabled?: boolean; sort_order?: number}) {
  const response = await fetch('/api/shopping-stores/' + id, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(change),
  })
  if (!response.ok) {
    showAppNotification('Could not update store settings.')
    return false
  }
  await loadShoppingStores()
  return true
}
async function addShoppingStore(event: FormEvent<HTMLFormElement>) {
  event.preventDefault()
  const name = newShoppingStoreName.trim()
  if (!name) return
  const response = await fetch('/api/shopping-stores', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name}),
  })
  if (!response.ok) {
    showAppNotification('Could not add store. Check for a duplicate name.')
    return
  }
  setNewShoppingStoreName('')
  await loadShoppingStores()
}
async function moveShoppingStore(storeId: number, direction: number) {
  const index = shoppingStores.findIndex(store => store.id === storeId)
  const neighbor = shoppingStores[index + direction]
  if (index < 0 || !neighbor) return
  const first = shoppingStores[index]
  const firstOrder = first.sort_order
  const secondOrder = neighbor.sort_order
  const temp = Math.max(...shoppingStores.map(store => store.sort_order), 0) + 10
  if (!await updateShoppingStore(first.id,{sort_order: temp})) return
  if (!await updateShoppingStore(neighbor.id,{sort_order: firstOrder})) return
  await updateShoppingStore(first.id,{sort_order: secondOrder})
}
async function enableStoreSorting(listId: number, enabled: boolean) {
  const response = await fetch('/api/lists/' + listId + '/store-sorting', {
    method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({enabled}),
  })
  if (!response.ok) { showAppNotification('Could not update store sorting.'); return }
  // Always return to the appropriate automatic mode when store sorting
  // changes. A previous Custom order must not leave drag grips in this view.
  setListSortMode(enabled ? 'store' : 'category')
  setStoreFilter('all')
  setListCategoryFilter('All')
  setOpenListSwipe(null)
  await loadLists()
}
async function sortListByStores(listId: number, askArney: boolean) {
  if (storeSortBusy) return
  setStoreSortBusy(true)
  try {
    const response = await fetch('/api/lists/' + listId + '/sort-stores', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({askArney}),
    })
    if (!response.ok) throw new Error('Store organizer failed')
    const result: {sorted:number; aiSorted:number; remaining:number; aiAvailable:boolean|null} = await response.json()
    await loadLists()
    if (askArney || result.sorted > 0) {
      const count = result.sorted + result.aiSorted
      showAppNotification(askArney && result.aiAvailable === false
        ? 'Local Arney is unavailable. Offline sorting still works.'
        : count ? 'Sorted ' + count + ' items by store.'
          : 'No further store suggestions. Unsorted items stay visible.')
    }
  } catch { showAppNotification('Could not organize stores.') }
  finally { setStoreSortBusy(false) }
}

async function loadCaptureInbox() {
  const response = await fetch(
    '/api/capture-inbox'
  )

  if (!response.ok) {
    showAppNotification(
      'Could not load Capture Inbox.'
    )
    return
  }

  const data = await response.json()

  setCaptureInbox(data)
}

async function deleteCaptureInboxItem(
  capture: CaptureInboxItem
) {
  const shouldDelete = window.confirm(
    'Delete this item from Capture Inbox?'
  )

  if (!shouldDelete) {
    return
  }

  const response = await fetch(
    `/api/capture-inbox/${capture.id}`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
    showAppNotification(
      'Could not delete the capture.'
    )
    return
  }

 setCaptureInbox((currentCaptures) =>
  currentCaptures.filter(
    (currentCapture) =>
      currentCapture.id !== capture.id
  )
)

if (selectedCaptureId === capture.id) {
  setSelectedCaptureId(null)
}

showAppNotification(
  'Capture deleted.'
)
}

async function updateCaptureType(
  captureId: number,
  captureType:
    | 'event'
    | 'recipe'
    | 'list'
    | 'other'
) {
  const response = await fetch(
    `/api/capture-inbox/${captureId}/type`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        captureType,
      }),
    }
  )

  if (!response.ok) {
    showAppNotification(
      'Could not update the capture.'
    )
    return
  }

  const updatedCapture:
    CaptureInboxItem =
    await response.json()

  setCaptureInbox((currentCaptures) =>
    currentCaptures.map(
      (capture) =>
        capture.id === captureId
          ? updatedCapture
          : capture
    )
  )

  const typeLabel =
    captureType === 'event'
      ? 'Event'
      : captureType === 'recipe'
        ? 'Recipe'
        : captureType === 'list'
          ? 'List'
          : 'Other'

  showAppNotification(
    `Marked as ${typeLabel}.`
  )
}

async function analyzeCapture(
  captureId: number
) {
  setCaptureAnalyzingId(
    captureId
  )

  try {
    const startResponse = await fetch(
      `/api/capture-inbox/${captureId}/analyze`,
      {
        method: 'POST',
      }
    )

    if (!startResponse.ok) {
      showAppNotification(
        'Could not start capture analysis.'
      )
      return
    }

    setCaptureInbox(
      (currentCaptures) =>
        currentCaptures.map(
          (capture) =>
            capture.id === captureId
              ? {
                  ...capture,
                  analysisStatus:
                    'analyzing',
                }
              : capture
        )
    )

    const maxAttempts = 60

    for (
      let attempt = 0;
      attempt < maxAttempts;
      attempt += 1
    ) {
      await new Promise<void>(
        (resolve) => {
          window.setTimeout(
            resolve,
            1000
          )
        }
      )

      const response = await fetch(
        '/api/capture-inbox'
      )

      if (!response.ok) {
        continue
      }

      const captures:
        CaptureInboxItem[] =
        await response.json()

      const updatedCapture =
        captures.find(
          (capture) =>
            capture.id === captureId
        )

      if (!updatedCapture) {
        continue
      }

      setCaptureInbox(
        (currentCaptures) =>
          currentCaptures.map(
            (capture) =>
              capture.id ===
              captureId
                ? updatedCapture
                : capture
          )
      )

      if (
        updatedCapture.analysisStatus ===
        'complete'
      ) {
        showAppNotification(
          'Capture analysis complete.'
        )

        return
      }

      if (
        updatedCapture.analysisStatus ===
        'error'
      ) {
        showAppNotification(
          'Local AI could not analyze the capture.'
        )

        return
      }
    }

    showAppNotification(
      'Analysis is still running. You can check the Capture Inbox again shortly.'
    )
  } catch (error) {
    console.error(
      'Capture analysis failed:',
      error
    )

    showAppNotification(
      'Could not reach the calendar server.'
    )
  } finally {
    setCaptureAnalyzingId(
      null
    )
  }
}

function normalizeCapturedTime(
  value: string | undefined
) {
  const cleanValue =
    (value ?? '').trim()

  if (cleanValue === '') {
    return ''
  }

  const twentyFourHourMatch =
    cleanValue.match(
      /^(\d{1,2}):(\d{2})$/
    )

  if (twentyFourHourMatch) {
    const hour = Number(
      twentyFourHourMatch[1]
    )

    const minute = Number(
      twentyFourHourMatch[2]
    )

    if (
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59
    ) {
      return `${String(hour).padStart(
        2,
        '0'
      )}:${String(minute).padStart(
        2,
        '0'
      )}`
    }
  }

  const twelveHourMatch =
    cleanValue
      .toUpperCase()
      .match(
        /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/
      )

  if (!twelveHourMatch) {
    return ''
  }

  let hour = Number(
    twelveHourMatch[1]
  )

  const minute = Number(
    twelveHourMatch[2] ?? '0'
  )

  const period =
    twelveHourMatch[3]

  if (
    hour < 1 ||
    hour > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return ''
  }

  if (period === 'AM') {
    if (hour === 12) {
      hour = 0
    }
  } else if (hour !== 12) {
    hour += 12
  }

  return `${String(hour).padStart(
    2,
    '0'
  )}:${String(minute).padStart(
    2,
    '0'
  )}`
}

function openCapturedEventForReview(
  analysis: CaptureAnalysis,
  capturedEvent: NonNullable<
    CaptureAnalysis['events']
  >[number],
  cleanCaptureNote: string
) {
  const dateContext =
    analysis.dateContext

  let targetDate:
    Date | null = null

  let targetDateKey = ''

    if (
    typeof dateContext?.month ===
      'number' &&
    typeof dateContext.day ===
      'number'
  ) {
    let targetYear =
      dateContext.yearVisible ===
        true &&
      typeof dateContext.year ===
        'number'
        ? dateContext.year
        : today.getFullYear()

    let candidateDate =
      new Date(
        targetYear,
        dateContext.month - 1,
        dateContext.day
      )

    const dateIsValid =
      candidateDate.getFullYear() ===
        targetYear &&
      candidateDate.getMonth() ===
        dateContext.month - 1 &&
      candidateDate.getDate() ===
        dateContext.day

    if (
      dateIsValid &&
      dateContext.yearVisible !== true
    ) {
      const todayStart =
        new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate()
        )

      if (
        candidateDate <
        todayStart
      ) {
        targetYear += 1

        candidateDate =
          new Date(
            targetYear,
            dateContext.month - 1,
            dateContext.day
          )
      }
    }

    if (
      candidateDate.getFullYear() ===
        targetYear &&
      candidateDate.getMonth() ===
        dateContext.month - 1 &&
      candidateDate.getDate() ===
        dateContext.day
    ) {
      targetDate =
        candidateDate

      targetDateKey =
        getDateKeyFromDate(
          candidateDate
        )
    }
  }

  clearEventForm()

  setPage('calendar')
  setCalendarView('month')

  setEventTitle(
    capturedEvent.title ?? ''
  )

  setEventTime(
    normalizeCapturedTime(
      capturedEvent.startTime
    )
  )

  setEventEndTime(
    normalizeCapturedTime(
      capturedEvent.endTime
    )
  )

  setEventAllDay(
    Boolean(
      capturedEvent.allDay
    )
  )

  setEventLocation(
    capturedEvent.location ?? ''
  )

  const eventNotes = [
    capturedEvent.notes?.trim(),
    cleanCaptureNote,
  ]
    .filter(
      (value) =>
        Boolean(value)
    )
    .join('\n\n')

  setEventNotes(
    eventNotes
  )

  if (
    targetDate !== null
  ) {
    setEventStartDate(
      targetDateKey
    )

    setEventStartDateText(
      formatDateKeyForText(
        targetDateKey
      )
    )

    setViewDate(
      new Date(
        targetDate.getFullYear(),
        targetDate.getMonth(),
        1
      )
    )

    setWeekDate(
      targetDate
    )

    setSelectedDay(
      targetDate.getDate()
    )
  } else {
    setEventStartDate('')

    setEventStartDateText(
      dateContext?.dateText ??
        ''
    )

    setSelectedDay(null)
  }

  setIsAddingEvent(true)

  if (capturePreviewUrl) {
    URL.revokeObjectURL(
      capturePreviewUrl
    )
  }

  setCaptureOpen(false)
  setCaptureFile(null)
  setCapturePreviewUrl('')
  setCaptureNote('')

  showAppNotification(
    'Event found. Review it before saving.'
  )
}

async function analyzeQuickAddPhoto() {
  if (
    captureFile === null ||
    captureSaving
  ) {
    return
  }

  const formData =
    new FormData()

  formData.append(
    'image',
    captureFile
  )

  setCaptureSaving(true)

  try {
    const response = await fetch(
      '/api/capture/analyze-photo',
      {
        method: 'POST',
        body: formData,
      }
    )

    if (!response.ok) {
      const responseText =
        await response.text()

      console.error(
        'Direct photo analysis failed:',
        response.status,
        responseText
      )

      showAppNotification(
        'Could not analyze the photo.'
      )

      return
    }

    const analysis:
      CaptureAnalysis =
      await response.json()

    const cleanCaptureNote =
      captureNote.trim()

    if (
      analysis.captureType ===
      'recipe'
    ) {
      const recipe =
        analysis.recipe

      if (
        !recipe ||
        !recipe.title
      ) {
        showAppNotification(
          'A recipe was detected, but there was not enough information to create it.'
        )

        return
      }

      openAddRecipeForm(
        'recipes'
      )

      setRecipeName(
        recipe.title ?? ''
      )

           const capturedServings =
        recipe.servings?.trim() ??
        ''

      setRecipeServings(
        /^\d+$/.test(
          capturedServings
        ) &&
        Number(
          capturedServings
        ) > 0
          ? capturedServings
          : ''
      )

            const capturedPrepTime =
        recipe.prepTime?.trim() ??
        ''

      const capturedCookTime =
        recipe.cookTime?.trim() ??
        ''

      setRecipePrepTime(
        capturedPrepTime &&
        !/^not specified$/i.test(
          capturedPrepTime
        ) &&
        !/^not found$/i.test(
          capturedPrepTime
        ) &&
        !/^unknown$/i.test(
          capturedPrepTime
        )
          ? capturedPrepTime
          : ''
      )

      setRecipeCookTime(
        capturedCookTime &&
        !/^not specified$/i.test(
          capturedCookTime
        ) &&
        !/^not found$/i.test(
          capturedCookTime
        ) &&
        !/^unknown$/i.test(
          capturedCookTime
        )
          ? capturedCookTime
          : ''
      )

      setRecipeIngredients(
        Array.isArray(
          recipe.ingredients
        )
          ? recipe.ingredients.join(
              '\n'
            )
          : ''
      )

      setRecipeInstructions(
        Array.isArray(
          recipe.instructions
        )
          ? recipe.instructions.join(
              '\n'
            )
          : ''
      )

      setRecipeTags(
        Array.isArray(
          recipe.tags
        )
          ? recipe.tags.join(
              ', '
            )
          : ''
      )

      setRecipeNotes(
        cleanCaptureNote
      )

      setRecipeSourceImage(
  analysis.sourceImage ?? ''
)

      setPage('meals')
      setMealsView('recipes')

      if (capturePreviewUrl) {
        URL.revokeObjectURL(
          capturePreviewUrl
        )
      }

      setCaptureOpen(false)
      setCaptureFile(null)
      setCapturePreviewUrl('')
      setCaptureNote('')

      showAppNotification(
        'Recipe found. Review it before saving.'
      )

      return
    }

        if (
      analysis.captureType ===
      'event'
    ) {
      const capturedEvents =
        Array.isArray(
          analysis.events
        )
          ? analysis.events
          : []

      if (
        capturedEvents.length === 0
      ) {
        showAppNotification(
          'An event was detected, but no event details were found.'
        )

        return
      }

      if (
  capturedEvents.length > 1
) {
 

  setMultiEventReview({
          analysis,
          note:
            cleanCaptureNote,
        })

        setCaptureOpen(false)

        return
      }

      openCapturedEventForReview(
        analysis,
        capturedEvents[0],
        cleanCaptureNote
      )

      return
    }

        if (
      analysis.captureType ===
      'list'
    ) {
      const capturedList =
        analysis.list

      if (
        !capturedList ||
        !Array.isArray(
          capturedList.items
        ) ||
        capturedList.items.length === 0
      ) {
        showAppNotification(
          'A list was detected, but no list items were found.'
        )

        return
      }

      const cleanListName =
        capturedList.name?.trim() ||
        'New List'

      const cleanListItems =
        capturedList.items
          .map((item) =>
            item.trim()
          )
          .filter((item) =>
            item.length > 0
          )

      if (
        cleanListItems.length === 0
      ) {
        showAppNotification(
          'A list was detected, but no list items were found.'
        )

        return
      }

      const listResponse =
        await fetch(
          '/api/lists',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              name: cleanListName,
            }),
          }
        )

      if (!listResponse.ok) {
        showAppNotification(
          'Could not create the detected list.'
        )

        return
      }

      const createdList =
        await listResponse.json()

      for (
        const item of cleanListItems
      ) {
        const itemResponse =
          await fetch(
            `/api/lists/${createdList.id}/items`,
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                text: item,
              }),
            }
          )

        if (!itemResponse.ok) {
          throw new Error(
            'Could not add a detected list item.'
          )
        }
      }

      await loadLists()

      setSelectedListId(
        createdList.id
      )

      setEditingListName(
        cleanListName
      )

      setNewListItemText('')

      setPage('lists')

      if (capturePreviewUrl) {
        URL.revokeObjectURL(
          capturePreviewUrl
        )
      }

      setCaptureOpen(false)
      setCaptureFile(null)
      setCapturePreviewUrl('')
      setCaptureNote('')

      showAppNotification(
        `Created ${cleanListName} with ${cleanListItems.length} ${
          cleanListItems.length === 1
            ? 'item'
            : 'items'
        }.`
      )

      return
    }

    showAppNotification(
      'The photo could not be identified as an event or recipe.'
    )
  } catch (error) {
    console.error(
      'Direct photo analysis failed:',
      error
    )

    showAppNotification(
      'Could not reach the local AI.'
    )
  } finally {
    setCaptureSaving(false)
  }
}



function openCaptureDestination(
  capture: CaptureInboxItem
) {
  if (capture.captureType === 'event') {
    const targetDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    )

    const targetDateKey =
      getDateKeyFromDate(targetDate)

    setSelectedCaptureId(null)
    setMonthEventsOpen(false)

    setPage('calendar')
    setCalendarView('month')

    setViewDate(
      new Date(
        targetDate.getFullYear(),
        targetDate.getMonth(),
        1
      )
    )

    window.setTimeout(() => {
      clearEventForm()
      setSelectedDay(
        targetDate.getDate()
      )
      setEventStartDate(
        targetDateKey
      )
      setEventStartDateText(
        formatDateKeyForText(
          targetDateKey
        )
      )

      if (capture.note) {
        setEventNotes(
          capture.note
        )
      }

      setIsAddingEvent(true)

      window.setTimeout(() => {
        const eventInput =
          document.querySelector<HTMLInputElement>(
            '.event-input'
          )

        eventInput?.focus()
      }, 0)
    }, 0)

    return
  }

  if (capture.captureType === 'recipe') {
    setSelectedCaptureId(null)

    setPage('meals')
    setMealsView('recipes')

    window.setTimeout(() => {
      openAddRecipeForm()
    }, 0)

    return
  }

  if (capture.captureType === 'list') {
    setSelectedCaptureId(null)

    if (lists.length === 0) {
      setPage('lists')
      setNewListName('')
      setListCreateOpen(true)
      return
    }

    const targetListId =
      lists.some(
        (list) =>
          list.id === selectedListId
      )
        ? selectedListId
        : lists[0]?.id ?? null

    setQuickListId(
      targetListId
    )
    setQuickListText(
      capture.note ?? ''
    )
    setQuickListOpen(true)
  }
}

async function loadMealPlans() {
  const response = await fetch('/api/meal-plans')
  const data = await response.json()

  setMealPlans(data)
}

async function loadMealPlanItems() {
  const response = await fetch(
    '/api/meal-plan-items'
  )

  if (!response.ok) {
    showAppNotification(
      'Could not load meal planner.'
    )
    return
  }

  const data = await response.json()

  setMealPlanItems(data)
}

function openMealPlanForm(
  date: string,
  mealType: MealPlanItem['mealType']
) {
  setMealPlanFormSource('planner')
  setEditingMealPlanItemId(null)
  setMealPlanDeleteConfirmOpen(false)
  setMealPlanFormDate(date)
  setMealPlanFormMealType(mealType)
  setMealPlanRecipeId('')
  setMealPlanCustomTitle('')
  setMealPlanNotes('')

  setMealPlanEntryMode(
    recipes.length > 0
      ? 'recipe'
      : 'custom'
  )

  setMealPlanFormOpen(true)
}

function openEditMealPlanForm(
  meal: MealPlanItem
) {
  setMealPlanFormSource('planner')
  setEditingMealPlanItemId(meal.id)
  setMealPlanDeleteConfirmOpen(false)
  setMealPlanFormDate(meal.date)
  setMealPlanFormMealType(meal.mealType)

  if (meal.recipeId !== null) {
    setMealPlanEntryMode('recipe')
    setMealPlanRecipeId(
      String(meal.recipeId)
    )
    setMealPlanCustomTitle('')
  } else {
    setMealPlanEntryMode('custom')
    setMealPlanRecipeId('')
    setMealPlanCustomTitle(
      meal.title
    )
  }

  setMealPlanNotes(
    meal.notes ?? ''
  )

  setMealPlanFormOpen(true)
}
function openRecipeMealPlanForm(
  recipe: Recipe
) {
  setEditingMealPlanItemId(null)
  setMealPlanDeleteConfirmOpen(false)
  setMealPlanFormSource('recipe')

  setMealPlanFormDate(
    getDateKeyFromDate(new Date())
  )

  setMealPlanFormMealType('dinner')
  setMealPlanEntryMode('recipe')
  setMealPlanRecipeId(
    String(recipe.id)
  )
  setMealPlanCustomTitle('')
  setMealPlanNotes('')

  setMealPlanFormOpen(true)
}
function closeMealPlanForm() {
  setMealPlanFormSource('planner')
  setMealPlanFormOpen(false)
  setMealPlanDeleteConfirmOpen(false)
  setEditingMealPlanItemId(null)
  setMealPlanFormDate('')
  setMealPlanRecipeId('')
  setMealPlanCustomTitle('')
  setMealPickerSearch('')
  setMealPickerKeyboardOpen(false)
  setMealPlanNotes('')
}

async function deleteMealPlanItem() {
  if (mealPlanFormDate === '') {
    return
  }

  const response = await fetch(
    `/api/meal-plan-items/${mealPlanFormDate}/${mealPlanFormMealType}`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
    const errorData =
      await response.json()

    showAppNotification(
      errorData.error ??
        'Could not remove the meal.'
    )

    return
  }

  await loadMealPlanItems()

  setMealPlanDeleteConfirmOpen(false)
  closeMealPlanForm()

  showAppNotification(
    'Meal removed from planner.'
  )
}
async function selectRecipeForMealPlan(
  recipe: Recipe
) {
  if (mealPlanFormDate === '') {
    return
  }

  if (editingMealPlanItemId === null) {
    const existingMeal =
      mealPlanItems.find(
        (item) =>
          item.date === mealPlanFormDate &&
          item.mealType ===
            mealPlanFormMealType
      )

    if (existingMeal) {
      showAppNotification(
        'That meal slot is already filled.'
      )
      return
    }
  }

  const wasEditing =
    editingMealPlanItemId !== null

  const response = await fetch(
    `/api/meal-plan-items/${mealPlanFormDate}/${mealPlanFormMealType}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify({
        itemId:
          editingMealPlanItemId,
        recipeId: recipe.id,
        title: '',
        notes: mealPlanNotes,
      }),
    }
  )

  if (!response.ok) {
    const errorData =
      await response.json()

    showAppNotification(
      errorData.error ??
        'Could not save the meal.'
    )

    return
  }

  await loadMealPlanItems()

  closeMealPlanForm()

  showAppNotification(
    wasEditing
      ? 'Meal updated.'
      : 'Meal added to planner.'
  )
}
async function saveMealPlanItem(
  event: FormEvent<HTMLFormElement>
) {
  event.preventDefault()

  if (mealPlanFormDate === '') {
    return
  }

  if (
    mealPlanEntryMode === 'recipe' &&
    mealPlanRecipeId === ''
  ) {
    showAppNotification(
      'Choose a recipe.'
    )
    return
  }

  if (
    mealPlanEntryMode === 'custom' &&
    mealPlanCustomTitle.trim() === ''
  ) {
    showAppNotification(
      'Enter a meal name.'
    )
    return
  }
if (editingMealPlanItemId === null) {
  const existingMeal =
    mealPlanItems.find(
      (item) =>
        item.date === mealPlanFormDate &&
        item.mealType ===
          mealPlanFormMealType
    )

  if (existingMeal) {
    showAppNotification(
      'That meal slot is already filled.'
    )
    return
  }
}
  const requestBody =
  mealPlanEntryMode === 'recipe'
    ? {
        itemId:
          editingMealPlanItemId,
        recipeId:
          Number(mealPlanRecipeId),
        title: '',
        notes: mealPlanNotes,
      }
    : {
        itemId:
          editingMealPlanItemId,
        recipeId: null,
        title:
          mealPlanCustomTitle.trim(),
        notes: mealPlanNotes,
      }

  const response = await fetch(
    `/api/meal-plan-items/${mealPlanFormDate}/${mealPlanFormMealType}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(
        requestBody
      ),
    }
  )

  if (!response.ok) {
    const errorData =
      await response.json()

    showAppNotification(
      errorData.error ??
        'Could not save the meal.'
    )
    return
  }

  await loadMealPlanItems()

  closeMealPlanForm()

  showAppNotification(
  editingMealPlanItemId === null
    ? 'Meal added to planner.'
    : 'Meal updated.'
)
}

async function loadRecipes() {
  const response = await fetch('/api/recipes')

  if (!response.ok) {
    showAppNotification(
      'Could not load recipes.'
    )
    return
  }

  const data = await response.json()

  setRecipes(data)
}

function clearRecipeForm() {
  setEditingRecipeId(null)
  setRecipeName('')
  setRecipeImageFile(null)
  setRecipeImagePreview('')
  setRecipeFileInputKey((value) => value + 1)
  setRecipeServings('')
  setRecipePrepTime('')
  setRecipeCookTime('')
  setRecipeIngredients('')
  setRecipeInstructions('')
  setRecipeNotes('')
  setRecipeTags('')
  setRecipeFavorite(false)
setRecipeSourceUrl('')
setRecipeSourceImage('')
}

function openRecipeDetails(recipeId: number) {
  setViewingRecipeId(recipeId)
}

function closeRecipeDetails() {
  setRecipeDeleteConfirmOpen(false)
  setRecipeListPickerOpen(false)
  setViewingRecipeId(null)
}

async function addRecipeIngredientsToList(
  recipe: Recipe,
  listId: number
) {
  const listsResponse = await fetch('/api/lists')

  if (!listsResponse.ok) {
    showAppNotification(
      'Could not check the current list.'
    )
    return
  }

  const freshLists = await listsResponse.json()

  const targetList = freshLists.find(
    (list: {
      id: number
      name: string
      items: ListItem[]
    }) => list.id === listId
  )

  if (!targetList) {
    showAppNotification(
      'That list could not be found.'
    )
    return
  }

  const ingredientLines = recipe.ingredients
    .split(/\r?\n/)
    .map((ingredient) => ingredient.trim())
    .filter((ingredient) => ingredient !== '')

  if (ingredientLines.length === 0) {
    showAppNotification(
      'This recipe does not have any ingredients yet.'
    )
    return
  }

  const existingItems = new Set(
    targetList.items.map((item: ListItem) =>
      item.text.trim().toLowerCase()
    )
  )

  const recipeItems = new Set<string>()

  const ingredientsToAdd =
    ingredientLines.filter((ingredient) => {
      const normalizedIngredient =
        ingredient.toLowerCase()

      if (
        existingItems.has(normalizedIngredient) ||
        recipeItems.has(normalizedIngredient)
      ) {
        return false
      }

      recipeItems.add(normalizedIngredient)
      return true
    })

  if (ingredientsToAdd.length === 0) {
    showAppNotification(
      `All ingredients are already on ${targetList.name}.`
    )
    setRecipeListPickerOpen(false)
    return
  }

  let addedCount = 0

  for (const ingredient of ingredientsToAdd) {
    const response = await fetch(
      `/api/lists/${listId}/items`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: ingredient,
        }),
      }
    )

    if (!response.ok) {
      await loadLists()

      showAppNotification(
        addedCount > 0
          ? `Added ${addedCount} ingredients, but the rest could not be added.`
          : 'Could not add the ingredients.'
      )

      return
    }

    addedCount += 1
  }

  await loadLists()
  setRecipeListPickerOpen(false)

  showAppNotification(
    `Added ${addedCount} ${
      addedCount === 1
        ? 'ingredient'
        : 'ingredients'
    } to ${targetList.name}.`
  )
}
async function addMealPlannerWeekIngredientsToList(
  listId: number
) {
  const targetList = lists.find(
    (list) => list.id === listId
  )

  if (!targetList) {
    showAppNotification(
      'That list could not be found.'
    )
    return
  }

   const isMobile =
    window.innerWidth <= 760

  const viewedWeekStart =
    isMobile
      ? new Date(mobileMealsDate)
      : new Date(
          mealPlannerWeekStart
        )

  viewedWeekStart.setHours(
    12,
    0,
    0,
    0
  )

  if (isMobile) {
    viewedWeekStart.setDate(
      viewedWeekStart.getDate() -
        viewedWeekStart.getDay()
    )
  }

  const viewedWeekEnd =
    new Date(viewedWeekStart)

  viewedWeekEnd.setDate(
    viewedWeekStart.getDate() + 6
  )

  const currentDate =
    new Date()

  currentDate.setHours(
    12,
    0,
    0,
    0
  )

  if (
    viewedWeekEnd.getTime() <
    currentDate.getTime()
  ) {
    showAppNotification(
      'That week has already passed.'
    )

    setMealPlannerListPickerOpen(false)
    return
  }

  const isCurrentWeek =
    currentDate.getTime() >=
      viewedWeekStart.getTime() &&
    currentDate.getTime() <=
      viewedWeekEnd.getTime()

  const groceryStartDate =
    isCurrentWeek
      ? new Date(currentDate)
      : new Date(viewedWeekStart)

  const groceryDayCount =
    Math.floor(
      (
        viewedWeekEnd.getTime() -
        groceryStartDate.getTime()
      ) /
        (
          24 *
          60 *
          60 *
          1000
        )
    ) + 1

  const weekDateKeys =
    new Set(
      Array.from(
        {
          length:
            groceryDayCount,
        },
        (_, dayIndex) => {
          const day =
            new Date(
              groceryStartDate
            )

          day.setDate(
            groceryStartDate.getDate() +
              dayIndex
          )

          return getDateKeyFromDate(
            day
          )
        }
      )
    )

  const weekMeals = mealPlanItems.filter(
    (meal) =>
      weekDateKeys.has(meal.date) &&
      meal.recipeId !== null
  )

  if (weekMeals.length === 0) {
    showAppNotification(
      'There are no recipe-based meals planned for this week.'
    )
    setMealPlannerListPickerOpen(false)
    return
  }

  const existingItems = new Set(
    targetList.items.map((item) =>
      item.text.trim().toLowerCase()
    )
  )

  const queuedIngredients =
    new Set<string>()

  const ingredientsToAdd: string[] = []

  for (const meal of weekMeals) {
    if (meal.recipeId === null) {
      continue
    }

    const recipe = recipes.find(
      (item) =>
        item.id === meal.recipeId
    )

    if (!recipe) {
      continue
    }

    const ingredientLines =
      recipe.ingredients
        .split(/\r?\n/)
        .map((ingredient) =>
          ingredient.trim()
        )
        .filter(
          (ingredient) =>
            ingredient !== ''
        )

    for (const ingredient of ingredientLines) {
      const normalizedIngredient =
        ingredient.toLowerCase()

      if (
        existingItems.has(
          normalizedIngredient
        ) ||
        queuedIngredients.has(
          normalizedIngredient
        )
      ) {
        continue
      }

      queuedIngredients.add(
        normalizedIngredient
      )

      ingredientsToAdd.push(
        ingredient
      )
    }
  }

  if (ingredientsToAdd.length === 0) {
    showAppNotification(
      `There are no new ingredients to add to ${targetList.name}.`
    )

    setMealPlannerListPickerOpen(false)
    return
  }

  let addedCount = 0

  for (const ingredient of ingredientsToAdd) {
    const response = await fetch(
      `/api/lists/${listId}/items`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
        },
        body: JSON.stringify({
          text: ingredient,
        }),
      }
    )

    if (!response.ok) {
      await loadLists()

      showAppNotification(
        addedCount > 0
          ? `Added ${addedCount} ingredients, but the rest could not be added.`
          : 'Could not add the ingredients.'
      )

      return
    }

    addedCount += 1
  }

  await loadLists()

  setMealPlannerListPickerOpen(false)

  showAppNotification(
    `Added ${addedCount} ${
      addedCount === 1
        ? 'ingredient'
        : 'ingredients'
    } to ${targetList.name}.`
  )
}
async function deleteRecipe() {
  if (viewingRecipeId === null) {
    return
  }

  const response = await fetch(
    `/api/recipes/${viewingRecipeId}`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
    const errorData =
      await response.json()

    showAppNotification(
      errorData.error ??
        'Could not delete the recipe.'
    )

    return
  }

  await loadRecipes()

  setRecipeDeleteConfirmOpen(false)
  setViewingRecipeId(null)

  showAppNotification(
    'Recipe deleted.'
  )
}

function startEditingRecipe(recipe: Recipe) {
  clearRecipeForm()

  setEditingRecipeId(recipe.id)
  setRecipeName(recipe.name)
  setRecipeImageFile(null)
  setRecipeImagePreview(
    recipe.image
      ? `/uploads/${recipe.image}`
      : ''
  )
  setRecipeFileInputKey(
    (value) => value + 1
  )
  setRecipeServings(
    recipe.servings !== null
      ? String(recipe.servings)
      : ''
  )
  setRecipePrepTime(
    recipe.prepTime ?? ''
  )
  setRecipeCookTime(
    recipe.cookTime ?? ''
  )
  setRecipeIngredients(
    recipe.ingredients
  )
  setRecipeInstructions(
    recipe.instructions
  )
  setRecipeNotes(
    recipe.notes ?? ''
  )
  setRecipeTags(
    recipe.tags ?? ''
  )
  setRecipeFavorite(
    recipe.favorite
  )
  setRecipeSourceUrl(
    recipe.sourceUrl ?? ''
  )

  setRecipeFormOpen(true)
}

function openAddRecipeForm(
  source: 'recipes' | 'meal-picker' = 'recipes'
) {
  clearRecipeForm()
  setRecipeFormSource(source)
  setRecipeFormOpen(true)
}

function closeRecipeForm() {
  setRecipeFormOpen(false)
  setRecipeFormSource('recipes')
  clearRecipeForm()
}

function toggleRecipeQuickTag(tag: string) {
  setRecipeTags((currentTags) => {
    const tags = currentTags
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')

    const tagExists = tags.some(
      (item) =>
        item.toLowerCase() === tag.toLowerCase()
    )

    const nextTags = tagExists
      ? tags.filter(
          (item) =>
            item.toLowerCase() !==
            tag.toLowerCase()
        )
      : [...tags, tag]

    return nextTags.join(', ')
  })
}

function recipeQuickTagIsSelected(tag: string) {
  return recipeTags
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .includes(tag.toLowerCase())
}

function handleRecipeImageChange(
  event: ChangeEvent<HTMLInputElement>
) {
  const file =
    event.target.files?.[0] ?? null

  setRecipeImageFile(file)

  if (file) {
    setRecipeImagePreview(
      URL.createObjectURL(file)
    )
    return
  }

  setRecipeImagePreview('')
}

async function saveRecipe(
  event: FormEvent<HTMLFormElement>
) {
  event.preventDefault()

  if (recipeName.trim() === '') {
    showAppNotification(
      'Enter a recipe name.'
    )
    return
  }

  const formData = new FormData()

  formData.append(
    'name',
    recipeName.trim()
  )

  formData.append(
    'servings',
    recipeServings
  )

  formData.append(
    'prepTime',
    recipePrepTime
  )

  formData.append(
    'cookTime',
    recipeCookTime
  )

  formData.append(
    'ingredients',
    recipeIngredients
  )

  formData.append(
    'instructions',
    recipeInstructions
  )

  formData.append(
    'notes',
    recipeNotes
  )

  formData.append(
    'tags',
    recipeTags
  )

  formData.append(
    'favorite',
    recipeFavorite ? 'true' : 'false'
  )

  formData.append(
    'sourceUrl',
    recipeSourceUrl
  )

  if (recipeSourceImage !== '') {
  formData.append(
    'sourceImage',
    recipeSourceImage
  )
}

  if (recipeImageFile) {
    formData.append(
      'image',
      recipeImageFile
    )
  }

  const recipeUrl =
  editingRecipeId === null
    ? '/api/recipes'
    : `/api/recipes/${editingRecipeId}`

const recipeMethod =
  editingRecipeId === null
    ? 'POST'
    : 'PUT'

const response = await fetch(
  recipeUrl,
  {
    method: recipeMethod,
    body: formData,
  }
)

  if (!response.ok) {
    const errorData =
      await response.json()

    showAppNotification(
      errorData.error ??
        'Could not save the recipe.'
    )

    return
  }

  await loadRecipes()

  showAppNotification(
  editingRecipeId === null
    ? 'Recipe saved.'
    : 'Recipe updated.'
)

  closeRecipeForm()
}

  function getDateKeyForMonth(
  targetYear: number,
  targetMonth: number,
  day: number
) {
  const monthNumber =
    String(targetMonth + 1).padStart(2, '0')

  const dayNumber =
    String(day).padStart(2, '0')

  return `${targetYear}-${monthNumber}-${dayNumber}`
}

function getDateKey(day: number) {
  return getDateKeyForMonth(
    year,
    month,
    day
  )
}

function getDateKeyFromDate(date: Date) {
  const yearNumber = date.getFullYear()
  const monthNumber = String(date.getMonth() + 1).padStart(2, '0')
  const dayNumber = String(date.getDate()).padStart(2, '0')

  return `${yearNumber}-${monthNumber}-${dayNumber}`
}
function getWeekDates(date: Date) {
  const startOfWeek = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - date.getDay()
  )

  return Array.from({ length: 7 }, (_, index) => {
    return new Date(
      startOfWeek.getFullYear(),
      startOfWeek.getMonth(),
      startOfWeek.getDate() + index
    )
  })
}
function formatDateKeyForText(
  dateKey: string
) {
  const [year, month, day] =
    dateKey.split('-')

  return `${month}/${day}/${year}`
}
function getOrdinalSuffix(
  day: number
) {
  if (
    day >= 11 &&
    day <= 13
  ) {
    return 'th'
  }

  switch (day % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

function formatWeekMultiDayDateRange(
  startDateKey: string,
  endDateKey: string
) {
  const startDate = new Date(
    `${startDateKey}T12:00:00`
  )

  const endDate = new Date(
    `${endDateKey}T12:00:00`
  )

  const startDay =
    startDate.getDate()

  const endDay =
    endDate.getDate()

  const startMonth =
    startDate.toLocaleDateString(
      'en-US',
      {
        month: 'short',
      }
    )

  const endMonth =
    endDate.toLocaleDateString(
      'en-US',
      {
        month: 'short',
      }
    )

  const startYear =
    startDate.getFullYear()

  const endYear =
    endDate.getFullYear()

  const startDayText =
    `${startDay}${getOrdinalSuffix(
      startDay
    )}`

  const endDayText =
    `${endDay}${getOrdinalSuffix(
      endDay
    )}`

  if (startYear !== endYear) {
    return (
      `${startMonth} ${startDayText}, ` +
      `${startYear} – ` +
      `${endMonth} ${endDayText}, ` +
      `${endYear}`
    )
  }

  if (
    startDate.getMonth() ===
    endDate.getMonth()
  ) {
    return (
      `${startMonth} ${startDayText} – ` +
      `${endDayText}`
    )
  }

  return (
    `${startMonth} ${startDayText} – ` +
    `${endMonth} ${endDayText}`
  )
}
function parseDateTextToDateKey(
  value: string
) {
  const match = value
    .trim()
    .match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
    )

  if (!match) {
    return null
  }

  const month = Number(match[1])
  const day = Number(match[2])
  const year = Number(match[3])

  const testDate = new Date(
    Date.UTC(year, month - 1, day)
  )

  if (
    testDate.getUTCFullYear() !== year ||
    testDate.getUTCMonth() !== month - 1 ||
    testDate.getUTCDate() !== day
  ) {
    return null
  }

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-')
}
function addDaysToDateKey(
  dateKey: string,
  numberOfDays: number
) {
  const [dateYear, dateMonth, dateDay] =
    dateKey.split('-').map(Number)

  const date = new Date(
    Date.UTC(
      dateYear,
      dateMonth - 1,
      dateDay
    )
  )

  date.setUTCDate(
    date.getUTCDate() + numberOfDays
  )

  return date.toISOString().slice(0, 10)
}

function getDateDifferenceInDays(
  startDate: string,
  endDate: string
) {
  const [startYear, startMonth, startDay] =
    startDate.split('-').map(Number)

  const [endYear, endMonth, endDay] =
    endDate.split('-').map(Number)

  const startUtc = Date.UTC(
    startYear,
    startMonth - 1,
    startDay
  )

  const endUtc = Date.UTC(
    endYear,
    endMonth - 1,
    endDay
  )

  const millisecondsPerDay =
    24 * 60 * 60 * 1000

  return Math.round(
    (endUtc - startUtc) /
      millisecondsPerDay
  )
}

function getEventDurationDays(
  calendarEvent: CalendarEvent
) {
  if (
    !calendarEvent.endDate ||
    calendarEvent.endDate <= calendarEvent.date
  ) {
    return 0
  }

  return getDateDifferenceInDays(
    calendarEvent.date,
    calendarEvent.endDate
  )
}

function doesEventStartOnDate(
  calendarEvent: CalendarEvent,
  targetDate: string
) {
  if (
    calendarEvent.exceptions?.includes(
      targetDate
    )
  ) {
    return false
  }

  if (!calendarEvent.repeatUnit) {
    return calendarEvent.date === targetDate
  }

  if (targetDate < calendarEvent.date) {
    return false
  }

  if (
    calendarEvent.repeatEndType === 'date' &&
    calendarEvent.repeatEndDate &&
    targetDate > calendarEvent.repeatEndDate
  ) {
    return false
  }

  const interval =
    calendarEvent.repeatInterval ?? 1

  const [startYear, startMonth, startDay] =
    calendarEvent.date.split('-').map(Number)

  const [targetYear, targetMonth, targetDay] =
    targetDate.split('-').map(Number)

  const startUtc = Date.UTC(
    startYear,
    startMonth - 1,
    startDay
  )

  const targetUtc = Date.UTC(
    targetYear,
    targetMonth - 1,
    targetDay
  )

  const millisecondsPerDay =
    24 * 60 * 60 * 1000

  const differenceInDays =
    (targetUtc - startUtc) /
    millisecondsPerDay

  let occurrenceNumber: number | null = null

  if (calendarEvent.repeatUnit === 'day') {
    if (
      differenceInDays % interval !== 0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInDays / interval + 1
  }

  if (calendarEvent.repeatUnit === 'week') {
    const daysPerOccurrence =
      interval * 7

    if (
      differenceInDays %
        daysPerOccurrence !==
      0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInDays /
        daysPerOccurrence +
      1
  }

  if (calendarEvent.repeatUnit === 'month') {
    if (targetDay !== startDay) {
      return false
    }

    const differenceInMonths =
      (targetYear - startYear) * 12 +
      (targetMonth - startMonth)

    if (
      differenceInMonths < 0 ||
      differenceInMonths % interval !== 0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInMonths / interval + 1
  }

  if (calendarEvent.repeatUnit === 'year') {
    if (
      targetMonth !== startMonth ||
      targetDay !== startDay
    ) {
      return false
    }

    const differenceInYears =
      targetYear - startYear

    if (
      differenceInYears < 0 ||
      differenceInYears % interval !== 0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInYears / interval + 1
  }

  if (occurrenceNumber === null) {
    return false
  }

  if (
    calendarEvent.repeatEndType === 'count' &&
    calendarEvent.repeatCount !== null &&
    occurrenceNumber >
      calendarEvent.repeatCount
  ) {
    return false
  }

  return true
}

function getOccurrenceStartForDate(
  calendarEvent: CalendarEvent,
  targetDate: string
) {
  const durationDays =
    getEventDurationDays(calendarEvent)

  for (
    let dayOffset = 0;
    dayOffset <= durationDays;
    dayOffset += 1
  ) {
    const possibleStartDate =
      addDaysToDateKey(
        targetDate,
        -dayOffset
      )

    if (
      doesEventStartOnDate(
        calendarEvent,
        possibleStartDate
      )
    ) {
      return possibleStartDate
    }
  }

  return null
}

function doesEventOccurOnDate(
  calendarEvent: CalendarEvent,
  targetDate: string
) {
  if (
    calendarPersonFilterId !== null &&
    !calendarEvent.people.some(
      (person) =>
        person.id === calendarPersonFilterId
    )
  ) {
    return false
  }

  return (
    getOccurrenceStartForDate(
      calendarEvent,
      targetDate
    ) !== null
  )
}
function isMultiDayEvent(
  calendarEvent: CalendarEvent
) {
  return Boolean(
    calendarEvent.endDate &&
    calendarEvent.endDate > calendarEvent.date
  )
}

function getMonthWeekMultiDaySegments(
  week: (number | null)[],
  targetYear = year,
  targetMonth = month
) {
  const segments: Array<{
    calendarEvent: CalendarEvent
    occurrenceStartDate: string
    occurrenceEndDate: string
    startColumn: number
    endColumn: number
    continuesBefore: boolean
    continuesAfter: boolean
  }> = []

for (const calendarEvent of events) {
  if (
    calendarPersonFilterId !== null &&
    !calendarEvent.people.some(
      (person) =>
        person.id === calendarPersonFilterId
    )
  ) {
    continue
  }

  if (!isMultiDayEvent(calendarEvent)) {
    continue
  }

    const durationDays =
      getEventDurationDays(calendarEvent)

    const occurrenceStartDates = new Set<string>()

    week.forEach((day) => {
      if (day === null) return

      const dateKey =
  getDateKeyForMonth(
    targetYear,
    targetMonth,
    day
  )

      const occurrenceStartDate =
        getOccurrenceStartForDate(
          calendarEvent,
          dateKey
        )

      if (occurrenceStartDate) {
        occurrenceStartDates.add(
          occurrenceStartDate
        )
      }
    })

    for (
      const occurrenceStartDate
      of occurrenceStartDates
    ) {
      const occurrenceEndDate =
        addDaysToDateKey(
          occurrenceStartDate,
          durationDays
        )

      const coveredColumns: number[] = []

      week.forEach((day, columnIndex) => {
        if (day === null) return

        const dateKey =
  getDateKeyForMonth(
    targetYear,
    targetMonth,
    day
  )

        if (
          dateKey >= occurrenceStartDate &&
          dateKey <= occurrenceEndDate
        ) {
          coveredColumns.push(columnIndex)
        }
      })

      if (coveredColumns.length === 0) {
        continue
      }

      const startColumn =
        coveredColumns[0]

      const endColumn =
        coveredColumns[
          coveredColumns.length - 1
        ]

      const firstVisibleDay =
        week[startColumn]

      const lastVisibleDay =
        week[endColumn]

      if (
        firstVisibleDay === null ||
        lastVisibleDay === null
      ) {
        continue
      }

      const firstVisibleDate =
        getDateKey(firstVisibleDay)

      const lastVisibleDate =
        getDateKey(lastVisibleDay)

      segments.push({
        calendarEvent,
        occurrenceStartDate,
        occurrenceEndDate,
        startColumn,
        endColumn,
        continuesBefore:
          occurrenceStartDate <
          firstVisibleDate,
        continuesAfter:
          occurrenceEndDate >
          lastVisibleDate,
      })
    }
  }

  segments.sort((segmentA, segmentB) => {
    if (
      segmentA.startColumn !==
      segmentB.startColumn
    ) {
      return (
        segmentA.startColumn -
        segmentB.startColumn
      )
    }

    return (
      segmentB.endColumn -
      segmentA.endColumn
    )
  })

  const laneEndColumns: number[] = []

  return segments.map((segment) => {
    let lane = laneEndColumns.findIndex(
      (endColumn) =>
        endColumn < segment.startColumn
    )

    if (lane === -1) {
      lane = laneEndColumns.length
      laneEndColumns.push(
        segment.endColumn
      )
    } else {
      laneEndColumns[lane] =
        segment.endColumn
    }

    return {
      ...segment,
      lane,
    }
  })
}

function getWeekMultiDaySegments(
  boardDates: Date[]
) {
  const segments: Array<{
    calendarEvent: CalendarEvent
    occurrenceStartDate: string
    occurrenceEndDate: string
    startColumn: number
    endColumn: number
    continuesBefore: boolean
    continuesAfter: boolean
  }> = []

  for (const calendarEvent of events) {
    if (
      calendarPersonFilterId !== null &&
      !calendarEvent.people.some(
        (person) =>
          person.id ===
          calendarPersonFilterId
      )
    ) {
      continue
    }

    if (!isMultiDayEvent(calendarEvent)) {
      continue
    }

    const durationDays =
      getEventDurationDays(calendarEvent)

    const occurrenceStartDates =
      new Set<string>()

    boardDates.forEach((boardDate) => {
      const dateKey =
        getDateKeyFromDate(boardDate)

      const occurrenceStartDate =
        getOccurrenceStartForDate(
          calendarEvent,
          dateKey
        )

      if (occurrenceStartDate) {
        occurrenceStartDates.add(
          occurrenceStartDate
        )
      }
    })

    for (
      const occurrenceStartDate
      of occurrenceStartDates
    ) {
      const occurrenceEndDate =
        addDaysToDateKey(
          occurrenceStartDate,
          durationDays
        )

      const coveredColumns: number[] = []

      boardDates.forEach(
        (boardDate, columnIndex) => {
          const dateKey =
            getDateKeyFromDate(boardDate)

          if (
            dateKey >= occurrenceStartDate &&
            dateKey <= occurrenceEndDate
          ) {
            coveredColumns.push(
              columnIndex
            )
          }
        }
      )

      if (coveredColumns.length === 0) {
        continue
      }

      const startColumn =
        coveredColumns[0]

      const endColumn =
        coveredColumns[
          coveredColumns.length - 1
        ]

      const firstVisibleDate =
        getDateKeyFromDate(
          boardDates[startColumn]
        )

      const lastVisibleDate =
        getDateKeyFromDate(
          boardDates[endColumn]
        )

      segments.push({
        calendarEvent,
        occurrenceStartDate,
        occurrenceEndDate,
        startColumn,
        endColumn,
        continuesBefore:
          occurrenceStartDate <
          firstVisibleDate,
        continuesAfter:
          occurrenceEndDate >
          lastVisibleDate,
      })
    }
  }

  segments.sort((segmentA, segmentB) => {
    if (
      segmentA.startColumn !==
      segmentB.startColumn
    ) {
      return (
        segmentA.startColumn -
        segmentB.startColumn
      )
    }

    return (
      segmentB.endColumn -
      segmentA.endColumn
    )
  })

  const laneEndColumns: number[] = []

  return segments.map((segment) => {
    let lane = laneEndColumns.findIndex(
      (endColumn) =>
        endColumn <
        segment.startColumn
    )

    if (lane === -1) {
      lane = laneEndColumns.length

      laneEndColumns.push(
        segment.endColumn
      )
    } else {
      laneEndColumns[lane] =
        segment.endColumn
    }

    return {
      ...segment,
      lane,
    }
  })
}

function isValidEventTimeRange(
  startDate: string,
  endDate: string | null,
  startTime: string,
  endTime: string,
  allDay: boolean
) {
  if (allDay || !endTime) {
    return true
  }

  if (!startTime) {
    return false
  }

  const actualEndDate =
    endDate || startDate

  if (actualEndDate > startDate) {
    return true
  }

  return endTime > startTime
}
  function formatTime(time: string | null) {
    if (!time) return ''

    const [hourText, minuteText] = time.split(':')
    const hour = Number(hourText)

    if (Number.isNaN(hour)) return time

    const period = hour >= 12 ? 'PM' : 'AM'
    const displayHour = hour % 12 || 12

    return `${displayHour}:${minuteText} ${period}`
  }

  function getTextColor(backgroundColor: string) {
    const hex = backgroundColor.replace('#', '')

    const red = parseInt(hex.substring(0, 2), 16)
    const green = parseInt(hex.substring(2, 4), 16)
    const blue = parseInt(hex.substring(4, 6), 16)

    const brightness =
      (red * 299 + green * 587 + blue * 114) / 1000

    return brightness > 150 ? '#222' : '#fff'
  }
function softenEventColor(
  color: string
) {
  return `color-mix(
    in srgb,
    ${color} 60%,
    white
  )`
}

function getEventBackground(
  eventPeople: Person[]
) {
  if (eventPeople.length === 0) {
    return '#e8edff'
  }

  if (eventPeople.length === 1) {
    return softenEventColor(
      eventPeople[0].color
    )
  }

  const colors = eventPeople.map(
    (person) =>
      softenEventColor(person.color)
  )

  const bandSize =
    100 / colors.length

  const blendSize = Math.min(
    7,
    bandSize * 0.3
  )

  const stops: string[] = [
    `${colors[0]} 0%`,
  ]

  for (
    let index = 1;
    index < colors.length;
    index += 1
  ) {
    const boundary =
      index * bandSize

    stops.push(
      `${colors[index - 1]} ${
        boundary - blendSize / 2
      }%`
    )

    stops.push(
      `${colors[index]} ${
        boundary + blendSize / 2
      }%`
    )
  }

  stops.push(
    `${colors[colors.length - 1]} 100%`
  )

  return `radial-gradient(
    ellipse 135% 175%
    at -12% 112%,
    ${stops.join(', ')}
  )`
}

  function getPersonImageUrl(image: string) {
    return `/uploads/${image}`
  }

  function renderPersonAvatar(
    person: Person,
    className: string
  ) {
    if (person.image) {
      return (
        <img
          className={`${className} person-avatar-image`}
          src={getPersonImageUrl(person.image)}
          alt={person.name}
        />
      )
    }

    return (
      <div
        className={`${className} person-avatar-fallback`}
        style={{
          backgroundColor: person.color,
          color: getTextColor(person.color),
        }}
      >
        {person.name.charAt(0).toUpperCase()}
      </div>
    )
  }
function togglePendingMultipleEventDate(
  dateKey: string
) {
  setPendingMultipleDates(
    (currentDates) =>
      currentDates.includes(dateKey)
        ? currentDates.filter(
            (selectedDate) =>
              selectedDate !== dateKey
          )
        : [
            ...currentDates,
            dateKey,
          ].sort()
  )
}
  function togglePersonForEvent(personId: number) {
    setSelectedPersonIds((currentIds) => {
      if (currentIds.includes(personId)) {
        return currentIds.filter((id) => id !== personId)
      }

      return [...currentIds, personId]
    })
  }

  async function addOrUpdateEvent(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault()

    if (selectedDay === null) return
    if (eventTitle.trim() === '') {
  setEventTitleError(true)

  window.setTimeout(() => {
    setEventTitleError(false)
  }, 1200)

  return
}
const editingCalendarEvent =
  editingEventId !== null
    ? events.find(
        (calendarEvent) =>
          calendarEvent.id === editingEventId
      )
    : null

    if (editingCalendarEvent?.batchId) {
  setRecurringAction('batch-save')
  return
}

if (
  editingCalendarEvent?.repeatUnit &&
  editingCalendarEvent.repeatUnit !== 'none'
) {
  setRecurringAction('save')
  return
}

const isMultipleDateAdd =
  editingEventId === null &&
  eventDateMode === 'multiple'

if (
  isMultipleDateAdd &&
  eventMultipleDates.length === 0
) {
  showAppNotification(
    'Select at least one date.'
  )
  return
}

const parsedStartDate =
  isMultipleDateAdd
    ? eventMultipleDates[0]
    : parseDateTextToDateKey(
        eventStartDateText
      )

if (!parsedStartDate) {
  setEventStartDateError(true)

  window.setTimeout(() => {
    setEventStartDateError(false)
  }, 1200)

  return
}

let parsedEndDate: string | null = null

if (eventEndDateText.trim() !== '') {
  parsedEndDate =
    parseDateTextToDateKey(
      eventEndDateText
    )

  if (!parsedEndDate) {
    setEventEndDateError(true)

    window.setTimeout(() => {
      setEventEndDateError(false)
    }, 1200)

    return
  }

  if (parsedEndDate < parsedStartDate) {
    setEventEndDateError(true)

    window.setTimeout(() => {
      setEventEndDateError(false)
    }, 1200)

    return
  }
}

const saveStartDate =
  parsedStartDate

const saveEndDate =
  parsedEndDate

const multipleDateTimeIsValid =
  eventAllDay ||
  !eventEndTime ||
  Boolean(eventTime)

if (
  isMultipleDateAdd
    ? !multipleDateTimeIsValid
    : !isValidEventTimeRange(
        saveStartDate,
        saveEndDate,
        eventTime,
        eventEndTime,
        eventAllDay
      )
) {
  setEventTimeError(true)

  window.setTimeout(() => {
    setEventTimeError(false)
  }, 1200)

  return
}
let saveRepeatEndDate: string | null = null

if (
  repeatUnit !== 'none' &&
  repeatEndType === 'date'
) {
  saveRepeatEndDate =
    parseDateTextToDateKey(
      repeatEndDateText
    )

  if (
    !saveRepeatEndDate ||
    saveRepeatEndDate < saveStartDate
  ) {
    setRepeatEndDateError(true)

    window.setTimeout(() => {
      setRepeatEndDateError(false)
    }, 1200)

    return
  }
}
  const eventData = {
  date: saveStartDate,
endDate: saveEndDate,
  title: eventTitle.trim(),
 time: eventAllDay ? '' : eventTime,
endTime: eventAllDay ? '' : eventEndTime,
notes: eventNotes,
location: eventLocation,
  personIds: selectedPersonIds,
  repeatUnit,
  repeatInterval,
  repeatEndType,
  repeatEndDate:
  repeatEndType === 'date'
    ? saveRepeatEndDate
    : null,
  repeatCount:
    repeatEndType === 'count'
      ? repeatCount
      : null,
}

    if (editingEventId !== null) {
      const response = await fetch(
        `/api/events/${editingEventId}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(eventData),
        }
      )

      if (!response.ok) {
        showAppNotification('Could not update the event.')
        return
      }

      await loadEvents()
      clearEventForm()
      return
    }
if (isMultipleDateAdd) {
  const batchId =
  `batch-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
  const isOvernight =
    !eventAllDay &&
    Boolean(eventTime) &&
    Boolean(eventEndTime) &&
    eventEndTime <= eventTime

  const responses =
    await Promise.all(
      eventMultipleDates.map(
        (selectedDate) => {
          const multipleDateEventData = {
  ...eventData,
  batchId,
  date: selectedDate,
            endDate: isOvernight
              ? addDaysToDateKey(
                  selectedDate,
                  1
                )
              : null,
            repeatUnit: 'none',
            repeatInterval: 1,
            repeatEndType: 'never',
            repeatEndDate: null,
            repeatCount: null,
          }

          return fetch('/api/events', {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify(
              multipleDateEventData
            ),
          })
        }
      )
    )

  const failedResponse =
    responses.some(
      (response) => !response.ok
    )

  if (failedResponse) {
    showAppNotification(
      'Could not add every selected date.'
    )

    await loadEvents()
    return
  }

  await loadEvents()
clearEventForm()

  return

return
}

    const response = await fetch('/api/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventData),
    })

    if (!response.ok) {
      showAppNotification('Could not add the event.')
      return
    }

    await loadEvents()
    const wasDuplicate = duplicateSourceEventId !== null
    clearEventForm()
    if (wasDuplicate) showAppNotification('Event copy created. Original event unchanged.')
  }

  async function saveBatchThisEventOnly() {
  if (editingEventId === null) {
    return
  }

  const calendarEvent = events.find(
    (event) => event.id === editingEventId
  )

  if (!calendarEvent?.batchId) {
    return
  }

  if (eventTitle.trim() === '') {
    setEventTitleError(true)

    window.setTimeout(() => {
      setEventTitleError(false)
    }, 1200)

    return
  }

  const parsedStartDate =
    parseDateTextToDateKey(
      eventStartDateText
    )

  if (!parsedStartDate) {
    setEventStartDateError(true)

    window.setTimeout(() => {
      setEventStartDateError(false)
    }, 1200)

    return
  }

  let parsedEndDate: string | null = null

  if (eventEndDateText.trim() !== '') {
    parsedEndDate =
      parseDateTextToDateKey(
        eventEndDateText
      )

    if (
      !parsedEndDate ||
      parsedEndDate < parsedStartDate
    ) {
      setEventEndDateError(true)

      window.setTimeout(() => {
        setEventEndDateError(false)
      }, 1200)

      return
    }
  }

  if (
    !isValidEventTimeRange(
      parsedStartDate,
      parsedEndDate,
      eventTime,
      eventEndTime,
      eventAllDay
    )
  ) {
    setEventTimeError(true)

    window.setTimeout(() => {
      setEventTimeError(false)
    }, 1200)

    return
  }

  const eventData = {
    date: parsedStartDate,
    endDate: parsedEndDate,
    title: eventTitle.trim(),
    time: eventAllDay ? '' : eventTime,
    endTime:
      eventAllDay ? '' : eventEndTime,
    notes: eventNotes,
    location: eventLocation,
    personIds: selectedPersonIds,
    repeatUnit: 'none',
    repeatInterval: 1,
    repeatEndType: 'never',
    repeatEndDate: null,
    repeatCount: null,
  }

  const response = await fetch(
    `/api/events/${editingEventId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventData),
    }
  )

  if (!response.ok) {
    showAppNotification(
      'Could not update this event.'
    )
    return
  }

  await loadEvents()
  clearEventForm()
}

async function saveEventBatchChanges() {
  if (editingEventId === null) {
    return
  }

  const editingCalendarEvent = events.find(
    (event) => event.id === editingEventId
  )

  if (!editingCalendarEvent?.batchId) {
    return
  }

  if (eventTitle.trim() === '') {
    setEventTitleError(true)

    window.setTimeout(() => {
      setEventTitleError(false)
    }, 1200)

    return
  }

  const batchEvents = events.filter(
    (calendarEvent) =>
      calendarEvent.batchId ===
      editingCalendarEvent.batchId
  )

  if (batchEvents.length === 0) {
    return
  }

  const timeIsValid =
    eventAllDay ||
    !eventEndTime ||
    Boolean(eventTime)

  if (!timeIsValid) {
    setEventTimeError(true)

    window.setTimeout(() => {
      setEventTimeError(false)
    }, 1200)

    return
  }

  const isOvernight =
    !eventAllDay &&
    Boolean(eventTime) &&
    Boolean(eventEndTime) &&
    eventEndTime <= eventTime

  const responses = await Promise.all(
    batchEvents.map((calendarEvent) => {
      const eventData = {
        date: calendarEvent.date,
        endDate: isOvernight
          ? addDaysToDateKey(
              calendarEvent.date,
              1
            )
          : null,
        title: eventTitle.trim(),
        time:
          eventAllDay ? '' : eventTime,
        endTime:
          eventAllDay ? '' : eventEndTime,
        notes: eventNotes,
        location: eventLocation,
        personIds: selectedPersonIds,
        repeatUnit: 'none',
        repeatInterval: 1,
        repeatEndType: 'never',
        repeatEndDate: null,
        repeatCount: null,
      }

      return fetch(
        `/api/events/${calendarEvent.id}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify(eventData),
        }
      )
    })
  )

  const failedResponse =
    responses.some(
      (response) => !response.ok
    )

  if (failedResponse) {
    showAppNotification(
      'Could not update every selected date.'
    )

    await loadEvents()
    return
  }

  await loadEvents()

  showAppNotification(
    `Updated ${batchEvents.length} selected dates.`
  )

  clearEventForm()
}
async function saveEntireSeriesChanges() {
  if (
    editingEventId === null ||
    selectedDay === null
  ) {
    return
  }

  const editingCalendarEvent = events.find(
    (calendarEvent) =>
      calendarEvent.id === editingEventId
  )

  if (!editingCalendarEvent) {
    return
  }

  const parsedStartDate =
    parseDateTextToDateKey(
      eventStartDateText
    )

  if (!parsedStartDate) {
    setEventStartDateError(true)

    window.setTimeout(() => {
      setEventStartDateError(false)
    }, 1200)

    return
  }

  let parsedEndDate: string | null = null

  if (eventEndDateText.trim() !== '') {
    parsedEndDate =
      parseDateTextToDateKey(
        eventEndDateText
      )

    if (!parsedEndDate) {
      setEventEndDateError(true)

      window.setTimeout(() => {
        setEventEndDateError(false)
      }, 1200)

      return
    }

    if (parsedEndDate < parsedStartDate) {
      setEventEndDateError(true)

      window.setTimeout(() => {
        setEventEndDateError(false)
      }, 1200)

      return
    }
  }

  if (
    !isValidEventTimeRange(
      parsedStartDate,
      parsedEndDate,
      eventTime,
      eventEndTime,
      eventAllDay
    )
  ) {
    setEventTimeError(true)

    window.setTimeout(() => {
      setEventTimeError(false)
    }, 1200)

    return
  }

  let saveRepeatEndDate: string | null = null

if (
  repeatUnit !== 'none' &&
  repeatEndType === 'date'
) {
  saveRepeatEndDate =
    parseDateTextToDateKey(
      repeatEndDateText
    )

  if (
    !saveRepeatEndDate ||
    saveRepeatEndDate < parsedStartDate
  ) {
    setRepeatEndDateError(true)

    window.setTimeout(() => {
      setRepeatEndDateError(false)
    }, 1200)

    return
  }
}
  const eventData = {
    date: parsedStartDate,
    endDate: parsedEndDate,
    title: eventTitle.trim(),
    time: eventAllDay ? '' : eventTime,
    endTime:
      eventAllDay ? '' : eventEndTime,
    notes: eventNotes,
    location: eventLocation,
    personIds: selectedPersonIds,
    repeatUnit,
    repeatInterval,
    repeatEndType,
    repeatEndDate:
  repeatEndType === 'date'
    ? saveRepeatEndDate
    : null,
    repeatCount:
      repeatEndType === 'count'
        ? repeatCount
        : null,
  }

  const response = await fetch(
    `/api/events/${editingEventId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventData),
    }
  )

  if (!response.ok) {
   showAppNotification('Could not update the series.')
    return
  }

  await loadEvents()
  clearEventForm()
}
function openEventDetails(
  calendarEvent: CalendarEvent,
  occurrenceDate: string
) {
  const occurrence =
    new Date(`${occurrenceDate}T00:00:00`)

  setEditingEventId(null)
  setDuplicateSourceEventId(null)
  setEditingOccurrenceDate(null)
  setIsAddingEvent(false)
  setRecurringAction(null)

  setViewingEventId(calendarEvent.id)
  setViewingOccurrenceDate(occurrenceDate)

  setViewDate(
    new Date(
      occurrence.getFullYear(),
      occurrence.getMonth(),
      1
    )
  )

  setSelectedDay(
    occurrence.getDate()
  )
}
function startEditingEvent(
  calendarEvent: CalendarEvent,
  occurrenceDate: string
) {
  setDuplicateSourceEventId(null)
  setEventTitle(calendarEvent.title)
 setEventTime(calendarEvent.time ?? '')
setEventEndTime(calendarEvent.endTime ?? '')
setEventAllDay(!calendarEvent.time)
setEventDateMode('single')
setEventMultipleDates([])
  setEventStartDate(calendarEvent.date)
  setEventStartDateText(
  formatDateKeyForText(calendarEvent.date)
)
  setEventEndDate(calendarEvent.endDate ?? '')
setEventEndDateText(
  calendarEvent.endDate
    ? formatDateKeyForText(
        calendarEvent.endDate
      )
    : ''
)
  setEventNotes(calendarEvent.notes ?? '')
  setEventLocation(calendarEvent.location ?? '')
  setRepeatUnit(calendarEvent.repeatUnit ?? 'none')
  setRepeatInterval(calendarEvent.repeatInterval ?? 1)
  setRepeatEndType(calendarEvent.repeatEndType ?? 'never')
 setRepeatEndDate(calendarEvent.repeatEndDate ?? '')
setRepeatEndDateText(
  calendarEvent.repeatEndDate
    ? formatDateKeyForText(
        calendarEvent.repeatEndDate
      )
    : ''
)
  setRepeatCount(calendarEvent.repeatCount ?? 10)
  setSelectedPersonIds(
    calendarEvent.people.map((person) => person.id)
  )
  setEditingEventId(calendarEvent.id)
  setEditingOccurrenceDate(occurrenceDate)
}

function startDuplicatingEvent(calendarEvent: CalendarEvent, occurrenceDate: string) {
  // Prepare a new event using the selected occurrence. This makes no API call.
  const draft = makeEventDuplicateDraft(calendarEvent, occurrenceDate)
  clearEventForm()
  setDuplicateSourceEventId(calendarEvent.id)
  setEventTitle(draft.title)
  setEventTime(draft.time)
  setEventEndTime(draft.endTime)
  setEventAllDay(draft.allDay)
  setEventStartDate(draft.date)
  setEventStartDateText(formatDateKeyForText(draft.date))
  setEventEndDate(draft.endDate ?? '')
  setEventEndDateText(draft.endDate ? formatDateKeyForText(draft.endDate) : '')
  setEventNotes(draft.notes)
  setEventLocation(draft.location)
  setSelectedPersonIds(draft.personIds)
  setRepeatUnit(draft.repeatUnit)
  setRepeatInterval(draft.repeatInterval)
  setRepeatEndType(draft.repeatEndType)
  setRepeatEndDate('')
  setRepeatEndDateText('')
  setRepeatCount(10)
  setEventDateMode('single')
  setEventMultipleDates([])
  setIsAddingEvent(true)
}
  async function deleteEvent() {
  const activeEventId =
    editingEventId ?? viewingEventId

  if (activeEventId === null) {
    return
  }

  const response = await fetch(
    `/api/events/${activeEventId}`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
    showAppNotification(
      'Could not delete the event.'
    )
    return
  }

  await loadEvents()
  clearEventForm()
}
async function deleteEventBatch() {
  const activeEventId =
    editingEventId ?? viewingEventId

  if (activeEventId === null) {
    return
  }

  const calendarEvent = events.find(
    (event) => event.id === activeEventId
  )

  if (!calendarEvent?.batchId) {
    await deleteEvent()
    return
  }

  const response = await fetch(
    `/api/event-batches/${encodeURIComponent(
      calendarEvent.batchId
    )}`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
    showAppNotification(
      'Could not delete the selected dates.'
    )
    return
  }

  await loadEvents()
  clearEventForm()
}
async function deleteThisEventOnly() {
  const activeEventId =
    editingEventId ?? viewingEventId

  const activeOccurrenceDate =
    editingOccurrenceDate ??
    viewingOccurrenceDate

  if (
    activeEventId === null ||
    activeOccurrenceDate === null
  ) {
    return
  }

  const calendarEvent = events.find(
    (event) =>
      event.id === activeEventId
  )

  if (!calendarEvent) {
    return
  }

  if (
    !calendarEvent.repeatUnit ||
    calendarEvent.repeatUnit === 'none'
  ) {
    await deleteEvent()
    return
  }

  const occurrenceStartDate =
    getOccurrenceStartForDate(
      calendarEvent,
      activeOccurrenceDate
    ) ?? activeOccurrenceDate

  const response = await fetch(
    `/api/events/${activeEventId}/exceptions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        occurrenceDate:
          occurrenceStartDate,
      }),
    }
  )

  if (!response.ok) {
    showAppNotification(
      'Could not delete this occurrence.'
    )
    return
  }

  await loadEvents()
  clearEventForm()
}

async function deleteThisAndFutureEvents() {
  const activeEventId =
    editingEventId ?? viewingEventId

  const activeOccurrenceDate =
    editingOccurrenceDate ??
    viewingOccurrenceDate

  if (
    activeEventId === null ||
    activeOccurrenceDate === null
  ) {
    return
  }

  const calendarEvent = events.find(
    (event) =>
      event.id === activeEventId
  )

  if (!calendarEvent) {
    return
  }

  if (
    !calendarEvent.repeatUnit ||
    calendarEvent.repeatUnit === 'none' ||
    activeOccurrenceDate <= calendarEvent.date
  ) {
    await deleteEvent()
    return
  }

  const [year, month, day] =
    activeOccurrenceDate
      .split('-')
      .map(Number)

  const previousDate = new Date(
    Date.UTC(
      year,
      month - 1,
      day
    )
  )

  previousDate.setUTCDate(
    previousDate.getUTCDate() - 1
  )

  const newEndDate =
    previousDate
      .toISOString()
      .slice(0, 10)

  const eventData = {
    date: calendarEvent.date,
    endDate: calendarEvent.endDate,
    title: calendarEvent.title,
    time: calendarEvent.time,
    endTime: calendarEvent.endTime,
    notes: calendarEvent.notes,
    personIds:
      calendarEvent.people.map(
        (person) => person.id
      ),
    repeatUnit:
      calendarEvent.repeatUnit,
    repeatInterval:
      calendarEvent.repeatInterval ?? 1,
    repeatEndType: 'date',
    repeatEndDate: newEndDate,
    repeatCount: null,
  }

  const response = await fetch(
    `/api/events/${activeEventId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(
        eventData
      ),
    }
  )

  if (!response.ok) {
    showAppNotification(
      'Could not delete this and future events.'
    )
    return
  }

  await loadEvents()
  clearEventForm()
}

async function saveThisEventOnly() {
  if (
    editingEventId === null ||
    editingOccurrenceDate === null
  ) {
    return
  }

  const calendarEvent = events.find(
    (event) => event.id === editingEventId
  )

  if (!calendarEvent?.repeatUnit) {
    return
  }

  if (eventTitle.trim() === '') {
    return
  }

  const parsedStartDate =
    parseDateTextToDateKey(
      eventStartDateText
    )

  if (!parsedStartDate) {
    setEventStartDateError(true)

    window.setTimeout(() => {
      setEventStartDateError(false)
    }, 1200)

    return
  }

  let parsedEndDate: string | null = null

  if (eventEndDateText.trim() !== '') {
    parsedEndDate =
      parseDateTextToDateKey(
        eventEndDateText
      )

    if (!parsedEndDate) {
      setEventEndDateError(true)

      window.setTimeout(() => {
        setEventEndDateError(false)
      }, 1200)

      return
    }

    if (parsedEndDate < parsedStartDate) {
      setEventEndDateError(true)

      window.setTimeout(() => {
        setEventEndDateError(false)
      }, 1200)

      return
    }
  }

  if (
    !isValidEventTimeRange(
      parsedStartDate,
      parsedEndDate,
      eventTime,
      eventEndTime,
      eventAllDay
    )
  ) {
    setEventTimeError(true)

    window.setTimeout(() => {
      setEventTimeError(false)
    }, 1200)

    return
  }

  const originalStartDate =
    calendarEvent.date

  const startShiftDays =
    getDateDifferenceInDays(
      originalStartDate,
      parsedStartDate
    )

  const replacementStartDate =
    addDaysToDateKey(
      editingOccurrenceDate,
      startShiftDays
    )

  let replacementEndDate: string | null =
    null

  if (parsedEndDate) {
    const editedDurationDays =
      getDateDifferenceInDays(
        parsedStartDate,
        parsedEndDate
      )

    replacementEndDate =
      addDaysToDateKey(
        replacementStartDate,
        editedDurationDays
      )
  }

  const exceptionResponse = await fetch(
    `/api/events/${editingEventId}/exceptions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        occurrenceDate:
          editingOccurrenceDate,
      }),
    }
  )

  if (!exceptionResponse.ok) {
    showAppNotification(
  'Could not update this occurrence.'
)
    return
  }

  const replacementData = {
    date: replacementStartDate,
    endDate: replacementEndDate,
    title: eventTitle.trim(),
    time:
      eventAllDay ? '' : eventTime,
    endTime:
      eventAllDay ? '' : eventEndTime,
    notes: eventNotes,
    location: eventLocation,
    personIds: selectedPersonIds,
    repeatUnit: 'none',
    repeatInterval: 1,
    repeatEndType: 'never',
    repeatEndDate: null,
    repeatCount: null,
  }

  const replacementResponse = await fetch(
    '/api/events',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        replacementData
      ),
    }
  )

  if (!replacementResponse.ok) {
    const restoreResponse = await fetch(
      `/api/events/${editingEventId}/exceptions/${editingOccurrenceDate}`,
      {
        method: 'DELETE',
      }
    )

    await loadEvents()

    if (!restoreResponse.ok) {
      showAppNotification(
  'The edited occurrence could not be created, and the original occurrence could not be restored automatically.',
  7000
)
      return
    }

   showAppNotification(
  'The edited occurrence could not be created. The original occurrence was restored.',
  6000
)
    return
  }

  await loadEvents()
  clearEventForm()
}
async function saveThisAndFutureEvents() {
  if (
    editingEventId === null ||
    editingOccurrenceDate === null
  ) {
    return
  }

  const calendarEvent = events.find(
    (event) => event.id === editingEventId
  )

  if (!calendarEvent?.repeatUnit) {
    return
  }

  if (
  editingOccurrenceDate === calendarEvent.date
) {
  await saveEntireSeriesChanges()
  return
}

  if (eventTitle.trim() === '') {
    return
  }

  

const parsedStartDate =
  parseDateTextToDateKey(
    eventStartDateText
  )

if (!parsedStartDate) {
  setEventStartDateError(true)

  window.setTimeout(() => {
    setEventStartDateError(false)
  }, 1200)

  return
}

let parsedEndDate: string | null = null

if (eventEndDateText.trim() !== '') {
  parsedEndDate =
    parseDateTextToDateKey(
      eventEndDateText
    )

  if (!parsedEndDate) {
    setEventEndDateError(true)

    window.setTimeout(() => {
      setEventEndDateError(false)
    }, 1200)

    return
  }

  if (parsedEndDate < parsedStartDate) {
    setEventEndDateError(true)

    window.setTimeout(() => {
      setEventEndDateError(false)
    }, 1200)

    return
  }
}

if (
  !isValidEventTimeRange(
    parsedStartDate,
    parsedEndDate,
    eventTime,
    eventEndTime,
    eventAllDay
  )
) {
  setEventTimeError(true)

  window.setTimeout(() => {
    setEventTimeError(false)
  }, 1200)

  return
}

const originalStartDate =
  calendarEvent.date

const startShiftDays =
  getDateDifferenceInDays(
    originalStartDate,
    parsedStartDate
  )

const futureStartDate =
  addDaysToDateKey(
    editingOccurrenceDate,
    startShiftDays
  )

let futureEndDate: string | null = null

if (parsedEndDate) {
  const editedDurationDays =
    getDateDifferenceInDays(
      parsedStartDate,
      parsedEndDate
    )

  futureEndDate =
    addDaysToDateKey(
      futureStartDate,
      editedDurationDays
    )
}

 let futureRepeatEndDate: string | null = null

if (
  repeatUnit !== 'none' &&
  repeatEndType === 'date'
) {
  futureRepeatEndDate =
    parseDateTextToDateKey(
      repeatEndDateText
    )

  if (
    !futureRepeatEndDate ||
    futureRepeatEndDate < futureStartDate
  ) {
    setRepeatEndDateError(true)

    window.setTimeout(() => {
      setRepeatEndDateError(false)
    }, 1200)

    return
  }
}

  const previousDate =
    addDaysToDateKey(
      editingOccurrenceDate,
      -1
    )

  let occurrenceNumber = 1

  const originalInterval =
    calendarEvent.repeatInterval ?? 1

  if (calendarEvent.repeatUnit === 'day') {
    occurrenceNumber =
      getDateDifferenceInDays(
        calendarEvent.date,
        editingOccurrenceDate
      ) /
        originalInterval +
      1
  }

  if (calendarEvent.repeatUnit === 'week') {
    occurrenceNumber =
      getDateDifferenceInDays(
        calendarEvent.date,
        editingOccurrenceDate
      ) /
        (originalInterval * 7) +
      1
  }

  if (calendarEvent.repeatUnit === 'month') {
    const [
      startYear,
      startMonth,
    ] = calendarEvent.date
      .split('-')
      .map(Number)

    const [
      occurrenceYear,
      occurrenceMonth,
    ] = editingOccurrenceDate
      .split('-')
      .map(Number)

    const differenceInMonths =
      (occurrenceYear - startYear) * 12 +
      (occurrenceMonth - startMonth)

    occurrenceNumber =
      differenceInMonths /
        originalInterval +
      1
  }

  if (calendarEvent.repeatUnit === 'year') {
    const startYear =
      Number(
        calendarEvent.date.split('-')[0]
      )

    const occurrenceYear =
      Number(
        editingOccurrenceDate.split('-')[0]
      )

    occurrenceNumber =
      (occurrenceYear - startYear) /
        originalInterval +
      1
  }

  let futureRepeatCount: number | null =
    repeatEndType === 'count'
      ? repeatCount
      : null

  if (
    repeatEndType === 'count' &&
    calendarEvent.repeatEndType === 'count' &&
    calendarEvent.repeatCount !== null &&
    repeatCount === calendarEvent.repeatCount
  ) {
    futureRepeatCount = Math.max(
      1,
      calendarEvent.repeatCount -
        occurrenceNumber +
        1
    )
  }

  const originalSeriesData = {
    date: calendarEvent.date,
    endDate: calendarEvent.endDate,
    title: calendarEvent.title,
    time: calendarEvent.time,
endTime: calendarEvent.endTime,
notes: calendarEvent.notes,
    personIds: calendarEvent.people.map(
      (person) => person.id
    ),
    repeatUnit: calendarEvent.repeatUnit,
    repeatInterval:
      calendarEvent.repeatInterval ?? 1,
    repeatEndType:
      calendarEvent.repeatEndType ?? 'never',
    repeatEndDate:
      calendarEvent.repeatEndType === 'date'
        ? calendarEvent.repeatEndDate
        : null,
    repeatCount:
      calendarEvent.repeatEndType === 'count'
        ? calendarEvent.repeatCount
        : null,
  }

  const trimmedSeriesData = {
    ...originalSeriesData,
    repeatEndType: 'date',
    repeatEndDate: previousDate,
    repeatCount: null,
  }

  const futureSeriesData = {
    date: futureStartDate,
    endDate: futureEndDate,
    title: eventTitle.trim(),
    time: eventAllDay ? '' : eventTime,
endTime: eventAllDay ? '' : eventEndTime,
notes: eventNotes,
location: eventLocation,
    personIds: selectedPersonIds,
    repeatUnit,
    repeatInterval,
    repeatEndType,
   repeatEndDate:
  repeatEndType === 'date'
    ? futureRepeatEndDate
    : null,
    repeatCount: futureRepeatCount,
  }

  const trimResponse = await fetch(
    `/api/events/${editingEventId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        trimmedSeriesData
      ),
    }
  )

  if (!trimResponse.ok) {
    showAppNotification(
  'Could not update the earlier part of the series.',
  5000
)
    return
  }

  const futureResponse = await fetch(
    '/api/events',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        futureSeriesData
      ),
    }
  )

  if (!futureResponse.ok) {
    const restoreResponse = await fetch(
      `/api/events/${editingEventId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type':
            'application/json',
        },
        body: JSON.stringify(
          originalSeriesData
        ),
      }
    )

    await loadEvents()

    if (!restoreResponse.ok) {
     showAppNotification(
  'The future series could not be created, and the original series could not be restored automatically.',
  7000
)
      return
    }

    showAppNotification(
  'The future series could not be created. The original series was restored.',
  6000
)
    return
  }

  await loadEvents()
  clearEventForm()
}
function closeEventModal() {
  if (eventModalClosing) {
    return
  }

  setEventModalClosing(true)

  setTimeout(() => {
    clearEventForm()
    setSelectedDay(null)
    setEventModalClosing(false)
  }, 220)
}
 function clearEventForm() {
setEditingEventId(null)
setDuplicateSourceEventId(null)
setViewingEventId(null)
setViewingOccurrenceDate(null)
setDetailsDeleteConfirmOpen(false)
setIsAddingEvent(false)
  setEditingOccurrenceDate(null)
  setRecurringAction(null)
  setEventTimeError(false)
setEventStartDateError(false)
setEventEndDateError(false)
setEventTitleError(false)
  setEventTitle('')
 setEventTime('')
setEventEndTime('')
setEventAllDay(true)
 setEventStartDate('')
setEventStartDateText('')
setEventEndDate('')
setEventEndDateText('')
setEventDateMode('single')
setEventMultipleDates([])
setEventNotes('')
setEventLocation('')
  setRepeatUnit('none')
  setRepeatInterval(1)
  setRepeatEndType('never')
  setRepeatEndDate('')
  setRepeatEndDateText('')
setRepeatEndDateError(false)
  setRepeatCount(10)
  setSelectedPersonIds([])
}

  function handlePersonImageChange(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0] ?? null

    setPersonImageFile(file)

    if (file) {
      setPersonImagePreview(URL.createObjectURL(file))
      return
    }

    if (editingPersonId !== null) {
      const currentPerson = people.find(
        (person) => person.id === editingPersonId
      )

      if (currentPerson?.image) {
        setPersonImagePreview(
          getPersonImageUrl(currentPerson.image)
        )

        return
      }
    }

    setPersonImagePreview('')
  }

  async function savePerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (personName.trim() === '') return

    const formData = new FormData()
    formData.append('name', personName.trim())
    formData.append('color', personColor)

    if (personImageFile) {
      formData.append('image', personImageFile)
    }

    const url =
      editingPersonId === null
        ? '/api/people'
        : `/api/people/${editingPersonId}`

    const method =
      editingPersonId === null
        ? 'POST'
        : 'PUT'

    const response = await fetch(url, {
      method,
      body: formData,
    })

    if (!response.ok) {
      const errorData = await response.json()

     showAppNotification(
  errorData.error ?? 'Could not save person.'
)
      return
    }

    const updatedPeople =
  await loadPeople()

await loadEvents()

clearPersonForm(updatedPeople)
  }

  function startEditingPerson(person: Person) {
    setEditingPersonId(person.id)
    setPersonName(person.name)
    setPersonColor(person.color)
    setPersonImageFile(null)
    setPersonImagePreview(
      person.image ? getPersonImageUrl(person.image) : ''
    )
    setPersonFileInputKey((value) => value + 1)
  }

 function deletePerson(person: Person) {
  setPersonDeleteTarget(person)
}

async function confirmDeletePerson() {
  if (!personDeleteTarget) {
    return
  }

  const person = personDeleteTarget

  const response = await fetch(
    `/api/people/${person.id}`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
    showAppNotification(
      'Could not delete person.'
    )
    return
  }

  const updatedPeople =
    await loadPeople()

  await loadEvents()

  if (editingPersonId === person.id) {
    clearPersonForm(updatedPeople)
  }

  setPersonDeleteTarget(null)
}

  function clearPersonForm(
  peopleToCheck: Person[] = people
) {
  setEditingPersonId(null)
  setPersonKeyboardOpen(false)
setPersonShiftActive(false)
setPersonCapsLockActive(false)
  setPersonName('')

  personNameRef.current = ''
  personCursorPositionRef.current = 0
  setPersonCursorPosition(0)

  setPersonColor(
    getNextUnusedPersonColor(
      peopleToCheck
    )
  )

  setPersonImageFile(null)
  setPersonImagePreview('')
  setPersonFileInputKey(
    (value) => value + 1
  )
}
async function createList(event: FormEvent<HTMLFormElement>) {
  event.preventDefault()

  const cleanName = newListName.trim()

  if (cleanName === '') {
    return
  }

  const response = await fetch('/api/lists', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: cleanName,
      icon: newListIcon,
    }),
  })

  if (!response.ok) {
    showAppNotification('Could not create the list.')
    return
  }

  setNewListName('')
  setNewListIcon(null)
  setListIconPickerTarget(null)
  setListCreateOpen(false)
  await loadLists()
}

async function changeExistingListIcon(listId: number, icon: string | null) {
  const response = await fetch(`/api/lists/${listId}/icon`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ icon }),
  })
  if (!response.ok) {
    showAppNotification('Could not save the list icon.')
    return
  }
  await loadLists()
}

async function addListItem(event: FormEvent<HTMLFormElement>) {
  event.preventDefault()

  if (selectedListId === null) {
    return
  }

  const cleanText = newListItemText.trim()

  if (cleanText === '') {
    return
  }

  const response = await fetch(
    `/api/lists/${selectedListId}/items`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: cleanText,
        category: newListItemCategory.trim() || 'General',
      }),
    }
  )

  if (!response.ok) {
   showAppNotification('Could not add the item.')
    return
  }

  setNewListItemText('')
  setNewListItemCategory('General')
  setNewListCategoryManuallySet(false)
  setListItemAddOpen(false)
  await loadLists()
}

async function addQuickListItem() {
  if (quickListId === null) {
    return
  }

  const cleanText = quickListText.trim()

  if (cleanText === '') {
    return
  }

  const targetList = lists.find(
    (list) => list.id === quickListId
  )

  const response = await fetch(
    `/api/lists/${quickListId}/items`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: cleanText,
      }),
    }
  )

  if (!response.ok) {
    showAppNotification(
      'Could not add the item.'
    )
    return
  }

  setQuickListText('')
  setQuickListOpen(false)

  await loadLists()

  showAppNotification(
    targetList
      ? `Added to ${targetList.name}.`
      : 'Item added.'
  )
}
async function toggleListItem(item: ListItem) {
  if (listToggleInFlightRef.current.has(item.id)) return
  listToggleInFlightRef.current.add(item.id)
  const completed = !item.completed
  setLists((current) => current.map((list) => ({
    ...list,
    items: list.items.map((entry) => entry.id === item.id
      ? { ...entry, completed }
      : entry),
  })))
  try {
    const response = await fetch(`/api/list-items/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed }),
    })
    if (!response.ok) throw new Error('Update failed')
    await loadLists()
  } catch {
    showAppNotification('Could not update the item.')
    await loadLists()
  } finally {
    listToggleInFlightRef.current.delete(item.id)
  }
}
async function deleteListItem(itemId: number) {
  setOpenListSwipe(null)
  const response = await fetch(
    `/api/list-items/${itemId}`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
   showAppNotification('Could not delete the item.')
    return
  }

  await loadLists()
}
async function organizeExistingList(listId: number) {
  if (isOrganizingList) return
  setIsOrganizingList(true)
  try {
    const response = await fetch(`/api/lists/${listId}/organize`, {
      method: 'POST',
    })
    if (!response.ok) throw new Error('Organizer request failed')
    const result: { categorized: number; remainingGeneral: number } = await response.json()
    await loadLists()
    setListCategoryFilter('All')
    setListSortMode(lists.find(list => list.id === listId)?.store_enabled ? 'store' : 'category')
    setOpenListSwipe(null)
    showAppNotification(result.categorized > 0
      ? `Organized ${result.categorized} existing ${result.categorized === 1 ? 'item' : 'items'} by category.`
      : 'No recognizable General items to organize.')
  } catch {
    showAppNotification('Could not organize this list.')
  } finally {
    setIsOrganizingList(false)
  }
}

async function clearCompletedItems() {
  if (selectedListId === null) {
    return
  }

  const selectedList = lists.find(
    (list) => list.id === selectedListId
  )

  if (!selectedList) {
    return
  }

  const completedCount = selectedList.items.filter(
    (item) => item.completed
  ).length

  if (completedCount === 0) {
    return
  }

  const shouldClear = window.confirm(
    `Remove ${completedCount} completed ${
      completedCount === 1 ? 'item' : 'items'
    }?`
  )

  if (!shouldClear) {
    return
  }

  const response = await fetch(
    `/api/lists/${selectedListId}/completed`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
   showAppNotification(
  'Could not clear completed items.'
)
    return
  }

  await loadLists()
}
function startEditingListItem(item: ListItem) {
  setOpenListSwipe(null)
  setEditingListItemId(item.id)
  setEditingListItemText(item.text)
  setEditingListItemCategory(item.category || 'General')
  setEditingListItemStoreId(item.store_id ?? null)
  setEditingListItemStoreChanged(false)
}

function cancelEditingListItem() {
  setEditingListItemId(null)
  setEditingListItemText('')
  setEditingListItemCategory('General')
  setEditingListItemStoreId(null)
  setEditingListItemStoreChanged(false)
}

async function saveListItemEdit(itemId: number) {
  const cleanText = editingListItemText.trim()

  if (cleanText === '') {
    return
  }

  const response = await fetch(
    `/api/list-items/${itemId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: cleanText,
        category: editingListItemCategory.trim() || 'General',
        ...(editingListItemStoreChanged ? { store_id: editingListItemStoreId } : {}),
      }),
    }
  )

  if (!response.ok) {
    showAppNotification('Could not update the item.')
    return
  }

  cancelEditingListItem()
  await loadLists()
}
async function handleListDragEnd(event: DragEndEvent) {
  if (selectedListId === null || listCategoryFilter !== 'All' || listSortMode !== 'custom') {
    return
  }

  const { active, over } = event

  if (!over || active.id === over.id) {
    return
  }

  const selectedList = lists.find(
    (list) => list.id === selectedListId
  )

  if (!selectedList) {
    return
  }

  const oldIndex = selectedList.items.findIndex(
    (item) => item.id === active.id
  )

  const newIndex = selectedList.items.findIndex(
    (item) => item.id === over.id
  )

  if (oldIndex === -1 || newIndex === -1) {
    return
  }

  const reorderedItems = arrayMove(
    selectedList.items,
    oldIndex,
    newIndex
  )

  setLists((currentLists) =>
    currentLists.map((list) =>
      list.id === selectedListId
        ? {
            ...list,
            items: reorderedItems,
          }
        : list
    )
  )

  const response = await fetch(
    `/api/lists/${selectedListId}/reorder`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        itemIds: reorderedItems.map((item) => item.id),
      }),
    }
  )

  if (!response.ok) {
    showAppNotification(
  'Could not save the new item order.'
)
    await loadLists()
  }
}
async function deleteList(listId: number) {
  const shouldDelete = window.confirm(
    'Delete this entire list and all of its items?'
  )

  if (!shouldDelete) {
    return
  }

  const response = await fetch(
    `/api/lists/${listId}`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
    showAppNotification('Could not delete the list.')
    return
  }

  setSelectedListId(null)
  setNewListItemText('')
  setListCategoryFilter('All')
  await loadLists()
}
async function renameList(event: FormEvent<HTMLFormElement>) {
  event.preventDefault()

  if (selectedListId === null) {
    return
  }

  const cleanName = editingListName.trim()

  if (cleanName === '') {
    return
  }

  const response = await fetch(
    `/api/lists/${selectedListId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: cleanName,
      }),
    }
  )

  if (!response.ok) {
    showAppNotification('Could not rename the list.')
    return
  }

 await loadLists()
setListNameEditing(false)
}

function goToPreviousPeriod() {
  if (calendarView === 'day') {
    setWeekDate(
      new Date(
        weekDate.getFullYear(),
        weekDate.getMonth(),
        weekDate.getDate() - 1
      )
    )

    setSelectedDay(null)
    clearEventForm()
    return
  }

  if (
  calendarView === 'week' ||
  calendarView === 'schedule'
) {
    setWeekDate(
      new Date(
        weekDate.getFullYear(),
        weekDate.getMonth(),
        weekDate.getDate() - 7
      )
    )

    setSelectedDay(null)
    clearEventForm()
    return
  }

  setViewDate(new Date(year, month - 1, 1))
  setSelectedDay(null)
  clearEventForm()
}

 function goToNextPeriod() {
  if (calendarView === 'day') {
    setWeekDate(
      new Date(
        weekDate.getFullYear(),
        weekDate.getMonth(),
        weekDate.getDate() + 1
      )
    )

    setSelectedDay(null)
    clearEventForm()
    return
  }

  if (
  calendarView === 'week' ||
  calendarView === 'schedule'
) {
    setWeekDate(
      new Date(
        weekDate.getFullYear(),
        weekDate.getMonth(),
        weekDate.getDate() + 7
      )
    )

    setSelectedDay(null)
    clearEventForm()
    return
  }

  setViewDate(new Date(year, month + 1, 1))
  setSelectedDay(null)
  clearEventForm()
}

function goToToday() {
  const todayDate = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  )

  setViewDate(
    new Date(
      today.getFullYear(),
      today.getMonth(),
      1
    )
  )

  setWeekDate(todayDate)

  if (calendarView === 'month') {
    setSelectedDay(null)
  } else if (calendarView === 'day') {
    setSelectedDay(today.getDate())
  } else {
    setSelectedDay(null)
  }

  clearEventForm()
}

function changeCalendarView(
  nextView:
    | 'month'
    | 'week'
    | 'day'
    | 'schedule'
) {
  if (nextView === calendarView) {
    return
  }

  if (nextView === 'month') {
    setViewDate(
      new Date(
        weekDate.getFullYear(),
        weekDate.getMonth(),
        1
      )
    )

    setSelectedDay(null)
    setCalendarView('month')
    return
  }

if (nextView === 'week') {
  const targetDate =
    selectedDay !== null
      ? new Date(
          year,
          month,
          selectedDay
        )
      : new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate()
        )

  setWeekDate(targetDate)
  setCalendarView('week')
  return
}

 if (nextView === 'schedule') {
  const targetDate =
    calendarView === 'week' ||
    calendarView === 'day'
      ? weekDate
      : calendarView === 'month' &&
          selectedDay !== null
        ? new Date(
            year,
            month,
            selectedDay
          )
        : new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate()
          )

  setViewDate(
    new Date(
      targetDate.getFullYear(),
      targetDate.getMonth(),
      1
    )
  )

  setWeekDate(targetDate)
  setSelectedDay(null)
  setCalendarView('schedule')
  return
}

  const targetDate =
  new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  )

setWeekDate(targetDate)

setViewDate(
  new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    1
  )
)

setSelectedDay(
  targetDate.getDate()
)

setCalendarView('day')
}

function transitionCalendarView(action: () => void) {
  setCalendarViewChanging(true)

  setTimeout(() => {
    action()

    requestAnimationFrame(() => {
      setCalendarViewChanging(false)
    })
  }, 160)
}
function transitionMonthSidebar(action: () => void) {
  setSidebarContentChanging(true)

  setTimeout(() => {
    action()

    requestAnimationFrame(() => {
      setSidebarContentChanging(false)
    })
  }, 140)
}

const weekDates = getWeekDates(weekDate)

const previousWeekDate = new Date(weekDate)
previousWeekDate.setDate(
  previousWeekDate.getDate() - 7
)

const previousWeekDates =
  getWeekDates(previousWeekDate)

const nextWeekDate = new Date(weekDate)
nextWeekDate.setDate(
  nextWeekDate.getDate() + 7
)

const nextWeekDates =
  getWeekDates(nextWeekDate)


const scheduleVisibleDays = 5

const scheduleRangeStart =
  new Date(
    today.getFullYear(),
    today.getMonth() - 3,
    today.getDate()
  )

const scheduleRangeEnd =
  new Date(
    today.getFullYear(),
    today.getMonth() + 6,
    today.getDate() +
      scheduleVisibleDays -
      1
  )

const scheduleRangeDayCount =
  Math.round(
    (
      Date.UTC(
        scheduleRangeEnd.getFullYear(),
        scheduleRangeEnd.getMonth(),
        scheduleRangeEnd.getDate()
      ) -
      Date.UTC(
        scheduleRangeStart.getFullYear(),
        scheduleRangeStart.getMonth(),
        scheduleRangeStart.getDate()
      )
    ) /
      (24 * 60 * 60 * 1000)
  ) + 1

const scheduleDisplayDates =
  Array.from(
    {
      length:
        scheduleRangeDayCount,
    },
    (_, index) => {
      const scheduleDate =
        new Date(scheduleRangeStart)

      scheduleDate.setDate(
        scheduleDate.getDate() +
          index
      )

      return scheduleDate
    }
  )

const scheduleTargetDayOffset =
  Math.round(
    (
      Date.UTC(
        weekDate.getFullYear(),
        weekDate.getMonth(),
        weekDate.getDate()
      ) -
      Date.UTC(
        scheduleRangeStart.getFullYear(),
        scheduleRangeStart.getMonth(),
        scheduleRangeStart.getDate()
      )
    ) /
      (24 * 60 * 60 * 1000)
  )

const scheduleMaximumStartIndex =
  Math.max(
    0,
    scheduleDisplayDates.length -
      scheduleVisibleDays
  )

const scheduleInitialDayIndex =
  Math.max(
    0,
    Math.min(
      scheduleTargetDayOffset,
      scheduleMaximumStartIndex
    )
  )

const scheduleInitialScrollLeft =
  scheduleInitialDayIndex *
  scheduleDayWidth
  const scheduleCanvasWidth =
  76 +
  scheduleDisplayDates.length *
    scheduleDayWidth
    const scheduleMultiDaySegments =
  getWeekMultiDaySegments(
    scheduleDisplayDates
  ).filter(
    (segment) =>
      !segment.calendarEvent.time
  )

  const isMobileScheduleViewport =
  window.matchMedia(
    '(max-width: 760px)'
  ).matches

useLayoutEffect(() => {
  if (calendarView !== 'schedule') {
    return
  }

  const scheduleScroll =
    scheduleScrollRef.current

  if (!scheduleScroll) {
    return
  }

  const updateScheduleDayWidth = () => {
  if (scheduleScroll.clientWidth <= 76) {
    return
  }

  const availableDayWidth =
    scheduleScroll.clientWidth - 76

    const nextDayWidth =
      Math.max(
        1,
        availableDayWidth / 5
      )

    setScheduleDayWidth(
      (currentDayWidth) =>
        Math.abs(
          currentDayWidth -
            nextDayWidth
        ) < 0.5
          ? currentDayWidth
          : nextDayWidth
    )
  }

  updateScheduleDayWidth()

  const resizeObserver =
    new ResizeObserver(
      updateScheduleDayWidth
    )

  resizeObserver.observe(
    scheduleScroll
  )

  return () => {
    resizeObserver.disconnect()
  }
}, [calendarView])
useLayoutEffect(() => {
  if (calendarView !== 'schedule') {
    return
  }

  const scheduleScroll =
    scheduleScrollRef.current

  if (!scheduleScroll) {
    return
  }

  scheduleScroll.scrollLeft =
    scheduleInitialScrollLeft

  scheduleLastScrollLeftRef.current =
    scheduleInitialScrollLeft
}, [
  calendarView,
  weekDate,
  scheduleDayWidth,
])

  useEffect(() => {
  if (calendarView !== 'schedule') {
    return
  }

  

  const scheduleScroll =
    scheduleScrollRef.current

  if (!scheduleScroll) {
    return
  }

  const scheduleDates =
  Array.from(
    {
      length:
        scheduleVisibleDays,
    },
    (_, index) => {
      const scheduleDay =
        new Date(weekDate)

      scheduleDay.setDate(
        scheduleDay.getDate() +
          index
      )

      return scheduleDay
    }
  )

  let earliestMinutes:
    number | null = null

  for (
    const scheduleDay
    of scheduleDates
  ) {
    const dateKey =
      getDateKeyFromDate(
        scheduleDay
      )

    for (
      const calendarEvent
      of events
    ) {
      if (
        !calendarEvent.time ||
        !doesEventOccurOnDate(
          calendarEvent,
          dateKey
        )
      ) {
        continue
      }

      const [
        hour,
        minute,
      ] =
        calendarEvent.time
          .split(':')
          .map(Number)

      if (
        Number.isNaN(hour) ||
        Number.isNaN(minute)
      ) {
        continue
      }

      const eventMinutes =
        hour * 60 + minute

      if (
        earliestMinutes === null ||
        eventMinutes <
          earliestMinutes
      ) {
        earliestMinutes =
          eventMinutes
      }
    }
  }

  const targetMinutes =
  earliestMinutes ?? 8 * 60

  const targetTop =
    Math.max(
      0,
      (targetMinutes / 60) *
        56 -
        56
    )

  const frame =
    window.requestAnimationFrame(
      () => {
        scheduleScroll.scrollTo({
          top: targetTop,
          behavior: 'smooth',
        })
      }
    )

  return () => {
    window.cancelAnimationFrame(
      frame
    )
  }
}, [
  calendarView,
  weekDate,
  events,
  calendarPersonFilterId,
])

function softlySnapScheduleToDay(
  targetLeft: number
) {
  const scheduleScroll =
    scheduleScrollRef.current

  if (!scheduleScroll) {
    return
  }

  if (
    scheduleSnapAnimationRef.current !==
    null
  ) {
    window.cancelAnimationFrame(
      scheduleSnapAnimationRef.current
    )
  }

  const startLeft =
    scheduleScroll.scrollLeft

  const distance =
    targetLeft - startLeft

  if (Math.abs(distance) < 1) {
    scheduleScroll.scrollLeft =
      targetLeft

    scheduleLastScrollLeftRef.current =
      targetLeft

    return
  }

  const duration = 520
  const startTime = performance.now()

  scheduleSnapAnimatingRef.current =
    true

  const animate = (
    currentTime: number
  ) => {
    const elapsed =
      currentTime - startTime

    const progress =
      Math.min(
        1,
        elapsed / duration
      )

    const eased =
      1 -
      Math.pow(
        1 - progress,
        4
      )

    const nextLeft =
      startLeft +
      distance * eased

    scheduleScroll.scrollLeft =
      nextLeft

    scheduleLastScrollLeftRef.current =
      nextLeft

    if (progress < 1) {
      scheduleSnapAnimationRef.current =
        window.requestAnimationFrame(
          animate
        )

      return
    }

    scheduleScroll.scrollLeft =
      targetLeft

    scheduleLastScrollLeftRef.current =
      targetLeft

    scheduleSnapAnimatingRef.current =
      false

    scheduleSnapAnimationRef.current =
      null
  }

  scheduleSnapAnimationRef.current =
    window.requestAnimationFrame(
      animate
    )
}

function settleScheduleHorizontalScroll() {
  const scheduleScroll =
    scheduleScrollRef.current

  if (!scheduleScroll) {
    return
  }

  const dayWidth = scheduleDayWidth

  const currentLeft =
    scheduleScroll.scrollLeft

  const maxScrollLeft =
    scheduleScroll.scrollWidth -
    scheduleScroll.clientWidth

  const snappedLeft =
    Math.max(
      0,
      Math.min(
        maxScrollLeft,
        Math.round(
          currentLeft / dayWidth
        ) * dayWidth
      )
    )

  const dayIndex =
    Math.max(
      0,
      Math.min(
        scheduleDisplayDates.length - 1,
        Math.round(
          snappedLeft / dayWidth
        )
      )
    )

  const visibleDate =
    scheduleDisplayDates[dayIndex]

 if (visibleDate) {
  const nextVisibleDate =
    new Date(
      visibleDate.getFullYear(),
      visibleDate.getMonth(),
      visibleDate.getDate()
    )

  setWeekDate(nextVisibleDate)

  setViewDate(
    new Date(
      visibleDate.getFullYear(),
      visibleDate.getMonth(),
      1
    )
  )
}

  softlySnapScheduleToDay(
    snappedLeft
  )
}

function handleScheduleScroll() {
  if (calendarView !== 'schedule') {
    return
  }

  const scheduleScroll =
    scheduleScrollRef.current

  if (
    !scheduleScroll ||
    scheduleSnapAnimatingRef.current
  ) {
    return
  }

  const currentLeft =
    scheduleScroll.scrollLeft

  const horizontalDelta =
    Math.abs(
      currentLeft -
        scheduleLastScrollLeftRef.current
    )

  scheduleLastScrollLeftRef.current =
    currentLeft

  if (horizontalDelta < 0.75) {
    return
  }

  scheduleHorizontalMovedRef.current =
    true

  if (
    scheduleScrollSettleTimerRef.current !==
    null
  ) {
    window.clearTimeout(
      scheduleScrollSettleTimerRef.current
    )
  }

  scheduleScrollSettleTimerRef.current =
    window.setTimeout(() => {
      scheduleScrollSettleTimerRef.current =
        null

      if (
        !scheduleHorizontalMovedRef.current
      ) {
        return
      }

      scheduleHorizontalMovedRef.current =
        false

      settleScheduleHorizontalScroll()
    }, 140)
}

function getScheduleTimedEventLayouts(
  scheduleDay: Date
) {
  const dateKey =
    getDateKeyFromDate(scheduleDay)

  const scheduleEventUsableWidth =
    scheduleDayWidth - 10

  const timedEventLayouts: Array<{
    calendarEvent: (typeof events)[number]
    dateKey: string
    visibleStart: number
    visibleEnd: number
    durationMinutes: number
    leftPx: number
    widthPx: number
  }> = []

  for (const calendarEvent of events) {
    if (
      !calendarEvent.time ||
      !doesEventOccurOnDate(
        calendarEvent,
        dateKey
      )
    ) {
      continue
    }

    const [
      startHour,
      startMinute,
    ] = calendarEvent.time
      .split(':')
      .map(Number)

    if (
      Number.isNaN(startHour) ||
      Number.isNaN(startMinute)
    ) {
      continue
    }

    const startMinutes =
      startHour * 60 + startMinute

    let endMinutes =
      startMinutes + 60

    if (calendarEvent.endTime) {
      const [
        endHour,
        endMinute,
      ] = calendarEvent.endTime
        .split(':')
        .map(Number)

      if (
        !Number.isNaN(endHour) &&
        !Number.isNaN(endMinute)
      ) {
        endMinutes =
          endHour * 60 + endMinute

        if (
          endMinutes <=
          startMinutes
        ) {
          endMinutes += 1440
        }
      }
    }

    const visibleStart =
      Math.max(0, startMinutes)

    const visibleEnd =
      Math.min(24 * 60, endMinutes)

    if (visibleEnd <= visibleStart) {
      continue
    }

    timedEventLayouts.push({
      calendarEvent,
      dateKey,
      visibleStart,
      visibleEnd,
      durationMinutes:
        visibleEnd - visibleStart,
      leftPx: 5,
      widthPx:
        scheduleEventUsableWidth,
    })
  }

  timedEventLayouts.sort(
    (eventA, eventB) => {
      if (
        eventA.visibleStart !==
        eventB.visibleStart
      ) {
        return (
          eventA.visibleStart -
          eventB.visibleStart
        )
      }

      if (
        eventA.durationMinutes !==
        eventB.durationMinutes
      ) {
        return (
          eventB.durationMinutes -
          eventA.durationMinutes
        )
      }

      return eventA.calendarEvent.title.localeCompare(
        eventB.calendarEvent.title
      )
    }
  )

  const overlapGroups:
    Array<typeof timedEventLayouts> =
    []

  let currentGroup:
    typeof timedEventLayouts =
    []

  let currentGroupEnd = -1

  for (const timedEventLayout of timedEventLayouts) {
    if (currentGroup.length === 0) {
      currentGroup = [
        timedEventLayout,
      ]
      currentGroupEnd =
        timedEventLayout.visibleEnd
      continue
    }

    if (
      timedEventLayout.visibleStart <
      currentGroupEnd
    ) {
      currentGroup.push(
        timedEventLayout
      )
      currentGroupEnd =
        Math.max(
          currentGroupEnd,
          timedEventLayout.visibleEnd
        )
      continue
    }

    overlapGroups.push(currentGroup)

    currentGroup = [
      timedEventLayout,
    ]
    currentGroupEnd =
      timedEventLayout.visibleEnd
  }

  if (currentGroup.length > 0) {
    overlapGroups.push(currentGroup)
  }

 for (const overlapGroup of overlapGroups) {
  if (overlapGroup.length === 1) {
    continue
  }

  const durationOrderedGroup =
    [...overlapGroup].sort(
      (eventA, eventB) => {
        if (
          eventA.durationMinutes !==
          eventB.durationMinutes
        ) {
          return (
            eventB.durationMinutes -
            eventA.durationMinutes
          )
        }

        if (
          eventA.visibleStart !==
          eventB.visibleStart
        ) {
          return (
            eventA.visibleStart -
            eventB.visibleStart
          )
        }

        return eventA.calendarEvent.title.localeCompare(
          eventB.calendarEvent.title
        )
      }
    )

  durationOrderedGroup[0].leftPx = 5
  durationOrderedGroup[0].widthPx =
    scheduleEventUsableWidth

  if (overlapGroup.length === 2) {
    const shorterWidth =
      Math.max(
        72,
        Math.round(
          scheduleEventUsableWidth *
            0.86
        )
      )

    durationOrderedGroup[1].leftPx =
      5 +
      scheduleEventUsableWidth -
      shorterWidth

    durationOrderedGroup[1].widthPx =
      shorterWidth

    continue
  }

  const sameTimeGroups:
    Array<typeof durationOrderedGroup> =
    []

  for (
    const timedEventLayout of
    durationOrderedGroup
  ) {
    const matchingGroup =
      sameTimeGroups.find(
        (sameTimeGroup) =>
          sameTimeGroup[0]
            .visibleStart ===
            timedEventLayout.visibleStart &&
          sameTimeGroup[0]
            .visibleEnd ===
            timedEventLayout.visibleEnd
      )

    if (matchingGroup) {
      matchingGroup.push(
        timedEventLayout
      )
    } else {
      sameTimeGroups.push([
        timedEventLayout,
      ])
    }
  }

  const nestedWidthRatios = [
    1,
    0.86,
    0.74,
    0.62,
    0.52,
  ]

  sameTimeGroups.forEach(
    (
      sameTimeGroup,
      groupIndex
    ) => {
      const widthRatio =
        nestedWidthRatios[
          Math.min(
            groupIndex,
            nestedWidthRatios.length - 1
          )
        ]

      const tierWidth =
        Math.max(
          72,
          Math.round(
            scheduleEventUsableWidth *
              widthRatio
          )
        )

      const tierLeft =
        5 +
        Math.max(
          0,
          scheduleEventUsableWidth -
            tierWidth
        )

      if (sameTimeGroup.length === 1) {
        sameTimeGroup[0].leftPx =
          tierLeft

        sameTimeGroup[0].widthPx =
          tierWidth

        return
      }

      const sameStartOrderedGroup =
  [...sameTimeGroup].sort(
    (eventA, eventB) => {
      if (
        eventA.durationMinutes !==
        eventB.durationMinutes
      ) {
        return (
          eventB.durationMinutes -
          eventA.durationMinutes
        )
      }

      return eventA.calendarEvent.title.localeCompare(
        eventB.calendarEvent.title
      )
    }
  )

const sameStartWidthRatios = [
  1,
  0.86,
  0.74,
  0.62,
  0.52,
]

sameStartOrderedGroup.forEach(
  (
    timedEventLayout,
    eventIndex
  ) => {
    const widthRatio =
      sameStartWidthRatios[
        Math.min(
          eventIndex,
          sameStartWidthRatios.length - 1
        )
      ]

    const eventWidth =
      Math.max(
        72,
        Math.round(
          tierWidth *
            widthRatio
        )
      )

    timedEventLayout.leftPx =
      tierLeft +
      Math.max(
        0,
        tierWidth -
          eventWidth
      )

    timedEventLayout.widthPx =
      eventWidth
  }
)
    }
  )
}

  return timedEventLayouts
}



function renderMobileScheduleDay(
  targetDate: Date
) {
  const targetDateKey =
    getDateKeyFromDate(targetDate)

  const targetIsToday =
    targetDateKey ===
    getDateKeyFromDate(today)

  const allDayEvents =
    events.filter(
      (calendarEvent) =>
        !calendarEvent.time &&
        doesEventOccurOnDate(
          calendarEvent,
          targetDateKey
        )
    )
const isMobileAllDayExpanded =
  expandedScheduleAllDayDates.has(
    targetDateKey
  )

const mobileVisibleAllDayEvents =
  isMobileAllDayExpanded
    ? allDayEvents
    : allDayEvents.slice(
        0,
        allDayEvents.length > 3
          ? 2
          : 3
      )

const mobileHiddenAllDayEventCount =
  allDayEvents.length -
  mobileVisibleAllDayEvents.length
  const timedLayouts =
  getScheduleTimedEventLayouts(
    targetDate
  )

  return (
    <div className="mobile-schedule-day">
      <div className="mobile-schedule-date-heading">
      <button
    type="button"
    className="calendar-period-button mobile-schedule-date-arrow"
    disabled={
      targetDate <=
      mobileScheduleMinDate
    }
    aria-label="Previous day"
    onPointerDown={(event) => {
      event.stopPropagation()
    }}
    onPointerUp={(event) => {
      event.stopPropagation()
    }}
    onClick={() => {
      const previousDate =
        new Date(targetDate)

      previousDate.setDate(
        previousDate.getDate() - 1
      )

      if (
        previousDate <
        mobileScheduleMinDate
      ) {
        return
      }

      setWeekDate(previousDate)
    }}
  >
    &lsaquo;
  </button>

        <div>
          <span>
            {targetDate.toLocaleDateString(
              'en-US',
              {
                weekday: 'long',
              }
            )}
          </span>

          <strong>
            {targetDate.toLocaleDateString(
              'en-US',
              {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              }
            )}
          </strong>

          <button
  type="button"
  className={`mobile-schedule-today-button ${
    targetIsToday
      ? 'mobile-schedule-today-button-active'
      : ''
  }`}
  onPointerDown={(event) => {
    event.stopPropagation()
  }}
  onPointerUp={(event) => {
    event.stopPropagation()
  }}
  onClick={(event) => {
    event.stopPropagation()

    const todayDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    )
positionMobileScheduleTimeline(
  todayDate
)
    setWeekDate(todayDate)

    setViewDate(
      new Date(
        todayDate.getFullYear(),
        todayDate.getMonth(),
        1
      )
    )

    setSelectedDay(todayDate.getDate())
  }}
>
  Today
</button>
        </div>

        <button
  type="button"
  className="calendar-period-button mobile-schedule-date-arrow"
  disabled={
    targetDate >=
    mobileScheduleMaxDate
  }
  aria-label="Next day"
  onPointerDown={(event) => {
    event.stopPropagation()
  }}
  onPointerUp={(event) => {
    event.stopPropagation()
  }}
  onClick={() => {
    const nextDate =
      new Date(targetDate)

    nextDate.setDate(
      nextDate.getDate() + 1
    )

    if (
      nextDate >
      mobileScheduleMaxDate
    ) {
      return
    }

    setWeekDate(nextDate)
  }}
>
  &rsaquo;
</button>
      </div>

      {allDayEvents.length > 0 && (
        <div className="mobile-schedule-all-day">
          <span className="mobile-schedule-all-day-label">
            All Day
          </span>

          <div className="mobile-schedule-all-day-events">
            {mobileVisibleAllDayEvents.map(
              (calendarEvent) => (
                <button
                  type="button"
                  className="mobile-schedule-all-day-event"
                  key={`${targetDateKey}-${calendarEvent.id}`}
                  style={{
                    background:
                      getEventBackground(
                        calendarEvent.people
                      ),
                  }}
                  onClick={() =>
                    openEventDetails(
                      calendarEvent,
                      targetDateKey
                    )
                  }
                >
                  {calendarEvent.title}
                </button>
              )
            )}
            {allDayEvents.length > 3 && (
  <button
    type="button"
    className="schedule-more-events"
    onClick={(event) => {
      event.stopPropagation()

      setExpandedScheduleAllDayDates(
        (currentDates) => {
          const nextDates =
            new Set(currentDates)

          if (
            nextDates.has(
              targetDateKey
            )
          ) {
            nextDates.delete(
              targetDateKey
            )
          } else {
            nextDates.add(
              targetDateKey
            )
          }

          return nextDates
        }
      )
    }}
  >
    {isMobileAllDayExpanded
      ? 'Show less'
      : `+${mobileHiddenAllDayEventCount} more`}
  </button>
)}
          </div>
        </div>
      )}

      <div
  className="mobile-schedule-timeline-scroll"
 
>
        <div className="mobile-schedule-timeline">
          {Array.from(
            { length: 24 },
            (_, hour) => hour
          ).map((hour) => (
            <div
  className="mobile-schedule-hour"
  key={`${targetDateKey}-${hour}`}
  onClick={(event) => {
    if (
      performance.now() <
      mobileScheduleSuppressClickUntilRef.current
    ) {
      return
    }

    const now =
      performance.now()

    const previousTap =
      mobileScheduleEmptyTapRef.current

    const distanceX =
      event.clientX -
      previousTap.x

    const distanceY =
      event.clientY -
      previousTap.y

    const tapDistance =
      Math.hypot(
        distanceX,
        distanceY
      )

    const isDoubleTap =
      now - previousTap.time <= 325 &&
      previousTap.dateKey ===
        targetDateKey &&
      previousTap.hour === hour &&
      tapDistance <= 40

    mobileScheduleEmptyTapRef.current = {
      time: now,
      dateKey: targetDateKey,
      hour,
      x: event.clientX,
      y: event.clientY,
    }

    if (!isDoubleTap) {
      return
    }

    mobileScheduleEmptyTapRef.current = {
      time: 0,
      dateKey: '',
      hour: -1,
      x: 0,
      y: 0,
    }

    const eventTimeText =
      `${String(hour).padStart(
        2,
        '0'
      )}:00`

    clearEventForm()

    setViewDate(
      new Date(
        targetDate.getFullYear(),
        targetDate.getMonth(),
        1
      )
    )

    setWeekDate(
      new Date(targetDate)
    )

    setSelectedDay(
      targetDate.getDate()
    )

    setEventStartDate(
      targetDateKey
    )

    setEventStartDateText(
      formatDateKeyForText(
        targetDateKey
      )
    )

    setEventAllDay(false)

    setEventTime(
      eventTimeText
    )

    setIsAddingEvent(true)

    window.setTimeout(() => {
      const titleInput =
        document.querySelector<HTMLInputElement>(
          '.event-form .event-input[type="text"]'
        )

      titleInput?.focus()
    }, 0)
  }}
>
              <span>
                {new Date(
                  2026,
                  0,
                  1,
                  hour
                ).toLocaleTimeString(
                  'en-US',
                  {
                    hour: 'numeric',
                  }
                )}
              </span>
            </div>
          ))}

          {targetIsToday && (
            <div
              className="mobile-schedule-now"
              style={{
                top: `${
                  (dayTimelineNowMinutes /
                    60) *
                  56
                }px`,
              }}
            >
              <span>
                {dayTimelineNow.toLocaleTimeString(
                  'en-US',
                  {
                    hour: 'numeric',
                    minute: '2-digit',
                  }
                )}
              </span>

              <i />

              <b />
            </div>
          )}

          <div className="mobile-schedule-events-layer">
            {timedLayouts.map(
              (timedLayout) => {
                const calendarEvent =
                  timedLayout.calendarEvent

                const top =
                  (timedLayout.visibleStart /
                    60) *
                  56

                const height =
                  Math.max(
                    42,
                    ((timedLayout.visibleEnd -
                      timedLayout.visibleStart) /
                      60) *
                      56 -
                      5
                  )

                const layoutUsableWidth =
  scheduleDayWidth - 10

const leftPercent =
  layoutUsableWidth > 0
    ? ((timedLayout.leftPx - 5) /
        layoutUsableWidth) *
      100
    : 0

const widthPercent =
  layoutUsableWidth > 0
    ? (timedLayout.widthPx /
        layoutUsableWidth) *
      100
    : 100

                return (
                  <button
                    type="button"
                    className="mobile-schedule-event"
                    key={`${targetDateKey}-${calendarEvent.id}`}
                    style={{
                      top: `${top}px`,
                      height: `${height}px`,
                      left: `calc(${leftPercent}% + 3px)`,
width: `calc(${widthPercent}% - 6px)`,
                      background:
                        getEventBackground(
                          calendarEvent.people
                        ),
                    }}
                    onClick={() =>
                      openEventDetails(
                        calendarEvent,
                        targetDateKey
                      )
                    }
                  >
                    <strong>
                      {calendarEvent.title}
                    </strong>

                    <span>
                      {formatTime(
                        calendarEvent.time!
                      )}

                      {calendarEvent.endTime &&
                        ` – ${formatTime(
                          calendarEvent.endTime
                        )}`}
                    </span>

                    {calendarEvent.location && (
                      <small>
                        {
                          calendarEvent.location
                        }
                      </small>
                    )}
                  </button>
                )
              }
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function renderWeekBoard(
  boardDates: Date[]
) {
  const weekMultiDaySegments =
  getWeekMultiDaySegments(boardDates)
  const boardNextWeekStart =
    new Date(boardDates[0])

  boardNextWeekStart.setDate(
    boardNextWeekStart.getDate() + 7
  )

  const boardNextWeekEnd =
    new Date(boardDates[6])

  boardNextWeekEnd.setDate(
    boardNextWeekEnd.getDate() + 7
  )

  return (
    <div className="week-view-grid">
      {boardDates.map(
  (weekDay, columnIndex) => {
        const dateKey =
          getDateKeyFromDate(weekDay)

        const isToday =
          weekDay.getDate() === today.getDate() &&
          weekDay.getMonth() === today.getMonth() &&
          weekDay.getFullYear() === today.getFullYear()

        const dayEvents = events.filter(
  (calendarEvent) =>
    !isMultiDayEvent(calendarEvent) &&
    doesEventOccurOnDate(
              calendarEvent,
              dateKey
            )
        )

        const dayMultiDaySegments =
  weekMultiDaySegments.filter(
    (segment) =>
      columnIndex >=
        segment.startColumn &&
      columnIndex <=
        segment.endColumn
  )
const dayMultiDayLaneCount =
  dayMultiDaySegments.reduce(
    (highestLane, segment) =>
      Math.max(
        highestLane,
        segment.lane + 1
      ),
    0
  )
        return (
          <div
            className={`week-day ${
              isToday ? 'today' : ''
            }`}
            key={dateKey}
            data-multiday-count={
  dayMultiDaySegments.length
}
          >
            <div className="week-day-top">
              <button
                type="button"
                className="week-day-heading"
                onClick={() => {
                  if (
                    suppressWeekPagerClick()
                  ) {
                    return
                  }

                  setWeekDate(weekDay)

                  setViewDate(
                    new Date(
                      weekDay.getFullYear(),
                      weekDay.getMonth(),
                      1
                    )
                  )

                  setSelectedDay(
                    weekDay.getDate()
                  )

                  clearEventForm()
                  setCalendarView('day')
                }}
              >
                <div className="week-day-heading-date">
                  <span>
                    {weekDay.toLocaleDateString(
                      'en-US',
                      {
                        weekday: 'short',
                      }
                    )}
                  </span>

                  <strong>
                    {weekDay.getDate()}
                  </strong>
                </div>

                <small>
  {dayEvents.length +
    dayMultiDaySegments.length}{' '}
  {dayEvents.length +
    dayMultiDaySegments.length ===
  1
    ? 'event'
    : 'events'}
</small>
              </button>

              <button
                type="button"
                className="week-add-event-button"
                onClick={(event) => {
                  event.stopPropagation()

                  if (
                    suppressWeekPagerClick()
                  ) {
                    return
                  }

                  clearEventForm()

setEventStartDate(dateKey)

setEventStartDateText(
  formatDateKeyForText(dateKey)
)

setViewDate(
  new Date(
    weekDay.getFullYear(),
    weekDay.getMonth(),
    1
  )
)

setWeekDate(weekDay)

setSelectedDay(
  weekDay.getDate()
)

setIsAddingEvent(true)
                }}
              >
                + Add Event
              </button>
            </div>
<div
  className="week-day-events-scroll"
  onScroll={(event) => {
    const scrollElement =
      event.currentTarget

    const existingTimer =
      weekDayScrollResetTimersRef
        .current[dateKey]

    if (existingTimer !== undefined) {
      window.clearTimeout(
        existingTimer
      )

      delete weekDayScrollResetTimersRef
        .current[dateKey]
    }

    if (scrollElement.scrollTop <= 1) {
      return
    }

    weekDayScrollResetTimersRef
      .current[dateKey] =
      window.setTimeout(() => {
        delete weekDayScrollResetTimersRef
          .current[dateKey]

        scrollElement.scrollTo({
          top: 0,
          behavior: 'smooth',
        })
      }, 10000)
  }}
>
{dayMultiDayLaneCount > 0 && (
  <div
    className="week-multiday-stack"
    style={{
      height:
        `${dayMultiDayLaneCount * 59}px`,
    }}
  >
    {dayMultiDaySegments.map(
      (segment) => {
        const startsVisiblePiece =
          segment.startColumn ===
            columnIndex ||
          columnIndex === 0 ||
          columnIndex === 4

        const endsVisiblePiece =
          segment.endColumn ===
            columnIndex ||
          columnIndex === 3 ||
          columnIndex === 6

        const showTitle =
          startsVisiblePiece

        return (
          <button
            type="button"
            className={[
              'week-multiday-piece',
              startsVisiblePiece
                ? 'week-multiday-start'
                : '',
              endsVisiblePiece
                ? 'week-multiday-end'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            key={`${segment.calendarEvent.id}-${segment.occurrenceStartDate}-${columnIndex}`}
            aria-label={
              segment.calendarEvent.title
            }
            style={{
              top:
                `${segment.lane * 59}px`,
              background:
                getEventBackground(
                  segment.calendarEvent
                    .people
                ),
            }}
            onClick={(event) => {
              event.stopPropagation()

              if (
                suppressWeekPagerClick()
              ) {
                return
              }

              openEventDetails(
                segment.calendarEvent,
                segment.occurrenceStartDate
              )
            }}
          >
            {showTitle && (
  <span className="week-multiday-content">
    <span className="week-multiday-title">
      {
        segment.calendarEvent
          .title
      }
    </span>

    <span className="week-multiday-dates">
      {formatWeekMultiDayDateRange(
        segment.occurrenceStartDate,
        segment.occurrenceEndDate
      )}
    </span>
  </span>
)}
          </button>
        )
      }
    )}
  </div>
)}
            
              <div className="event-list">
                {dayEvents.map(
                  (calendarEvent) => {
                    const background =
                      getEventBackground(
                        calendarEvent.people
                      )

                    return (
                      <div
                        className="event"
                        key={`${calendarEvent.id}-${dateKey}`}
                        style={{
                          background,
                        }}
                        onClick={(event) => {
                          event.stopPropagation()

                          if (
                            suppressWeekPagerClick()
                          ) {
                            return
                          }

                          openEventDetails(
  calendarEvent,
  dateKey
)
                        }}
                      >
                        <div className="event-title">
                          {calendarEvent.title}
                        </div>
                        


                        <div className="event-bottom-row">
                          <div className="event-time">
                            {calendarEvent.time
                              ? (
                                  <>
                                    {formatTime(
                                      calendarEvent.time
                                    )}

                                    {calendarEvent.endTime &&
                                      ` – ${formatTime(
                                        calendarEvent.endTime
                                      )}`}
                                  </>
                                )
                              : 'All day'}
                          </div>
<CompactEventWeather
  location={calendarEvent.location}
  date={dateKey}
  time={calendarEvent.time}
/>
                          
                        </div>
                      </div>
                    )
                  }
                )}
              </div>

        
            </div>
          </div>
        )
            }
    )}

      <button
  type="button"
  className="week-next-tile"
  onClick={(event) => {
    event.stopPropagation()

    if (suppressWeekPagerClick()) {
      return
    }

    if (
      weekPagerTransitioningRef.current
    ) {
      return
    }

    const pager = weekPagerRef.current
    const track =
      weekPagerTrackRef.current

    if (!pager || !track) {
      return
    }

    const width = pager.clientWidth

    weekPagerPendingDirectionRef.current =
      1

    weekPagerTransitioningRef.current =
      true

    track.style.transition =
      'transform 440ms cubic-bezier(0.16, 1, 0.3, 1)'

    track.style.transform =
      `translate3d(${
        -width * 2
      }px, 0, 0)`
  }}
>
        <strong>Next Week</strong>

        <span>
          {boardNextWeekStart.toLocaleDateString(
            'en-US',
            {
              month: 'short',
              day: 'numeric',
            }
          )}
          {' – '}
          {boardNextWeekEnd.toLocaleDateString(
            'en-US',
            {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            }
          )}
        </span>
      </button>
    </div>
  )
}

const dayViewDate = weekDate
const previousDayViewDate = new Date(
  dayViewDate.getFullYear(),
  dayViewDate.getMonth(),
  dayViewDate.getDate() - 1
)

const nextDayViewDate = new Date(
  dayViewDate.getFullYear(),
  dayViewDate.getMonth(),
  dayViewDate.getDate() + 1
)
const dayViewDateKey = getDateKeyFromDate(dayViewDate)
const dayViewIsToday =
  dayViewDate.getFullYear() ===
    dayTimelineNow.getFullYear() &&
  dayViewDate.getMonth() ===
    dayTimelineNow.getMonth() &&
  dayViewDate.getDate() ===
    dayTimelineNow.getDate()

const dayTimelineNowMinutes =
  dayTimelineNow.getHours() * 60 +
  dayTimelineNow.getMinutes()
const dayMiniMonthWeeks =
  getMonthWeeksForDate(dayViewDate)
const dayViewEvents = events.filter(
  (calendarEvent) =>
    doesEventOccurOnDate(
      calendarEvent,
      dayViewDateKey
    )
)


function renderDaySwipePreview(
  targetDate: Date
) {
  const targetDateKey =
    getDateKeyFromDate(targetDate)

  const targetEvents = events.filter(
    (calendarEvent) =>
      doesEventOccurOnDate(
        calendarEvent,
        targetDateKey
      )
  )

  

  const targetMeal = mealPlans.find(
    (mealPlan) =>
      mealPlan.date === targetDateKey
  )

  const targetIsToday =
    targetDate.getFullYear() ===
      dayTimelineNow.getFullYear() &&
    targetDate.getMonth() ===
      dayTimelineNow.getMonth() &&
    targetDate.getDate() ===
      dayTimelineNow.getDate()
const targetMiniMonthFirstDay =
  new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    1
  ).getDay()

const targetMiniMonthDayCount =
  new Date(
    targetDate.getFullYear(),
    targetDate.getMonth() + 1,
    0
  ).getDate()

const targetMiniMonthCellCount =
  Math.ceil(
    (
      targetMiniMonthFirstDay +
      targetMiniMonthDayCount
    ) / 7
  ) * 7

const targetMiniMonthDays =
  Array.from(
    {
      length:
        targetMiniMonthCellCount,
    },
    (_, index) => {
      const day =
        index -
        targetMiniMonthFirstDay +
        1

      if (
        day < 1 ||
        day > targetMiniMonthDayCount
      ) {
        return null
      }

      return day
    }
  )
  return (
    <div className="day-view">
      

      <div className="day-dashboard">
        <aside className="day-left-panel">
          <section className="day-panel-card day-mini-calendar-card">
  <div className="day-mini-calendar-heading">
    <strong>
      {targetDate.toLocaleDateString(
        'en-US',
        {
          month: 'long',
        }
      )}
    </strong>

    <span>
      {targetDate.getFullYear()}
    </span>
  </div>

  <div className="day-mini-weekdays">
    {[
      'S',
      'M',
      'T',
      'W',
      'T',
      'F',
      'S',
    ].map((weekday, index) => (
      <span
        key={`preview-weekday-${index}`}
      >
        {weekday}
      </span>
    ))}
  </div>

  <div className="day-mini-calendar-grid">
    {targetMiniMonthDays.map(
      (day, index) => {
        if (day === null) {
          return (
            <span
              className="day-mini-date day-mini-date-empty"
              key={`preview-empty-${index}`}
            />
          )
        }

        const miniDate =
          new Date(
            targetDate.getFullYear(),
            targetDate.getMonth(),
            day
          )

        const isSelected =
          day === targetDate.getDate()

        const isToday =
          miniDate.getFullYear() ===
            today.getFullYear() &&
          miniDate.getMonth() ===
            today.getMonth() &&
          miniDate.getDate() ===
            today.getDate()

        return (
          <span
            className={[
              'day-mini-date',
              isSelected
                ? 'day-mini-date-selected'
                : '',
              isToday
                ? 'day-mini-date-today'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            key={`preview-mini-${targetDateKey}-${day}`}
          >
            {day}
          </span>
        )
      }
    )}
  </div>
</section>
          <section className="day-panel-card">
            <div className="day-panel-heading">
              <strong>Today's Events</strong>

              <span>
                {targetEvents.length}
              </span>
            </div>

            <div className="day-summary-events">
              {targetEvents.map(
                (calendarEvent) => {
                  const background =
                    getEventBackground(
                      calendarEvent.people
                    )

                  return (
                    <div
                      className="day-summary-event"
                      key={`preview-summary-${targetDateKey}-${calendarEvent.id}`}
                    >
                      <span
                        className="day-summary-event-color"
                        style={{
                          background,
                        }}
                      />

                      <span className="day-summary-event-text">
                        <strong>
                          {calendarEvent.title}
                        </strong>

                        <small>
                          {calendarEvent.time
                            ? calendarEvent.endTime
                              ? `${formatTime(
                                  calendarEvent.time
                                )} – ${formatTime(
                                  calendarEvent.endTime
                                )}`
                              : formatTime(
                                  calendarEvent.time
                                )
                            : 'All day'}
                        </small>
                      </span>
                    </div>
                  )
                }
              )}
            </div>
          </section>
        </aside>

        <main className="day-center-panel">
         

          <div className="day-timeline-scroll">
            <div className="day-timeline-grid">
              {Array.from(
                { length: 24 },
                (_, hour) => hour
              ).map((hour) => (
                <div
                  className="day-timeline-hour"
                  key={`preview-hour-${targetDateKey}-${hour}`}
                >
                  <span className="day-timeline-hour-label">
                    {new Date(
                      2026,
                      0,
                      1,
                      hour
                    ).toLocaleTimeString(
                      'en-US',
                      {
                        hour: 'numeric',
                      }
                    )}
                  </span>
                </div>
              ))}

              {targetIsToday && (
                <div
                  className="day-current-time"
                  style={{
                    top:
                      `${
                        (dayTimelineNowMinutes /
                          60) *
                        56
                      }px`,
                  }}
                >
                  <span className="day-current-time-label">
                    {dayTimelineNow.toLocaleTimeString(
                      'en-US',
                      {
                        hour: 'numeric',
                        minute: '2-digit',
                      }
                    )}
                  </span>

                  <span className="day-current-time-dot" />

                  <span className="day-current-time-line" />
                </div>
              )}

              <div className="day-timeline-events-layer">
                {getScheduleTimedEventLayouts(
  targetDate
)
  .filter(
    (timedEventLayout) =>
      !isMultiDayEvent(
        timedEventLayout.calendarEvent
      )
  )
  .map(
    (timedEventLayout) => {
      const calendarEvent =
        timedEventLayout.calendarEvent

      const eventTop =
        (timedEventLayout.visibleStart /
          60) *
        56

      const eventHeight =
        Math.max(
          42,
          ((timedEventLayout.visibleEnd -
            timedEventLayout.visibleStart) /
            60) *
            56 -
            6
        )

      const layoutUsableWidth =
        scheduleDayWidth - 10

      const leftPercent =
        layoutUsableWidth > 0
          ? ((timedEventLayout.leftPx -
              5) /
              layoutUsableWidth) *
            100
          : 0

      const widthPercent =
        layoutUsableWidth > 0
          ? (timedEventLayout.widthPx /
              layoutUsableWidth) *
            100
          : 100

      const background =
        getEventBackground(
          calendarEvent.people
        )

      return (
        <div
          className="day-timeline-event"
          key={`preview-timeline-${targetDateKey}-${calendarEvent.id}`}
          style={{
            top: `${eventTop}px`,
            height: `${eventHeight}px`,
            left: `${leftPercent}%`,
            width: `${widthPercent}%`,
            right: 'auto',
            background,
          }}
        >
          <div className="day-timeline-event-top">
            <strong>
              {calendarEvent.title}
            </strong>

            {calendarEvent.location && (
              <span>
                {calendarEvent.location}
              </span>
            )}
          </div>

          <div className="day-timeline-event-bottom">
            <span>
              {formatTime(
                calendarEvent.time!
              )}

              {calendarEvent.endTime &&
                ` – ${formatTime(
                  calendarEvent.endTime
                )}`}
            </span>

            <CompactEventWeather
              location={
                calendarEvent.location
              }
              date={targetDateKey}
              time={
                calendarEvent.time
              }
            />
          </div>
        </div>
      )
    }
  )}
              </div>
            </div>
          </div>

          {targetMeal && (
            <div className="day-timeline-dinner">
              <span className="calendar-dinner-icon">
                🍽️
              </span>

              <span className="calendar-dinner-text">
                {targetMeal.dinner}
              </span>
            </div>
          )}
        </main>

        <aside className="day-right-panel">
          <DayWeather
            date={targetDateKey}
          />
<button
  type="button"
  className="day-add-event-button"
  tabIndex={-1}
  style={{
    pointerEvents: 'none',
  }}
>
  + Add Event
</button>
          <section className="day-notes-card">
            <div className="day-notes-heading">
              <strong>
                {targetDateKey ===
                getDateKeyFromDate(today)
                  ? 'Notes for Today'
                  : 'Notes for This Day'}
              </strong>

              <span>
                {targetDate.toLocaleDateString(
                  'en-US',
                  {
                    month: 'short',
                    day: 'numeric',
                  }
                )}
              </span>
            </div>

            <div className="day-notes-status">
              Swipe to view this day
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

  useEffect(() => {
  if (calendarView !== 'day') {
    return
  }

  let active = true

  setDayNote('')
  setDayNoteError('')
  setDayNoteLoading(true)

  const loadDayNote = async () => {
    try {
      const response = await fetch(
        `/api/daily-notes/${dayViewDateKey}`
      )

      if (!response.ok) {
        throw new Error(
          'Could not load day note.'
        )
      }

      const data =
        await response.json()

      if (!active) {
        return
      }

      setDayNote(
        typeof data.note === 'string'
          ? data.note
          : ''
      )
    } catch {
      if (active) {
        setDayNoteError(
          'Could not load this note.'
        )
      }
    } finally {
      if (active) {
        setDayNoteLoading(false)
      }
    }
  }

  void loadDayNote()

  return () => {
    active = false
  }
}, [
  calendarView,
  dayViewDateKey,
])

async function saveDayNote() {
  if (dayNoteSaving) {
    return
  }

  setDayNoteSaving(true)
  setDayNoteError('')

  try {
    const response = await fetch(
      `/api/daily-notes/${dayViewDateKey}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type':
            'application/json',
        },
        body: JSON.stringify({
          note: dayNote,
        }),
      }
    )

    if (!response.ok) {
      throw new Error(
        'Could not save day note.'
      )
    }

    const savedNote =
      await response.json()

    setDayNote(
      typeof savedNote.note ===
        'string'
        ? savedNote.note
        : ''
    )

    showAppNotification(
      dayNote.trim() === ''
        ? 'Day note cleared.'
        : 'Day note saved.'
    )
  } catch {
    setDayNoteError(
      'Could not save this note.'
    )
  } finally {
    setDayNoteSaving(false)
  }
}
useLayoutEffect(() => {
  if (calendarView !== 'day') {
    return
  }

  const timelineScroll =
    dayTimelineScrollRef.current

  if (!timelineScroll) {
    return
  }

  const timedEvents =
    dayViewEvents
      .filter(
        (calendarEvent) =>
          Boolean(calendarEvent.time) &&
          !isMultiDayEvent(calendarEvent)
      )
      .map((calendarEvent) => {
        const [hour, minute] =
          calendarEvent.time!
            .split(':')
            .map(Number)

        return {
          calendarEvent,
          minutes:
            hour * 60 + minute,
        }
      })
      .filter(
        (entry) =>
          !Number.isNaN(
            entry.minutes
          )
      )
      .sort(
        (eventA, eventB) =>
          eventA.minutes -
          eventB.minutes
      )

  const now = new Date()

  const isViewingToday =
    dayViewDate.getFullYear() ===
      now.getFullYear() &&
    dayViewDate.getMonth() ===
      now.getMonth() &&
    dayViewDate.getDate() ===
      now.getDate()

  let targetMinutes = 8 * 60

  if (
    isViewingToday &&
    timedEvents.length > 0
  ) {
    const currentMinutes =
      now.getHours() * 60 +
      now.getMinutes()

    const closestEvent =
      timedEvents.reduce(
        (closest, candidate) => {
          const closestDistance =
            Math.abs(
              closest.minutes -
                currentMinutes
            )

          const candidateDistance =
            Math.abs(
              candidate.minutes -
                currentMinutes
            )

          return candidateDistance <
            closestDistance
            ? candidate
            : closest
        }
      )

    targetMinutes =
      closestEvent.minutes
  } else if (
    timedEvents.length > 0
  ) {
    targetMinutes =
      timedEvents[0].minutes
  } else if (isViewingToday) {
    targetMinutes =
      now.getHours() * 60 +
      now.getMinutes()
  }

  const targetTop =
    Math.max(
      0,
      (targetMinutes / 60) * 56 -
        112
    )

  const frame =
    window.requestAnimationFrame(
      () => {
        timelineScroll.scrollTo({
          top: targetTop,
          behavior: 'auto',
        })
      }
    )

  return () => {
    window.cancelAnimationFrame(
      frame
    )
  }
}, [
  calendarView,
  dayViewDateKey,
  events,
])
const dayViewMeal = mealPlans.find(
  (mealPlan) =>
    mealPlan.date === dayViewDateKey
)
const monthSelectedEvents =
  selectedDay === null
    ? []
    : events
        .filter(
          (calendarEvent) =>
            doesEventOccurOnDate(
              calendarEvent,
              getDateKey(selectedDay)
            )
        )
        .sort((eventA, eventB) => {
          if (!eventA.time && !eventB.time) {
            return eventA.title.localeCompare(eventB.title)
          }

          if (!eventA.time) return 1
          if (!eventB.time) return -1

          const timeCompare =
            eventA.time.localeCompare(eventB.time)

          if (timeCompare !== 0) {
            return timeCompare
          }

          return eventA.title.localeCompare(eventB.title)
        })

const showCalendarSidebar =
  calendarView !== 'month' &&
  calendarView !== 'week' ||
  editingEventId !== null ||
  isAddingEvent ||
  monthSelectedEvents.length > 0 ||
  (
    calendarView === 'month' &&
    monthEventsOpen
  )
 const showEventModal =
  viewingEventId !== null ||
  isAddingEvent ||
  (
    selectedDay !== null &&
    (
      editingEventId !== null ||
      (
        calendarView === 'month' &&
        monthSelectedEvents.length > 0
      )
    )
  )
  
  
          const viewingCalendarEvent =
  viewingEventId === null
    ? null
    : events.find(
        (calendarEvent) =>
          calendarEvent.id === viewingEventId
      ) ?? null

const viewingDateKey =
  viewingCalendarEvent === null
    ? null
    : viewingOccurrenceDate ??
      viewingCalendarEvent.date

const viewingStartDate =
  viewingCalendarEvent !== null &&
  viewingDateKey !== null
    ? getOccurrenceStartForDate(
        viewingCalendarEvent,
        viewingDateKey
      ) ?? viewingDateKey
    : null

const viewingEndDate =
  viewingCalendarEvent !== null &&
  viewingStartDate !== null
    ? addDaysToDateKey(
        viewingStartDate,
        getEventDurationDays(
          viewingCalendarEvent
        )
      )
    : null
    const homeTodayDateKey =
  getDateKeyFromDate(today)

const homeTodayEvents = events
  .flatMap((calendarEvent) => {
    const occurrenceStartDate =
      getOccurrenceStartForDate(
        calendarEvent,
        homeTodayDateKey
      )

    if (occurrenceStartDate === null) {
      return []
    }

    return [
      {
        calendarEvent,
        occurrenceStartDate,
      },
    ]
  })
  .sort((a, b) => {
    const firstTime =
      a.calendarEvent.time ?? '99:99'
    const secondTime =
      b.calendarEvent.time ?? '99:99'

    return firstTime.localeCompare(
      secondTime
    )
  })

const homeUpcomingEvents = Array.from(
  {
    length: 14,
  },
  (_, dayIndex) => {
    const day = new Date(today)

    day.setHours(12, 0, 0, 0)

    day.setDate(
      day.getDate() +
        dayIndex +
        1
    )

    return day
  }
)
  .flatMap((day) => {
    const dateKey =
      getDateKeyFromDate(day)

    return events.flatMap(
      (calendarEvent) => {
        const occurrenceStartDate =
          getOccurrenceStartForDate(
            calendarEvent,
            dateKey
          )

        if (
          occurrenceStartDate !==
          dateKey
        ) {
          return []
        }

        return [
          {
            calendarEvent,
            dateKey,
          },
        ]
      }
    )
  })
  .sort((a, b) => {
    const dateComparison =
      a.dateKey.localeCompare(
        b.dateKey
      )

    if (dateComparison !== 0) {
      return dateComparison
    }

    const firstTime =
      a.calendarEvent.time ?? '99:99'
    const secondTime =
      b.calendarEvent.time ?? '99:99'

    return firstTime.localeCompare(
      secondTime
    )
  })
  .slice(0, 5)

const homeTodayMeals =
  mealPlanItems
    .filter(
      (meal) =>
        meal.date ===
        homeTodayDateKey
    )
    .sort((a, b) => {
      const mealOrder = [
        'breakfast',
        'lunch',
        'dinner',
        'snack',
      ]

      return (
        mealOrder.indexOf(
          a.mealType
        ) -
        mealOrder.indexOf(
          b.mealType
        )
      )
    })

const homeListPreview =
  lists.slice(0, 4)
return (
    <main className="calendar-app">
      <header
  className={`top-bar ${
    page === 'meals'
      ? 'top-bar-meals'
      : page === 'home'
        ? 'top-bar-home'
        : page === 'lists'
          ? 'top-bar-lists'
          : ''
  }`}
>
     {page !== 'meals' &&
  page !== 'home' &&
  page !== 'calendar' &&
  page !== 'lists' && (
  <div>
    <h1>Family Calendar</h1>
    <p>{fullDate}</p>
  </div>
)}

         

        <nav
  className="app-sidebar"
  aria-label="Main navigation"
>
  <button
  type="button"
  className={`sidebar-nav-button ${
    page === 'home'
      ? 'active-sidebar-nav'
      : ''
  }`}
  onClick={() => setPage('home')}
>
  <span className="sidebar-nav-icon">⌂</span>
  <span>Home</span>
</button>
  <button
    type="button"
    className={`sidebar-nav-button ${
      page === 'calendar'
        ? 'active-sidebar-nav'
        : ''
    }`}
    onClick={() => setPage('calendar')}
  >
    <span className="sidebar-nav-icon">▣</span>
    <span>Calendar</span>
  </button>

  <button
  type="button"
  className={`sidebar-nav-button ${
    page === 'meals'
      ? 'active-sidebar-nav'
      : ''
  }`}
  onClick={() => setPage('meals')}
>
  <span className="sidebar-nav-icon">🍽</span>
  <span>Meals</span>
</button>

  <button
    type="button"
    className={`sidebar-nav-button ${
      page === 'lists'
        ? 'active-sidebar-nav'
        : ''
    }`}
    onClick={() => setPage('lists')}
  >
    <span className="sidebar-nav-icon">✓</span>
    <span>Lists</span>
  </button>

  <button
    type="button"
    className="sidebar-nav-button"
    disabled
  >
    <span className="sidebar-nav-icon">☑</span>
    <span>Chores</span>
  </button>

  <button
    type="button"
    className="sidebar-nav-button"
    disabled
  >
    <span className="sidebar-nav-icon">🍽</span>
    <span>Recipes</span>
  </button>

  <button
    type="button"
    className="sidebar-nav-button"
    disabled
  >
    <span className="sidebar-nav-icon">✦</span>
    <span>AI</span>
  </button>

  <div className="sidebar-nav-spacer" />

  <button
    type="button"
    className={`sidebar-nav-button ${
      page === 'people'
        ? 'active-sidebar-nav'
        : ''
    }`}
    onClick={() => setPage('people')}
  >
    <span className="sidebar-nav-icon">👥</span>
    <span>People</span>
  </button>

  <button
    type="button"
    className="sidebar-nav-button"
    onClick={() => setMobileSettingsOpen(true)}
  >
    <span className="sidebar-nav-icon">⚙</span>
    <span>Settings</span>
  </button>
</nav>
      </header>
      <div className="mobile-bottom-controls">
  <div
    className={`mobile-page-slider ${
      mobileNavSettling
        ? 'mobile-page-slider-settling'
        : ''
    }`}
    role="navigation"
    aria-label="Mobile page navigation"
    onPointerDown={
      handleMobileNavPointerDown
    }
    onPointerMove={
      handleMobileNavPointerMove
    }
    onPointerUp={
      finishMobileNavGesture
    }
    onPointerCancel={
      cancelMobileNavGesture
    }
  >
    <span
      className="mobile-page-slider-label mobile-page-slider-previous"
      style={{
        transform: `translateX(calc(-100% + ${mobileNavDragX}px))`,
      }}
    >
      {mobileNavPreviousItem.label}
    </span>

    <span
      className="mobile-page-slider-label mobile-page-slider-current"
      style={{
        transform: `translateX(${mobileNavDragX}px)`,
      }}
    >
      {mobileNavActiveItem.label}
    </span>

    <span
      className="mobile-page-slider-label mobile-page-slider-next"
      style={{
        transform: `translateX(calc(100% + ${mobileNavDragX}px))`,
      }}
    >
      {mobileNavNextItem.label}
    </span>

    <span className="mobile-page-slider-cue mobile-page-slider-cue-left">
      ‹
    </span>

    <span className="mobile-page-slider-cue mobile-page-slider-cue-right">
      ›
    </span>
  </div>

  <button
  type="button"
  className="mobile-capture-button"
  aria-label="Open Quick Add"
  onPointerDown={startCalendarAddHold}
  onPointerUp={cancelCalendarAddHold}
  onPointerCancel={cancelCalendarAddHold}
  onContextMenu={(event) => {
    event.preventDefault()
  }}
  onClick={() => {
    if (consumeCalendarAddLongPress()) {
      return
    }

    setQuickAddOpen(true)
  }}
>
  +
</button>
</div>

{aiCommandOpen &&
  createPortal(
    <div
      className="ai-command-overlay"
      onClick={() => {
        setAiCommandOpen(false)
      }}
    >
      <div
        className="ai-command-panel"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="ai-command-header">
          <div>
            <span className="ai-command-eyebrow">
              Calendar Assistant
            </span>

            <h2>What would you like to do?</h2>
          </div>

          <button
            type="button"
            className="ai-command-close"
            aria-label="Close AI command"
            onClick={() => {
              setAiCommandOpen(false)
            }}
          >
            ×
          </button>
        </div>

        <form
  className="ai-command-form"
  onSubmit={(event) => {
    event.preventDefault()
    void submitAiCommand()
  }}
>
          <textarea
            className="ai-command-input"
            value={aiCommandText}
            onChange={(event) => {
              setAiCommandText(
                event.target.value
              )
            }}
            placeholder="Try: Cancel my dentist appointment tomorrow at 2 PM"
            autoFocus
          />
{aiCancellationPreview?.status ===
  'needs_clarification' &&
  aiCancellationPreview.matches?.length === 0 && (
    <div className="ai-cancel-confirmation">
      <span className="ai-cancel-confirmation-label">
        Arney needs more information
      </span>

      <strong>
        {!aiCancellationPreview.criteria?.title
          ? 'Which event do you mean?'
          : !aiCancellationPreview.criteria?.date
            ? 'What date is the event?'
            : !aiCancellationPreview.criteria?.person
              ? 'Who is the event for?'
              : 'Can you provide more details?'}
      </strong>

                  {aiCancellationPreview.criteria?.title &&
      aiCancellationPreview.criteria?.date &&
      !aiCancellationPreview.criteria?.person ? (
        <div className="ai-cancel-choice-list ai-person-choice-strip">
          {people.length === 0 ? (
            <span>
              No family profiles are loaded.
            </span>
          ) : (
            people.map((person) => (
              <button
                key={person.id}
                type="button"
                className="ai-cancel-choice"
                disabled={aiCommandLoading}
                onClick={() => {
                  void chooseAiCancellationPerson(
                    person.name
                  )
                }}
              >
                <strong>{person.name}</strong>
              </button>
            ))
          )}
        </div>
      ) : (
        <span>
          Update your request above with the
          missing information, then press Send
          again.
        </span>
      )}
    </div>
  )}

{aiCancellationPreview?.status ===
  'needs_clarification' &&
  aiCancellationPreview.count === 0 &&
  aiCancellationPreview.criteria?.date == null &&
  aiCancellationPreview.criteria?.title &&
  aiCancellationPreview.criteria?.person && (
    <div className="ai-cancel-confirmation">
      <span className="ai-cancel-confirmation-label">
        One more detail
      </span>

      <strong>
        What date is{' '}
        {aiCancellationPreview.criteria.person}
        {'\'s '}
        {aiCancellationPreview.criteria.title}
        {' event?'}
      </strong>

      <input
        type="text"
        className="ai-clarification-input"
        value={aiClarificationAnswer}
        onChange={(event) => {
          setAiClarificationAnswer(
            event.target.value
          )
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submitAiClarification()
          }
        }}
        placeholder="October 9 at 7 AM"
      />

      <button
        type="button"
        className="ai-command-send"
        disabled={
          aiClarificationAnswer.trim() === '' ||
          aiCommandLoading
        }
        onClick={submitAiClarification}
      >
        {aiCommandLoading
          ? 'Thinking...'
          : 'Continue'}
      </button>
    </div>
  )}

{aiCancellationPreview?.status ===
  'needs_clarification' &&
  aiCancellationPreview.matches?.length > 1 && (
    <div className="ai-cancel-confirmation">
      <span className="ai-cancel-confirmation-label">
        Which event did you mean?
      </span>

      <div className="ai-cancel-choice-list">
        {aiCancellationPreview.matches.map(
          (match: {
            id: number
            title: string
            date: string
            time: string | null
            occurrenceDate: string | null
            person: string | null
            people?: Person[]
          }) => (
            <button
              key={`${match.id}-${match.occurrenceDate ?? ''}`}
              type="button"
              className="ai-cancel-choice"
              onClick={() => {
                setAiCancellationPreview({
                  ...aiCancellationPreview,
                  status:
                    'ready_for_confirmation',
                  count: 1,
                  matches: [match],
                })
              }}
            >
              <strong>{match.title}</strong>

              <span>
                {match.occurrenceDate ??
                  match.date}
                {' at '}
                {match.time ?? 'All day'}
              </span>

              <span>
                {match.people
                  ?.map(
                    (person) =>
                      person.name
                  )
                  .join(', ') ||
                  match.person ||
                  'Unassigned'}
              </span>
            </button>
          )
        )}
      </div>
    </div>
  )}
{aiCancellationPreview?.status ===
  'ready_for_confirmation' &&
  aiCancellationPreview.matches?.length ===
    1 && (
    <div className="ai-cancel-confirmation">
      <span className="ai-cancel-confirmation-label">
        Confirm cancellation
      </span>

      <strong>
        {
          aiCancellationPreview
            .matches[0].title
        }
      </strong>

      <span>
        {
          aiCancellationPreview
            .matches[0].date
        }
        {' at '}
        {
          aiCancellationPreview
            .matches[0].time
        }
      </span>

      <span>
        {
          aiCancellationPreview
            .matches[0].people
            ?.map(
              (person: Person) =>
                person.name
            )
            .join(', ') ||
          aiCancellationPreview
            .matches[0].person
        }
      </span>

      <div className="ai-cancel-confirmation-actions">
        <button
          type="button"
          className="ai-command-cancel"
          onClick={() => {
            setAiCancellationPreview(null)
          }}
        >
          Keep Event
        </button>

        <button
          type="button"
          className="ai-cancel-confirm-button"
          disabled={aiCommandLoading}
          onClick={() => {
  void confirmAiCancellation()
}}
        >
          Cancel Event
        </button>
      </div>
    </div>
  )}

{aiReschedulePreview?.status === 'needs_clarification' &&
  aiReschedulePreview.reason === 'multiple_matching_events' &&
  aiReschedulePreview.matches?.length > 1 && (
    <div className="ai-cancel-confirmation">
      <span className="ai-cancel-confirmation-label">
        Arney needs one more detail
      </span>

      <strong>Which event would you like to move?</strong>

      <div className="ai-cancel-choice-list">
        {aiReschedulePreview.matches.map(
          (match: {
            id: number
            title: string
            date: string
            time: string | null
            endTime: string | null
            repeatUnit: string | null
            matchType: string
            person: string | null
            people?: Person[]
          }) => (
            <button
              key={match.id}
              type="button"
              className="ai-cancel-choice"
              disabled={aiCommandLoading}
              onClick={() => {
                const proposed = {
                  date:
                    aiReschedulePreview.criteria?.newDate ??
                    match.date,
                  time:
                    aiReschedulePreview.criteria?.newTime ??
                    match.time,
                }

                if (
                  match.matchType !== 'event' ||
                  match.repeatUnit != null ||
                  (
                    match.endTime != null &&
                    proposed.time !== match.time
                  )
                ) {
                  showAppNotification(
                    'This event type cannot be rescheduled by Arney yet.'
                  )
                  return
                }

                if (
                  proposed.date === match.date &&
                  proposed.time === match.time
                ) {
                  showAppNotification(
                    'The event is already scheduled for that date and time.'
                  )
                  return
                }

                setAiReschedulePreview({
                  ...aiReschedulePreview,
                  status: 'ready_for_confirmation',
                  count: 1,
                  matches: [match],
                  eventId: match.id,
                  original: {
                    date: match.date,
                    time: match.time,
                  },
                  proposed,
                })
              }}
            >
              <strong>
                {match.people
                  ?.map((person: Person) => person.name)
                  .join(', ') ||
                  match.person ||
                  'Unassigned'}
              </strong>

              <span>{match.title}</span>

              <span>
                {match.date}
                {' at '}
                {match.time ?? 'All day'}
              </span>
            </button>
          )
        )}
      </div>
    </div>
  )}

{aiReschedulePreview?.status ===
  'ready_for_confirmation' &&
  aiReschedulePreview.matches?.length === 1 && (
    <div className="ai-cancel-confirmation">
      <span className="ai-cancel-confirmation-label">
        Rescheduling Preview
      </span>

      <strong>
        {aiReschedulePreview.matches[0].title}
      </strong>

      <span>
        {aiReschedulePreview.matches[0].people
          ?.map((person: Person) => person.name)
          .join(', ') ||
          aiReschedulePreview.matches[0].person ||
          'Unassigned'}
      </span>

      <span>
        Current: {aiReschedulePreview.original.date}
        {' at '}
        {aiReschedulePreview.original.time ?? 'No time'}
      </span>

      <span>
        Proposed: {aiReschedulePreview.proposed.date}
        {' at '}
        {aiReschedulePreview.proposed.time ?? 'No time'}
      </span>

            <div className="ai-cancel-confirmation-actions">
        <button
          type="button"
          className="ai-command-cancel"
          disabled={aiCommandLoading}
          onClick={() => {
            setAiReschedulePreview(null)
          }}
        >
          Keep Event
        </button>

        <button
          type="button"
          className="ai-command-send"
          disabled={aiCommandLoading}
          onClick={() => {
            void confirmAiReschedule()
          }}
        >
          {aiCommandLoading
            ? 'Rescheduling...'
            : 'Confirm Move'}
        </button>
      </div>
    </div>
  )}

{aiCommandResult !== '' && (
  <pre className="ai-command-debug">
    {aiCommandResult}
  </pre>
)}


          <div className="ai-command-actions">
            <button
              type="button"
              className="ai-command-cancel"
              onClick={() => {
                setAiCommandOpen(false)
              }}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="ai-command-send"
              disabled={
  aiCommandText.trim() === '' ||
  aiCommandLoading
}
            >
              {aiCommandLoading
  ? 'Thinking...'
  : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )}


{quickAddOpen &&
  createPortal(
    <div
      className="quick-add-overlay"
      onClick={() => {
        setQuickAddOpen(false)
      }}
    >
      <div
        className="quick-add-sheet"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="quick-add-header">
          <div>
            <span className="quick-add-eyebrow">
              Add something
            </span>

            <h2>Quick Add</h2>
          </div>

          <button
            className="quick-add-close"
            type="button"
            aria-label="Close Quick Add"
            onClick={() => {
              setQuickAddOpen(false)
            }}
          >
            ×
          </button>
        </div>

        <div className="quick-add-options">
          <button
            className="quick-add-option"
            type="button"
            

               onClick={() => {
  const targetDate = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  )

  const targetDateKey =
    getDateKeyFromDate(targetDate)

  setQuickAddOpen(false)

  clearEventForm()

  setMonthEventsOpen(false)
  setPage('calendar')
  setCalendarView('month')

  setViewDate(
    new Date(
      targetDate.getFullYear(),
      targetDate.getMonth(),
      1
    )
  )

  setWeekDate(targetDate)
  setSelectedDay(targetDate.getDate())

  setEventStartDate(targetDateKey)
  setEventStartDateText(
    formatDateKeyForText(targetDateKey)
  )

  setIsAddingEvent(true)

  window.requestAnimationFrame(() => {
    const eventInput =
      document.querySelector<HTMLInputElement>(
        '.event-input'
      )

    eventInput?.focus()
  })
}}
          >
            <span className="quick-add-option-icon">
              +
            </span>

            <span className="quick-add-option-text">
              <strong>Event</strong>
              <small>
                Add something to the calendar
              </small>
            </span>
          </button>

          <button
  className="quick-add-option"
  type="button"
  onClick={() => {
    const targetListId =
      selectedListId !== null &&
      lists.some(
        (list) =>
          list.id === selectedListId
      )
        ? selectedListId
        : lists[0]?.id ?? null

    setQuickAddOpen(false)
    setQuickListId(targetListId)
    setQuickListText('')
    setQuickListOpen(true)
  }}
>
  <span className="quick-add-option-icon">
    ✓
  </span>

  <span className="quick-add-option-text">
    <strong>List</strong>
    <small>Add an item to a list</small>
  </span>
</button>

          <button
  className="quick-add-option"
  type="button"
  onClick={() => {
    setQuickAddOpen(false)

    setPage('meals')
    setMealsView('recipes')

    window.setTimeout(() => {
      openAddRecipeForm()
    }, 0)
  }}
>
  <span className="quick-add-option-icon">
    R
  </span>

  <span className="quick-add-option-text">
    <strong>Recipe</strong>
    <small>Add a new recipe</small>
  </span>
</button>

          <button
  className="quick-add-option"
  type="button"
  onClick={() => {
    setQuickAddOpen(false)

    if (capturePreviewUrl) {
      URL.revokeObjectURL(
        capturePreviewUrl
      )
    }

    setCaptureFile(null)
    setCapturePreviewUrl('')
    setCaptureNote('')
    setCaptureOpen(true)
  }}
>
  <span className="quick-add-option-icon">
    ▣
  </span>

  <span className="quick-add-option-text">
    <strong>Photo / Screenshot</strong>
    <small>Analyze an event or recipe</small>
  </span>
</button>
        </div>
      </div>
    </div>,
    document.body
  )}
  {captureOpen &&
createPortal(
  <div
    className="quick-add-overlay"
    onClick={() => {
      if (captureSaving) {
        return
      }

      if (capturePreviewUrl) {
        URL.revokeObjectURL(
          capturePreviewUrl
        )
      }

      setCaptureOpen(false)
      setCaptureFile(null)
      setCapturePreviewUrl('')
      setCaptureNote('')
    }}
  >
    <div
      className="quick-add-sheet"
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      <span className="quick-add-eyebrow">
  AI Quick Add
</span>

<h2>Photo / Screenshot</h2>

<p>
  Choose a photo or screenshot and let AI create the event or recipe.
</p>

<button
  type="button"
  className="capture-view-inbox-button"
  onClick={() => {
    if (capturePreviewUrl) {
      URL.revokeObjectURL(
        capturePreviewUrl
      )
    }

    setCaptureOpen(false)
    setCaptureFile(null)
    setCapturePreviewUrl('')
    setCaptureNote('')

    setPage('capture')
    void loadCaptureInbox()
  }}
>
  View Capture Inbox
</button>

<input
  className="event-input"
  type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={captureSaving}
       onChange={async (event) => {
  const file =
    event.target.files?.[0] ??
    null

  if (capturePreviewUrl) {
    URL.revokeObjectURL(
      capturePreviewUrl
    )
  }

  if (!file) {
    setCaptureFile(null)
    setCapturePreviewUrl('')
    return
  }

  const preparedFile =
    await prepareCaptureImage(file)

  setCaptureFile(preparedFile)

  setCapturePreviewUrl(
    URL.createObjectURL(
      preparedFile
    )
  )
}}
      />

      {capturePreviewUrl && (
        <div className="capture-preview">
          <img
            src={capturePreviewUrl}
            alt="Selected capture preview"
          />
        </div>
      )}

      <label className="quick-list-list-field">
        <span className="quick-list-list-label">
          Note
        </span>

        <textarea
          className="event-input"
          value={captureNote}
          maxLength={2000}
          disabled={captureSaving}
          placeholder="Optional note"
          onChange={(event) => {
            setCaptureNote(
              event.target.value
            )
          }}
        />
      </label>

      <div className="event-form-actions">
        <button
          className="event-form-cancel-button"
          type="button"
          disabled={captureSaving}
          onClick={() => {
            if (capturePreviewUrl) {
              URL.revokeObjectURL(
                capturePreviewUrl
              )
            }

            setCaptureOpen(false)
            setCaptureFile(null)
            setCapturePreviewUrl('')
            setCaptureNote('')
          }}
        >
          Cancel
        </button>

        <button
  className="add-event-button"
  type="button"
  disabled={
    captureFile === null ||
    captureSaving
  }
  onClick={() => {
    void analyzeQuickAddPhoto()
  }}
>
  {captureSaving
    ? 'Analyzing...'
    : 'Analyze Photo'}
</button>
      </div>
    </div>
  </div>,
  document.body
)}

{multiEventReview &&
  !isAddingEvent &&
  createPortal(
    <div
      className="quick-add-overlay"
      onClick={() => {
        if (
          capturePreviewUrl
        ) {
          URL.revokeObjectURL(
            capturePreviewUrl
          )
        }

        setMultiEventReview(null)
        setCaptureFile(null)
        setCapturePreviewUrl('')
        setCaptureNote('')
      }}
    >
      <div
        className="quick-add-sheet"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="quick-add-header">
          <div>
            <span className="quick-add-eyebrow">
              AI Quick Add
            </span>

            <h2>
              {
                multiEventReview
                  .analysis
                  .events?.length ?? 0
              }{' '}
              Events Found
            </h2>
          </div>

          <button
            className="quick-add-close"
            type="button"
            aria-label="Close event review"
            onClick={() => {
              if (
                capturePreviewUrl
              ) {
                URL.revokeObjectURL(
                  capturePreviewUrl
                )
              }

              setMultiEventReview(null)
              setCaptureFile(null)
              setCapturePreviewUrl('')
              setCaptureNote('')
            }}
          >
            X
          </button>
        </div>

        <p>
          Choose the event you want to review and add.
        </p>

        <div className="quick-add-options">
          {(
            multiEventReview
              .analysis
              .events ?? []
          ).map(
            (
              capturedEvent,
              eventIndex
            ) => (
              <button
                className="quick-add-option"
                type="button"
                key={`${capturedEvent.title}-${eventIndex}`}
                onClick={() => {
  const remainingEvents =
    (
      multiEventReview
        .analysis
        .events ?? []
    ).filter(
      (
        _event,
        remainingIndex
      ) =>
        remainingIndex !==
        eventIndex
    )

  if (
    remainingEvents.length > 0
  ) {
    setMultiEventReview({
      analysis: {
        ...multiEventReview.analysis,
        events:
          remainingEvents,
      },
      note:
        multiEventReview.note,
    })
  } else {
    setMultiEventReview(null)
  }

  openCapturedEventForReview(
    multiEventReview.analysis,
    capturedEvent,
    multiEventReview.note
  )
}}
              >
                <span className="quick-add-option-text">
                  <strong>
                    {capturedEvent.title ||
                      `Event ${eventIndex + 1}`}
                  </strong>

                  <small>
                    {[
                      capturedEvent.startTime,
                      capturedEvent.endTime,
                    ]
                      .filter(Boolean)
                      .join(' - ') ||
                      'Time not shown'}
                  </small>

                  {capturedEvent.location && (
                    <small>
                      {
                        capturedEvent.location
                      }
                    </small>
                  )}
                </span>
              </button>
            )
          )}
        </div>
      </div>
    </div>,
    document.body
  )}


  {quickListOpen &&
  createPortal(
    <div
      className="quick-add-overlay"
      onClick={() => {
        setQuickListOpen(false)
      }}
    >
      <div
        className="quick-add-sheet"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="quick-add-header">
          <div>
            <span className="quick-add-eyebrow">
              Quick Add
            </span>

            <h2>Add to List</h2>
          </div>

          <button
            className="quick-add-close"
            type="button"
            aria-label="Close Add to List"
            onClick={() => {
              setQuickListOpen(false)
            }}
          >
            X
          </button>
        </div>

        {lists.length === 0 ? (
          <div className="quick-list-empty">
            <p>
              You do not have any lists yet.
            </p>

            <button
              className="add-event-button"
              type="button"
              onClick={() => {
                setQuickListOpen(false)
                setPage('lists')
              }}
            >
              Go to Lists
            </button>
          </div>
        ) : (
          <form
            className="quick-list-form"
            onSubmit={async (event) => {
              event.preventDefault()
              await addQuickListItem()
            }}
          >
          <div className="quick-list-list-field">
  <span className="quick-list-list-label">
    List
  </span>

  <div className="quick-list-select-row">
    <select
      className="event-input"
      value={quickListId ?? ''}
      onChange={(event) => {
        const nextId =
          Number(event.target.value)

        setQuickListId(
          Number.isFinite(nextId)
            ? nextId
            : null
        )
      }}
    >
      {lists.map((list) => (
        <option
          key={list.id}
          value={list.id}
        >
          {list.name}
        </option>
      ))}
    </select>

    <button
      className="quick-list-create-button"
      type="button"
      onClick={() => {
        setQuickListOpen(false)
        setNewListName('')
        setPage('lists')
        setListCreateOpen(true)
      }}
    >
      <span aria-hidden="true">+</span>
      New List
    </button>
  </div>
</div>

            <label className="event-field">
              Item
              <input
                className="event-input"
                type="text"
                placeholder="Example: Milk"
                value={quickListText}
                onChange={(event) => {
                  setQuickListText(
                    event.target.value
                  )
                }}
                autoFocus
              />
            </label>

            <button
              className="add-event-button"
              type="submit"
              disabled={
                quickListId === null ||
                quickListText.trim() === ''
              }
            >
              Add Item
            </button>
          </form>
        )}
      </div>
    </div>,
    document.body
  )}

{appNotification && (
  <div
    className="app-notification"
    role="status"
  >
    {appNotification}
  </div>
)}
      {page === 'home' && (
  <section className="home-dashboard">
    <div className="home-dashboard-heading">
      <div>
        <span className="home-dashboard-eyebrow">
          Family Dashboard
        </span>

        <h1>Home</h1>

        <p>
          Everything your family needs at a glance.
        </p>
      </div>

     <div className="home-dashboard-date">
  <strong>
    {today.toLocaleDateString(
      undefined,
      {
        weekday: 'long',
      }
    )}
  </strong>

  <span>
    {today.toLocaleDateString(
      undefined,
      {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }
    )}
  </span>
</div>
    </div>
{isEditingHome && (
  <button
    type="button"
    className="home-edit-done-button"
    onClick={() => {
      setIsEditingHome(false)
    }}
  >
    Done
  </button>
)}

<DndContext
  sensors={sensors}
  collisionDetection={closestCenter}
  onDragEnd={handleHomeWidgetDragEnd}
>
  <SortableContext
  items={homeWidgetOrder}
  strategy={rectSortingStrategy}
>

    <div
  className={`home-widget-grid ${
    isEditingHome
      ? 'home-widget-grid-editing'
      : ''
  }`}
  onPointerDown={(event) => {
    if (isEditingHome) {
      return
    }

    const target =
      event.target as HTMLElement

    if (
      target.closest(
        'button, input, textarea, select, a'
      )
    ) {
      return
    }

    if (
      homeEditHoldRef.current.timer !==
      null
    ) {
      window.clearTimeout(
        homeEditHoldRef.current.timer
      )
    }

    homeEditHoldRef.current.startX =
      event.clientX

    homeEditHoldRef.current.startY =
      event.clientY

    homeEditHoldRef.current.timer =
      window.setTimeout(() => {
        homeEditHoldRef.current.timer =
          null

        setIsEditingHome(true)
      }, 1200)
  }}
  onPointerMove={(event) => {
    if (
      homeEditHoldRef.current.timer ===
      null
    ) {
      return
    }

    const deltaX =
      event.clientX -
      homeEditHoldRef.current.startX

    const deltaY =
      event.clientY -
      homeEditHoldRef.current.startY

    if (
      Math.hypot(deltaX, deltaY) > 12
    ) {
      window.clearTimeout(
        homeEditHoldRef.current.timer
      )

      homeEditHoldRef.current.timer =
        null
    }
  }}
  onPointerUp={() => {
    if (
      homeEditHoldRef.current.timer !==
      null
    ) {
      window.clearTimeout(
        homeEditHoldRef.current.timer
      )

      homeEditHoldRef.current.timer =
        null
    }
  }}
  onPointerCancel={() => {
    if (
      homeEditHoldRef.current.timer !==
      null
    ) {
      window.clearTimeout(
        homeEditHoldRef.current.timer
      )

      homeEditHoldRef.current.timer =
        null
    }
  }}
>
     
  <SortableHomeWidget
  id="weather"
  enabled={isEditingHome}
  order={homeWidgetOrder.indexOf(
    'weather'
  )}
  className={`home-widget home-widget-weather home-widget-size-${homeWeatherSize}`}
>

  {isEditingHome && (
    <button
      type="button"
      className="home-widget-resize-button"
      onClick={() => {
        setHomeWeatherSize((current) => {
          if (current === 'small') {
            return 'medium'
          }

          if (current === 'medium') {
            return 'large'
          }

          return 'small'
        })
      }}
    >
      Size: {homeWeatherSize}
    </button>
  )}

  <HomeWeather />
</SortableHomeWidget>

     <SortableHomeWidget
  id="today"
  enabled={isEditingHome}
  order={homeWidgetOrder.indexOf(
    'today'
  )}
  className={`home-widget home-widget-today home-widget-size-${homeTodaySize}`}
>
  {isEditingHome && (
    <button
      type="button"
      className="home-widget-resize-button"
      onClick={() => {
        setHomeTodaySize((current) => {
          if (current === 'small') {
            return 'medium'
          }

          if (current === 'medium') {
            return 'large'
          }

          return 'small'
        })
      }}
    >
      Size: {homeTodaySize}
    </button>
  )}
        <div className="home-widget-heading">
          <span>Today</span>

          <button
            type="button"
            className="home-widget-link"
            onClick={() => {
              setPage('calendar')
            }}
          >
            Calendar
          </button>
        </div>

        {homeTodayEvents.length === 0 ? (
          <div className="home-widget-empty">
            Nothing scheduled today.
          </div>
        ) : (
          <div className="home-schedule-list">
            {homeTodayEvents
              .slice(0, 5)
              .map(
                ({
                  calendarEvent,
                  occurrenceStartDate,
                }) => (
                  <button
                    type="button"
                    className="home-schedule-item"
                    key={`${calendarEvent.id}-${occurrenceStartDate}`}
                    onClick={() => {
                      setPage('calendar')

                      openEventDetails(
                        calendarEvent,
                        occurrenceStartDate
                      )
                    }}
                  >
                    <div className="home-schedule-time">
                      {calendarEvent.time
                        ? formatTime(
                            calendarEvent.time
                          )
                        : 'All Day'}
                    </div>

                    <div
  className="home-schedule-info"
  style={{
    background:
      getEventBackground(
        calendarEvent.people
      ),
  }}
>
                      <strong>
                        {calendarEvent.title}
                      </strong>

                      {calendarEvent.people.length > 0 && (
                        <span>
                          {calendarEvent.people
                            .map(
                              (person) =>
                                person.name
                            )
                            .join(', ')}
                        </span>
                      )}
                    </div>
                    <CompactEventWeather
  location={calendarEvent.location}
  date={occurrenceStartDate}
  time={calendarEvent.time}
/>
                  </button>
                )
              )}
          </div>
        )}
      </SortableHomeWidget>

      <SortableHomeWidget
  id="upcoming"
  enabled={isEditingHome}
  order={homeWidgetOrder.indexOf(
    'upcoming'
  )}
  className={`home-widget home-widget-upcoming home-widget-size-${homeUpcomingSize}`}
>
  {isEditingHome && (
    <button
      type="button"
      className="home-widget-resize-button"
      onClick={() => {
        setHomeUpcomingSize((current) => {
          if (current === 'small') {
            return 'medium'
          }

          if (current === 'medium') {
            return 'large'
          }

          return 'small'
        })
      }}
    >
      Size: {homeUpcomingSize}
    </button>
  )}
        <div className="home-widget-heading">
          <span>Upcoming</span>

          <button
            type="button"
            className="home-widget-link"
            onClick={() => {
              setPage('calendar')
            }}
          >
            View All
          </button>
        </div>

        {homeUpcomingEvents.length === 0 ? (
          <div className="home-widget-empty">
            Nothing coming up.
          </div>
        ) : (
          <div className="home-upcoming-list">
            {homeUpcomingEvents.map(
              ({
                calendarEvent,
                dateKey,
              }) => (
                <button
                  type="button"
                  className="home-upcoming-item"
                  key={`${calendarEvent.id}-${dateKey}`}
                  onClick={() => {
                    setPage('calendar')

                    openEventDetails(
                      calendarEvent,
                      dateKey
                    )
                  }}
                >
                  <div className="home-upcoming-date">
                    <strong>
                      {new Date(
                        `${dateKey}T12:00:00`
                      ).toLocaleDateString(
                        undefined,
                        {
                          weekday: 'short',
                        }
                      )}
                    </strong>

                    <span>
                      {new Date(
                        `${dateKey}T12:00:00`
                      ).getDate()}
                    </span>
                  </div>

                  <div
  className="home-upcoming-info"
  style={{
    background:
      getEventBackground(
        calendarEvent.people
      ),
  }}
>
                    <strong>
                      {calendarEvent.title}
                    </strong>

                    <span>
                      {calendarEvent.time
                        ? formatTime(
                            calendarEvent.time
                          )
                        : 'All Day'}
                    </span>
                  </div>
                  <CompactEventWeather
  location={calendarEvent.location}
  date={dateKey}
  time={calendarEvent.time}
/>
                </button>
              )
            )}
          </div>
        )}
      </SortableHomeWidget>

      <SortableHomeWidget
  id="notes"
  enabled={isEditingHome}
  order={homeWidgetOrder.indexOf(
    'notes'
  )}
  className={`home-widget home-widget-notes home-widget-size-${homeNotesSize}`}
>
  {isEditingHome && (
    <button
      type="button"
      className="home-widget-resize-button"
      onClick={() => {
        setHomeNotesSize((current) => {
          if (current === 'small') {
            return 'medium'
          }

          if (current === 'medium') {
            return 'large'
          }

          return 'small'
        })
      }}
    >
      Size: {homeNotesSize}
    </button>
  )}
        <div className="home-widget-heading">
          <span>Notes</span>
        </div>

        <div className="home-widget-placeholder">
          Family notes will appear here.
        </div>
      </SortableHomeWidget>

      <SortableHomeWidget
  id="meals"
  enabled={isEditingHome}
  order={homeWidgetOrder.indexOf(
    'meals'
  )}
  className={`home-widget home-widget-meals home-widget-size-${homeMealsSize}`}
>
  {isEditingHome && (
    <button
      type="button"
      className="home-widget-resize-button"
      onClick={() => {
        setHomeMealsSize((current) => {
          if (current === 'small') {
            return 'medium'
          }

          if (current === 'medium') {
            return 'large'
          }

          return 'small'
        })
      }}
    >
      Size: {homeMealsSize}
    </button>
  )}
        <div className="home-widget-heading">
          <span>Today's Meals</span>

          <button
            type="button"
            className="home-widget-link"
            onClick={() => {
              const currentWeekStart =
                new Date()

              currentWeekStart.setHours(
                12,
                0,
                0,
                0
              )

              currentWeekStart.setDate(
                currentWeekStart.getDate() -
                  currentWeekStart.getDay()
              )

              setMealPlannerWeekStart(
                currentWeekStart
              )

              setMealsView('planner')
              setPage('meals')
            }}
          >
            Meal Planner
          </button>
        </div>

        {homeTodayMeals.length === 0 ? (
          <div className="home-widget-empty">
            No meals planned today.
          </div>
        ) : (
          <div className="home-meal-list">
            {homeTodayMeals.map(
              (meal) => (
                <button
  type="button"
  className={`home-meal-item home-meal-item-${meal.mealType}`}
  key={meal.id}
                  onClick={() => {
                    setMealsView('planner')
                    setPage('meals')
                  }}
                >
                  <span className="home-meal-icon">
  {meal.mealType === 'breakfast'
    ? '☀️'
    : meal.mealType === 'lunch'
      ? '🥪'
      : meal.mealType === 'dinner'
        ? '🍽️'
        : '🍿'}
</span>

<div className="home-meal-info">
  <span className="home-meal-type">
    {meal.mealType}
  </span>

  <strong>
    {meal.title}
  </strong>
</div>

<span className="home-meal-arrow">
  ›
</span>
                </button>
              )
            )}
          </div>
        )}
      </SortableHomeWidget>

      <SortableHomeWidget
  id="lists"
  enabled={isEditingHome}
  order={homeWidgetOrder.indexOf(
    'lists'
  )}
  className={`home-widget home-widget-lists home-widget-size-${homeListsSize}`}
>
  {isEditingHome && (
    <button
      type="button"
      className="home-widget-resize-button"
      onClick={() => {
        setHomeListsSize((current) => {
          if (current === 'small') {
            return 'medium'
          }

          if (current === 'medium') {
            return 'large'
          }

          return 'small'
        })
      }}
    >
      Size: {homeListsSize}
    </button>
  )}
        <div className="home-widget-heading">
          <span>Lists</span>

          <button
            type="button"
            className="home-widget-link"
            onClick={() => {
              setPage('lists')
            }}
          >
            View All
          </button>
        </div>

        {homeListPreview.length === 0 ? (
          <div className="home-widget-empty">
            No lists yet.
          </div>
        ) : (
          <div className="home-list-preview">
            {homeListPreview.map(
              (list) => {
                const remainingCount =
                  list.items.filter(
                    (item) =>
                      !item.completed
                  ).length

                return (
                  <button
                    type="button"
                    className="home-list-preview-item"
                    key={list.id}
                    onClick={() => {
                      setSelectedListId(
                        list.id
                      )

                      setNewListItemText('')

                      setEditingListName(
                        list.name
                      )

                      setPage('lists')
                    }}
                  >
                    <div>
                      <strong>
                        {list.name}
                      </strong>

                      <span>
                        {remainingCount}{' '}
                        {remainingCount === 1
                          ? 'item left'
                          : 'items left'}
                      </span>
                    </div>

                    <span className="home-list-arrow">
                      ›
                    </span>
                  </button>
                )
              }
            )}
          </div>
                )}
      </SortableHomeWidget>
    </div>
  </SortableContext>
</DndContext>

    <div
      className="home-ai-buddy-zone"
      aria-hidden="true"
    />
    <button
      type="button"
      className="home-mobile-settings-button"
      onClick={() => setMobileSettingsOpen(true)}
    >
      Settings
    </button>
  </section>
)}
{mobileSettingsOpen && createPortal(
  <div
    className="mobile-settings-overlay"
    onClick={() => setMobileSettingsOpen(false)}
  >
    <section
      className="mobile-settings-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobile-settings-title"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="mobile-settings-heading">
        <h2 id="mobile-settings-title">Settings</h2>
        <button
          className="mobile-settings-close"
          type="button"
          aria-label="Close settings"
          onClick={() => setMobileSettingsOpen(false)}
        >
          ×
        </button>
      </div>
      <p>Manage your family calendar preferences.</p>
      {familyAuthEnabled && (
        <button
          className="mobile-settings-option"
          type="button"
          onClick={() => window.location.assign('/account')}
        >
          Family Account
          <span aria-hidden="true">›</span>
        </button>
      )}
      <button
        className="mobile-settings-option"
        type="button"
        onClick={() => {
          setMobileSettingsOpen(false)
          window.dispatchEvent(new Event('family-calendar:open-arney-settings'))
        }}
      >
        Arney Voice Settings
        <span aria-hidden="true">›</span>
      </button>
      <button className="mobile-settings-option" type="button" onClick={() => {
        setMobileSettingsOpen(false)
        setShoppingStoreSettingsOpen(true)
        void loadShoppingStores()
      }}>Shopping Stores <span aria-hidden="true">›</span></button>
      <button
        className="mobile-settings-option"
        type="button"
        onClick={() => {
          setMobileSettingsOpen(false)
          setPage('people')
        }}
      >
        Manage People
        <span aria-hidden="true">›</span>
      </button>
      <button
        className="mobile-settings-option"
        type="button"
        onClick={() => {
          setMobileSettingsOpen(false)
          setIsEditingHome(true)
          setPage('home')
        }}
      >
        Customize Home
        <span aria-hidden="true">›</span>
      </button>
    </section>
  </div>,
  document.body
)}

      {page === 'calendar' && (
       <section
  className={`dashboard ${
  calendarView === 'month' ||
  calendarView === 'week' ||
  calendarView === 'day' ||
  calendarView === 'schedule' ||
  !showCalendarSidebar
    ? 'dashboard-full'
    : ''
}`}
>
          <div
  className={`calendar-panel ${
    calendarViewChanging
      ? 'calendar-panel-changing'
      : ''
  }`}
  
>
             <div className="calendar-heading">
  {calendarView !== 'week' &&
    calendarView !== 'schedule' && (
      <button
        type="button"
        className="calendar-period-button"
        onClick={goToPreviousPeriod}
        aria-label="Previous period"
      >
        &lsaquo;
      </button>
    )}

  <h2>
    {calendarView === 'day'
      ? dayViewDate.toLocaleDateString(
          'en-US',
          {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          }
        )
      : calendarView === 'week'
        ? `${weekDates[0].toLocaleDateString(
            'en-US',
            {
              month: 'short',
              day: 'numeric',
            }
          )} - ${weekDates[6].toLocaleDateString(
            'en-US',
            {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            }
          )}`
        : `${monthName} ${year}`}
  </h2>

  {calendarView !== 'week' &&
    calendarView !== 'schedule' && (
      <button
        type="button"
        className="calendar-period-button"
        onClick={goToNextPeriod}
        aria-label="Next period"
      >
        &rsaquo;
      </button>
    )}
</div>      
<div className="calendar-secondary-row">
  <div className="calendar-mobile-toolbar">
  <button
    type="button"
    className="calendar-mobile-today-button"
    onClick={() => {
      const now = new Date()

      setViewDate(
        new Date(
          now.getFullYear(),
          now.getMonth(),
          1
        )
      )

      setWeekDate(
        new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate()
        )
      )

      setSelectedDay(now.getDate())
      clearEventForm()
    }}
  >
    Today
  </button>

  <div className="calendar-mobile-avatar-strip">
  {people.map((person) => {
    const initial =
      person.name
        .trim()
        .charAt(0)
        .toUpperCase() || '?'

    const isSelected =
      calendarPersonFilterId ===
      person.id

    return (
      <button
        key={person.id}
        type="button"
        className={`calendar-mobile-avatar-button ${
          isSelected
            ? 'calendar-mobile-avatar-button-active'
            : ''
        }`}
        onClick={() =>
          setCalendarPersonFilterId(
            (current) =>
              current === person.id
                ? null
                : person.id
          )
        }
        aria-label={person.name}
        aria-pressed={isSelected}
        title={person.name}
        style={{
          background:
            `color-mix(in srgb, ${person.color} 22%, white)`,
          borderColor:
            `color-mix(in srgb, ${person.color} 42%, white)`,
        }}
      >
        <span
          style={{
            background: person.color,
          }}
        >
          {initial}
        </span>
      </button>
    )
  })}
</div>
</div>
<div className="calendar-desktop-toolbar">
            <div className="calendar-toolbar-controls">
             
<div className="calendar-view-buttons">
  <button
    type="button"
    className={`calendar-view-button ${
      calendarView === 'month'
        ? 'active-calendar-view-button'
        : ''
    }`}
    onClick={() => {
      changeCalendarView('month')
    }}
  >
    Month
  </button>

  <button
    type="button"
    className={`calendar-view-button ${
      calendarView === 'week'
        ? 'active-calendar-view-button'
        : ''
    }`}
    onClick={() => {
      changeCalendarView('week')
    }}
  >
    Week
  </button>

  <button
    type="button"
    className={`calendar-view-button ${
      calendarView === 'day'
        ? 'active-calendar-view-button'
        : ''
    }`}
    onClick={() => {
      changeCalendarView('day')
    }}
  >
    Day
  </button>

  <button
    type="button"
    className={`calendar-view-button ${
      calendarView === 'schedule'
        ? 'active-calendar-view-button'
        : ''
    }`}
    onClick={() => {
  changeCalendarView('schedule')
}}
  >
    Schedule
  </button>


</div>
              
            </div>  
               <button
  type="button"
  className="calendar-today-button"
  onClick={goToToday}
>
  Today
</button>
             <div
  className="family-slider"
  ref={familySliderRef}
  onPointerDown={handleFamilySliderPointerDown}
  onPointerMove={handleFamilySliderPointerMove}
  onPointerUp={endFamilySliderDrag}
  onPointerCancel={endFamilySliderDrag}
  onScroll={scheduleFamilySliderSnap}
>
    {people.map((person) => (
      <div
  className={`family-slider-card ${
    calendarPersonFilterId === person.id
      ? 'family-slider-card-selected'
      : ''
  }`}
  key={person.id}
  style={{
  background:
    softenEventColor(person.color),
  border:
    calendarPersonFilterId === person.id
      ? `3px solid color-mix(in srgb, ${person.color} 55%, black)`
      : '1px solid rgba(0, 0, 0, 0.05)',
  outline: 'none',
}}
  onClick={() => {
    if (
      familySliderPointerRef.current.moved
    ) {
      return
    }

    setCalendarPersonFilterId(
      (currentPersonId) =>
        currentPersonId === person.id
          ? null
          : person.id
    )
  }}
>
        {renderPersonAvatar(
          person,
          'family-slider-avatar'
        )}

        <span className="family-slider-name">
          {person.name}
        </span>
      </div>
        ))}
  </div>

</div>
</div>

{calendarView === 'month' && (
  <div
    className="calendar-swipe-surface month-swipe-surface"
    onPointerDown={
      handleWeekPagerPointerDown
    }
    onPointerMove={
      handleWeekPagerPointerMove
    }
    
    onPointerUp={
      handleWeekPagerPointerUp
    }
    onPointerCancel={
      handleWeekPagerPointerCancel
    }
    onClickCapture={(event) => {
  if (suppressWeekPagerClick()) {
    event.preventDefault()
    event.stopPropagation()
  }
}}
  >
   <div className="weekdays">
  <div>Sun</div>
  <div>Mon</div>
  <div>Tue</div>
  <div>Wed</div>
  <div>Thu</div>
  <div>Fri</div>
  <div>Sat</div>
</div>

<div
  className="month-pager-track"
  ref={monthPagerTrackRef}
>
  {[-1, 0, 1].map((monthOffset) => {
    const pageDate =
      new Date(
        year,
        month + monthOffset,
        1
      )

    const targetYear =
      pageDate.getFullYear()

    const targetMonth =
      pageDate.getMonth()

    const targetMonthWeeks =
      getMonthWeeksForDate(pageDate)

    return (
      <div
        className="month-pager-page"
        key={`${targetYear}-${targetMonth}`}
      >
        <div className="calendar-grid month-calendar-grid">
          {targetMonthWeeks.map(
            (week, weekIndex) => {
    const multiDaySegments =
      getMonthWeekMultiDaySegments(
  week,
  targetYear,
  targetMonth
)

      const multiDayLaneCount =
  multiDaySegments.reduce(
    (highestLane, segment) =>
      Math.max(
        highestLane,
        segment.lane + 1
      ),
    0
  )

    return (
      <div
        className="month-week"
        key={`week-${weekIndex}`}
      >
        <div className="month-week-days">
          {week.map((day, columnIndex) => {
            if (day === null) {
              return (
                <div
                  className="day empty-day"
                  key={`blank-${weekIndex}-${columnIndex}`}
                />
              )
            }

            const isToday =
  day === today.getDate() &&
  targetMonth ===
    today.getMonth() &&
  targetYear ===
    today.getFullYear()

            const isSelected =
  monthOffset === 0 &&
  day === selectedDay
const dayMultiDayLaneCount =
  multiDaySegments.reduce(
    (highestLane, segment) => {
      const crossesThisDay =
        columnIndex >= segment.startColumn &&
        columnIndex <= segment.endColumn

      if (!crossesThisDay) {
        return highestLane
      }

      return Math.max(
        highestLane,
        segment.lane + 1
      )
    },
    0
  )
const maximumVisibleDayEventCount =
  Math.max(
    0,
    (
      isCompactMonthLayout
        ? 3
        : 4
    ) - dayMultiDayLaneCount
  )
           const dayEvents = events
  .filter(
    (calendarEvent) =>
      !isMultiDayEvent(calendarEvent) &&
      doesEventOccurOnDate(
        calendarEvent,
        getDateKeyForMonth(
          targetYear,
          targetMonth,
          day
        )
      )
  )
  .sort((eventA, eventB) => {
    if (!eventA.time && !eventB.time) {
      return eventA.title.localeCompare(
        eventB.title
      )
    }

    if (!eventA.time) return 1
    if (!eventB.time) return -1

    const timeCompare =
      eventA.time.localeCompare(
        eventB.time
      )

    if (timeCompare !== 0) {
      return timeCompare
    }

    return eventA.title.localeCompare(
      eventB.title
    )
  })

const visibleDayEventCount =
  dayEvents.length >
  maximumVisibleDayEventCount
    ? Math.max(
        0,
        maximumVisibleDayEventCount - 1
      )
    : maximumVisibleDayEventCount 

            return (
              <div
                key={day}
                className={`day ${
                  isToday ? 'today' : ''
                } ${
                  isSelected
                    ? 'selected-day'
                    : ''
                }`}
                onClick={() => {
  const openEventsForDay = () => {
    setSelectedDay(day)
    clearEventForm()

    if (
      window.matchMedia(
        '(min-width: 761px)'
      ).matches &&
      dayEvents.length === 0
    ) {
      setMonthEventsOpen(false)
      return
    }

    setMonthEventsOpen(true)
  }

  if (showCalendarSidebar) {
    transitionMonthSidebar(
      openEventsForDay
    )
    return
  }

  openEventsForDay()
}}
              >
                <div className="month-day-open-zone">
  <strong>{day}</strong>
</div>

                <div
                  className="event-list month-event-list"
                 style={{
  paddingTop:
    dayMultiDayLaneCount > 0
      ? `${
          dayMultiDayLaneCount * 20 + 3
        }px`
      : 0,
}}
                >
                  {dayEvents
                    .slice(0, visibleDayEventCount)
                    .map((calendarEvent) => {
                      const background =
                        getEventBackground(
                          calendarEvent.people
                        )

                      const textReferenceColor =
                        calendarEvent.people[0]
                          ?.color ?? '#e8edff'

                      const openEventsForDay =
                        () => {
                          setSelectedDay(day)
                          clearEventForm()
                        }

                      return (
                        <button
                          className="month-time-event"
                          type="button"
                          key={calendarEvent.id}
                          style={{
                            background,
                            color:
                              getTextColor(
                                textReferenceColor
                              ),
                          }}
                          onClick={(event) => {
                            event.stopPropagation()

                            if (
                              showCalendarSidebar
                            ) {
                              transitionMonthSidebar(
                                openEventsForDay
                              )
                              return
                            }

                            openEventsForDay()
                          }}
                        >
                          {calendarEvent.time && (
                            <span className="month-event-time">
                              {formatTime(
                                calendarEvent.time
                              )}
                            </span>
                          )}

                          <span className="month-event-title">
                            {calendarEvent.title}
                          </span>
                          

                        </button>
                      )
                    })}

                 {dayEvents.length > visibleDayEventCount && (
  <button
    type="button"
    className="month-more-events"
    onClick={(event) => {
      event.stopPropagation()

      const openEventsForDay = () => {
        setSelectedDay(day)
        clearEventForm()
      }

      if (showCalendarSidebar) {
        transitionMonthSidebar(
          openEventsForDay
        )
        return
      }

      openEventsForDay()
    }}
  >
    +{dayEvents.length - visibleDayEventCount} more
  </button>
)}
                </div>
              </div>
            )
          })}
        </div>

        {multiDayLaneCount > 0 && (
          <div
            className="month-week-multiday-layer"
            style={{
              height: `${
                multiDayLaneCount * 20
              }px`,
            }}
          >
            {multiDaySegments.map(
              (segment) => {
                const background =
                  getEventBackground(
                    segment.calendarEvent.people
                  )

                const textReferenceColor =
                  segment.calendarEvent.people[0]
                    ?.color ?? '#e8edff'

                const span =
                  segment.endColumn -
                  segment.startColumn +
                  1

                return (
  <button
    className="month-multiday-bar"
    type="button"
   key={`${segment.calendarEvent.id}-${segment.occurrenceStartDate}-${weekIndex}`}
    style={{
      left: `${
        (segment.startColumn / 7) * 100
      }%`,
      width: `${
        (span / 7) * 100
      }%`,
      top: `${segment.lane * 20}px`,
      background,
      color:
        getTextColor(
          textReferenceColor
        ),
      borderTopLeftRadius:
        segment.continuesBefore
          ? 0
          : 6,
      borderBottomLeftRadius:
        segment.continuesBefore
          ? 0
          : 6,
      borderTopRightRadius:
        segment.continuesAfter
          ? 0
          : 6,
      borderBottomRightRadius:
        segment.continuesAfter
          ? 0
          : 6,
    }}
    onClick={(event) => {
      event.stopPropagation()

      const bar =
        event.currentTarget.getBoundingClientRect()

      const clickRatio =
        bar.width > 0
          ? (event.clientX - bar.left) /
            bar.width
          : 0

      const clickedOffset = Math.min(
        span - 1,
        Math.max(
          0,
          Math.floor(clickRatio * span)
        )
      )

      const clickedDay =
        week[
          segment.startColumn +
            clickedOffset
        ]

      if (clickedDay === null) {
        return
      }

      const openEventsForDay = () => {
        setSelectedDay(clickedDay)
        clearEventForm()
      }

      if (showCalendarSidebar) {
        transitionMonthSidebar(
          openEventsForDay
        )
        return
      }

      openEventsForDay()
    }}
  >
    <span className="month-multiday-title">
      {segment.calendarEvent.title}
    </span>
  </button>
)
              }
            )}
          </div>
        )}
            </div>
    )
  })}
        </div>
      </div>
    )
  })}
</div>
  </div>
)}

{calendarView === 'week' && (
  <div
    className="week-pager"
    ref={weekPagerRef}
    onPointerDown={
      handleWeekPagerPointerDown
    }
    onPointerMove={
      handleWeekPagerPointerMove
    }
    onPointerUp={
      handleWeekPagerPointerUp
    }
    onPointerCancel={
      handleWeekPagerPointerCancel
    }
    onClickCapture={(event) => {
  if (suppressWeekPagerClick()) {
    event.preventDefault()
    event.stopPropagation()
  }
}}
  >
    <div
      className="week-pager-track"
      ref={weekPagerTrackRef}
      onTransitionEnd={(event) => {
        if (
          event.target !==
          event.currentTarget
        ) {
          return
        }

        finishWeekPagerTransition()
      }}
    >
      <div className="week-pager-page">
        {renderWeekBoard(
          previousWeekDates
        )}
      </div>

      <div className="week-pager-page">
        {renderWeekBoard(
          weekDates
        )}
      </div>

      <div className="week-pager-page">
        {renderWeekBoard(
          nextWeekDates
        )}
      </div>
    </div>
  </div>
)}

{calendarView === 'schedule' &&
  isMobileScheduleViewport && (
  <div className="mobile-schedule-view">
    

    <div
  className="mobile-schedule-pager"
  ref={mobileSchedulePagerRef}
  onScroll={(event) => {
    const pager =
      event.currentTarget
const width =
  pager.clientWidth

if (width > 0) {
  const visibleIndex =
    Math.max(
      0,
      Math.min(
        mobileScheduleBufferedDates.length -
          1,
        Math.round(
          pager.scrollLeft / width
        )
      )
    )

  const visibleDate =
    mobileScheduleBufferedDates[
      visibleIndex
    ]

  if (visibleDate) {
    positionMobileScheduleTimeline(
      visibleDate
    )
  }
}
    if (
      mobileScheduleScrollEndTimerRef.current !==
      null
    ) {
      window.clearTimeout(
        mobileScheduleScrollEndTimerRef.current
      )
    }

    mobileScheduleScrollEndTimerRef.current =
      window.setTimeout(() => {
        const width =
          pager.clientWidth

        if (width <= 0) {
          return
        }

        const index =
          Math.max(
            0,
            Math.min(
              mobileScheduleBufferedDates.length -
                1,
              Math.round(
                pager.scrollLeft / width
              )
            )
          )

        const targetDate =
          mobileScheduleBufferedDates[index]

        if (!targetDate) {
          return
        }

        const targetDateKey =
  getDateKeyFromDate(targetDate)



if (
  targetDateKey !==
  mobileScheduleDateKey
) {
  setWeekDate(
    new Date(targetDate)
  )
}
      }, 40)
    }}
  >
    <div className="mobile-schedule-track">
      {mobileScheduleBufferedDates.map(
        (targetDate) => {
          const targetDateKey =
            getDateKeyFromDate(targetDate)

          const isCurrentDate =
            targetDateKey ===
            mobileScheduleDateKey

          return (
           <div
  key={targetDateKey}
  data-mobile-schedule-date={
    targetDateKey
  }
  className={`mobile-schedule-page ${
    isCurrentDate
      ? 'mobile-schedule-page-current'
      : ''
  }`}
              aria-hidden={
                isCurrentDate
                  ? undefined
                  : true
              }
            >
              {renderMobileScheduleDay(
                targetDate
              )}
            </div>
          )
        }
      )}
    </div>
  </div>
  </div>
)}



{calendarView === 'schedule' &&
  !isMobileScheduleViewport && (
  <div className="schedule-view">
    <div
  className="schedule-scroll"
  ref={scheduleScrollRef}
  onScroll={handleScheduleScroll}
>
      <div
  className="schedule-canvas"
  style={{
    width: `${scheduleCanvasWidth}px`,
    minWidth: `${scheduleCanvasWidth}px`,
  }}
>
        <div
  className="schedule-header"
  style={{
    width: `${scheduleCanvasWidth}px`,
    minWidth: `${scheduleCanvasWidth}px`,
    gridTemplateColumns:
      `76px repeat(${scheduleDisplayDates.length}, ${scheduleDayWidth}px)`,
  }}
>
          <div className="schedule-time-spacer">
            <span>All Day</span>
          </div>

          {scheduleDisplayDates.map(
  (scheduleDay, columnIndex) => {
            const dateKey =
              getDateKeyFromDate(scheduleDay)

            const isToday =
              scheduleDay.getDate() ===
                today.getDate() &&
              scheduleDay.getMonth() ===
                today.getMonth() &&
              scheduleDay.getFullYear() ===
                today.getFullYear()

           const allDayEvents =
  events.filter(
    (calendarEvent) =>
      !calendarEvent.time &&
      !isMultiDayEvent(
        calendarEvent
      ) &&
      doesEventOccurOnDate(
        calendarEvent,
        dateKey
      )
  )

const dayMultiDaySegments =
  scheduleMultiDaySegments.filter(
    (segment) =>
      columnIndex >=
        segment.startColumn &&
      columnIndex <=
        segment.endColumn
  )
          const isAllDayExpanded =
  expandedScheduleAllDayDates.has(
    dateKey
  )

const totalAllDayEventCount =
  dayMultiDaySegments.length +
  allDayEvents.length

const collapsedVisibleEventCount =
  totalAllDayEventCount > 3
    ? 2
    : 3

const visibleDayMultiDaySegments =
  isAllDayExpanded
    ? dayMultiDaySegments
    : [...dayMultiDaySegments]
        .sort(
          (segmentA, segmentB) =>
            segmentA.lane -
            segmentB.lane
        )
        .slice(
          0,
          collapsedVisibleEventCount
        )

const remainingSingleDaySlots =
  Math.max(
    0,
    collapsedVisibleEventCount -
      visibleDayMultiDaySegments.length
  )

const visibleAllDayEvents =
  isAllDayExpanded
    ? allDayEvents
    : allDayEvents.slice(
        0,
        remainingSingleDaySlots
      )

const hiddenAllDayEventCount =
  totalAllDayEventCount -
  visibleDayMultiDaySegments.length -
  visibleAllDayEvents.length   
const visibleMultiDayLaneCount =
  visibleDayMultiDaySegments.reduce(
    (highestLane, segment) =>
      Math.max(
        highestLane,
        segment.lane + 1
      ),
    0
  )
            return (
              <div
                className={`schedule-day-header ${
                  isToday
                    ? 'schedule-day-header-today'
                    : ''
                }`}
                key={dateKey}
              >
                <span>
                  {scheduleDay.toLocaleDateString(
                    'en-US',
                    {
                      weekday: 'short',
                    }
                  )}
                </span>

                <strong>
                  {scheduleDay.getDate()}
                </strong>
{visibleMultiDayLaneCount > 0 && (
  <div
    className="schedule-multiday-events"
    style={{
      height:
        `${
          visibleMultiDayLaneCount *
32
        }px`,
    }}
  >
    {visibleDayMultiDaySegments.map(
      (segment) => {
        const startsVisiblePiece =
          columnIndex ===
          segment.startColumn

        const endsVisiblePiece =
          columnIndex ===
          segment.endColumn

        const hasTrueStart =
          startsVisiblePiece &&
          !segment.continuesBefore

        const hasTrueEnd =
          endsVisiblePiece &&
          !segment.continuesAfter

        const showTitle =
          startsVisiblePiece

        return (
          <button
            type="button"
            className="schedule-multiday-piece"
            key={`schedule-multiday-${segment.calendarEvent.id}-${segment.occurrenceStartDate}-${columnIndex}`}
            aria-label={
              segment.calendarEvent.title
            }
            style={{
              top:
                `${
                  segment.lane * 32
                }px`,
              left: hasTrueStart
                ? '5px'
                : '-1px',
              right: hasTrueEnd
                ? '5px'
                : '-1px',
              background:
                getEventBackground(
                  segment.calendarEvent
                    .people
                ),
              borderTopLeftRadius:
                hasTrueStart ? 6 : 0,
              borderBottomLeftRadius:
                hasTrueStart ? 6 : 0,
              borderTopRightRadius:
                hasTrueEnd ? 6 : 0,
              borderBottomRightRadius:
                hasTrueEnd ? 6 : 0,
            }}
            onClick={(event) => {
              event.stopPropagation()

              openEventDetails(
                segment.calendarEvent,
                segment.occurrenceStartDate
              )
            }}
          >
            {showTitle &&
              segment.calendarEvent.title}
          </button>
        )
      }
    )}
  </div>
)}
                <div className="schedule-all-day-events">
                  {visibleAllDayEvents
                    .map(
                      (calendarEvent) => (
                        <button
                          type="button"
                          className="schedule-all-day-event"
                          key={`${calendarEvent.id}-${dateKey}`}
                          style={{
                            background:
                              getEventBackground(
                                calendarEvent.people
                              ),
                          }}
                          onClick={() =>
                            openEventDetails(
                              calendarEvent,
                              dateKey
                            )
                          }
                        >
                          {calendarEvent.title}
                        </button>
                      )
                    )}

                  {totalAllDayEventCount > 3 && (
  <button
    type="button"
    className="schedule-more-events"
    onClick={() => {
      setExpandedScheduleAllDayDates(
        (currentDates) => {
          const nextDates =
            new Set(currentDates)

          if (
            nextDates.has(dateKey)
          ) {
            nextDates.delete(dateKey)
          } else {
            nextDates.add(dateKey)
          }

          return nextDates
        }
      )
    }}
  >
    {isAllDayExpanded
  ? 'Show less'
  : `+${hiddenAllDayEventCount} more`}
  </button>
)}
                </div>
              </div>
            )
                    }
        )}
        </div>

        <div
  className="schedule-grid"
  style={{
    width: `${scheduleCanvasWidth}px`,
    minWidth: `${scheduleCanvasWidth}px`,
    gridTemplateColumns:
      `76px repeat(${scheduleDisplayDates.length}, ${scheduleDayWidth}px)`,
  }}
>
          <div className="schedule-time-column">
            <div
  className="schedule-current-time"
  style={{
    top:
      `${
        (dayTimelineNowMinutes /
          60) *
        56
      }px`,
  }}
>
  <span className="schedule-current-time-label">
    {dayTimelineNow.toLocaleTimeString(
      'en-US',
      {
        hour: 'numeric',
        minute: '2-digit',
      }
    )}
  </span>

  <span className="schedule-current-time-dot" />
</div>
            {Array.from(
              { length: 24 },
              (_, hour) => hour
            ).map((hour) => (
              <div
                className="schedule-time-label"
                key={hour}
              >
                {new Date(
                  2026,
                  0,
                  1,
                  hour
                ).toLocaleTimeString(
                  'en-US',
                  {
                    hour: 'numeric',
                  }
                )}
              </div>
            ))}
          </div>

          {scheduleDisplayDates.map((scheduleDay) => {
            const dateKey =
              getDateKeyFromDate(scheduleDay)

            const isToday =
              scheduleDay.getDate() ===
                today.getDate() &&
              scheduleDay.getMonth() ===
                today.getMonth() &&
              scheduleDay.getFullYear() ===
                today.getFullYear()

           const timedEventLayouts =
  getScheduleTimedEventLayouts(
    scheduleDay
  )

            return (
             <div
  className={`schedule-day-column ${
    isToday
      ? 'schedule-day-column-today'
      : ''
  }`}
  key={dateKey}
  onDoubleClick={(event) => {
    if (
      (
        event.target as HTMLElement
      ).closest('.schedule-event')
    ) {
      return
    }

    const columnRect =
      event.currentTarget.getBoundingClientRect()

    const clickY =
      event.clientY - columnRect.top

    const rawMinutes =
      (clickY / 56) * 60

    const roundedMinutes =
      Math.max(
        0,
        Math.min(
          1439,
          Math.round(
            rawMinutes / 15
          ) * 15
        )
      )

    const hour =
      Math.floor(
        roundedMinutes / 60
      )

    const minute =
      roundedMinutes % 60

    const eventTimeValue =
      `${String(hour).padStart(
        2,
        '0'
      )}:${String(minute).padStart(
        2,
        '0'
      )}`

    clearEventForm()

    setEventStartDate(dateKey)

    setEventStartDateText(
      formatDateKeyForText(
        dateKey
      )
    )

    setEventAllDay(false)
    setEventTime(eventTimeValue)

    setViewDate(
      new Date(
        scheduleDay.getFullYear(),
        scheduleDay.getMonth(),
        1
      )
    )

    setWeekDate(
      new Date(scheduleDay)
    )

    setSelectedDay(
      scheduleDay.getDate()
    )

    setIsAddingEvent(true)
  }}
>
                {Array.from(
                  { length: 24 },
                  (_, index) => (
                    <div
                      className="schedule-hour-line"
                      key={index}
                    />
                  )
                )}

                {timedEventLayouts.map(
  (timedEventLayout) => {
    const top =
      (timedEventLayout.visibleStart /
        60) *
      56

    const height =
      Math.max(
        28,
        ((timedEventLayout.visibleEnd -
          timedEventLayout.visibleStart) /
          60) *
          56
      )

    return (
      <button
        type="button"
        className="schedule-event"
        key={`${timedEventLayout.calendarEvent.id}-${timedEventLayout.dateKey}`}
        style={{
          top: `${top}px`,
          height: `${height}px`,
          left: `${timedEventLayout.leftPx}px`,
          width: `${timedEventLayout.widthPx}px`,
          right: 'auto',
          background:
            getEventBackground(
              timedEventLayout.calendarEvent.people
            ),
        }}
        onClick={() =>
          openEventDetails(
            timedEventLayout.calendarEvent,
            timedEventLayout.dateKey
          )
        }
      >
        <strong>
  {
    timedEventLayout.calendarEvent.title
  }
</strong>

<span className="schedule-event-time">
  {formatTime(
    timedEventLayout.calendarEvent.time!
  )}

  {timedEventLayout.calendarEvent.endTime &&
    ` – ${formatTime(
      timedEventLayout.calendarEvent.endTime
    )}`}
</span>
      </button>
    )
  }
)}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  </div>
)}
{calendarView === 'day' && (
 <div
  className="day-pager"
  ref={dayPagerRef}
  onPointerDown={(event) => {
    if (
      window.matchMedia(
        '(min-width: 761px)'
      ).matches
    ) {
      return
    }

    handleWeekPagerPointerDown(event)
  }}
  onPointerMove={(event) => {
    if (
      window.matchMedia(
        '(min-width: 761px)'
      ).matches
    ) {
      return
    }

    handleWeekPagerPointerMove(event)
  }}
  onPointerUp={(event) => {
    if (
      window.matchMedia(
        '(min-width: 761px)'
      ).matches
    ) {
      return
    }

    handleWeekPagerPointerUp(event)
  }}
  onPointerCancel={(event) => {
    if (
      window.matchMedia(
        '(min-width: 761px)'
      ).matches
    ) {
      return
    }

    handleWeekPagerPointerCancel(event)
  }}
  onClickCapture={(event) => {
    if (
      window.matchMedia(
        '(min-width: 761px)'
      ).matches
    ) {
      return
    }

    if (suppressWeekPagerClick()) {
      event.preventDefault()
      event.stopPropagation()
    }
  }}
  onScroll={(event) => {
    if (
      !window.matchMedia(
        '(min-width: 761px)'
      ).matches
    ) {
      return
    }

    const pager = event.currentTarget

    if (
      dayPagerScrollEndTimerRef.current !==
      null
    ) {
      window.clearTimeout(
        dayPagerScrollEndTimerRef.current
      )
    }

    dayPagerScrollEndTimerRef.current =
      window.setTimeout(() => {
        dayPagerScrollEndTimerRef.current =
          null

        const width = pager.clientWidth

        if (width <= 0) {
          return
        }

        const index = Math.round(
          pager.scrollLeft / width
        )

        if (index === 1) {
          return
        }

        const direction =
          index < 1 ? -1 : 1

        setWeekDate((currentDate) =>
          new Date(
            currentDate.getFullYear(),
            currentDate.getMonth(),
            currentDate.getDate() +
              direction
          )
        )

        setSelectedDay(null)
        clearEventForm()
      }, 40)
  }}
>
    <div
      className="day-pager-track"
      ref={dayPagerTrackRef}
      onTransitionEnd={(event) => {
        if (
          event.target !==
          event.currentTarget
        ) {
          return
        }

        finishWeekPagerTransition()
      }}
    >
      <div
        className="day-pager-page"
        aria-hidden="true"
      >
        {renderDaySwipePreview(
  previousDayViewDate
)}
      </div>

      <div className="day-pager-page">
        <div className="day-view">
         

    <div className="day-dashboard">
      <aside className="day-left-panel">
        <section className="day-panel-card day-mini-calendar-card">
  <div className="day-mini-calendar-heading">
    <strong>
      {dayViewDate.toLocaleDateString(
        'en-US',
        {
          month: 'long',
        }
      )}
    </strong>

    <span>
      {dayViewDate.getFullYear()}
    </span>
  </div>

  <div className="day-mini-weekdays">
    {[
      'S',
      'M',
      'T',
      'W',
      'T',
      'F',
      'S',
    ].map((weekday, index) => (
      <span
        key={`${weekday}-${index}`}
      >
        {weekday}
      </span>
    ))}
  </div>

  <div className="day-mini-calendar-grid">
    {dayMiniMonthWeeks.flatMap(
      (week, weekIndex) =>
        week.map(
          (day, dayIndex) => {
            if (day === null) {
              return (
                <span
                  className="day-mini-date day-mini-date-empty"
                  key={`empty-${weekIndex}-${dayIndex}`}
                />
              )
            }

            const miniDate =
              new Date(
                dayViewDate.getFullYear(),
                dayViewDate.getMonth(),
                day
              )

            const isSelected =
              day ===
              dayViewDate.getDate()

            const isToday =
              miniDate.getFullYear() ===
                today.getFullYear() &&
              miniDate.getMonth() ===
                today.getMonth() &&
              miniDate.getDate() ===
                today.getDate()

            return (
              <button
                type="button"
                className={[
                  'day-mini-date',
                  isSelected
                    ? 'day-mini-date-selected'
                    : '',
                  isToday
                    ? 'day-mini-date-today'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={day}
                onClick={(event) => {
                  event.stopPropagation()

                  setWeekDate(miniDate)

                  setViewDate(
                    new Date(
                      miniDate.getFullYear(),
                      miniDate.getMonth(),
                      1
                    )
                  )

                  setSelectedDay(day)

                  clearEventForm()
                }}
              >
                {day}
              </button>
            )
          }
        )
    )}
  </div>
</section>
        <section className="day-panel-card">
          <div className="day-panel-heading">
            <strong>Today's Events</strong>

            <span>
              {dayViewEvents.length}
            </span>
          </div>

          <div className="day-summary-events">
            {dayViewEvents.map(
              (calendarEvent) => {
                const background =
                  getEventBackground(
                    calendarEvent.people
                  )

                return (
                  <button
                    type="button"
                    className="day-summary-event"
                    key={`summary-${calendarEvent.id}`}
                    onClick={(event) => {
                      event.stopPropagation()

                      openEventDetails(
                        calendarEvent,
                        dayViewDateKey
                      )
                    }}
                  >
                    <span
                      className="day-summary-event-color"
                      style={{
                        background,
                      }}
                    />

                    <span className="day-summary-event-text">
                      <strong>
                        {calendarEvent.title}
                      </strong>

                      <small>
                        {calendarEvent.time
                          ? calendarEvent.endTime
                            ? `${formatTime(
                                calendarEvent.time
                              )} – ${formatTime(
                                calendarEvent.endTime
                              )}`
                            : formatTime(
                                calendarEvent.time
                              )
                          : 'All day'}
                      </small>
                    </span>
                  </button>
                )
              }
            )}
          </div>
        </section>
      </aside>

     <main className="day-center-panel">
      
 <div
  className="day-timeline-scroll"
  ref={dayTimelineScrollRef}
>
    <div className="day-timeline-grid">
      {Array.from(
        { length: 24 },
        (_, hour) => hour
      ).map((hour) => (
        <div
          className="day-timeline-hour"
          key={hour}
        >
          <span className="day-timeline-hour-label">
            {new Date(
              2026,
              0,
              1,
              hour
            ).toLocaleTimeString(
              'en-US',
              {
                hour: 'numeric',
              }
            )}
          </span>
        </div>
      ))}
{dayViewIsToday && (
  <div
    className="day-current-time"
    style={{
      top:
        `${
          (dayTimelineNowMinutes /
            60) *
          56
        }px`,
    }}
  >
    <span className="day-current-time-label">
      {dayTimelineNow.toLocaleTimeString(
        'en-US',
        {
          hour: 'numeric',
          minute: '2-digit',
        }
      )}
    </span>

    <span className="day-current-time-dot" />

    <span className="day-current-time-line" />
  </div>
)}
<div className="day-timeline-events-layer">
      {getScheduleTimedEventLayouts(
  dayViewDate
)
  .filter(
    (timedEventLayout) =>
      !isMultiDayEvent(
        timedEventLayout.calendarEvent
      )
  )
  .map(
    (timedEventLayout) => {
      const calendarEvent =
        timedEventLayout.calendarEvent

      const eventTop =
        (timedEventLayout.visibleStart /
          60) *
        56

      const eventHeight =
        Math.max(
          42,
          ((timedEventLayout.visibleEnd -
            timedEventLayout.visibleStart) /
            60) *
            56 -
            6
        )

      const layoutUsableWidth =
        scheduleDayWidth - 10

      const leftPercent =
        layoutUsableWidth > 0
          ? ((timedEventLayout.leftPx -
              5) /
              layoutUsableWidth) *
            100
          : 0

      const widthPercent =
        layoutUsableWidth > 0
          ? (timedEventLayout.widthPx /
              layoutUsableWidth) *
            100
          : 100

      const background =
        getEventBackground(
          calendarEvent.people
        )

      return (
        <button
          type="button"
          className="day-timeline-event"
          key={`timeline-${calendarEvent.id}`}
          style={{
            top: `${eventTop}px`,
            height: `${eventHeight}px`,
            left: `${leftPercent}%`,
            width: `${widthPercent}%`,
            right: 'auto',
            background,
          }}
          onClick={(event) => {
            event.stopPropagation()

            openEventDetails(
              calendarEvent,
              dayViewDateKey
            )
          }}
        >
          <div className="day-timeline-event-top">
            <strong>
              {calendarEvent.title}
            </strong>

            {calendarEvent.location && (
              <span>
                {calendarEvent.location}
              </span>
            )}
          </div>

          <div className="day-timeline-event-bottom">
            <span>
              {formatTime(
                calendarEvent.time!
              )}

              {calendarEvent.endTime &&
                ` – ${formatTime(
                  calendarEvent.endTime
                )}`}
            </span>

            <CompactEventWeather
              location={
                calendarEvent.location
              }
              date={dayViewDateKey}
              time={
                calendarEvent.time
              }
            />
          </div>
        </button>
      )
    }
  )}
      </div>
    </div>
  </div>

  {dayViewMeal && (
    <div
      className="day-timeline-dinner"
      onClick={(event) => {
        event.stopPropagation()

        setSelectedDay(
          dayViewDate.getDate()
        )
      }}
    >
      <span className="calendar-dinner-icon">
        🍽️
      </span>

      <span className="calendar-dinner-text">
        {dayViewMeal.dinner}
      </span>
    </div>
  )}
</main>

      <aside className="day-right-panel">
  <DayWeather
    date={dayViewDateKey}
  />

  <button
    type="button"
    className="day-add-event-button"
    onClick={(event) => {
      event.stopPropagation()

      clearEventForm()

setEventStartDate(dayViewDateKey)

setEventStartDateText(
  formatDateKeyForText(
    dayViewDateKey
  )
)

setViewDate(
        new Date(
          dayViewDate.getFullYear(),
          dayViewDate.getMonth(),
          1
        )
      )

      setWeekDate(dayViewDate)

      setSelectedDay(
        dayViewDate.getDate()
      )

      setIsAddingEvent(true)
    }}
  >
    + Add Event
  </button>

  <section className="day-notes-card">
    <div className="day-notes-heading">
      <strong>
        {dayViewDateKey ===
        getDateKeyFromDate(today)
          ? 'Notes for Today'
          : 'Notes for This Day'}
      </strong>

      <span>
        {dayViewDate.toLocaleDateString(
          'en-US',
          {
            month: 'short',
            day: 'numeric',
          }
        )}
      </span>
    </div>

    {dayNoteLoading ? (
      <div className="day-notes-status">
        Loading note...
      </div>
    ) : (
      <>
        <textarea
          className="day-notes-input"
          value={dayNote}
          maxLength={5000}
          placeholder="Add a note for this day..."
          onChange={(event) => {
            setDayNote(
              event.target.value
            )

            if (dayNoteError) {
              setDayNoteError('')
            }
          }}
          onPointerDown={(event) => {
            event.stopPropagation()
          }}
        />

        {dayNoteError && (
          <div className="day-notes-error">
            {dayNoteError}
          </div>
        )}

        <button
          type="button"
          className="day-notes-save"
          disabled={dayNoteSaving}
          onPointerDown={(event) => {
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.stopPropagation()
            void saveDayNote()
          }}
        >
          {dayNoteSaving
            ? 'Saving...'
            : 'Save Note'}
        </button>
      </>
    )}
   </section>
</aside>
        </div>
      </div>
    </div>

    <div
      className="day-pager-page"
      aria-hidden="true"
    >
        {renderDaySwipePreview(
    nextDayViewDate
  )}
    </div>
  </div>
</div>
)}
          </div>

       {createPortal(
  <div className="event-modal-portal">
    <aside
      className={`sidebar ${
        showEventModal
          ? 'event-modal-host'
          : ''
      }`}
    >   
  {showEventModal && (
    <button
      className="event-modal-backdrop"
      type="button"
      aria-label="Close event window"
     onClick={closeEventModal}
    />
  )}

  <div
    className={`card event-modal-card ${
  showEventModal
    ? eventModalClosing
      ? 'event-modal-card-closing'
      : 'event-modal-card-open'
    : 'event-modal-card-hidden'
}`}
onClick={(event) => {
  if (recurringAction === null) {
    return
  }

  const clickedElement =
    event.target as HTMLElement

  if (
  clickedElement.closest(
    '.recurring-action-popover'
  )
) {
  return
}

  setRecurringAction(null)
}}
  >
              
<div
  className={`sidebar-content-fade ${
    sidebarContentChanging
      ? 'sidebar-content-fade-out'
      : ''
  }`}
>
        {viewingCalendarEvent !== null ? (
  <div className="event-details-panel">
    <div className="event-details-header">
      <div>
        <span className="event-details-label">
          Event
        </span>

        <h2>
          {viewingCalendarEvent.title}
        </h2>
      </div>

      <button
        type="button"
        className="event-details-close"
        aria-label="Close event details"
        onClick={closeEventModal}
      >
        ×
      </button>
    </div>

    <div className="event-details-section">
      {viewingStartDate !== null && (
        <div className="event-details-row">
          <span className="event-details-row-label">
            Date
          </span>

          <strong>
            {new Date(
              `${viewingStartDate}T00:00:00`
            ).toLocaleDateString(
              'en-US',
              {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              }
            )}

            {viewingEndDate !== null &&
              viewingEndDate !==
                viewingStartDate && (
                <>
                  {' – '}
                  {new Date(
                    `${viewingEndDate}T00:00:00`
                  ).toLocaleDateString(
                    'en-US',
                    {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    }
                  )}
                </>
              )}
          </strong>
        </div>
      )}

      <div className="event-details-row">
        <span className="event-details-row-label">
          Time
        </span>

        <strong>
          {viewingCalendarEvent.time
            ? viewingCalendarEvent.endTime
              ? `${formatTime(
                  viewingCalendarEvent.time
                )} – ${formatTime(
                  viewingCalendarEvent.endTime
                )}`
              : formatTime(
                  viewingCalendarEvent.time
                )
            : 'All Day'}
        </strong>
      </div>

      <div className="event-details-row">
        <EventWeather
  location={viewingCalendarEvent.location}
  date={viewingStartDate}
  time={viewingCalendarEvent.time}
/>
        <span className="event-details-row-label">
          Repeat
        </span>

        <strong>
  {viewingCalendarEvent.repeatUnit &&
  viewingCalendarEvent.repeatUnit !== 'none'
    ? `Every ${
        viewingCalendarEvent.repeatInterval ?? 1
      } ${
        viewingCalendarEvent.repeatUnit
      }${
        (viewingCalendarEvent.repeatInterval ?? 1) === 1
          ? ''
          : 's'
      }`
    : 'Does not repeat'}
</strong>
      </div>
    </div>

    {viewingCalendarEvent.people.length > 0 && (
      <div className="event-details-section">
        <span className="event-details-section-title">
          People
        </span>

        <div className="event-details-people">
          {viewingCalendarEvent.people.map(
            (person) => (
              <div
                className="event-details-person"
                key={person.id}
              >
                {renderPersonAvatar(
                  person,
                  'event-details-avatar'
                )}

                <span>
                  {person.name}
                </span>
              </div>
            )
          )}
        </div>
      </div>
    )}

{viewingCalendarEvent.location && (
  <div className="event-details-section">
    <span className="event-details-section-title">
      Location
    </span>

    <p className="event-details-notes">
      {viewingCalendarEvent.location}
    </p>
  </div>
)}

    {viewingCalendarEvent.notes && (
      <div className="event-details-section">
        <span className="event-details-section-title">
          Description
        </span>

        <p className="event-details-notes">
          {viewingCalendarEvent.notes}
        </p>
      </div>
    )}

    <div className="event-details-actions">
  <button
    type="button"
    className="event-details-delete-button"
    aria-label="Delete event"
   onPointerDown={(event) => {
  event.stopPropagation()
}}
onClick={(event) => {
  event.preventDefault()
  event.stopPropagation()
  setDetailsDeleteConfirmOpen(true)
}}
  >
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </button>

  <button
    type="button"
    className="event-details-duplicate-button"
    aria-label="Duplicate event"
    onClick={() => {
      if (viewingStartDate !== null) {
        startDuplicatingEvent(viewingCalendarEvent, viewingStartDate)
      }
    }}
  >
    Duplicate
  </button>

  <button
    type="button"
    className="event-details-edit-button"
    onClick={() => {
      if (viewingDateKey === null) {
        return
      }

      const eventToEdit =
        viewingCalendarEvent

      setViewingEventId(null)
      setViewingOccurrenceDate(null)
      setDetailsDeleteConfirmOpen(false)

      startEditingEvent(
        eventToEdit,
        viewingDateKey
      )
    }}
  >
    Edit Event
  </button>
</div>

{detailsDeleteConfirmOpen && (
  <div className="event-details-delete-confirm">
    <h3>Delete Event?</h3>

    <p>Deleting events cannot be undone.</p>

    {viewingCalendarEvent.batchId ? (
      <div className="event-details-delete-options">
        <button
          type="button"
          onClick={deleteEvent}
        >
          Delete This Event
        </button>

        <button
          type="button"
          className="event-details-delete-danger"
          onClick={deleteEventBatch}
        >
          Delete All Selected Dates
        </button>

        <button
          type="button"
          className="event-details-delete-cancel"
          onClick={() => {
            setDetailsDeleteConfirmOpen(false)
          }}
        >
          Cancel
        </button>
      </div>
    ) : viewingCalendarEvent.repeatUnit &&
      viewingCalendarEvent.repeatUnit !== 'none' ? (
      <div className="event-details-delete-options">
        <button
          type="button"
          onClick={deleteThisEventOnly}
        >
          This Event Only
        </button>

        <button
          type="button"
          onClick={deleteThisAndFutureEvents}
        >
          This and Future
        </button>

        <button
          type="button"
          className="event-details-delete-danger"
          onClick={deleteEvent}
        >
          Entire Series
        </button>

        <button
          type="button"
          className="event-details-delete-cancel"
          onClick={() => {
            setDetailsDeleteConfirmOpen(false)
          }}
        >
          Cancel
        </button>
      </div>
    ) : (
      <div className="event-details-delete-confirm-actions">
        <button
          type="button"
          className="event-details-delete-cancel"
          onClick={() => {
            setDetailsDeleteConfirmOpen(false)
          }}
        >
          Cancel
        </button>

        <button
          type="button"
          className="event-details-delete-danger"
          onClick={deleteEvent}
        >
          Delete Event
        </button>
      </div>
    )}
  </div>
)}

  </div>
) : calendarView === 'month' &&
editingEventId === null &&
!isAddingEvent ? (      
  <>
    <div className="month-events-popup-header">
  <button
    type="button"
    className="month-events-back-button"
    onClick={() => {
      transitionMonthSidebar(() => {
  setMonthEventsOpen(false)
  setSelectedDay(null)
  clearEventForm()
})
    }}
  >
    <span aria-hidden="true">‹</span>
    Back
  </button>

  <h2>Events</h2>

  <button
    type="button"
    className="month-events-schedule-button"
    onClick={() => {
      changeCalendarView('schedule')
    }}
  >
    Schedule
  </button>
</div>

   {selectedDay !== null && (
  <p className="month-sidebar-date">
    {new Date(year, month, selectedDay).toLocaleDateString(
      undefined,
      {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }
    )}
  </p>
)}

    <div
  className={`month-selected-events ${
    monthSelectedEvents.length > 5
      ? 'month-selected-events-scroll'
      : ''
  }`}
>
      {monthSelectedEvents.map((calendarEvent) => {
        const background =
          getEventBackground(calendarEvent.people)

        const textReferenceColor =
          calendarEvent.people[0]?.color ?? '#e8edff'
const selectedDateKey =
  selectedDay !== null
    ? getDateKey(selectedDay)
    : calendarEvent.date

const occurrenceStartDate =
  getOccurrenceStartForDate(
    calendarEvent,
    selectedDateKey
  ) ?? calendarEvent.date

const occurrenceEndDate =
  addDaysToDateKey(
    occurrenceStartDate,
    getEventDurationDays(calendarEvent)
  )
        return (
          <button
            className="event month-sidebar-event"
            type="button"
            key={calendarEvent.id}
            style={{
              background,
              color: getTextColor(textReferenceColor),
            }}
            onClick={() => {
  if (selectedDay === null) return

  const selectedDate =
    getDateKey(selectedDay)

  const occurrenceStartDate =
    getOccurrenceStartForDate(
      calendarEvent,
      selectedDate
    ) ?? selectedDate

  transitionMonthSidebar(() => {
  openEventDetails(
    calendarEvent,
    occurrenceStartDate
  )
})
}}
          >
            <div className="month-sidebar-event-main">
  <div className="month-sidebar-event-time">
  {calendarEvent.time
    ? calendarEvent.endTime
      ? `${formatTime(calendarEvent.time)} – ${formatTime(calendarEvent.endTime)}`
      : formatTime(calendarEvent.time)
    : 'All Day'}
</div>

  <div className="month-sidebar-event-title">
    {calendarEvent.title}
  </div>
{isMultiDayEvent(calendarEvent) && (
  <div className="month-sidebar-event-range">
    {new Date(
      `${occurrenceStartDate}T00:00:00`
    ).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })}
    {' – '}
    {new Date(
      `${occurrenceEndDate}T00:00:00`
    ).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })}
  </div>
)}
</div>


          </button>
        )
      })}
    </div>
  </>
) : (
  <>
          <div className="event-modal-heading-row">
  <h2>
    {editingEventId !== null
      ? 'Edit Event'
      : duplicateSourceEventId !== null
        ? 'Duplicate Event'
        : 'Add Event'}
  </h2>

  {people.length > 0 && (
    <div className="event-header-people">
  <div className="family-slider event-header-family-slider">
    {people.map((person) => {
      const isSelected =
        selectedPersonIds.includes(person.id)

      return (
        <button
          type="button"
          key={person.id}
          className={`family-slider-card ${
            isSelected
              ? 'family-slider-card-selected'
              : ''
          }`}
         style={{
  background:
    softenEventColor(person.color),
  border: isSelected
    ? `3px solid color-mix(in srgb, ${person.color} 55%, black)`
    : '1px solid rgba(0, 0, 0, 0.05)',
  outline: 'none',
}}
          onClick={() =>
            togglePersonForEvent(person.id)
          }
        >
          {renderPersonAvatar(
            person,
            'family-slider-avatar'
          )}

          <span className="family-slider-name">
            {person.name}
          </span>
        </button>
      )
    })}
  </div>
</div>
  )}
</div>    
              {selectedDay === null ? (
                <p>Click a day on the calendar first.</p>
              ) : (
                <>
                 {editingEventId !== null && (
  <p className="event-selected-date">
  {editingEventId !== null ? (
    (() => {
      const editingCalendarEvent = events.find(
        (calendarEvent) =>
          calendarEvent.id === editingEventId
      )

      if (!editingCalendarEvent) {
        return null
      }

      const clickedOccurrenceDate =
        editingOccurrenceDate ??
        editingCalendarEvent.date

      const occurrenceStartDate =
        getOccurrenceStartForDate(
          editingCalendarEvent,
          clickedOccurrenceDate
        ) ?? clickedOccurrenceDate

      const occurrenceEndDate =
        addDaysToDateKey(
          occurrenceStartDate,
          getEventDurationDays(
            editingCalendarEvent
          )
        )

      const startText =
        new Date(
          `${occurrenceStartDate}T00:00:00`
        ).toLocaleDateString(undefined, {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })

      if (
        occurrenceEndDate ===
        occurrenceStartDate
      ) {
        return (
          <>
            Date: <strong>{startText}</strong>
          </>
        )
      }

      const endText =
        new Date(
          `${occurrenceEndDate}T00:00:00`
        ).toLocaleDateString(undefined, {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })

      return (
        <>
          Dates:{' '}
          <strong>
            {startText} – {endText}
          </strong>
        </>
      )
    })()
  ) : (
    <>
      Date:{' '}
      <strong>
        {monthName} {selectedDay}, {year}
      </strong>
    </>
  )}
  </p>
)}

                  {duplicateSourceEventId !== null && (
                    <p className="event-duplicate-notice">
                      Change the date or time, then create your copy.
                      The original stays unchanged. Recurring events
                      are copied as one non-repeating event.
                    </p>
                  )}
                  <form
                    className="event-form"
                    onSubmit={addOrUpdateEvent}
                  >
                    <label className="event-field">
                      Title
                      <input
                        className={`event-input ${
  eventTitleError
    ? 'event-date-error'
    : ''
}`}
                        type="text"
                        placeholder="Example: Dentist"
                        value={eventTitle}
                        onChange={(event) =>
                          setEventTitle(event.target.value)
                        }
                      />
                    </label>
<label className="event-field">
  Location / Address
  <input
    className="event-input"
    type="text"
    placeholder="Example: 123 Main St, Houston, TX 77002"
    value={eventLocation}
    onChange={(event) =>
      setEventLocation(event.target.value)
    }
  />
  <span className="small-message">
    Include a ZIP code to show weather for this event.
  </span>
</label>
                   <div className="event-date-time-row">
<label className="event-field event-time-field">
  Start Time

  <input
    className={`event-input ${
      eventAllDay
        ? 'event-time-all-day'
        : ''
    } ${
      eventTimeError
        ? 'event-time-error'
        : ''
    }`}
    type="time"
    value={eventTime}
    onClick={() => {
      if (eventAllDay) {
        setEventAllDay(false)
      }
    }}
    onFocus={() => {
      if (eventAllDay) {
        setEventAllDay(false)
      }
    }}
    onChange={(event) =>
      setEventTime(event.target.value)
    }
  />

  <span className="event-all-day">
    <input
      type="checkbox"
      checked={eventAllDay}
      onChange={(event) =>
        setEventAllDay(
          event.target.checked
        )
      }
    />
    <span>All Day</span>
  </span>
</label>
<label className="event-field event-time-field">
  End Time
  <input
    className={`event-input ${
  eventAllDay
    ? 'event-time-all-day'
    : ''
} ${
  eventTimeError
    ? 'event-time-error'
    : ''
}`}
    type="time"
    value={eventEndTime}
    onClick={() => {
      if (eventAllDay) {
        setEventAllDay(false)
      }
    }}
    onFocus={() => {
      if (eventAllDay) {
        setEventAllDay(false)
      }
    }}
    onChange={(event) =>
      setEventEndTime(event.target.value)
    }
  />
  <span className="small-message">
  Optional
</span>
</label>

{editingEventId === null && (
  <div className="event-date-mode-section">
    <div className="event-date-mode-label">
      Date Selection
    </div>

    <div className="event-date-mode-buttons">
      <button
        type="button"
        className={`event-date-mode-button ${
          eventDateMode === 'single'
            ? 'event-date-mode-button-active'
            : ''
        }`}
        onClick={() => {
          setEventDateMode('single')
          setEventMultipleDates([])
        }}
      >
        Single Date
      </button>

      <button
        type="button"
        className={`event-date-mode-button ${
          eventDateMode === 'multiple'
            ? 'event-date-mode-button-active'
            : ''
        }`}
        onClick={() => {
  setEventDateMode('multiple')

  const startingDates =
    eventMultipleDates.length > 0
      ? eventMultipleDates
      : eventStartDate
        ? [eventStartDate]
        : []

  setPendingMultipleDates(
    startingDates
  )

  const startingDate =
    startingDates[0]
      ? new Date(
          `${startingDates[0]}T00:00:00`
        )
      : today

  setMultipleDateCalendarMonth(
    new Date(
      startingDate.getFullYear(),
      startingDate.getMonth(),
      1
    )
  )

  setEventEndDate('')
  setEventEndDateText('')
  setRepeatUnit('none')

  setMultipleDatePickerOpen(true)
}}
      >
        Multiple Dates
      </button>
    </div>

    {eventDateMode === 'multiple' && (
  <div className="event-multiple-date-summary">
    <div>
      <strong>
        {eventMultipleDates.length}{' '}
        {eventMultipleDates.length === 1
          ? 'date selected'
          : 'dates selected'}
      </strong>

      <span>
        Choose separate dates for this event.
      </span>
    </div>

    <button
      type="button"
      className="event-multiple-date-change-button"
      onClick={() => {
        setPendingMultipleDates(
          eventMultipleDates
        )

        const startingDate =
          eventMultipleDates[0]
            ? new Date(
                `${eventMultipleDates[0]}T00:00:00`
              )
            : eventStartDate
              ? new Date(
                  `${eventStartDate}T00:00:00`
                )
              : today

        setMultipleDateCalendarMonth(
          new Date(
            startingDate.getFullYear(),
            startingDate.getMonth(),
            1
          )
        )

        setMultipleDatePickerOpen(true)
      }}
    >
      {eventMultipleDates.length > 0
        ? 'Change Dates'
        : 'Choose Dates'}
    </button>
  </div>
)}
  </div>
)}

 {(editingEventId !== null ||
  eventDateMode === 'single') && (
<label className="event-field">
  Start Date

  <div className="event-date-text-wrap">
    <input
      className={`event-input event-date-text-input ${
  eventStartDateError
    ? 'event-date-error'
    : ''
}`}
      type="text"
      inputMode="numeric"
      placeholder="MM/DD/YYYY"
      maxLength={10}
      value={eventStartDateText}
      onChange={(event) => {
        const value = event.target.value

        setEventStartDateText(value)

        const newStartDate =
          parseDateTextToDateKey(value)

        if (!newStartDate) {
          if (value.trim() === '') {
            setEventStartDate('')
          }

          return
        }

        const oldStartDate =
          eventStartDate ||
          getDateKey(selectedDay)

        if (
          eventEndDate &&
          oldStartDate
        ) {
          const durationDays =
            getDateDifferenceInDays(
              oldStartDate,
              eventEndDate
            )

          if (durationDays >= 0) {
            const newEndDate =
              addDaysToDateKey(
                newStartDate,
                durationDays
              )

            setEventEndDate(newEndDate)
            setEventEndDateText(
              formatDateKeyForText(
                newEndDate
              )
            )
          }
        }

        setEventStartDate(newStartDate)
      }}
    />

    <span className="event-date-picker-wrap">
      <span className="event-date-picker-icon">
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect
      x="3"
      y="5"
      width="18"
      height="16"
      rx="2"
    />
    <path d="M16 3v4" />
    <path d="M8 3v4" />
    <path d="M3 11h18" />
  </svg>
</span>

      <input
        className="event-date-picker-native"
        type="date"
        value={eventStartDate}
        onChange={(event) => {
          const newStartDate =
            event.target.value

          if (!newStartDate) {
            return
          }

          const oldStartDate =
            eventStartDate ||
            getDateKey(selectedDay)

          if (
            eventEndDate &&
            oldStartDate
          ) {
            const durationDays =
              getDateDifferenceInDays(
                oldStartDate,
                eventEndDate
              )

            if (durationDays >= 0) {
              const newEndDate =
                addDaysToDateKey(
                  newStartDate,
                  durationDays
                )

              setEventEndDate(newEndDate)
              setEventEndDateText(
                formatDateKeyForText(
                  newEndDate
                )
              )
            }
          }

          setEventStartDate(newStartDate)
          setEventStartDateText(
            formatDateKeyForText(
              newStartDate
            )
          )
        }}
        aria-label="Choose start date"
      />
    </span>
  </div>
</label>
)}

{(editingEventId !== null ||
  eventDateMode === 'single') && (
<label className="event-field">
  End Date

  <div className="event-date-text-wrap">
    <input
      className={`event-input event-date-text-input ${
  eventEndDateError
    ? 'event-date-error'
    : ''
}`}
      type="text"
      inputMode="numeric"
      placeholder="MM/DD/YYYY"
      maxLength={10}
      value={eventEndDateText}
      onChange={(event) => {
        const value = event.target.value

        setEventEndDateText(value)

        if (value.trim() === '') {
          setEventEndDate('')
          return
        }

        const parsedDate =
          parseDateTextToDateKey(value)

        if (parsedDate) {
          setEventEndDate(parsedDate)
        }
      }}
    />

    <span className="event-date-picker-wrap">
      <span className="event-date-picker-icon">
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect
      x="3"
      y="5"
      width="18"
      height="16"
      rx="2"
    />
    <path d="M16 3v4" />
    <path d="M8 3v4" />
    <path d="M3 11h18" />
  </svg>
</span>

      <input
        className="event-date-picker-native"
        type="date"
        value={eventEndDate}
        onChange={(event) => {
          const selectedDate =
            event.target.value

          setEventEndDate(selectedDate)

          setEventEndDateText(
            selectedDate
              ? formatDateKeyForText(
                  selectedDate
                )
              : ''
          )
        }}
        aria-label="Choose end date"
      />
    </span>
  </div>

  <span className="small-message">
  Optional
</span>
</label>
)}
</div>

                    
                    <div className="event-field">
                      <label>
                        Repeat
                        <select
                          className="event-input"
                          value={repeatUnit}
                          onChange={(event) => {
                            setRepeatUnit(event.target.value)

                           if (event.target.value === 'none') {
  setRepeatEndType('never')
  setRepeatEndDate('')
  setRepeatEndDateText('')
  setRepeatEndDateError(false)
  setRepeatCount(10)
}
                          }}
                        >
                          <option value="none">
                            Does not repeat
                          </option>
                          <option value="day">Days</option>
                          <option value="week">Weeks</option>
                          <option value="month">Months</option>
                          <option value="year">Years</option>
                        </select>
                      </label>
                    </div>

                    {repeatUnit !== 'none' && (
                      <div className="repeat-settings">
                        <label className="event-field">
                          Repeat Every
                          <div className="repeat-every-row">
                            <input
                              className="event-input repeat-number-input"
                              type="number"
                              min="1"
                              max="365"
                              value={repeatInterval}
                              onChange={(event) =>
                                setRepeatInterval(
                                  Math.max(
                                    1,
                                    Number(event.target.value)
                                  )
                                )
                              }
                            />

                            <span>
                              {repeatInterval === 1
                                ? repeatUnit
                                : `${repeatUnit}s`}
                            </span>
                          </div>
                        </label>

                        <label className="event-field">
                          Ends
                          <select
                            className="event-input"
                            value={repeatEndType}
                            onChange={(event) =>
                              setRepeatEndType(event.target.value)
                            }
                          >
                            <option value="never">
                              Never
                            </option>
                            <option value="date">
                              On a date
                            </option>
                            <option value="count">
                              After a number of times
                            </option>
                          </select>
                        </label>

                        {repeatEndType === 'date' && (
  <label className="event-field">
    Repeat Until

    <div className="event-date-text-wrap">
      <input
        className={`event-input event-date-text-input ${
          repeatEndDateError
            ? 'event-date-error'
            : ''
        }`}
        type="text"
        inputMode="numeric"
        placeholder="MM/DD/YYYY"
        maxLength={10}
        value={repeatEndDateText}
        onChange={(event) => {
          const value = event.target.value

          setRepeatEndDateText(value)

          if (value.trim() === '') {
            setRepeatEndDate('')
            return
          }

          const parsedDate =
            parseDateTextToDateKey(value)

          if (parsedDate) {
            setRepeatEndDate(parsedDate)
          }
        }}
      />

      <span className="event-date-picker-wrap">
        <span className="event-date-picker-icon">
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect
      x="3"
      y="5"
      width="18"
      height="16"
      rx="2"
    />
    <path d="M16 3v4" />
    <path d="M8 3v4" />
    <path d="M3 11h18" />
  </svg>
</span>

        <input
          className="event-date-picker-native"
          type="date"
          value={repeatEndDate}
          onChange={(event) => {
            const selectedDate =
              event.target.value

            setRepeatEndDate(selectedDate)

            setRepeatEndDateText(
              selectedDate
                ? formatDateKeyForText(
                    selectedDate
                  )
                : ''
            )
          }}
          aria-label="Choose repeat end date"
        />
      </span>
    </div>
  </label>
)}

                        {repeatEndType === 'count' && (
                          <label className="event-field">
                            Number of Occurrences
                            <input
                              className="event-input repeat-number-input"
                              type="number"
                              min="1"
                              max="1000"
                              value={repeatCount}
                              onChange={(event) =>
                                setRepeatCount(
                                  Math.max(
                                    1,
                                    Number(event.target.value)
                                  )
                                )
                              }
                            />
                          </label>
                        )}
                      </div>
                    )}
                    <label className="event-field">
                      Description
                      <textarea
                        className="event-input event-notes"
                        placeholder="Optional notes"
                        value={eventNotes}
                        onChange={(event) =>
                          setEventNotes(event.target.value)
                        }
                      />
                    </label>

                    <div className="event-action-anchor">

             {recurringAction === 'batch-save' && (
  <div className="recurring-action-popover">
    <div className="recurring-action-title">
      Apply changes to:
    </div>

    <button
      className="recurring-action-option"
      type="button"
      onClick={saveBatchThisEventOnly}
    >
      This Event Only
    </button>

    <button
      className="recurring-action-option"
      type="button"
      onClick={saveEventBatchChanges}
    >
      All Selected Dates
    </button>

    <button
      className="recurring-action-cancel"
      type="button"
      onClick={() =>
        setRecurringAction(null)
      }
    >
      Cancel
    </button>
  </div>
)}         
  {recurringAction === 'save' && (
    <div className="recurring-action-popover">
      <div className="recurring-action-title">
        Apply changes to:
      </div>

      <button
  className="recurring-action-option"
  type="button"
  onClick={saveThisEventOnly}
>
  This Event Only
</button>

      <button
        className="recurring-action-option"
        type="button"
        onClick={saveThisAndFutureEvents}
      >
        This and Future
      </button>

      <button
        className="recurring-action-option"
        type="button"
        onClick={saveEntireSeriesChanges}
      >
        Entire Series
      </button>

      <button
        className="recurring-action-cancel"
        type="button"
        onClick={() =>
          setRecurringAction(null)
        }
      >
        Cancel
      </button>
    </div>
  )}

  <div className="event-form-actions">
  <button
    className="event-form-cancel-button"
    type="button"
    onClick={closeEventModal}
  >
    Cancel
  </button>

  <button
    className="add-event-button"
    type="submit"
    onClick={(event) => {
      if (recurringAction !== null) {
        event.preventDefault()
        event.stopPropagation()
        setRecurringAction(null)
      }
    }}
  >
    {editingEventId !== null
      ? 'Save Changes'
      : duplicateSourceEventId !== null
        ? 'Create Copy'
        : 'Add Event'}
  </button>
</div>
</div>
                  </form>

                {editingEventId !== null && (
  <>
    <div className="edit-buttons">
      <div className="event-action-anchor">
  {recurringAction === 'delete' && (
    <div className="recurring-action-popover">
      <div className="recurring-action-title">
        Delete:
        <button
  className="recurring-action-option"
  type="button"
  onClick={deleteThisEventOnly}
>
  This Event Only
</button>
      </div>

      <button
        className="recurring-action-option"
        type="button"
        onClick={deleteThisAndFutureEvents}
      >
        This and Future
      </button>

      <button
        className="recurring-action-option recurring-action-danger"
        type="button"
        onClick={deleteEvent}
      >
        Entire Series
      </button>

      <button
        className="recurring-action-cancel"
        type="button"
        onClick={() =>
          setRecurringAction(null)
        }
      >
        Cancel
      </button>
    </div>
  )}

  <button
    className="delete-event-button"
    type="button"
    onClick={() => {
      const editingCalendarEvent =
        events.find(
          (calendarEvent) =>
            calendarEvent.id === editingEventId
        )

   if (editingCalendarEvent?.repeatUnit) {
  setRecurringAction('delete')
  return
}

      deleteEvent()
    }}
  >
    Delete Event
  </button>
</div>

      
    </div>

   
  </>
)}
                </>
              )}
                      </>
            )}
            </div>

            {calendarView === 'month' &&
              showEventModal &&
              viewingEventId === null &&
              editingEventId === null &&
              !isAddingEvent && (
                <button
                 className={`calendar-floating-add calendar-floating-add-in-popup ${
  selectedDay !== null
    ? 'calendar-floating-add-ready'
    : ''
}`}
                              type="button"
                  onPointerDown={startCalendarAddHold}
                  onPointerUp={cancelCalendarAddHold}
                  onPointerCancel={cancelCalendarAddHold}
                  onContextMenu={(event) => {
                    event.preventDefault()
                  }}
                  aria-label={      
                    selectedDay !== null
                      ? `Add event to ${monthName} ${selectedDay}`
                      : 'Add event'
                  }
                                  onClick={() => {
  if (consumeCalendarAddLongPress()) {
    return
  }

  const targetDay =
    selectedDay ??
    (
      month === today.getMonth() &&
      year === today.getFullYear()
        ? today.getDate()
        : 1
    )

  const openAddForm = () => {
    const targetDateKey =
      getDateKey(targetDay)

    setMonthEventsOpen(false)
    setSelectedDay(targetDay)
    clearEventForm()
    setEventStartDate(targetDateKey)
    setEventStartDateText(
      formatDateKeyForText(
        targetDateKey
      )
    )
    setIsAddingEvent(true)

    setTimeout(() => {
      const eventInput =
        document.querySelector<HTMLInputElement>(
          '.event-input'
        )

      eventInput?.focus()
    }, 0)
  }

  if (showCalendarSidebar) {
    transitionMonthSidebar(
      openAddForm
    )
    return
  }

  openAddForm()
}}
                >
                  <span className="calendar-floating-add-plus">
                    +
                  </span>

                  {selectedDay !== null && (
                    <span className="calendar-floating-add-day">
                      {selectedDay}
                    </span>
                  )}
                </button>
              )}

            </div>

              </aside>      

 {calendarView === 'month' &&
    viewingEventId === null &&
    editingEventId === null &&
    !isAddingEvent && (
      <button
        className={`calendar-floating-add ${
          selectedDay !== null
            ? 'calendar-floating-add-ready'
            : ''
        }`}
                type="button"
        onPointerDown={startCalendarAddHold}
        onPointerUp={cancelCalendarAddHold}
        onPointerCancel={cancelCalendarAddHold}
onContextMenu={(event) => {
          event.preventDefault()
        }}
        aria-label={
          selectedDay !== null
            ? `Add event to ${monthName} ${selectedDay}`
            : 'Add event'
        }
                onClick={() => {
  if (consumeCalendarAddLongPress()) {
    return
  }

  if (
    window.matchMedia(
      '(max-width: 760px)'
    ).matches
  ) {
    setQuickAddOpen(true)
    return
  }

  const targetDay =
            selectedDay ??
            (
              month === today.getMonth() &&
              year === today.getFullYear()
                ? today.getDate()
                : 1
            )

          const openAddForm = () => {
            const targetDateKey =
              getDateKey(targetDay)

            setMonthEventsOpen(false)
            setSelectedDay(targetDay)
            clearEventForm()
            setEventStartDate(targetDateKey)
            setEventStartDateText(
              formatDateKeyForText(targetDateKey)
            )
            setIsAddingEvent(true)

            setTimeout(() => {
              const eventInput =
                document.querySelector<HTMLInputElement>(
                  '.event-input'
                )

              eventInput?.focus()
            }, 0)
          }

          if (
  monthEventsOpen &&
  showCalendarSidebar
) {
  transitionMonthSidebar(openAddForm)
  return
}

openAddForm()
        }}
      >
        <span className="calendar-floating-add-plus">
          +
        </span>

        {selectedDay !== null && (
          <span className="calendar-floating-add-day">
            {selectedDay}
          </span>
        )}
      </button>
    )}

  </div>,
  document.body
)}      

{multipleDatePickerOpen &&
  createPortal(
    <div
      className="multiple-date-picker-overlay"
      onClick={() => {
        setPendingMultipleDates(
          eventMultipleDates
        )

        setMultipleDatePickerOpen(false)
      }}
    >
      <div
        className="multiple-date-picker-dialog"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="multiple-date-picker-header">
          <div>
            <h2>Select Dates</h2>

            <p>
              {pendingMultipleDates.length}{' '}
              {pendingMultipleDates.length === 1
                ? 'date selected'
                : 'dates selected'}
            </p>
          </div>
        </div>

        {(() => {
          const calendarYear =
            multipleDateCalendarMonth.getFullYear()

          const calendarMonth =
            multipleDateCalendarMonth.getMonth()

          const firstWeekday =
            new Date(
              calendarYear,
              calendarMonth,
              1
            ).getDay()

          const daysInMonth =
            new Date(
              calendarYear,
              calendarMonth + 1,
              0
            ).getDate()

          const calendarCells =
            Array.from(
              { length: 42 },
              (_, index) => {
                const day =
                  index -
                  firstWeekday +
                  1

                if (
                  day < 1 ||
                  day > daysInMonth
                ) {
                  return null
                }

                const date =
                  new Date(
                    calendarYear,
                    calendarMonth,
                    day
                  )

                return {
                  day,
                  dateKey:
                    getDateKeyFromDate(date),
                }
              }
            )

          return (
            <div className="multiple-date-calendar">
              <div className="multiple-date-calendar-heading">
                <button
                  type="button"
                  className="multiple-date-calendar-nav"
                  aria-label="Previous month"
                  onClick={() => {
                    setMultipleDateCalendarMonth(
                      new Date(
                        calendarYear,
                        calendarMonth - 1,
                        1
                      )
                    )
                  }}
                >
                  ‹
                </button>

                <strong>
                  {multipleDateCalendarMonth.toLocaleDateString(
                    'en-US',
                    {
                      month: 'long',
                      year: 'numeric',
                    }
                  )}
                </strong>

                <button
                  type="button"
                  className="multiple-date-calendar-nav"
                  aria-label="Next month"
                  onClick={() => {
                    setMultipleDateCalendarMonth(
                      new Date(
                        calendarYear,
                        calendarMonth + 1,
                        1
                      )
                    )
                  }}
                >
                  ›
                </button>
              </div>

              <div className="multiple-date-calendar-weekdays">
                <span>Sun</span>
                <span>Mon</span>
                <span>Tue</span>
                <span>Wed</span>
                <span>Thu</span>
                <span>Fri</span>
                <span>Sat</span>
              </div>

              <div className="multiple-date-calendar-grid">
                {calendarCells.map(
                  (
                    calendarCell,
                    index
                  ) => {
                    if (!calendarCell) {
                      return (
                        <div
                          className="multiple-date-calendar-empty"
                          key={`empty-${index}`}
                        />
                      )
                    }

                    const isSelected =
                      pendingMultipleDates.includes(
                        calendarCell.dateKey
                      )

                    const isToday =
                      calendarCell.dateKey ===
                      getDateKeyFromDate(today)

                    return (
                      <button
                        type="button"
                        key={
                          calendarCell.dateKey
                        }
                        className={`multiple-date-calendar-day ${
                          isSelected
                            ? 'multiple-date-calendar-day-selected'
                            : ''
                        } ${
                          isToday
                            ? 'multiple-date-calendar-day-today'
                            : ''
                        }`}
                        aria-pressed={isSelected}
                        onClick={() => {
                          togglePendingMultipleEventDate(
                            calendarCell.dateKey
                          )
                        }}
                      >
                        {calendarCell.day}
                      </button>
                    )
                  }
                )}
              </div>
            </div>
          )
        })()}

        <div className="multiple-date-picker-actions">
          <button
            type="button"
            className="multiple-date-picker-cancel"
            onClick={() => {
              setPendingMultipleDates(
                eventMultipleDates
              )

              setMultipleDatePickerOpen(
                false
              )
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            className="multiple-date-picker-confirm"
            disabled={
              pendingMultipleDates.length === 0
            }
            onClick={() => {
              const confirmedDates =
                [...pendingMultipleDates].sort()

              setEventMultipleDates(
                confirmedDates
              )

              const firstDate =
                confirmedDates[0] ?? ''

              setEventStartDate(firstDate)

              setEventStartDateText(
                firstDate
                  ? formatDateKeyForText(
                      firstDate
                    )
                  : ''
              )

              setMultipleDatePickerOpen(
                false
              )
            }}
          >
            Add Selected Dates
          </button>
        </div>
      </div>
    </div>,
    document.body
  )}
          
        
        </section>
      )}
{page === 'meals' && (
  <section className="meals-page">
    <div className="meals-page-header">
      <div>
        <span className="meals-page-eyebrow">
          Family Kitchen
        </span>

        <h1>Meals & Recipes</h1>

        <p>
          Save favorite recipes, plan meals, and turn them into grocery lists.
        </p>
      </div>

      {mealsView === 'recipes' && (
  <button
    type="button"
    className="calendar-floating-add"
    aria-label="Add recipe"
    onClick={() => {
      openAddRecipeForm()
    }}
  >
    <span className="calendar-floating-add-plus">
      +
    </span>
  </button>
)}
    </div>
        <div className="mobile-meals-top-row">
      <div className="meals-view-switcher">
        <button
          type="button"
          className={
            mealsView === 'recipes'
              ? 'meals-view-button meals-view-button-active'
              : 'meals-view-button'
          }
          onClick={() => {
            setMealsView('recipes')
          }}
        >
          Recipes
        </button>

        <button
          type="button"
          className={
            mealsView === 'planner'
              ? 'meals-view-button meals-view-button-active'
              : 'meals-view-button'
          }
          onClick={() => {
            setMealsView('planner')
          }}
        >
          Meal Planner
        </button>
      </div>

      {mealsView === 'planner' && (
        <button
  type="button"
  className="mobile-build-week-grocery-button"
  disabled={(() => {
    const weekEnd =
      new Date(mobileMealsDate)

    weekEnd.setHours(
      12,
      0,
      0,
      0
    )

    weekEnd.setDate(
      weekEnd.getDate() -
        weekEnd.getDay() +
        6
    )

    const currentDate =
      new Date()

    currentDate.setHours(
      12,
      0,
      0,
      0
    )

    return (
      weekEnd.getTime() <
      currentDate.getTime()
    )
  })()}
  onClick={() => {
    setMealPlannerListPickerOpen(true)
  }}
>
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L20.5 8H6.1M10 20h.01M17 20h.01"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          <span>
            Build Week
            <strong>Grocery List</strong>
          </span>
        </button>
      )}
    </div>

{mealsView === 'planner' &&
  (() => {
    const weekStart =
      new Date(mobileMealsDate)

    weekStart.setHours(
      0,
      0,
      0,
      0
    )

    weekStart.setDate(
      weekStart.getDate() -
        weekStart.getDay()
    )

    const weekDays =
      Array.from(
        {
          length: 7,
        },
        (_, index) => {
          const day =
            new Date(weekStart)

          day.setDate(
            weekStart.getDate() +
              index
          )

          return day
        }
      )

    const weekEnd =
      weekDays[6]

    const selectedDateKey =
      getDateKeyFromDate(
        mobileMealsDate
      )

    const todayDateKey =
      getDateKeyFromDate(
        today
      )

    return (
      <div className="mobile-meals-date-navigation">
        <div className="mobile-meals-week-range">
          <button
            type="button"
            className="mobile-meals-week-arrow"
            aria-label="Previous week"
            onClick={() => {
              setMobileMealsDate(
                (currentDate) => {
                  const previousWeek =
                    new Date(
                      currentDate
                    )

                  previousWeek.setDate(
                    previousWeek.getDate() -
                      7
                  )

                  return previousWeek
                }
              )
            }}
          >
            &lsaquo;
          </button>

          <strong>
            {weekStart.toLocaleDateString(
              'en-US',
              {
                month: 'short',
                day: 'numeric',
              }
            )}
            {' – '}
            {weekEnd.toLocaleDateString(
              'en-US',
              {
                month: 'short',
                day: 'numeric',
              }
            )}
          </strong>

          <button
            type="button"
            className="mobile-meals-week-arrow"
            aria-label="Next week"
            onClick={() => {
              setMobileMealsDate(
                (currentDate) => {
                  const nextWeek =
                    new Date(
                      currentDate
                    )

                  nextWeek.setDate(
                    nextWeek.getDate() +
                      7
                  )

                  return nextWeek
                }
              )
            }}
          >
            &rsaquo;
          </button>
        </div>

        <div className="mobile-meals-week-days">
          {weekDays.map((day) => {
            const dateKey =
              getDateKeyFromDate(
                day
              )

            const isSelected =
              dateKey ===
              selectedDateKey

            const isToday =
              dateKey ===
              todayDateKey

            return (
              <button
                type="button"
                key={dateKey}
                className={`mobile-meals-day-chip ${
                  isSelected
                    ? 'mobile-meals-day-chip-active'
                    : ''
                } ${
                  isToday
                    ? 'mobile-meals-day-chip-today'
                    : ''
                }`}
                onClick={() => {
                  setMobileMealsDate(
                    new Date(day)
                  )
                }}
              >
                <span>
                  {day.toLocaleDateString(
                    'en-US',
                    {
                      weekday: 'short',
                    }
                  )}
                </span>

                <strong>
                  {day.getDate()}
                </strong>
              </button>
            )
          })}
        </div>
      </div>
    )
  })()}
    {mealsView === 'recipes' ? (
      <>
        <div className="recipes-toolbar">
          <div className="recipes-search">
            <span
              className="recipes-search-icon"
              aria-hidden="true"
            >
              ⌕
            </span>

            <input
  type="search"
  placeholder="Search recipes..."
  aria-label="Search recipes"
  value={recipeSearch}
  onChange={(event) => {
    setRecipeSearch(event.target.value)
  }}
/>
          </div>

       <div className="recipe-filter-row">
  <button
    type="button"
    className={
      recipeFilter === 'all'
        ? 'recipe-filter-chip recipe-filter-chip-active'
        : 'recipe-filter-chip'
    }
    onClick={() => {
      setRecipeFilter('all')
    }}
  >
    All
  </button>

  <button
    type="button"
    className={
      recipeFilter === 'favorites'
        ? 'recipe-filter-chip recipe-filter-chip-active'
        : 'recipe-filter-chip'
    }
    onClick={() => {
      setRecipeFilter('favorites')
    }}
  >
    Favorites
  </button>

  <button
    type="button"
    className={
      recipeFilter === 'breakfast'
        ? 'recipe-filter-chip recipe-filter-chip-active'
        : 'recipe-filter-chip'
    }
    onClick={() => {
      setRecipeFilter('breakfast')
    }}
  >
    Breakfast
  </button>

  <button
    type="button"
    className={
      recipeFilter === 'lunch'
        ? 'recipe-filter-chip recipe-filter-chip-active'
        : 'recipe-filter-chip'
    }
    onClick={() => {
      setRecipeFilter('lunch')
    }}
  >
    Lunch
  </button>

  <button
    type="button"
    className={
      recipeFilter === 'dinner'
        ? 'recipe-filter-chip recipe-filter-chip-active'
        : 'recipe-filter-chip'
    }
    onClick={() => {
      setRecipeFilter('dinner')
    }}
  >
    Dinner
  </button>

  <button
    type="button"
    className={
      recipeFilter === 'quick'
        ? 'recipe-filter-chip recipe-filter-chip-active'
        : 'recipe-filter-chip'
    }
    onClick={() => {
      setRecipeFilter('quick')
    }}
  >
    Quick
   </button>
</div>
</div>

{recipes.length === 0 ? (
  <div className="recipes-empty-state">
    <div
      className="recipes-empty-icon"
      aria-hidden="true"
    >
      🍽
    </div>

    <h2>Your recipe collection starts here</h2>

    <p>
      Save family favorites, quick dinners, breakfasts,
      desserts, and anything else you want to cook again.
    </p>

    <button
      type="button"
      className="meals-add-recipe-button"
      onClick={() => {
        showAppNotification(
          'Add Recipe is the next step.'
        )
      }}
    >
      <span>+</span>
      Add Your First Recipe
    </button>
    </div>
) : filteredRecipes.length === 0 ? (
  <div className="recipes-no-results">
    <div
      className="recipes-no-results-icon"
      aria-hidden="true"
    >
      ⌕
    </div>

    <h2>No recipes found</h2>

    <p>
      Try another search or choose a different category.
    </p>

    <button
      type="button"
      className="recipes-clear-filters-button"
      onClick={() => {
        setRecipeSearch('')
        setRecipeFilter('all')
      }}
    >
      Clear filters
    </button>
  </div>
) : (
  <div className="recipes-grid">
    {filteredRecipes.map((recipe) => (
      <button
  type="button"
  className="recipe-card"
  key={recipe.id}
  onClick={() => {
    openRecipeDetails(recipe.id)
  }}
>
        <div className="recipe-card-image">
          {recipe.image ? (
            <img
  src={`/uploads/${recipe.image}`}
  alt={recipe.name}
/>
          ) : (
            <span aria-hidden="true">
              🍽
            </span>
          )}
        </div>

        <div className="recipe-card-body">
  {recipe.favorite && (
    <span
      className="recipe-card-favorite"
      aria-label="Favorite recipe"
    >
      ★
    </span>
  )}

  <div className="recipe-card-heading">
    <h2>{recipe.name}</h2>
  </div>

  {(recipe.prepTime ||
    recipe.cookTime ||
    recipe.servings !== null) && (
    <div className="recipe-card-meta">
      {recipe.prepTime && (
        <span>
          <strong>Prep</strong> {recipe.prepTime}
        </span>
      )}

      {recipe.cookTime && (
        <span>
          <strong>Cook</strong> {recipe.cookTime}
        </span>
      )}

      {recipe.servings !== null && (
        <span>
          {recipe.servings}{' '}
          {recipe.servings === 1
            ? 'serving'
            : 'servings'}
        </span>
      )}
    </div>
  )}

  {recipe.tags && (
    <div className="recipe-card-tags">
      {recipe.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '')
        .slice(0, 3)
        .map((tag) => (
          <span
            className="recipe-card-tag"
            key={tag}
          >
            {tag}
          </span>
        ))}
    </div>
  )}
</div>
      </button>
    ))}
  </div>
)}
      </>
    ) : (
      <div className="meal-planner meal-planner-compact">
{(() => {
  const previousDate =
    new Date(mobileMealsDate)

  previousDate.setDate(
    previousDate.getDate() - 1
  )

  const nextDate =
    new Date(mobileMealsDate)

  nextDate.setDate(
    nextDate.getDate() + 1
  )

  return (
    <div
      ref={mobileMealsPagerRef}
      className="mobile-meal-planner"
      onPointerDown={
        handleMobileMealsSwipePointerDown
      }
      onPointerMove={
        handleMobileMealsSwipePointerMove
      }
      onPointerUp={
        finishMobileMealsSwipe
      }
      onPointerCancel={
        cancelMobileMealsSwipe
      }
    >
      <div
        className={`mobile-meal-planner-track ${
          mobileMealsSettling
            ? 'mobile-meal-planner-track-settling'
            : ''
        }`}
        style={{
          transform:
            `translateX(calc(-100% + ${mobileMealsDragX}px))`,
        }}
      >
        <div
          className="mobile-meal-planner-page"
          aria-hidden="true"
        >
          {renderMobileMealPlannerDay(
            previousDate
          )}
        </div>

        <div className="mobile-meal-planner-page">
          {renderMobileMealPlannerDay(
            mobileMealsDate
          )}
        </div>

        <div
          className="mobile-meal-planner-page"
          aria-hidden="true"
        >
          {renderMobileMealPlannerDay(
            nextDate
          )}
        </div>
      </div>
    </div>
  )
})()}

  {(() => {
    const weekDays = Array.from(
      {
        length: 7,
      },
      (_, dayIndex) => {
        const day = new Date(
          mealPlannerWeekStart
        )

        day.setDate(
          mealPlannerWeekStart.getDate() +
            dayIndex
        )

        return day
      }
    )

    const weekEnd =
  new Date(mealPlannerWeekStart)

weekEnd.setDate(
  mealPlannerWeekStart.getDate() + 6
)

    const weekRange =
      `${mealPlannerWeekStart.toLocaleDateString(
        undefined,
        {
          month: 'short',
          day: 'numeric',
        }
      )} – ${weekEnd.toLocaleDateString(
        undefined,
        {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }
      )}`

    const mealTypes = [
      {
        key: 'breakfast',
        label: 'Breakfast',
      },
      {
        key: 'lunch',
        label: 'Lunch',
      },
      {
        key: 'dinner',
        label: 'Dinner',
      },
      {
        key: 'snack',
        label: 'Snacks',
      },
    ] as const

    return (
      <>
        <div className="meal-planner-compact-toolbar">
          

          <div className="meal-planner-compact-navigation">
            <button
              type="button"
              className="meal-planner-arrow-button"
              aria-label="Previous week"
              onClick={() => {
                setMealPlannerWeekStart(
                  (currentWeekStart) => {
                    const previousWeek =
                      new Date(
                        currentWeekStart
                      )

                    previousWeek.setDate(
                      previousWeek.getDate() -
                        7
                    )

                    return previousWeek
                  }
                )
                resetMealPlannerScroll()
              }}
            >
              ‹
            </button>

            <span className="meal-planner-week-range">
              {weekRange}
            </span>

            <button
              type="button"
              className="meal-planner-arrow-button"
              aria-label="Next week"
              onClick={() => {
                setMealPlannerWeekStart(
                  (currentWeekStart) => {
                    const nextWeek =
                      new Date(
                        currentWeekStart
                      )

                    nextWeek.setDate(
                      nextWeek.getDate() +
                        7
                    )

                    return nextWeek
                  }
                )
                resetMealPlannerScroll()
              }}
            >
              ›
            </button>

            <button
              type="button"
              className="meal-planner-compact-this-week"
              onClick={() => {
                const today = new Date()

                today.setHours(
                  12,
                  0,
                  0,
                  0
                )

                today.setDate(
                  today.getDate() -
                    today.getDay()
                )

                setMealPlannerWeekStart(
                  today
                )
resetMealPlannerScroll()

              }}
            >
              This Week
            </button>
            <button
  type="button"
  className="meal-planner-compact-this-week"
  onClick={() => {
    setMealPlannerListPickerOpen(true)
  }}
>
  Build Grocery List
</button>
          </div>
        </div>

        <div
  key={getDateKeyFromDate(mealPlannerWeekStart)}
  ref={mealPlannerScrollRef}
  className="meal-planner-matrix-scroll"
  onTouchStart={(event) => {
    const touch = event.touches[0]

    if (!touch) {
      return
    }

    mealPlannerSwipeStartXRef.current =
      touch.clientX

    mealPlannerSwipeStartYRef.current =
      touch.clientY
  }}
  onTouchEnd={(event) => {
    const startX =
      mealPlannerSwipeStartXRef.current

    const startY =
      mealPlannerSwipeStartYRef.current

    const touch =
      event.changedTouches[0]

    mealPlannerSwipeStartXRef.current =
      null

    mealPlannerSwipeStartYRef.current =
      null

    if (
      startX === null ||
      startY === null ||
      !touch
    ) {
      return
    }

    const deltaX =
      touch.clientX - startX

    const deltaY =
      touch.clientY - startY

    if (
      Math.abs(deltaX) < 70 ||
      Math.abs(deltaX) <=
        Math.abs(deltaY)
    ) {
      return
    }

    setMealPlannerWeekStart(
      (currentWeekStart) => {
        const newWeek =
          new Date(currentWeekStart)

        newWeek.setDate(
          newWeek.getDate() +
            (deltaX < 0 ? 7 : -7)
        )

        return newWeek
      }
    )
  }}
  onTouchCancel={() => {
    mealPlannerSwipeStartXRef.current =
      null

    mealPlannerSwipeStartYRef.current =
      null
  }}
>
          <div className="meal-planner-matrix">
            <div className="meal-planner-matrix-header">
              <div className="meal-planner-matrix-corner" />

              {weekDays.map((day) => {
                const dateKey =
                  getDateKeyFromDate(day)

                const isToday =
                  dateKey ===
                  getDateKeyFromDate(
                    new Date()
                  )

                return (
                  <div
                    className={`meal-planner-matrix-day ${
                      isToday
                        ? 'meal-planner-matrix-day-today'
                        : ''
                    }`}
                    key={dateKey}
                  >
                    <span>
                      {day.toLocaleDateString(
                        undefined,
                        {
                          weekday:
                            'short',
                        }
                      )}
                    </span>

                    <strong>
                      {day.getDate()}
                    </strong>
                  </div>
                )
              })}
            </div>

            {mealTypes.map(
              ({
                key: mealType,
                label,
              }) => (
                <div
                  className={`meal-planner-matrix-row meal-planner-matrix-row-${mealType}`}
                  key={mealType}
                >
                  <div className="meal-planner-matrix-label">
  <span>{label}</span>
</div>

                  {weekDays.map(
                    (day) => {
                      const dateKey =
                        getDateKeyFromDate(
                          day
                        )

                      const isToday =
                        dateKey ===
                        getDateKeyFromDate(
                          new Date()
                        )

                      const meal =
                        mealPlanItems.find(
                          (item) =>
                            item.date ===
                              dateKey &&
                            item.mealType ===
                              mealType
                        )

                      return (
                        <div
                          className={`meal-planner-matrix-cell ${
                            isToday
                              ? 'meal-planner-matrix-cell-today'
                              : ''
                          }`}
                          key={dateKey}
                        >
                          {meal ? (
                            <button
                              type="button"
                              className="meal-planner-meal meal-planner-matrix-meal"
                              onClick={() => {
                                openEditMealPlanForm(
                                  meal
                                )
                              }}
                            >
                              {meal.recipeImage && (
                                <img
                                  className="meal-planner-meal-image"
                                  src={`/uploads/${meal.recipeImage}`}
                                  alt=""
                                />
                              )}

                              <div className="meal-planner-meal-text">
                                <strong>
                                  {
                                    meal.title
                                  }
                                </strong>

                                {meal.notes && (
                                  <span>
                                    {
                                      meal.notes
                                    }
                                  </span>
                                )}
                              </div>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="meal-planner-matrix-empty"
                              onClick={() => {
                                openMealPlanForm(
                                  dateKey,
                                  mealType
                                )
                              }}
                            >
                              + Add meal
                            </button>
                          )}
                        </div>
                      )
                    }
                  )}
                </div>
              )
            )}
          </div>
        </div>
      </>
    )
  })()}
</div>
    )}
  </section>
)}

{mealPlanFormOpen &&
  createPortal(
    <div
      className="recipe-modal-overlay meal-plan-form-overlay meal-picker-overlay"
      onClick={closeMealPlanForm}
    >
      {mealPickerKeyboardOpen && (
  <div
    className="meal-picker-keyboard"
    onClick={(event) => {
      event.stopPropagation()
    }}
  >
    <div className="meal-picker-keyboard-header">
      <div>
        <span className="meals-page-eyebrow">
          Recipe Search
        </span>

        <strong>
          {mealPickerSearch ||
            'Search recipes'}
        </strong>
      </div>

      <button
        type="button"
        className="meal-picker-keyboard-close"
        aria-label="Close keyboard"
        onClick={() => {
          setMealPickerKeyboardOpen(
            false
          )
        }}
      >
        &#215;
      </button>
    </div>

   <div className="meal-picker-keyboard-rows">
  <div className="meal-picker-keyboard-row">
    {'QWERTYUIOP'
      .split('')
      .map((letter) => (
        <button
          type="button"
          className="meal-picker-key"
          key={letter}
          onClick={() => {
            typePersonLetter(letter)
          }}
        >
          {letter}
        </button>
      ))}
  </div>

  <div className="meal-picker-keyboard-row meal-picker-keyboard-row-middle">
    {'ASDFGHJKL'
      .split('')
      .map((letter) => (
        <button
          type="button"
          className="meal-picker-key"
          key={letter}
          onClick={() => {
            typePersonLetter(letter)
          }}
        >
          {letter}
        </button>
      ))}
  </div>

  <div className="meal-picker-keyboard-row meal-picker-keyboard-row-bottom">
    {'ZXCVBNM'
      .split('')
      .map((letter) => (
        <button
          type="button"
          className="meal-picker-key"
          key={letter}
          onClick={() => {
            typePersonLetter(letter)
          }}
        >
          {letter}
        </button>
      ))}

    <button
      type="button"
      className="meal-picker-key meal-picker-key-backspace"
      onClick={() => {
        backspacePersonName()
      }}
    >
      Backspace
    </button>
  </div>
</div>

<div className="meal-picker-keyboard-actions">
  <button
    type="button"
    className="meal-picker-keyboard-action"
    onClick={() => {
      setPersonName('')
      personCursorPositionRef.current = 0
      setPersonCursorPosition(0)
    }}
  >
    Clear
  </button>

  <button
    type="button"
    className="meal-picker-keyboard-space"
    onClick={() => {
      insertPersonNameText(' ')
    }}
  >
    Space
  </button>

  <button
    type="button"
    className="meal-picker-keyboard-action"
    onClick={() => {
      setPersonKeyboardOpen(false)
    }}
  >
    Done
  </button>
</div>

    <div className="meal-picker-keyboard-actions">
      <button
        type="button"
        className="meal-picker-keyboard-action"
        onClick={() => {
          setMealPickerSearch('')
        }}
      >
        Clear
      </button>

      <button
        type="button"
        className="meal-picker-keyboard-space"
        onClick={() => {
          setMealPickerSearch(
            (currentSearch) =>
              currentSearch + ' '
          )
        }}
      >
        Space
      </button>

      <button
        type="button"
        className="meal-picker-keyboard-action"
        onClick={() => {
          setMealPickerKeyboardOpen(
            false
          )
        }}
      >
        Done
      </button>
    </div>
  </div>
)}
      <div
        className="recipe-modal meal-plan-form-modal meal-picker-panel"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="meal-picker-header">
          <div>
            <span className="meals-page-eyebrow">
              Meal Planner
            </span>

            <h2>
              {editingMealPlanItemId !==
              null
                ? 'Change'
                : 'Select'}{' '}
              {mealPlanFormMealType ===
              'breakfast'
                ? 'Breakfast'
                : mealPlanFormMealType ===
                    'lunch'
                  ? 'Lunch'
                  : mealPlanFormMealType ===
                      'dinner'
                    ? 'Dinner'
                    : 'Snack'}
            </h2>

            <span className="meal-plan-form-date">
              {formatDateKeyForText(
                mealPlanFormDate
              )}
            </span>
          </div>

          <button
            type="button"
            className="recipe-modal-close"
            aria-label="Close Meal Picker"
            onClick={closeMealPlanForm}
          >
            &#215;
          </button>
        </div>

        {mealPlanFormSource ===
          'recipe' && (
          <div className="meal-plan-schedule-fields meal-picker-schedule-fields">
            <label className="event-field">
              Date

              <input
                type="date"
                className="event-input"
                value={
                  mealPlanFormDate
                }
                onChange={(event) => {
                  setMealPlanFormDate(
                    event.target.value
                  )
                }}
              />
            </label>

            <label className="event-field">
              Meal

              <select
                className="event-input"
                value={
                  mealPlanFormMealType
                }
                onChange={(event) => {
                  setMealPlanFormMealType(
                    event.target
                      .value as
                      MealPlanItem['mealType']
                  )
                }}
              >
                <option value="breakfast">
                  Breakfast
                </option>

                <option value="lunch">
                  Lunch
                </option>

                <option value="dinner">
                  Dinner
                </option>

                <option value="snack">
                  Snack
                </option>
              </select>
            </label>
          </div>
        )}

        <div className="meal-picker-tabs">
          <button
            type="button"
            className={
              mealPlanEntryMode ===
              'recipe'
                ? 'meal-picker-tab meal-picker-tab-active'
                : 'meal-picker-tab'
            }
            onClick={() => {
              setMealPlanEntryMode(
                'recipe'
              )
            }}
          >
            Recipes
          </button>

          <button
            type="button"
            className={
              mealPlanEntryMode ===
              'custom'
                ? 'meal-picker-tab meal-picker-tab-active'
                : 'meal-picker-tab'
            }
            onClick={() => {
              setMealPlanEntryMode(
                'custom'
              )
            }}
          >
            Custom Meal
          </button>
        </div>

        {mealPlanEntryMode ===
'recipe' ? (
  <div className="meal-picker-recipe-area">
    <div className="meal-picker-recipe-heading">
  <strong>
    Saved Recipes
  </strong>

  <div className="meal-picker-recipe-heading-actions">
    <span>
      {
        recipes.filter((recipe) =>
          recipe.name
            .toLowerCase()
            .includes(
              mealPickerSearch
                .trim()
                .toLowerCase()
            )
        ).length
      }{' '}
      {
        recipes.filter((recipe) =>
          recipe.name
            .toLowerCase()
            .includes(
              mealPickerSearch
                .trim()
                .toLowerCase()
            )
        ).length === 1
          ? 'recipe'
          : 'recipes'
      }
    </span>

    <button
      type="button"
      className="meal-picker-add-recipe-button"
      onClick={() => {
        setMealPickerKeyboardOpen(false)
        setMealPickerSearch('')
        openAddRecipeForm()
      }}
    >
      + Add Recipe
    </button>
  </div>
</div>

            <div className="meal-picker-recipe-list">
              {recipes.filter((recipe) =>
  recipe.name
    .toLowerCase()
    .includes(
      mealPickerSearch
        .trim()
        .toLowerCase()
    )
).length === 0 ? (
  <div className="meal-picker-no-results">
    <strong>
      {recipes.length === 0
        ? 'No saved recipes yet'
        : 'No recipes found'}
    </strong>

    <span>
      {recipes.length === 0
        ? 'Add a recipe to get started.'
        : 'Try another search or add a new recipe.'}
    </span>
  </div>
) : (
  recipes
    .filter((recipe) =>
      recipe.name
        .toLowerCase()
        .includes(
          mealPickerSearch
            .trim()
            .toLowerCase()
        )
    )
    .map((recipe) => (
      <button
        type="button"
        className="meal-picker-recipe"
        key={recipe.id}
        onClick={() => {
          void selectRecipeForMealPlan(
            recipe
          )
        }}
      >
        {recipe.image ? (
          <img
            className="meal-picker-recipe-image"
            src={`/uploads/${recipe.image}`}
            alt=""
          />
        ) : (
          <div className="meal-picker-recipe-placeholder">
            <span>
              {recipe.name
                .charAt(0)
                .toUpperCase()}
            </span>
          </div>
        )}

        <div className="meal-picker-recipe-text">
          <strong>
            {recipe.name}
          </strong>

          <div className="meal-picker-recipe-meta">
            {recipe.cookTime && (
              <span>
                {recipe.cookTime}
              </span>
            )}

            {recipe.servings !==
              null && (
              <span>
                {recipe.servings}{' '}
                {recipe.servings === 1
                  ? 'serving'
                  : 'servings'}
              </span>
            )}
          </div>
        </div>

        <span className="meal-picker-add-icon">
          +
        </span>
      </button>
    ))
)}
            </div>

            <div className="meal-picker-footer">
              {editingMealPlanItemId !==
                null && (
                <button
                  type="button"
                  className="event-details-delete-button meal-plan-delete-button"
                  aria-label="Remove meal"
                  onClick={() => {
                    setMealPlanDeleteConfirmOpen(
                      true
                    )
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}

              <div
  className={
    mealPickerKeyboardOpen
      ? 'meal-picker-search meal-picker-search-keyboard-open'
      : 'meal-picker-search'
  }
>
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <circle
      cx="11"
      cy="11"
      r="6.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    />

    <path
      d="m16 16 4 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>

 <button
  type="button"
  className="meal-picker-search-display"
  onClick={() => {
    setMealPickerKeyboardOpen(true)
  }}
>
  {mealPickerSearch || 'Search recipes'}
</button>
</div>
            </div>
          </div>
        ) : (
          <form
            className="meal-plan-form meal-picker-custom-form"
            onSubmit={
              saveMealPlanItem
            }
          >
            <label className="event-field">
              Meal Name

              <input
                type="text"
                className="event-input"
                placeholder="Example: Leftovers"
                value={
                  mealPlanCustomTitle
                }
                onChange={(event) => {
                  setMealPlanCustomTitle(
                    event.target.value
                  )
                }}
              />
            </label>

            <label className="event-field">
              Notes

              <textarea
                className="event-input meal-plan-notes-input"
                placeholder="Optional notes"
                value={
                  mealPlanNotes
                }
                onChange={(event) => {
                  setMealPlanNotes(
                    event.target.value
                  )
                }}
              />
            </label>

            <div className="meal-plan-form-actions">
              {editingMealPlanItemId !==
                null && (
                <button
                  type="button"
                  className="event-details-delete-button meal-plan-delete-button"
                  aria-label="Remove meal"
                  onClick={() => {
                    setMealPlanDeleteConfirmOpen(
                      true
                    )
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}

              <button
                type="button"
                className="recipe-details-secondary-button"
                onClick={
                  closeMealPlanForm
                }
              >
                Cancel
              </button>

              <button
                type="submit"
                className="meals-add-recipe-button"
              >
                {editingMealPlanItemId !==
                null
                  ? 'Save Changes'
                  : 'Add to Planner'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  )}

{mealPlanDeleteConfirmOpen &&
  createPortal(
    <div
      className="recipe-delete-overlay"
      onClick={() => {
        setMealPlanDeleteConfirmOpen(false)
      }}
    >
      <div
        className="recipe-delete-confirm"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <h3>Remove Meal?</h3>

        <p>
          This will remove the meal from this day.
          The saved recipe itself will not be deleted.
        </p>

        <div className="recipe-delete-actions">
          <button
            type="button"
            className="recipe-delete-cancel"
            onClick={() => {
              setMealPlanDeleteConfirmOpen(false)
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            className="recipe-delete-danger"
            onClick={deleteMealPlanItem}
          >
            Remove Meal
          </button>
        </div>
      </div>
    </div>,
    document.body
  )}
{mealPlannerListPickerOpen &&
  createPortal(
    <div
      className="recipe-delete-overlay"
      onClick={() => {
        setMealPlannerListPickerOpen(false)
      }}
    >
      <div
        className="recipe-list-picker"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="recipe-list-picker-header">
          <span className="meals-page-eyebrow">
            Meal Planner
          </span>

          <h3>Build Grocery List</h3>

          <p>
            Choose a list for the ingredients
            from this week's planned recipes.
          </p>
        </div>

        {lists.length === 0 ? (
          <div className="recipe-list-picker-empty">
            You do not have any lists yet.
          </div>
        ) : (
          <div className="recipe-list-picker-options">
            {lists.map((list) => (
              <button
                type="button"
                className="recipe-list-picker-option"
                key={list.id}
                onClick={() => {
                  void addMealPlannerWeekIngredientsToList(
                    list.id
                  )
                }}
              >
                <strong>{list.name}</strong>

                <span>
                  {list.items.length}{' '}
                  {list.items.length === 1
                    ? 'item'
                    : 'items'}
                </span>
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          className="recipe-list-picker-cancel"
          onClick={() => {
            setMealPlannerListPickerOpen(false)
          }}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body
  )}

{viewingRecipeId !== null &&
  (() => {
    const recipe = recipes.find(
      (recipe) =>
        recipe.id === viewingRecipeId
    )

    if (!recipe) {
      return null
    }

    const recipeTagsList =
      recipe.tags
        ? recipe.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter((tag) => tag !== '')
        : []

    return createPortal(
      <div
        className={
  recipeFormSource === 'meal-picker'
    ? 'recipe-modal-overlay recipe-modal-overlay-from-meal-picker'
    : 'recipe-modal-overlay'
}
        onClick={closeRecipeDetails}
      >
        <div
          className="recipe-modal recipe-details-modal"
          onClick={(event) => {
            event.stopPropagation()
          }}
        >
          <div className="recipe-modal-header">
            <div>
              <span className="meals-page-eyebrow">
                Recipe
              </span>

              <h2>{recipe.name}</h2>
            </div>

            <button
              type="button"
              className="recipe-modal-close"
              aria-label="Close Recipe Details"
              onClick={closeRecipeDetails}
            >
              ×
            </button>
          </div>

          <div className="recipe-details-content">
            <div className="recipe-details-main">
              {recipe.image ? (
                <div className="recipe-details-image-wrap">
                  <img
                    className="recipe-details-image"
                    src={`/uploads/${recipe.image}`}
                    alt={recipe.name}
                  />
                </div>
              ) : (
                <div className="recipe-details-image-empty">
                  <span aria-hidden="true">
                    🍽
                  </span>
                </div>
              )}
 {recipe.sourceImage && (
                <div className="recipe-source-photo">
                  <span className="recipe-source-photo-label">
                    Source Photo
                  </span>

                  <a
                    className="recipe-source-photo-link"
                    href={`/uploads/${recipe.sourceImage}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open source photo"
                  >
                    <img
                      className="recipe-source-photo-thumbnail"
                      src={`/uploads/thumb-${recipe.sourceImage.replace(
                        /\.[^/.]+$/,
                        ''
                      )}.webp`}
                      alt="Original source"
                      loading="lazy"
                      onError={(event) => {
                        const image =
                          event.currentTarget

                        image.onerror = null
                        image.src =
                          `/uploads/${recipe.sourceImage}`
                      }}
                    />
                  </a>
                </div>
              )}
              <div className="recipe-details-summary">
                {recipe.servings !== null && (
                  <div className="recipe-details-summary-card">
                    <span>Servings</span>
                    <strong>
                      {recipe.servings}
                    </strong>
                  </div>
                )}

                {recipe.prepTime && (
                  <div className="recipe-details-summary-card">
                    <span>Prep Time</span>
                    <strong>
                      {recipe.prepTime}
                    </strong>
                  </div>
                )}

                {recipe.cookTime && (
                  <div className="recipe-details-summary-card">
                    <span>Cook Time</span>
                    <strong>
                      {recipe.cookTime}
                    </strong>
                  </div>
                )}
              </div>

              {recipeTagsList.length > 0 && (
                <div className="recipe-details-tags">
                  {recipeTagsList.map((tag) => (
                    <span key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {recipe.favorite && (
                <div className="recipe-details-favorite">
                  ★ Favorite Recipe
                </div>
              )}
            </div>

            <div className="recipe-details-sections">
              <section className="recipe-details-section">
                <h3>Ingredients</h3>

                {recipe.ingredients ? (
                  <div className="recipe-details-text">
                    {recipe.ingredients}
                  </div>
                ) : (
                  <p className="recipe-details-empty-text">
                    No ingredients added.
                  </p>
                )}
              </section>

              <section className="recipe-details-section">
                <h3>Instructions</h3>

                {recipe.instructions ? (
                  <div className="recipe-details-text">
                    {recipe.instructions}
                  </div>
                ) : (
                  <p className="recipe-details-empty-text">
                    No instructions added.
                  </p>
                )}
              </section>

              {recipe.notes && (
                <section className="recipe-details-section">
                  <h3>Notes</h3>

                  <div className="recipe-details-text">
                    {recipe.notes}
                  </div>
                </section>
              )}

              {recipe.sourceUrl && (
                <section className="recipe-details-section">
                  <h3>Source</h3>

                  <a
                    className="recipe-details-source"
                    href={recipe.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open original recipe
                  </a>
                </section>
              )}
            </div>

<div className="recipe-details-actions">
  <button
    type="button"
    className="event-details-delete-button"
    aria-label="Delete recipe"
    onClick={() => {
      setRecipeDeleteConfirmOpen(true)
    }}
  >
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </button>

<button
  type="button"
  className="recipe-details-secondary-button"
  onClick={() => {
    if (recipe.ingredients.trim() === '') {
      showAppNotification(
        'This recipe does not have any ingredients yet.'
      )
      return
    }

    setRecipeListPickerOpen(true)
  }}
>
  Add Ingredients to List
</button>

  <button
    type="button"
    className="recipe-details-secondary-button"
    onClick={() => {
  openRecipeMealPlanForm(recipe)
}}
  >
    Add to Meal Plan
  </button>

  <button
    type="button"
    className="meals-add-recipe-button"
    onClick={() => {
      startEditingRecipe(recipe)
    }}
  >
    Edit Recipe
  </button>
</div>
          </div>
        </div>
      </div>,
      document.body
    )
  })()}
  {recipeListPickerOpen &&
  viewingRecipeId !== null &&
  (() => {
    const recipe = recipes.find(
      (item) => item.id === viewingRecipeId
    )

    if (!recipe) {
      return null
    }

    return createPortal(
      <div
        className="recipe-delete-overlay"
        onClick={() => {
          setRecipeListPickerOpen(false)
        }}
      >
        <div
          className="recipe-list-picker"
          onClick={(event) => {
            event.stopPropagation()
          }}
        >
          <div className="recipe-list-picker-header">
            <span className="meals-page-eyebrow">
              Grocery List
            </span>

            <h3>Add Ingredients</h3>

            <p>
              Choose where to add the ingredients
              from {recipe.name}.
            </p>
          </div>

          {lists.length === 0 ? (
            <div className="recipe-list-picker-empty">
              You do not have any lists yet.
            </div>
          ) : (
            <div className="recipe-list-picker-options">
              {lists.map((list) => (
                <button
                  type="button"
                  className="recipe-list-picker-option"
                  key={list.id}
                  onClick={() => {
                    void addRecipeIngredientsToList(
                      recipe,
                      list.id
                    )
                  }}
                >
                  <strong>{list.name}</strong>

                  <span>
                    {list.items.length}{' '}
                    {list.items.length === 1
                      ? 'item'
                      : 'items'}
                  </span>
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            className="recipe-list-picker-cancel"
            onClick={() => {
              setRecipeListPickerOpen(false)
            }}
          >
            Cancel
          </button>
        </div>
      </div>,
      document.body
    )
  })()}

{recipeDeleteConfirmOpen &&
  viewingRecipeId !== null &&
  createPortal(
    <div
      className="recipe-delete-overlay"
      onClick={() => {
        setRecipeDeleteConfirmOpen(false)
      }}
    >
      <div
        className="recipe-delete-confirm"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <h3>Delete Recipe?</h3>

        <p>
          This recipe will be permanently deleted.
        </p>

        <div className="recipe-delete-actions">
          <button
            type="button"
            className="recipe-delete-cancel"
            onClick={() => {
              setRecipeDeleteConfirmOpen(false)
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            className="recipe-delete-danger"
            onClick={deleteRecipe}
          >
            Delete Recipe
          </button>
        </div>
      </div>
    </div>,
    document.body
  )}
{recipeFormOpen &&
  createPortal(
    <div
      className={`recipe-modal-overlay ${
        mealPlanFormOpen
          ? 'recipe-form-over-meal-picker'
          : ''
      }`}
      onClick={closeRecipeForm}
    >
      <div
        className="recipe-modal"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="recipe-modal-header">
          <div>
            <span className="meals-page-eyebrow">
              Recipe
            </span>

            <h2>
  {editingRecipeId !== null
    ? 'Edit Recipe'
    : 'Add Recipe'}
</h2>
          </div>

          <button
            type="button"
            className="recipe-modal-close"
            aria-label={
  editingRecipeId !== null
    ? 'Close Edit Recipe'
    : 'Close Add Recipe'
}
            onClick={closeRecipeForm}
          >
            ×
          </button>
        </div>

        <form
          className="recipe-form"
          onSubmit={saveRecipe}
        >
          <div className="recipe-form-main">
            <label className="event-field">
              Recipe Name
              <input
                className="event-input"
                type="text"
                placeholder="Example: Creamy Chicken Pasta"
                value={recipeName}
                onChange={(event) => {
                  setRecipeName(
                    event.target.value
                  )
                }}
              />
            </label>

            <div className="recipe-form-time-row">
              <label className="event-field">
                Servings
                <input
                  className="event-input"
                  type="number"
                  min="1"
                  max="1000"
                  value={recipeServings}
                  onChange={(event) => {
                    setRecipeServings(
                      event.target.value
                    )
                  }}
                />
              </label>

              <label className="event-field">
                Prep Time
                <input
                  className="event-input"
                  type="text"
                  value={recipePrepTime}
                  onChange={(event) => {
                    setRecipePrepTime(
                      event.target.value
                    )
                  }}
                />
              </label>

              <label className="event-field">
                Cook Time
                <input
                  className="event-input"
                  type="text"
                  value={recipeCookTime}
                  onChange={(event) => {
                    setRecipeCookTime(
                      event.target.value
                    )
                  }}
                />
              </label>
            </div>

            <label className="event-field">
              Ingredients
              <textarea
                className="event-input recipe-form-textarea"
                placeholder="Add one ingredient per line"
                value={recipeIngredients}
                onChange={(event) => {
                  setRecipeIngredients(
                    event.target.value
                  )
                }}
              />
            </label>

            <label className="event-field">
              Instructions
              <textarea
                className="event-input recipe-form-textarea recipe-form-instructions"
                placeholder="Add the cooking instructions"
                value={recipeInstructions}
                onChange={(event) => {
                  setRecipeInstructions(
                    event.target.value
                  )
                }}
              />
            </label>

            <label className="event-field">
              Notes
              <textarea
                className="event-input recipe-form-textarea"
                placeholder="Optional notes"
                value={recipeNotes}
                onChange={(event) => {
                  setRecipeNotes(
                    event.target.value
                  )
                }}
              />
            </label>
          </div>

          <div className="recipe-form-side">
            <div className="recipe-photo-field">
  <span className="recipe-photo-label">
    Photo
  </span>

  <label className="recipe-photo-picker">
    <input
      key={recipeFileInputKey}
      className="recipe-photo-input"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      onChange={
        handleRecipeImageChange
      }
    />

    <span className="recipe-photo-picker-button">
      {recipeImagePreview !== ''
        ? 'Change Photo'
        : 'Choose Photo'}
    </span>

    <span className="recipe-photo-picker-text">
      {recipeImageFile
        ? recipeImageFile.name
        : recipeImagePreview !== ''
          ? 'Current recipe photo'
          : 'No photo selected'}
    </span>
  </label>
</div>

            {recipeImagePreview !== '' && (
              <div className="recipe-image-preview-wrap">
                <img
                  className="recipe-image-preview"
                  src={recipeImagePreview}
                  alt="Recipe preview"
                />
              </div>
            )}

            <label className="event-field">
  Custom Tags

  <span className="recipe-custom-tags-help">
    Optional — add extras like Chicken, Pasta, Spicy
  </span>

  <input
    className="event-input"
    type="text"
    placeholder="Chicken, Pasta, Spicy"
    value={recipeTags}
    onChange={(event) => {
      setRecipeTags(
        event.target.value
      )
    }}
  />
</label>

            <label className="event-field">
              Source URL
              <input
                className="event-input"
                type="url"
                placeholder="https://..."
                value={recipeSourceUrl}
                onChange={(event) => {
                  setRecipeSourceUrl(
                    event.target.value
                  )
                }}
              />
            </label>

            <label className="recipe-favorite-toggle">
              <input
                type="checkbox"
                checked={recipeFavorite}
                onChange={(event) => {
                  setRecipeFavorite(
                    event.target.checked
                  )
                }}
              />

              <span>
                ★ Favorite
              </span>
            </label>
            <div className="recipe-quick-tags">
  <span className="recipe-quick-tags-label">
    Categories
  </span>

  <div className="recipe-quick-tags-buttons">
    {[
      'Breakfast',
      'Lunch',
      'Dinner',
      'Quick',
      'Snack',
      'Dessert',
    ].map((tag) => {
      const selected =
        recipeQuickTagIsSelected(tag)

      return (
        <button
          type="button"
          key={tag}
          className={
            selected
              ? 'recipe-quick-tag recipe-quick-tag-active'
              : 'recipe-quick-tag'
          }
          aria-pressed={selected}
          onClick={() => {
            toggleRecipeQuickTag(tag)
          }}
        >
          {tag}
        </button>
      )
    })}
  </div>
</div>
          </div>

          <div className="recipe-form-actions">
            <button
              type="button"
              className="cancel-button"
              onClick={closeRecipeForm}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="meals-add-recipe-button"
            >
              Save Recipe
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )}

      {page === 'people' && (
        <section className="people-page">
          <div className="people-page-heading">
            <div>
              <h2>People</h2>
              <p>
                Manage the people who can be assigned to calendar events.
              </p>
            </div>
          </div>

          <div className="people-page-layout people-management-layout">
            <div className="card people-editor-card">
              <h2>
                {editingPersonId !== null
                  ? 'Edit Person'
                  : 'Add Person'}
              </h2>

              <form
                className="people-form"
                onSubmit={savePerson}
              >
                <div className="event-field">
  <span>Name</span>

  <input
  className={`event-input person-name-display ${
    personName === ''
      ? 'person-name-display-placeholder'
      : ''
  }`}
  type="text"
  readOnly
  placeholder="Family member name"
  value={personName}
 onClick={(event) => {
  const nextPosition =
    event.currentTarget.selectionStart ??
    personName.length

  personCursorPositionRef.current =
    nextPosition

  setPersonCursorPosition(
    nextPosition
  )

  setPersonKeyboardOpen(true)
}}
onSelect={(event) => {
  const nextPosition =
    event.currentTarget.selectionStart ??
    personName.length

  personCursorPositionRef.current =
    nextPosition

  setPersonCursorPosition(
    nextPosition
  )
}}
/>
</div>

                <div className="event-field">
  <span>Color</span>

  <div className="person-color-palette">
    {personColorOptions.map((option) => {
      const isSelected =
        personColor.toLowerCase() ===
        option.color.toLowerCase()

      return (
        <button
          type="button"
          key={option.color}
          className={`person-color-swatch ${
            isSelected
              ? 'person-color-swatch-selected'
              : ''
          }`}
          style={{
            backgroundColor: option.color,
          }}
          title={option.name}
          aria-label={option.name}
          onClick={() =>
            setPersonColor(option.color)
          }
        />
      )
    })}

    <label
      className={`person-color-custom ${
        !personColorOptions.some(
          (option) =>
            option.color.toLowerCase() ===
            personColor.toLowerCase()
        )
          ? 'person-color-custom-selected'
          : ''
      }`}
      title="Custom color"
    >
      

      <input
        className="person-color-custom-input"
        type="color"
        value={personColor}
        onChange={(event) =>
          setPersonColor(event.target.value)
        }
      />
    </label>
  </div>
</div>

                <label className="event-field">
                  Photo
                  <input
                    key={personFileInputKey}
                    className="person-file-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handlePersonImageChange}
                  />
                </label>

                {personImagePreview !== '' && (
                  <div className="person-preview-block">
                    <img
                      className="person-image-preview"
                      src={personImagePreview}
                      alt="Person preview"
                    />
                  </div>
                )}

                <button
                  className="add-event-button"
                  type="submit"
                >
                  {editingPersonId !== null
                    ? 'Save Person'
                    : 'Add Person'}
                </button>

                {editingPersonId !== null && (
                  <button
                    className="cancel-button"
                    type="button"
                    onClick={() => {
  clearPersonForm()
}}
                  >
                    Cancel
                  </button>
                )}
              </form>
            </div>

            <div className="people-grid">
              {people.length === 0 ? (
                <div className="card">
                  <p>No people added yet.</p>
                </div>
              ) : (
                people.map((person) => (
  <div
    className={`person-card ${
      draggedPersonId === person.id
        ? 'person-card-dragging'
        : ''
    }`}
    key={person.id}
    draggable
    onDragStart={(event) => {
      setDraggedPersonId(person.id)

      event.dataTransfer.effectAllowed =
        'move'

      event.dataTransfer.setData(
        'text/plain',
        String(person.id)
      )
    }}
    onDragOver={(event) => {
  event.preventDefault()

  event.dataTransfer.dropEffect =
    'move'

  if (
    draggedPersonId !== null &&
    draggedPersonId !== person.id
  ) {
    movePersonDuringDrag(
      draggedPersonId,
      person.id
    )
  }
}}
onDrop={(event) => {
  event.preventDefault()

  void savePeopleOrder()

  setDraggedPersonId(null)
}}
    onDragEnd={() => {
      setDraggedPersonId(null)
    }}
  >
                    {renderPersonAvatar(person, 'person-card-avatar')}

                    <h3>{person.name}</h3>

                    <div className="person-color-row">
                      <span
                        className="person-color-dot"
                        style={{
                          backgroundColor: person.color,
                        }}
                      />

                      <span>{person.color}</span>
                    </div>

                    <div className="person-card-actions">
                      <button
                        type="button"
                        onClick={() =>
                          startEditingPerson(person)
                        }
                      >
                        Edit
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          deletePerson(person)
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          {personKeyboardOpen &&
  createPortal(
    <div
      className="person-keyboard-overlay"
      onClick={() => {
        setPersonKeyboardOpen(false)
      }}
    >
      <div
        className="meal-picker-keyboard person-keyboard"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="meal-picker-keyboard-header">
          <div>
            <span className="meals-page-eyebrow">
              Person Name
            </span>

 <div
  className="person-keyboard-name-custom-editor"
  onPointerDown={(event) => {
    if (event.target !== event.currentTarget) {
      return
    }

    const nextPosition =
      personName.length

    personCursorPositionRef.current =
      nextPosition

    setPersonCursorPosition(
      nextPosition
    )
  }}
>
  {personName === '' ? (
    <span
      className="person-keyboard-name-empty"
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()

        personCursorPositionRef.current = 0
        setPersonCursorPosition(0)
      }}
    >
      <span className="person-keyboard-caret person-keyboard-caret-start" />
      Enter a name
    </span>
  ) : (
    personName
      .split('')
      .map((character, index) => (
        <span
          className="person-keyboard-name-character"
          key={`${index}-${character}`}
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()

            const bounds =
              event.currentTarget.getBoundingClientRect()

            const nextPosition =
              event.clientX <
              bounds.left +
                bounds.width / 2
                ? index
                : index + 1

            personCursorPositionRef.current =
              nextPosition

            setPersonCursorPosition(
              nextPosition
            )
          }}
        >
          {personCursorPosition ===
            index && (
            <span className="person-keyboard-caret person-keyboard-caret-before" />
          )}

          {character === ' '
            ? '\u00A0'
            : character}

          {index ===
            personName.length - 1 &&
            personCursorPosition ===
              personName.length && (
              <span className="person-keyboard-caret person-keyboard-caret-after" />
            )}
        </span>
      ))
  )}
</div>
          </div>

          <button
            type="button"
            className="meal-picker-keyboard-close"
            aria-label="Close keyboard"
            onClick={() => {
              setPersonKeyboardOpen(false)
            }}
          >
            &#215;
          </button>
        </div>

       <div className="meal-picker-keyboard-rows">
  <div className="meal-picker-keyboard-row">
    {'QWERTYUIOP'
      .split('')
      .map((letter) => (
        <button
          type="button"
          className="meal-picker-key"
          key={letter}
          onClick={() => {
            typePersonLetter(letter)
          }}
        >
          {letter}
        </button>
      ))}
  </div>

  <div className="meal-picker-keyboard-row meal-picker-keyboard-row-middle">
    <button
  type="button"
  className={`meal-picker-key person-keyboard-caps ${
    personCapsLockActive
      ? 'person-keyboard-key-active'
      : ''
  }`}
  onClick={() => {
    setPersonCapsLockActive(
      (current) => !current
    )

    setPersonShiftActive(false)
  }}
>
  Caps
</button>
    {'ASDFGHJKL'
      .split('')
      .map((letter) => (
        <button
          type="button"
          className="meal-picker-key"
          key={letter}
          onClick={() => {
            typePersonLetter(letter)
          }}
        >
          {letter}
        </button>
      ))}
  </div>

  <div className="meal-picker-keyboard-row meal-picker-keyboard-row-bottom">
    <button
  type="button"
  className={`meal-picker-key person-keyboard-shift ${
    personShiftActive
      ? 'person-keyboard-key-active'
      : ''
  }`}
  onClick={() => {
    setPersonShiftActive(
      (current) => !current
    )
  }}
>
  ⇧
</button>
    {'ZXCVBNM'
      .split('')
      .map((letter) => (
        <button
          type="button"
          className="meal-picker-key"
          key={letter}
          onClick={() => {
            typePersonLetter(letter)
          }}
        >
          {letter}
        </button>
      ))}

    <button
      type="button"
      className="meal-picker-key meal-picker-key-backspace"
      onClick={() => {
        backspacePersonName()
      }}
    >
      Backspace
    </button>
  </div>
</div>

<div className="meal-picker-keyboard-actions">
  <button
    type="button"
    className="meal-picker-keyboard-action"
    onClick={() => {
      setPersonName('')
      personNameRef.current = ''
      personCursorPositionRef.current = 0
      setPersonCursorPosition(0)
    }}
  >
    Clear
  </button>

  <button
    type="button"
    className="meal-picker-keyboard-space"
    onClick={() => {
      insertPersonNameText(' ')
    }}
  >
    Space
  </button>

  <button
    type="button"
    className="meal-picker-keyboard-action"
    onClick={() => {
      setPersonKeyboardOpen(false)
    }}
  >
    Done
  </button>
</div>

       
      </div>
    </div>,
    document.body
  )}
  {personDeleteTarget &&
  createPortal(
    <div
      className="person-delete-overlay"
      onClick={() => {
        setPersonDeleteTarget(null)
      }}
    >
      <div
        className="person-delete-dialog"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="person-delete-content">
          <span className="people-page-eyebrow">
            Delete Person
          </span>

          <h3>
            Delete {personDeleteTarget.name}?
          </h3>

          <p>
            Their calendar events will remain.
            This only removes their profile.
          </p>
        </div>

        <div className="person-delete-actions">
          <button
            type="button"
            className="person-delete-button"
            onClick={() => {
              void confirmDeletePerson()
            }}
          >
            Delete
          </button>

          <button
            type="button"
            className="person-delete-cancel"
            onClick={() => {
              setPersonDeleteTarget(null)
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  )}
        </section>
      )}

{page === 'capture' && (
  <section className="people-page capture-inbox-page">
    <div className="people-page-heading">
      <div>
        <h2>Capture Inbox</h2>

        <p>
          Photos, screenshots, links, and other
          items waiting to be organized.
        </p>
      </div>
    </div>

    {captureInbox.length === 0 ? (
      <div className="card">
        <p>
          Nothing is waiting in Capture Inbox.
        </p>
      </div>
    ) : (
      <div className="capture-inbox-grid">
        {captureInbox.map((capture) => (
          <article
  className="card capture-inbox-card"
  key={capture.id}
  role="button"
  tabIndex={0}
  onClick={() => {
    setSelectedCaptureId(capture.id)
  }}
  onKeyDown={(event) => {
    if (
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      event.preventDefault()
      setSelectedCaptureId(capture.id)
    }
  }}
>
            <div className="capture-inbox-image">
              <img
  src={`/uploads/thumb-${capture.image.replace(
    /\.[^/.]+$/,
    ''
  )}.webp`}
  alt={
    capture.originalName ??
    'Capture Inbox image'
  }
  loading="lazy"
  decoding="async"
  onError={(event) => {
    const image =
      event.currentTarget

    const originalSource =
      `/uploads/${capture.image}`

    if (
      image.src.endsWith(
        originalSource
      )
    ) {
      return
    }

    image.src =
      originalSource
  }}
/>
            </div>

            <div className="capture-inbox-card-content">
              <div className="capture-inbox-card-top">
                <span className="quick-add-eyebrow">
  {capture.captureType
    ? capture.captureType === 'event'
      ? 'Event'
      : capture.captureType === 'recipe'
        ? 'Recipe'
        : capture.captureType === 'list'
          ? 'List'
          : 'Other'
    : 'New'}
</span>

                <span>
                  #{capture.id}
                </span>
              </div>

              {capture.note && (
                <p>{capture.note}</p>
              )}

              <small>
                {capture.createdAt}
              </small>
              <button
  type="button"
  className="capture-inbox-delete-button"
 onClick={(event) => {
  event.stopPropagation()

  void deleteCaptureInboxItem(
    capture
  )
}}
>
  Delete
</button>
            </div>
          </article>
        ))}
      </div>
    )}
  </section>
)}

{selectedCaptureId !== null &&
createPortal(
  <div
    className="capture-detail-overlay"
    onClick={() => {
      setSelectedCaptureId(null)
    }}
  >
    {captureInbox
      .filter(
        (capture) =>
          capture.id === selectedCaptureId
      )
      .map((capture) => (
        <div
          className="capture-detail-card"
          key={capture.id}
          onClick={(event) => {
            event.stopPropagation()
          }}
        >
          <div className="capture-detail-header">
            <div>
              <span className="quick-add-eyebrow">
                Capture Inbox
              </span>

              <h2>Captured Item</h2>
            </div>

            <button
              type="button"
              className="capture-detail-close"
              aria-label="Close Capture"
              onClick={() => {
                setSelectedCaptureId(null)
              }}
            >
              ×
            </button>
          </div>

          <div className="capture-detail-image">
            <img
              src={`/uploads/${capture.image}`}
              alt={
                capture.originalName ??
                'Capture Inbox image'
              }
            />
          </div>

          <div className="capture-detail-information">
            <div className="capture-detail-status-row">
              <span className="quick-add-eyebrow">
                {capture.status}
              </span>

              <span>
                #{capture.id}
              </span>
            </div>

            {capture.note && (
              <p>{capture.note}</p>
            )}

            <small>
              {capture.createdAt}
            </small>
            <div className="capture-type-section">
  <span className="capture-type-label">
    What is this?
  </span>

  <div className="capture-type-options">
    <button
      type="button"
      className={`capture-type-button ${
        capture.captureType === 'event'
          ? 'capture-type-button-active'
          : ''
      }`}
      onClick={() => {
        void updateCaptureType(
          capture.id,
          'event'
        )
      }}
    >
      Event
    </button>

    <button
      type="button"
      className={`capture-type-button ${
        capture.captureType === 'recipe'
          ? 'capture-type-button-active'
          : ''
      }`}
      onClick={() => {
        void updateCaptureType(
          capture.id,
          'recipe'
        )
      }}
    >
      Recipe
    </button>

    <button
      type="button"
      className={`capture-type-button ${
        capture.captureType === 'list'
          ? 'capture-type-button-active'
          : ''
      }`}
      onClick={() => {
        void updateCaptureType(
          capture.id,
          'list'
        )
      }}
    >
      List
    </button>

    <button
      type="button"
      className={`capture-type-button ${
        capture.captureType === 'other'
          ? 'capture-type-button-active'
          : ''
      }`}
      onClick={() => {
        void updateCaptureType(
          capture.id,
          'other'
        )
      }}
    >
      Other
    </button>
  </div>
</div>
<button
  type="button"
  className="capture-analyze-button"
  disabled={
    captureAnalyzingId ===
    capture.id
  }
  onClick={(event) => {
    event.stopPropagation()

    void analyzeCapture(
      capture.id
    )
  }}
>
  {captureAnalyzingId ===
  capture.id
    ? 'Analyzing...'
    : capture.analysisStatus ===
        'complete'
      ? 'Analyze Again'
      : 'Analyze Capture'}
</button>

<CaptureAnalysisPreview
  capture={capture}
/>

{capture.captureType &&
capture.captureType !== 'other' && (
  <button
    type="button"
    className="capture-handoff-button"
    onClick={() => {
      openCaptureDestination(
        capture
      )
    }}
  >
    {capture.captureType === 'event'
      ? 'Create Event'
      : capture.captureType === 'recipe'
        ? 'Create Recipe'
        : 'Add to List'}
  </button>
)}

          </div>

          <button
            type="button"
            className="capture-inbox-delete-button"
            onClick={() => {
              void deleteCaptureInboxItem(
                capture
              )
            }}
          >
            Delete
          </button>
        </div>
      ))}
  </div>,
  document.body
)}

      {page === 'lists' && (
  <section className="people-page lists-overview">
    {/* Reference-matched layered scallop/sweep artwork behind the Lists heading.
        Kept as live vector paths so future theme colors can recolor every band. */}
    <svg className="lists-reference-header-waves" viewBox="0 0 864 320"
      preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="lists-wave-field" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--lists-header-base)" />
          <stop offset="60%" stopColor="var(--lists-header-warm)" />
          <stop offset="100%" stopColor="var(--lists-header-base)" />
        </linearGradient>
        <linearGradient id="lists-wave-light" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--lists-wave-ivory)" />
          <stop offset="60%" stopColor="var(--lists-wave-mist)" />
          <stop offset="100%" stopColor="var(--lists-wave-ivory)" />
        </linearGradient>
        <linearGradient id="lists-wave-depth" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--lists-wave-shadow)" />
          <stop offset="58%" stopColor="var(--lists-header-warm)" />
          <stop offset="100%" stopColor="var(--lists-wave-mist)" />
        </linearGradient>
      </defs>
      <rect width="864" height="320" fill="url(#lists-wave-field)" />
      <path d="M0 0H864V110C757 47 700 39 575 80C449 121 389 172 272 135C159 100 69 111 0 82Z"
        fill="url(#lists-wave-light)" opacity=".65" />
      <path d="M0 0H864V31C761 18 671 84 568 109C433 145 369 81 266 67C166 53 91 102 0 78Z"
        fill="var(--lists-wave-ivory)" opacity=".55" />
      <path d="M0 130C130 84 219 88 324 143C443 205 528 146 653 106C746 75 816 86 864 99V320H0Z"
        fill="url(#lists-wave-depth)" opacity=".5" />
      <path d="M0 177C144 137 195 126 305 163C435 210 514 176 643 130C729 100 814 91 864 113V320H0Z"
        fill="var(--lists-header-warm)" opacity=".47" />
      <path d="M0 241C131 223 249 249 368 268C492 288 581 237 688 235C763 234 815 256 864 247V320H0Z"
        fill="var(--lists-header-base)" opacity=".6" />
    </svg>
    <div className="people-page-heading lists-overview-heading">
      <div>
        <h2>Lists</h2>
        <p>
          Shared lists for groceries, chores, shopping,
          packing, and more.
        </p>
      </div>
    </div>

    <div className="people-grid list-page-grid">
      {lists.length === 0 ? (
        <div className="card">
          <p>No lists created yet.</p>
        </div>
      ) : (
        lists.map((list) => (
          <button
            className="person-card list-card-button themed-list-card"
            key={list.id}
            style={{
              '--list-icon-tone': getListIconOption(list.icon)?.tone ?? '#8795a8',
            } as CSSProperties}
            type="button"
           onClick={() => {
  setSelectedListId(list.id)
  setNewListItemText('')
  setNewListItemCategory('General')
  setNewListCategoryManuallySet(false)
  setListCategoryFilter('All')
  setListSortMode(list.store_enabled ? 'store' : 'category')
  setStoreFilter('all')
  setListItemAddOpen(false)
  setListMoreOpen(false)
  setOpenListSwipe(null)
  setEditingListName(list.name)
  if (list.store_enabled) void sortListByStores(list.id, false)
  setListNameEditing(false)
}}
          >
            <span className={`themed-list-card-icon ${list.icon ? '' : 'themed-list-icon-neutral'}`}>
              <ListIcon id={list.icon} width={26} height={26} />
            </span>
            <span className="themed-list-card-divider" aria-hidden="true" />
            <span className="themed-list-card-copy">
              <span className="themed-list-card-name">{list.name}</span>
              <span className="themed-list-card-count">
                {list.items.length} {list.items.length === 1 ? 'item' : 'items'}
              </span>
            </span>
            <span className="themed-list-card-chevron" aria-hidden="true">›</span>
          </button>
        ))
      )}
    </div>

    <button
      className="calendar-floating-add"
      type="button"
      aria-label="Create list"
      onClick={() => {
        setNewListName('')
        setNewListIcon(null)
        setListIconPickerTarget(null)
        setListCreateOpen(true)
      }}
    >
      <span className="calendar-floating-add-plus">
        +
      </span>
    </button>

    {listCreateOpen &&
      createPortal(
        <div className="list-modal-overlay list-create-sheet-overlay"
          onClick={() => {
            setListCreateOpen(false)
            setNewListName('')
            setNewListIcon(null)
            setListIconPickerTarget(null)
          }}>
          <section className="list-modal list-create-modal list-create-bottom-sheet"
            role="dialog" aria-modal="true" aria-labelledby="list-create-title"
            onClick={event => event.stopPropagation()}>
            <div className="list-create-sheet-handle" aria-hidden="true"/>
            <div className="list-create-sheet-toolbar">
              <button type="button" className="list-create-sheet-cancel"
                onClick={() => {
                  setListCreateOpen(false)
                  setNewListName('')
                  setNewListIcon(null)
                  setListIconPickerTarget(null)
                }}>Cancel</button>
              <h2 id="list-create-title">Create List</h2>
              <button className="list-create-sheet-submit" type="submit"
                form="list-create-main-form" disabled={!newListName.trim()}>
                Create
              </button>
            </div>
            <form id="list-create-main-form"
              className="people-form list-create-form"
              onSubmit={createList}>
              <div className="list-create-fields">
                <div className="list-create-main-row">
                  <button className="list-create-icon-chooser" type="button"
                    onClick={() => setListIconPickerTarget('create')}
                    aria-label={newListIcon ? 'Change list icon' : 'Add a list icon'}
                    title={newListIcon ? 'Change icon' : 'Add icon'}>
                    <span className={newListIcon ? 'list-create-icon-spot selected' : 'list-create-icon-spot'}
                      style={newListIcon
                        ? { backgroundColor: getListIconOption(newListIcon)?.tone }
                        : undefined}>
                      {newListIcon
                        ? <ListIcon id={newListIcon} width={30} height={30}/>
                        : <span className="list-create-icon-plus" aria-hidden="true">+</span>}
                    </span>
                  </button>
                  <label className="list-create-name-field">
                    <span className="list-create-field-heading">List Name</span>
                    <input className="event-input list-create-name-input"
                      type="text" placeholder="e.g. Groceries, Work, Travel..."
                      maxLength={100} value={newListName}
                      onChange={event => setNewListName(event.target.value)}
                    />
                  </label>
                </div>
              </div>
            </form>
          </section>
        </div>, document.body
      )}

    {listIconPickerTarget !== null && createPortal(
      <div className="list-icon-picker-overlay"
        onClick={() => setListIconPickerTarget(null)}>
        <section className="list-icon-picker-modal" role="dialog" aria-modal="true"
          aria-labelledby="list-icon-picker-title" onClick={event => event.stopPropagation()}>
          <div className="list-icon-picker-handle" aria-hidden="true"/>
          <div className="list-icon-picker-heading">
            <h2 id="list-icon-picker-title">Choose an icon</h2>
            <button type="button" className="list-icon-picker-close"
              aria-label="Close icon picker" onClick={() => setListIconPickerTarget(null)}>×</button>
          </div>
          <div className="list-icon-picker-grid">
            {LIST_ICON_OPTIONS.map(option => (
              <button type="button" key={option.id}
                aria-label={option.label}
                aria-pressed={listIconPickerTarget === 'create'
                  ? newListIcon === option.id
                  : lists.find(list => list.id === listIconPickerTarget)?.icon === option.id}
                className="list-icon-picker-choice"
                onClick={() => {
                  const target = listIconPickerTarget
                  if (target === 'create') setNewListIcon(option.id)
                  else if (typeof target === 'number') void changeExistingListIcon(target, option.id)
                  setListIconPickerTarget(null)
                }}>
                <span className="list-icon-choice-art" style={{backgroundColor: option.tone}}>
                  <ListIcon id={option.id} width={25} height={25}/>
                </span>
              </button>
            ))}
          </div>
          <button type="button" className="list-icon-clear-choice" onClick={() => {
            const target = listIconPickerTarget
            if (target === 'create') setNewListIcon(null)
            else if (typeof target === 'number') void changeExistingListIcon(target, null)
            setListIconPickerTarget(null)
          }}>No icon</button>
        </section>
      </div>, document.body
    )}

    {selectedListId !== null &&
      createPortal(
        <div
          className="list-modal-overlay"
          onClick={() => {
            setSelectedListId(null)
            setListItemAddOpen(false)
            setListMoreOpen(false)
            setOpenListSwipe(null)
            setNewListItemText('')
            setEditingListItemId(null)
            setEditingListItemText('')
          }}
        >
          <div
            className="list-modal list-detail-modal"
            onClickCapture={event => {
              if (!openListSwipe) return
              const row = (event.target as HTMLElement).closest<HTMLElement>('.list-item-swipe-shell')
              if (!row || row.dataset.listItemId !== String(openListSwipe.itemId)) {
                setOpenListSwipe(null)
              }
            }}
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            {(() => {
              const selectedList =
                lists.find(
                  (list) =>
                    list.id ===
                    selectedListId
                )

              if (!selectedList) {
                return null
              }
              const storeSortingEnabled = selectedList.store_enabled === true
              const categoryOptions = Array.from(new Set(
                selectedList.items.map(item => item.category || 'General')
              )).sort((x, y) => x.localeCompare(y))
              const filteredItems = selectedList.items.filter(item =>
                listCategoryFilter === 'All' || (item.category || 'General') === listCategoryFilter
              )
              const categoryRank = (item: ListItem) => {
                const category = item.category || 'General'
                if (category === 'General') return 9999
                const index = SUGGESTED_LIST_CATEGORIES.indexOf(category)
                return index < 0 ? SUGGESTED_LIST_CATEGORIES.length : index
              }
              const categoryCompare = (x: ListItem, y: ListItem) =>
                categoryRank(x) - categoryRank(y)
                || (x.category || 'General').localeCompare(y.category || 'General')
                || x.id - y.id
              const storeRank = (item: ListItem) =>
                shoppingStores.find(store => store.id === item.store_id)?.sort_order ?? Number.MAX_SAFE_INTEGER
              const customSorting = listSortMode === 'custom'
              const orderedItems = customSorting ? filteredItems
                : storeSortingEnabled
                  ? [...filteredItems].sort((x, y) => storeRank(x) - storeRank(y)
                      || ((x.store_id ?? 0) - (y.store_id ?? 0))
                      || categoryCompare(x, y))
                  : [...filteredItems].sort(categoryCompare)
              const storeVisibleItems = storeSortingEnabled && storeFilter !== 'all'
                ? orderedItems.filter(item => storeFilter === 'unsorted'
                    ? item.store_id == null : item.store_id === Number(storeFilter))
                : orderedItems
              const visibleStores = shoppingStores.filter(store =>
                store.enabled || selectedList.items.some(item => item.store_id === store.id))
              const canReorderList = customSorting && listCategoryFilter === 'All'
                && (!storeSortingEnabled || storeFilter === 'all')
              const canOrganizeExisting = selectedList.items.some(item =>
                (item.category || 'General') === 'General' && suggestListCategory(item.text) !== null)
              return (
                <>
                  <div className="list-modal-header">
                   <div className="list-title-area">
  <span className="quick-add-eyebrow">
    List
  </span>

  {listNameEditing ? (
    <form
      className="list-inline-rename"
      onSubmit={renameList}
    >
      <input
        className="event-input"
        type="text"
        value={editingListName}
        onChange={(event) => {
          setEditingListName(
            event.target.value
          )
        }}
        autoFocus
      />

      <div className="list-inline-rename-actions">
        <button
          className="list-inline-save"
          type="submit"
          disabled={
            editingListName.trim() === ''
          }
        >
          Save
        </button>

        <button
          className="list-inline-cancel"
          type="button"
          onClick={() => {
            setEditingListName(
              selectedList.name
            )
            setListNameEditing(false)
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  ) : (
    <div className="list-title-row">
      <button type="button" className="list-detail-icon-edit"
        aria-label="Change list icon" title="Change list icon"
        style={{
          '--list-icon-tone': getListIconOption(selectedList.icon)?.tone ?? '#8795a8',
        } as CSSProperties}
        onClick={() => setListIconPickerTarget(selectedList.id)}>
        <ListIcon id={selectedList.icon} width={22} height={22} />
      </button>
      <h2>
        {selectedList.name}
      </h2>

      <button
        className="list-title-edit-button"
        type="button"
        aria-label="Rename list"
        title="Rename list"
        onClick={() => {
          setEditingListName(
            selectedList.name
          )
          setListNameEditing(true)
        }}
      >
        &#9998;
      </button>
    </div>
  )}

  <p className="list-header-count">
    {selectedList.items.length} {selectedList.items.length === 1 ? 'item' : 'items'}
    {storeSortingEnabled && <span className="list-compact-sorting-status">Store sorting: On</span>}
  </p>
</div>

                    <button
                      className="quick-add-close"
                      type="button"
                      aria-label="Close list"
                      onClick={() => {
                        setSelectedListId(null)
                        setListItemAddOpen(false)
                        setListMoreOpen(false)
                        setOpenListSwipe(null)
                        setNewListItemText('')
                        setEditingListItemId(
                          null
                        )
                        setEditingListItemText(
                          ''
                        )
                      }}
                    >
                      ×
                    </button>
                  </div>

                  <div className="list-compact-actions">
                    <button className="list-add-primary" type="button" onClick={() => {
                      setNewListItemText('')
                      setNewListItemCategory('General')
                      setNewListCategoryManuallySet(false)
                      setListMoreOpen(false)
                      setListItemAddOpen(true)
                    }}>+ Add Item</button>
                    {storeSortingEnabled && <button className="list-ask-arney"
                      type="button" disabled={storeSortBusy}
                      onClick={() => void sortListByStores(selectedList.id, true)}>
                      {storeSortBusy ? 'Sorting…' : '✦ Ask Arney'}
                    </button>}
                    <div className="list-more-control">
                      <button className="list-more-button" type="button"
                        aria-haspopup="menu" aria-expanded={listMoreOpen}
                        onClick={() => setListMoreOpen(open => !open)}>••• More</button>
                      {listMoreOpen && <div className="list-more-menu" role="menu">
                        {storeSortingEnabled && <button role="menuitem" type="button"
                          disabled={storeSortBusy}
                          onClick={() => {setListMoreOpen(false);void sortListByStores(selectedList.id, false)}}>
                          Sort stores again</button>}
                        <button role="menuitem" type="button"
                          onClick={() => {
                            setListMoreOpen(false)
                            setStoreFilter('all')
                            setListCategoryFilter('All')
                            setListSortMode(customSorting ? (storeSortingEnabled ? 'store' : 'category') : 'custom')
                          }}>
                          {customSorting ? 'Use automatic sorting' : 'Custom order (drag)'}</button>
                        <button role="menuitem" type="button" disabled={isOrganizingList || !canOrganizeExisting}
                          onClick={() => {setListMoreOpen(false);void organizeExistingList(selectedList.id)}}>
                          Organize existing categories</button>
                        {!storeSortingEnabled && <button role="menuitem" type="button"
                          onClick={() => {setListMoreOpen(false);void enableStoreSorting(selectedList.id, true)}}>
                          Enable store sorting</button>}
                        {storeSortingEnabled && <button role="menuitem" type="button"
                          onClick={() => {setListMoreOpen(false);void enableStoreSorting(selectedList.id, false)}}>
                          Disable store sorting</button>}
                        <button role="menuitem" type="button" disabled={!selectedList.items.some(item => item.completed)}
                          onClick={() => {setListMoreOpen(false);void clearCompletedItems()}}>Clear completed</button>
                      </div>}
                    </div>
                  </div>

                  <datalist id="list-category-suggestions">
                    {['General', ...SUGGESTED_LIST_CATEGORIES, 'Other'].map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                  {storeSortingEnabled && <div className="shopping-store-tabs" role="group" aria-label="Filter shopping items by store">
                    <button type="button" className={storeFilter === 'all' ? 'selected' : ''}
                      aria-pressed={storeFilter === 'all'} onClick={() => setStoreFilter('all')}>All</button>
                    {visibleStores.map(store => <button type="button" key={store.id}
                      className={storeFilter === String(store.id) ? 'selected' : ''}
                      aria-pressed={storeFilter === String(store.id)}
                      onClick={() => setStoreFilter(String(store.id))}>{store.name}{!store.enabled ? ' (hidden)' : ''}</button>)}
                    <button type="button" className={storeFilter === 'unsorted' ? 'selected' : ''}
                      aria-pressed={storeFilter === 'unsorted'} onClick={() => setStoreFilter('unsorted')}>Unsorted</button>
                  </div>}
                  <div className="list-category-toolbar">
                    <label htmlFor="list-category-filter">Show category</label>
                    <select
                      id="list-category-filter"
                      className="event-input"
                      value={listCategoryFilter}
                      onChange={(event) => setListCategoryFilter(event.target.value)}
                    >
                      <option value="All">All ({selectedList.items.length})</option>
                      {categoryOptions.map((category) => (
                        <option key={category} value={category}>{category}</option>
                      ))}
                    </select>
                  </div>
                  <div className="list-items">
                    {selectedList.items.length === 0 ? (
                      <p>No items yet.</p>
                    ) : storeVisibleItems.length === 0 ? (
                      <p>No items in this category.</p>
                    ) : (
                      <DndContext
                        sensors={sensors}
                        collisionDetection={
                          closestCenter
                        }
                        onDragEnd={
                          handleListDragEnd
                        }
                      >
                        <SortableContext
                          items={storeVisibleItems.map(
                            (item) =>
                              item.id
                          )}
                          strategy={
                            verticalListSortingStrategy
                          }
                        >
                          {storeVisibleItems.map((item, index) => (
                            <Fragment key={item.id}>
                              {storeSortingEnabled && storeFilter === 'all'
                                && !customSorting && (index === 0 || storeVisibleItems[index - 1].store_id !== item.store_id)
                                && <div className="list-store-group-heading">
                                  {shoppingStores.find(store => store.id === item.store_id)?.name ?? 'Unsorted'}
                                  <span>({storeVisibleItems.filter(entry => entry.store_id === item.store_id).length})</span>
                                </div>}
                              <SortableListItem
                                key={
                                  item.id
                                }
                                item={item}
                                isEditing={
                                  editingListItemId ===
                                  item.id
                                }
                                editingText={
                                  editingListItemText
                                }
                                editingCategory={editingListItemCategory}
                                editingStoreId={editingListItemStoreId}
                                showStore={Boolean(storeSortingEnabled)}
                                stores={shoppingStores}
                                canDrag={canReorderList}
                                onEditingTextChange={
                                  setEditingListItemText
                                }
                                onEditingCategoryChange={setEditingListItemCategory}
                                onEditingStoreChange={id => {setEditingListItemStoreId(id); setEditingListItemStoreChanged(true)}}
                                onStartEdit={
                                  startEditingListItem
                                }
                                onSaveEdit={
                                  saveListItemEdit
                                }
                                onCancelEdit={
                                  cancelEditingListItem
                                }
                                onToggle={
                                  toggleListItem
                                }
                                onDelete={
                                  deleteListItem
                                }
                                swipeSide={openListSwipe?.itemId === item.id ? openListSwipe.side : null}
                                onSwipeChange={side => setOpenListSwipe(
                                  side === null ? null : { itemId: item.id, side }
                                )}
                              />
                            </Fragment>
                          ))}
                        </SortableContext>
                      </DndContext>
                    )}
                  </div>
                  <div className="list-delete-footer">
  <button
  className="event-details-delete-button"
  type="button"
  aria-label="Delete list"
  title="Delete list"
  onClick={() => {
    deleteList(selectedList.id)
  }}
>
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
</button>
</div>
                </>
              )
            })()}
          </div>
        </div>,
        document.body
      )}
    {selectedListId !== null && listItemAddOpen && createPortal(
      <div className="list-item-add-overlay" onClick={() => setListItemAddOpen(false)}>
        <section className="list-item-add-sheet" role="dialog" aria-modal="true"
          aria-labelledby="list-item-add-heading" onClick={event => event.stopPropagation()}>
          <div className="list-item-add-handle" aria-hidden="true" />
          <div className="list-item-add-heading">
            <h2 id="list-item-add-heading">Add Item</h2>
            <button type="button" aria-label="Close Add Item" className="list-item-add-close"
              onClick={() => setListItemAddOpen(false)}>×</button>
          </div>
          <form className="list-item-add-form" onSubmit={addListItem}>
            <label className="event-field">Item name
              <input className="event-input" type="text" maxLength={200}
                placeholder="Example: Milk" value={newListItemText}
                onChange={event => {
                  const next = event.target.value
                  setNewListItemText(next)
                  if (!newListCategoryManuallySet) setNewListItemCategory(suggestListCategory(next) || 'General')
                }}
              />
            </label>
            <label className="event-field">Category
              <input className="event-input" type="text" maxLength={40}
                list="list-category-suggestions" value={newListItemCategory}
                placeholder="General, Produce, Dairy..."
                onChange={event => {setNewListItemCategory(event.target.value);setNewListCategoryManuallySet(true)}} />
            </label>
            <div className="list-item-add-buttons">
              <button type="button" className="list-item-add-cancel"
                onClick={() => setListItemAddOpen(false)}>Cancel</button>
              <button type="submit" className="list-item-add-save" disabled={!newListItemText.trim()}>Save</button>
            </div>
          </form>
        </section>
      </div>, document.body
    )}
  </section>
)}
{shoppingStoreSettingsOpen && createPortal(
  <div className="shopping-store-settings-overlay" onClick={() => setShoppingStoreSettingsOpen(false)}>
    <section className="shopping-store-settings-panel" role="dialog" aria-modal="true"
      aria-labelledby="shopping-stores-heading" onClick={event => event.stopPropagation()}>
      <div className="shopping-store-settings-header">
        <h2 id="shopping-stores-heading">Shopping Stores</h2>
        <button className="shopping-store-settings-close" type="button" aria-label="Close shopping store settings"
          onClick={() => setShoppingStoreSettingsOpen(false)}>×</button>
      </div>
      <p>Choose stores for automatic sorting. Hidden stores keep their items and saved preferences.</p>
      <div className="shopping-store-settings-list">
        {shoppingStores.map((store, index) => (
          <div className="shopping-store-settings-row" key={store.id}>
            <label><input type="checkbox" checked={store.enabled}
              onChange={event => void updateShoppingStore(store.id,{enabled:event.target.checked})} />
              <span>{store.name}</span></label>
            <div className="shopping-store-move-buttons">
              <button type="button" disabled={index === 0} aria-label={'Move ' + store.name + ' earlier'}
                onClick={() => void moveShoppingStore(store.id, -1)}>↑</button>
              <button type="button" disabled={index === shoppingStores.length - 1}
                aria-label={'Move ' + store.name + ' later'}
                onClick={() => void moveShoppingStore(store.id, 1)}>↓</button>
            </div>
          </div>
        ))}
      </div>
      <form className="shopping-store-add" onSubmit={addShoppingStore}>
        <label htmlFor="shopping-store-new">Add custom store</label>
        <div><input className="event-input" type="text" id="shopping-store-new"
          maxLength={50} value={newShoppingStoreName}
          onChange={event => setNewShoppingStoreName(event.target.value)}
          placeholder="Store name" />
          <button type="submit" disabled={!newShoppingStoreName.trim()}>Add</button>
        </div>
      </form>
      <p className="shopping-stores-footnote">Suggestions are preferences, not live inventory or pricing. Arney runs locally only when you request it.</p>
    </section>
  </div>, document.body
)}
    </main>
  )
}

export default App