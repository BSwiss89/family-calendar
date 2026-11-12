import assert from 'node:assert/strict'
import test from 'node:test'
import { getHomeWeatherScene } from '../src/homeWeatherScene.ts'

const fixtures = [
  [0, 'sunny', 'night'],
  [1, 'cloudy'], [2, 'cloudy'], [3, 'cloudy'],
  [45, 'fog'], [48, 'fog'],
  [51, 'rain'], [55, 'rain'], [61, 'rain'], [65, 'rain'],
  [56, 'sleet'], [57, 'sleet'], [66, 'sleet'], [67, 'sleet'], [79, 'sleet'],
  [71, 'snow'], [75, 'snow'], [77, 'snow'], [85, 'snow'], [86, 'snow'],
  [80, 'rain'], [82, 'rain'],
  [95, 'storm'], [96, 'storm'], [99, 'storm'],
  [-1, 'cloudy'],
]

test('Open-Meteo condition mappings preserve freezing precipitation and snow', () => {
  for (const [code, dayCondition, nightCondition=dayCondition] of fixtures) {
    assert.deepEqual(getHomeWeatherScene(code, true), {
      theme: 'weather-theme-' + dayCondition, period:'day',
    }, 'day code '+code)
    assert.deepEqual(getHomeWeatherScene(code, false), {
      theme: 'weather-theme-' + nightCondition, period:'night',
    }, 'night code '+code)
  }
})

test('night overlays conditions rather than replacing rainy, snowy or icy weather', () => {
  for (const code of [1,3,45,56,61,66,71,79,82,85,95,99]) {
    const day=getHomeWeatherScene(code,true)
    const night=getHomeWeatherScene(code,false)
    assert.equal(night.period,'night')
    assert.equal(night.theme,day.theme,'weather condition was lost after sunset: '+code)
  }
})
