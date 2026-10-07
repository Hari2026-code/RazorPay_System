import { ApiError } from './api-error.js'

const invalid = (message) => new ApiError(422, 'VALIDATION_ERROR', message)

// Numbers, or numeric strings like "500" / "499.50".
export function isNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(value)
}

// Optional string field: returns undefined when absent, trims, enforces max length.
export function optionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw invalid(`${field} can be at most ${maxLength} characters.`)
  return trimmed || undefined
}

export function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} is required.`)
  }
  return value.trim()
}

// Flat object of string/number/boolean values, at most 15 keys (Razorpay's limit for notes).
export function optionalNotes(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('notes must be an object.')
  const entries = Object.entries(value)
  if (entries.length > 13) throw invalid('notes can have at most 13 keys.') // 2 are reserved
  const notes = {}
  for (const [key, v] of entries) {
    if (!['string', 'number', 'boolean'].includes(typeof v)) throw invalid(`notes.${key} must be a string, number or boolean.`)
    if (String(v).length > 256) throw invalid(`notes.${key} can be at most 256 characters.`)
    notes[key] = String(v)
  }
  return notes
}

export function pagination(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100)
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0)
  return { limit, offset }
}
