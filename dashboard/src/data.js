import { FRAME_MANIFEST_URL } from './config'
import { frameUrl, loadLGFFrame, loadLGFManifest } from './lgf'

const GRID_FIELDS = [
  'x_min', 'x_max', 'y_min', 'y_max', 'resolution', 'elevation',
  'semantic_class', 'semantic_confidence', 'occupancy', 'traversability', 'point_count',
]

function parseGridBinary(buffer, fields) {
  const floats = new Float32Array(buffer)
  if (floats.length % fields.length !== 0) throw new Error('Invalid grid buffer')
  const cells = new Array(floats.length / fields.length)
  for (let row = 0; row < cells.length; row += 1) {
    const cell = {}
    for (let column = 0; column < fields.length; column += 1) {
      const field = fields[column]
      const value = floats[row * fields.length + column]
      cell[field] = field === 'semantic_class' ? Math.round(value) : value
    }
    cells[row] = cell
  }
  return cells
}

function manifestBaseUrl(manifestUrl) {
  return new URL('.', new URL(manifestUrl, globalThis.location?.href ?? manifestUrl)).href
}

function frameAssetUrl(baseUrl, kind, frameId, extension) {
  return new URL(`./${kind}/${frameId}_${kind}.${extension}`, baseUrl).href
}

function normalizeLocalFrame(frameId, grid, points, meta) {
  const pointBuffer = new Float32Array(points)
  if (pointBuffer.length % 4 !== 0) throw new Error(`Invalid point buffer for ${frameId}`)
  return { grid, points: pointBuffer, meta }
}

function normalizeLGFFrame(frame) {
  const { header, points, cells } = frame
  const grid = new Array(cells.count)
  const distribution = {}
  for (let index = 0; index < cells.count; index += 1) {
    const resolution = header.level_sizes_m[cells.level[index]]
    distribution[resolution] = (distribution[resolution] ?? 0) + 1
    const x = cells.ixy[index * 2]
    const y = cells.ixy[index * 2 + 1]
    const elevation = cells.zCm[index * 3 + 2] / 100
    grid[index] = {
      x_min: x * resolution,
      x_max: (x + 1) * resolution,
      y_min: y * resolution,
      y_max: (y + 1) * resolution,
      resolution,
      elevation,
      semantic_class: cells.cls[index] ? cells.cls[index] - 1 : -1,
      semantic_confidence: cells.confidence[index] / 255,
      occupancy: 1,
      traversability: cells.traversability[index] / 255,
      point_count: cells.pointCount[index],
      terrain_complexity: cells.complexity[index] / 255,
    }
  }

  const pointBuffer = new Float32Array(points.count * 4)
  for (let index = 0; index < points.count; index += 1) {
    pointBuffer[index * 4] = points.xyzCm[index * 3] / 100
    pointBuffer[index * 4 + 1] = points.xyzCm[index * 3 + 1] / 100
    pointBuffer[index * 4 + 2] = points.xyzCm[index * 3 + 2] / 100
    pointBuffer[index * 4 + 3] = points.cls[index] ? points.cls[index] - 1 : -1
  }

  return {
    grid,
    points: pointBuffer,
    meta: {
      frame_id: header.frame_id,
      total_input_points: header.n_points_total,
      exported_points: points.count,
      total_cells: cells.count,
      resolution_distribution: distribution,
      inference_ms: header.timing_ms?.salsanext_total ?? null,
      grid_ms: header.timing_ms?.grid_engine_total ?? null,
      total_ms: header.timing_ms?.end_to_end ?? null,
      method: header.device ? `Precomputed LGF clip (${header.device})` : 'Precomputed LGF clip',
      ...header.stats,
    },
  }
}

async function loadLocalFrames(manifestUrl, onProgress) {
  const manifestResponse = await fetch(manifestUrl)
  if (!manifestResponse.ok) throw new Error('Could not load frame manifest')
  const manifest = await manifestResponse.json()
  const { frames } = manifest
  if (!frames?.length) throw new Error('Frame manifest is empty')

  const loaded = new Map()
  const pending = new Map()
  const gridFormat = manifest.grid_format ?? 'json'
  const gridFields = manifest.grid_fields ?? GRID_FIELDS
  const baseUrl = manifestBaseUrl(manifestUrl)

  const loadFrame = (frameId) => {
    if (loaded.has(frameId)) return Promise.resolve(loaded.get(frameId))
    if (pending.has(frameId)) return pending.get(frameId)
    const request = (async () => {
      const gridUrl = gridFormat === 'binary'
        ? frameAssetUrl(baseUrl, 'grid', frameId, 'bin')
        : frameAssetUrl(baseUrl, 'grid', frameId, 'json')
      const [gridResponse, pointsResponse, metaResponse] = await Promise.all([
        fetch(gridUrl),
        fetch(frameAssetUrl(baseUrl, 'points', frameId, 'bin')),
        fetch(frameAssetUrl(baseUrl, 'meta', frameId, 'json')),
      ])
      if (![gridResponse, pointsResponse, metaResponse].every((response) => response.ok)) throw new Error(`Incomplete data for frame ${frameId}`)
      const [gridPayload, pointBuffer, meta] = await Promise.all([
        gridFormat === 'binary' ? gridResponse.arrayBuffer() : gridResponse.json(),
        pointsResponse.arrayBuffer(), metaResponse.json(),
      ])
      const grid = gridFormat === 'binary' ? parseGridBinary(gridPayload, gridFields) : gridPayload
      const frame = normalizeLocalFrame(frameId, grid, pointBuffer, meta)
      loaded.set(frameId, frame)
      pending.delete(frameId)
      while (loaded.size > 18) loaded.delete(loaded.keys().next().value)
      return frame
    })().catch((error) => { pending.delete(frameId); throw error })
    pending.set(frameId, request)
    return request
  }

  onProgress?.(0, 1)
  await loadFrame(frames[0])
  onProgress?.(1, 1)
  return {
    frameIds: frames,
    frames: loaded,
    loadFrame,
    semanticClasses: manifest.semantic_classes ?? [],
  }
}

async function loadLGFClipFrames(manifestUrl, onProgress) {
  const manifest = await loadLGFManifest(manifestUrl)
  if (!manifest.frames?.length) throw new Error('Frame manifest is empty')

  const loaded = new Map()
  const pending = new Map()
  const frameIds = manifest.frames.map((frame) => frame.id)
  const frameIndexes = new Map(manifest.frames.map((frame, index) => [frame.id, index]))

  const loadFrame = (frameId) => {
    if (loaded.has(frameId)) return Promise.resolve(loaded.get(frameId))
    if (pending.has(frameId)) return pending.get(frameId)
    const request = (async () => {
      const index = frameIndexes.get(frameId)
      if (index == null) throw new Error(`Unknown frame ${frameId}`)
      const frame = normalizeLGFFrame(await loadLGFFrame(frameUrl(manifest, index, 'lite')))
      loaded.set(frameId, frame)
      pending.delete(frameId)
      while (loaded.size > 12) loaded.delete(loaded.keys().next().value)
      return frame
    })().catch((error) => { pending.delete(frameId); throw error })
    pending.set(frameId, request)
    return request
  }

  onProgress?.(0, 1)
  await loadFrame(frameIds[0])
  onProgress?.(1, 1)
  return {
    frameIds,
    frames: loaded,
    loadFrame,
    semanticClasses: manifest.classes ?? [],
  }
}

export async function loadFrames(onProgress, manifestUrl = FRAME_MANIFEST_URL) {
  const response = await fetch(manifestUrl)
  if (!response.ok) throw new Error('Could not load frame manifest')
  const manifest = await response.json()
  if (manifest?.format === 'LGF1-clip') return loadLGFClipFrames(manifestUrl, onProgress)
  return loadLocalFrames(manifestUrl, onProgress)
}
