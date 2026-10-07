// ISO 8601 timestamp in Asia/Kolkata (+05:30), e.g. 2026-10-05T12:37:15+05:30.
export function isoIST(unixSeconds = Math.floor(Date.now() / 1000)) {
  const shifted = new Date((unixSeconds + 5.5 * 3600) * 1000)
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+05:30')
}
