// Error with an HTTP status and a stable machine-readable code.
// Throw it from any route/service; the error handler turns it into
// { success: false, error: { code, message } }.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })
