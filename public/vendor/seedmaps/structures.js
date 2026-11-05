/**
 * Structure overlay computation — shared by web map, CLI `map --structures`
 * and tests. Pure function over the unified WorldGenerator facade.
 *
 * For each landmark structure type we walk the struct-region grid (region
 * size = Cubiomes `getStructureRegionSize`, matched to the given MC version),
 * take the *attempted generation position* for each region inside the box and
 * ask the engine whether that position is actually viable (terrain/biome
 * filtered). This mirrors how Chunkbase plots structures: markers exist even
 * when they could not generate, rendered differently by `viable`.
 */

export const LANDMARK_TYPES = [
  { name: "village", color: "#ffd54f" },
  { name: "desert_pyramid", color: "#ffab40" },
  { name: "swamp_hut", color: "#aed581" },
  { name: "igloo", color: "#4dd0e1" },
  { name: "monument", color: "#64b5f6" },
  { name: "pillager_outpost", color: "#ef5350" },
  { name: "mansion", color: "#ba68c8" },
];

/**
 * @param {object}          opts
 * @param {object}          opts.engine   initialized JavaWorldGenerator facade
 * @param {bigint|number}   opts.seed     full 64-bit seed
 * @param {number}          opts.mc       Cubiomes MCVersion enum for the init
 * @param {{x0:number,z0:number,x1:number,z1:number}} opts.box  block-space bounds
 * @param {Array<{name,color}>} [opts.types] landmark specs (defaults LANDMARK_TYPES)
 * @returns {Array<{type,color,x,z,viable}>} sorted by x,z,type
 */
export function structureOverlay({ engine, seed, mc, box, types = LANDMARK_TYPES }) {
  const M = engine.module;
  const markers = [];
  for (const spec of types) {
    const t = engine.structures[spec.name];
    if (t === undefined) continue; // not modelled in this engine build
    const step = M._wasm_structure_region_size(t, mc);
    if (step <= 1) continue; // pseudo / one-chunk structures are not region-based
    // Cubiomes defines structure positions in chunk units: a cell is
    // `regionSize` chunks wide and the generated structure always lands inside
    // its own cell (getStructurePos: (rx*regionSize + off) << 4). Convert the
    // block-space box to the covering chunk range, then to cell indices.
    const c0 = Math.floor(box.x0 / 16);
    const c1 = Math.floor((box.x1 - 1) / 16);
    const rx0 = Math.floor(c0 / step) - 1;
    const rx1 = Math.ceil(c1 / step) + 1;
    const rz0 = Math.floor(Math.floor(box.z0 / 16) / step) - 1;
    const rz1 = Math.ceil(Math.floor((box.z1 - 1) / 16) / step) + 1;
    for (let rx = rx0; rx <= rx1; rx++) {
      for (let rz = rz0; rz <= rz1; rz++) {
        const p = engine.structurePos({ type: t }, seed, rx, rz);
        if (!p) continue;
        if (p.x < box.x0 || p.x >= box.x1 || p.z < box.z0 || p.z >= box.z1) continue;
        markers.push({
          type: spec.name,
          color: spec.color,
          x: p.x,
          z: p.z,
          viable: M._wasm_structure_viable(t, p.x, p.z) === 1,
        });
      }
    }
  }
  markers.sort((a, b) => a.x - b.x || a.z - b.z || a.type.localeCompare(b.type));
  return markers;
}

/** Pixel coordinate of block (bx,bz) inside a canvas whose top-left block is
 *  (box.x0, box.z0) at `scale` blocks per pixel. */
export function blockToPixel(bx, bz, box, scale) {
  return {
    px: (bx - box.x0) / scale,
    pz: (bz - box.z0) / scale,
  };
}