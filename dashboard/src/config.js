const trimTrailingSlash = (value) => value.replace(/\/+$/, '')

export const FRAME_MANIFEST_URL = (import.meta.env.VITE_FRAME_MANIFEST_URL ?? '/frames/manifest.json').trim()

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '/api').trim()
export const API_BASE_URL = apiBase ? trimTrailingSlash(apiBase) : ''
export const UPLOADS_ENABLED = Boolean(API_BASE_URL)

export function apiUrl(path) {
  if (!API_BASE_URL) throw new Error('Uploads are disabled for this deployment.')
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}
