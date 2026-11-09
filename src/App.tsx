Warning: truncated output (original token count: 137515)
Total output lines: 24511

import { normalizePersonPhoto } from './normalizePersonPhoto'
import {
  Fragment,
  useEffect,
  useCallback,
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
import { arneySpeechAvailable, beginArneySpeech, getArneySpeechDiagnostics, speakArneyReply, stopArneyReply } from './arneySpeech'
import { arneyLocalSpeechAvailable, beginArneyLocalSpeech } from './arneyLocalSpeech'
import { describeArneyError, describeArneyIntent, describeArneyPreview, shouldSpeakArneyReply, type ArneyReply } from './arneyResponses'
import { readArneyPreferences } from './arneyPreferences'
import { createArneyPlusHoldController, type ArneyPlusHoldController } from './arneyPlusHold'
import HouseholdMembersSettings from './HouseholdMembersSettings'
import HouseholdProfilePicker from './HouseholdProfilePicker'
import CalendarPersonFilterAvatar from './CalendarPersonFilterAvatar'
import SharedEventDetails from './SharedEventDetails'
import './SharedEventsOverlay.css'
import { useSharedEventFeed } from './useSharedEventFeed'
import { sharedEventsInRange, formatSharedTime, type AcceptedSharedEvent } from './sharedEventOverlay'
import FamilyEventSharing from './FamilyEventSharing'
import { DesktopInvitations, MobileInvitationReminder } from './InvitationCenter'
import { useInvitationInbox } from './useInvitationInbox'
import { useAssignmentInbox } from './useAssignmentInbox'
import { useFamilyPush, PushNotificationsControl } from './FamilyPushNotifications'
import { useFamilyEventInvitations } from './useFamilyEventInvitations'
import HouseholdEventJoin from './HouseholdEventJoin'
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
    'capture' |
    'householdMembers' |
    'invitations'
  >('home')

const [isEditingHome, setIsEditingHome] =
  useState(false)
const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false)
const [familyAuthEnabled, setFamilyAuthEnabled] = useState(false)
const [profileSwitchRequest, setProfileSwitchRequest] = useState(0)
const [profilePeopleRevision, setProfilePeopleRevision] = useState(0)
const [activeHouseholdProfile, setActiveHouseholdProfile] = useState<string | null>(null)
const [activeHouseholdPersonId, setActiveHouseholdPersonId] = useState<number | null>(null)
const invitationInbox = useInvitationInbox()
const assignmentInbox = useAssignmentInbox(activeHouseholdPersonId)
const familyPush = useFamilyPush(activeHouseholdPersonId)
const familyEventInvites = useFamilyEventInvitations(activeHouseholdPersonId)

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
const [mobileNavMenuOpen, setMobileNavMenuOpen] = useState(false)

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
  setMobileNavMenuOpen(false)

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

  const deltaY =
    event.clientY - gesture.startY

  const shouldChange =
    gesture.horizontal &&
    Math.abs(deltaX) >= 42

  const shouldOpenMenu =
    !gesture.horizontal &&
    !gesture.vertical &&
    Math.abs(deltaX) < 10 &&
    Math.abs(deltaY) < 10

  mobileNavGestureRef.current = {
    pointerId: -1,
    startX: 0,
    startY: 0,
    deltaX: 0,
    horizontal: false,
    vertical: false,
  }

  if (!shouldChange) {
    if (shouldOpenMenu) {
      setMobileNavMenuOpen(
        (current) => !current
      )
    }

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

const mobileMonthDayTapRef = useRef({
  time: 0,
  dateKey: '',
  x: 0,
  y: 0,
  singleTapTimer: null as number | null,
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
    Math.abs(mov…107515 tokens truncated…    </section>
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
        <section className="people-page people-management-page">
          <div className="people-page-heading">
            <div>
              <h2>People</h2>
              <p>
                Manage your household profiles.
              </p>
            </div>
            <button
              type="button"
              className="people-add-person-button"
              aria-label="Add Person"
              onClick={startAddingPerson}
            >
              <span aria-hidden="true">+</span>
              <span>Add Person</span>
            </button>
          </div>

          <div className="people-page-layout people-management-layout">
            {personEditorOpen && createPortal(
              <div className="person-editor-overlay" onClick={() => clearPersonForm()}>
                {personEditor}
              </div>, document.body
            )}

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
    draggable={window.matchMedia('(hover: hover) and (pointer: fine)').matches}
    onDragStart={(event) => {
      if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches ||
          (event.target instanceof Element && event.target.closest('button, input, select, textarea, a'))) {
        event.preventDefault()
        return
      }
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

                    <div className="person-color-row" aria-hidden="true">
                      <span
                        className="person-color-dot"
                        style={{
                          backgroundColor: person.color,
                        }}
                      />


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
      <MobileInvitationReminder {...invitationInbox} {...notificationDisplayProps} suppress={page === 'invitations'} />
      <HouseholdProfilePicker
        switchRequest={profileSwitchRequest}
        peopleRevision={profilePeopleRevision} onProfileCreated={handleProfileCreated}
        onProfileChange={handleHouseholdProfileChange}
      />
    </main>
  )
}

export default App
