// A tiny JSON-file "table": an array of records with a unique key field.
// Swap this module for a real database later; the services only use the methods below.
import fs from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR } from '../config/env.js'

export class JsonCollection {
  constructor(fileName, key) {
    this.file = path.join(DATA_DIR, fileName)
    this.key = key
    // Node runs requests on one thread, so chaining writes on a promise guarantees
    // no two read-modify-write cycles interleave (same job as a file lock).
    this.queue = Promise.resolve()
  }

  async all() {
    let raw
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw new Error(`Could not read ${path.basename(this.file)}.`)
    }
    let records
    try {
      records = JSON.parse(raw.trim() === '' ? '[]' : raw)
    } catch {
      records = null
    }
    if (!Array.isArray(records)) {
      throw new Error(`${path.basename(this.file)} contains invalid JSON.`)
    }
    return records
  }

  async find(id) {
    return (await this.all()).find((r) => r?.[this.key] === id) ?? null
  }

  // Records whose fields equal every value in `filter` (undefined values are ignored).
  async where(filter) {
    const entries = Object.entries(filter).filter(([, v]) => v !== undefined)
    return (await this.all()).filter((r) => entries.every(([f, v]) => r?.[f] === v))
  }

  // Atomically insert or update one record.
  // updater(existing | null) returns the record to store, or null to leave the file unchanged.
  // Resolves to { record, previous }.
  upsert(id, updater) {
    const run = this.queue.then(async () => {
      const records = await this.all()
      const index = records.findIndex((r) => r?.[this.key] === id)
      const previous = index === -1 ? null : records[index]
      const record = updater(previous)
      if (record === null) return { record: previous, previous }

      if (index === -1) records.push(record)
      else records[index] = record

      await fs.mkdir(path.dirname(this.file), { recursive: true })
      // Write to a temp file and rename, so a crash mid-write never corrupts the data.
      const tmp = `${this.file}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(records, null, 4))
      await fs.rename(tmp, this.file)
      return { record, previous }
    })
    this.queue = run.catch(() => {}) // keep the queue alive after a failure
    return run
  }
}
