const MAGIC = 'LGF1'

function isGzip(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
  return bytes.length === 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

async function gunzipIfNeeded(buffer) {
  if (!isGzip(buffer)) return buffer
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

function sectionView(buffer, section) {
  const count = section.shape.reduce((total, size) => total * size, 1)
  switch (section.dtype) {
    case 'int16': return new Int16Array(buffer, section.offset, count)
    case 'uint8': return new Uint8Array(buffer, section.offset, count)
    case 'uint16': return new Uint16Array(buffer, section.offset, count)
    case 'float32': return new Float32Array(buffer, section.offset, count)
    default: throw new Error(`LGF1: unsupported dtype ${String(section.dtype)} in ${section.name}`)
  }
}

export function decodeFrame(buffer) {
  if (buffer.byteLength < 8 || buffer.byteLength > 256 * 1024 * 1024) throw new Error('LGF1: invalid frame size')
  const bytes = new Uint8Array(buffer)
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== MAGIC) {
    throw new Error(isGzip(buffer) ? 'LGF1: expected decompressed bytes' : 'LGF1: bad magic')
  }

  const headerLength = new DataView(buffer).getUint32(4, true)
  if (!headerLength || headerLength > buffer.byteLength - 8 || (8 + headerLength) % 8) {
    throw new Error('LGF1: invalid header length')
  }

  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)))
  if (!header || header.format !== 'LGF1' || header.version !== 1 || typeof header.frame_id !== 'string') {
    throw new Error('LGF1: invalid header')
  }

  const widths = { int16: 2, uint8: 1, uint16: 2, float32: 4 }
  const sections = Object.create(null)
  const occupied = []
  for (const section of header.sections ?? []) {
    if (!section || typeof section.name !== 'string' || sections[section.name] || !Object.hasOwn(widths, section.dtype)) {
      throw new Error('LGF1: invalid section table')
    }
    const count = Array.isArray(section.shape) ? section.shape.reduce((total, size) => total * size, 1) : -1
    if (!Number.isInteger(section.offset) || !Number.isInteger(section.bytes) || !Array.isArray(section.shape) ||
        count < 0 || section.offset < 8 + headerLength || section.offset % 8 ||
        section.offset + section.bytes > buffer.byteLength || count * widths[section.dtype] !== section.bytes) {
      throw new Error(`LGF1: invalid section ${section.name}`)
    }
    sections[section.name] = section
    if (section.bytes) occupied.push([section.offset, section.offset + section.bytes])
  }
  occupied.sort((a, b) => a[0] - b[0])
  if (occupied.some((range, index) => index && range[0] < occupied[index - 1][1])) throw new Error('LGF1: overlapping sections')

  const requireSection = (name, dtype, shape) => {
    const section = sections[name]
    if (!section || section.dtype !== dtype || section.shape.length !== shape.length ||
        !shape.every((size, index) => section.shape[index] === size)) {
      throw new Error(`LGF1: invalid section ${name}`)
    }
  }

  const pointSection = sections['points.class']
  const cellSection = sections['cells.class']
  if (!pointSection || !cellSection) throw new Error('LGF1: missing class sections')
  const pointCount = pointSection.shape[0]
  const cellCount = cellSection.shape[0]
  if (pointCount > 1_000_000 || cellCount > 1_000_000 || header.n_cells !== cellCount) throw new Error('LGF1: invalid counts')

  requireSection('points.xyz_cm', 'int16', [pointCount, 3])
  for (const name of ['intensity', 'class', 'confidence']) requireSection(`points.${name}`, 'uint8', [pointCount])
  if (sections['points.gt_class']) requireSection('points.gt_class', 'uint8', [pointCount])
  requireSection('cells.ixy', 'int16', [cellCount, 2])
  requireSection('cells.z_cm', 'int16', [cellCount, 3])
  for (const name of ['level', 'class', 'traversability', 'complexity', 'confidence']) {
    requireSection(`cells.${name}`, 'uint8', [cellCount])
  }
  for (const name of ['z_std_mm', 'point_count']) requireSection(`cells.${name}`, 'uint16', [cellCount])

  const get = (name) => sectionView(buffer, sections[name])
  return {
    header,
    points: {
      count: pointCount,
      xyzCm: get('points.xyz_cm'),
      intensity: get('points.intensity'),
      cls: get('points.class'),
      confidence: get('points.confidence'),
      gtClass: sections['points.gt_class'] ? get('points.gt_class') : null,
    },
    cells: {
      count: cellCount,
      ixy: get('cells.ixy'),
      level: get('cells.level'),
      cls: get('cells.class'),
      zCm: get('cells.z_cm'),
      zStdMm: get('cells.z_std_mm'),
      traversability: get('cells.traversability'),
      complexity: get('cells.complexity'),
      confidence: get('cells.confidence'),
      pointCount: get('cells.point_count'),
    },
  }
}

export async function loadLGFFrame(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`LGF1: ${response.status} ${response.statusText} for ${url}`)
  return decodeFrame(await gunzipIfNeeded(await response.arrayBuffer()))
}

export async function loadLGFManifest(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load frame manifest: ${response.status} ${response.statusText}`)
  const manifest = await response.json()
  return {
    ...manifest,
    baseUrl: new URL('.', new URL(url, globalThis.location?.href ?? url)).href,
  }
}

export function frameUrl(manifest, index, kind = 'lite') {
  const frame = manifest.frames[index]
  return new URL(kind === 'full' ? frame.full : frame.lite, manifest.baseUrl).href
}
