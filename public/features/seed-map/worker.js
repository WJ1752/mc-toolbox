import { findBiome, generateMap, getBiomes, getStructures, resolveVersion, VERSIONS } from './engine.js'

const dimensions = ['overworld', 'nether', 'end']
const catalog = Object.fromEntries(VERSIONS.map(version => [
  version, Object.fromEntries(dimensions.map(dim => [dim, getStructures(version, dim)]))
]))
self.onmessage = async ({ data: { init, version, id, params, search } }) => {
  if (init) {
    const biomes = Object.fromEntries(VERSIONS.map(v => [
      v, Object.fromEntries(dimensions.map(dim => [dim, getBiomes(v, dim)]))
    ]))
    self.postMessage({ versions: VERSIONS, catalog, biomes, resolved: resolveVersion(version) })
    return
  }
  try {
    if (search) { self.postMessage({ point: await findBiome(params) }); return }
    const result = await generateMap(params)
    self.postMessage({ id, result }, [result.biomes.buffer])
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) })
  }
}
