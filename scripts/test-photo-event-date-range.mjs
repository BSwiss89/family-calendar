import test from 'node:test'
import assert from 'node:assert/strict'
import { resolvePhotoEventEndDate } from '../Server/photo-event-date-range.mjs'

const blank = { endMonth: null, endDay: null, endYear: null }

test('Christmas Market flyer: DECEMBER 8TH – 10TH, 2026 fills ending day', () => {
  assert.deepEqual(resolvePhotoEventEndDate({
    dateText: 'DECEMBER 8TH – 10TH, 2026', startMonth: 12, startDay: 8,
  }), { endMonth: 12, endDay: 10, endYear: null })
})

test('printed same-month ranges and numeric dates are detected', () => {
  for (const dateText of ['December 8-10, 2026', 'Dec 8th through 10th, 2026']) {
    assert.deepEqual(resolvePhotoEventEndDate({
      dateText, startMonth: 12, startDay: 8,
    }), { endMonth: 12, endDay: 10, endYear: null })
  }
  assert.deepEqual(resolvePhotoEventEndDate({
    dateText: '12/08/2026 - 12/10/2026', startMonth: 12, startDay: 8,
  }), { endMonth: 12, endDay: 10, endYear: null })
})

test('never invent a range from a single date or clock times', () => {
  assert.deepEqual(resolvePhotoEventEndDate({
    dateText: 'December 8, 2026', startMonth: 12, startDay: 8,
  }), blank)
  assert.deepEqual(resolvePhotoEventEndDate({
    dateText: 'Dec 8, 2026 8AM - 10AM', startMonth: 12, startDay: 8,
  }), blank)
  assert.deepEqual(resolvePhotoEventEndDate({
    dateText: 'December 8, 2026', startMonth: 12, startDay: 8,
    modelEndMonth: 12, modelEndDay: 10,
  }), blank)
})

test('separate printed cross-month spans use model endpoints only with visible range', () => {
  assert.deepEqual(resolvePhotoEventEndDate({
    dateText: 'DEC 30–JAN 2, 2027',
    startMonth: 12, startDay: 30,
    modelEndMonth: 1, modelEndDay: 2, modelEndYear: 2027,
  }), { endMonth: 1, endDay: 2, endYear: 2027 })
})

test('discard invalid dates and unsupported ranges', () => {
  assert.deepEqual(resolvePhotoEventEndDate({
    dateText: 'Dec 8-10, 2026', startMonth: null, startDay: 8,
  }), blank)
  assert.deepEqual(resolvePhotoEventEndDate({
    dateText: 'Dec 8-33, 2026', startMonth: 12, startDay: 8,
    modelEndMonth: 12, modelEndDay: 33,
  }), blank)
  assert.deepEqual(resolvePhotoEventEndDate({
    dateText: 'Dec 8 - 7, 2026', startMonth: 12, startDay: 8,
  }), blank)
})
