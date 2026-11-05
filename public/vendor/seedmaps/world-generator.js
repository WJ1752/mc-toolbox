import createModule from "./seed_engine.js";

/**
 * JS wrapper over the Cubiomes WASM engine.
 * Seeds are full 64-bit values; we split into two uint32 halves at the ABI.
 */
export class JavaWorldGenerator {
  constructor() {
    this.module = null;
    this.mc = null;
    this.initialized = false;
  }

  async init() {
    this.module = await createModule();
    this.mc = {
      "1.18": this.module._wasm_version_1_18(),
      "1.21": this.module._wasm_version_1_21(),
      newest: this.module._wasm_version_newest(),
    };
    this.versionRange = {
      min: this.module._wasm_version_min(),
      max: this.module._wasm_version_max(),
    };
    this.structures = this.#enumerateStructures();
    return this;
  }

  /** Resolve a version label like "1.16" / "1.19.2" to the Cubiomes enum. */
  versionFromString(label) {
    this.#assertModule();
    const inPtr = this.module._malloc(64);
    if (!inPtr) throw new Error("WASM malloc failed");
    try {
      const bytes = this.module.lengthBytesUTF8(label) + 1;
      this.module.stringToUTF8(label, inPtr, bytes);
      return this.module._wasm_version_from_string(inPtr);
    } finally {
      this.module._free(inPtr);
    }
  }

  versionName(mc) {
    this.#assertModule();
    const len = this.module._wasm_mc_name_length(mc);
    if (len <= 0) return null;
    const ptr = this.module._wasm_mc_name_ptr(mc);
    return this.module.UTF8ToString(ptr, len);
  }

  /** Enumerate every Cubiomes StructureType by name (0..count-1 contiguous). */
  #enumerateStructures() {
    const out = {};
    const count = this.module._wasm_structure_type_count();
    for (let i = 0; i < count; i++) {
      const len = this.module._wasm_structure_name_length(i);
      if (len <= 0) continue;
      const ptr = this.module._wasm_structure_name_ptr(i);
      const name = this.module.UTF8ToString(ptr, len);
      if (name && !(name in out)) out[name] = i;
    }
    return out;
  }

  /** Resolve a structure name or partial name to its enum type, or undefined. */
  resolveStructure(input) {
    if (typeof input === "number") return input;
    return this.structures[input];
  }

  /** Case-insensitive biome id lookup by resource-id name at version mc. */
  biomeId(name, mc) {
    this.#assertModule();
    const inPtr = this.module._malloc(64);
    if (!inPtr) throw new Error("WASM malloc failed");
    try {
      const bytes = this.module.lengthBytesUTF8(name) + 1;
      this.module.stringToUTF8(name, inPtr, bytes);
      return this.module._wasm_biome_id(mc ?? this.mcCurrent ?? this.mc["1.18"], inPtr);
    } finally {
      this.module._free(inPtr);
    }
  }

  static splitSeed(seed) {
    const v = BigInt(seed);
    return [
      Number(BigInt.asUintN(32, v)),
      Number(BigInt.asUintN(32, v >> 32n)),
    ];
  }

  initialize({ version, seed, dimension = 0 }) {
    if (!this.module) throw new Error("WASM module not loaded");
    const [low, high] = JavaWorldGenerator.splitSeed(seed);
    const mc = typeof version === "number" ? version : this.mc[version];
    if (mc === undefined) throw new Error(`Unknown version: ${version}`);
    const rc = this.module._wasm_init(mc, dimension, low, high);
    if (rc !== 0) throw new Error(`Engine init failed: ${rc}`);
    this.mcCurrent = mc;
    this.initialized = true;
  }

  getBiome(x, y, z, scale = 1) {
    this.#assertInit();
    return this.module._wasm_get_biome(scale, x, y, z);
  }

  generateBiomes({ x, z, width, height, scale = 4, y = 15 }) {
    this.#assertInit();
    const count = width * height;
    const ptr = this.module._malloc(count * 4);
    if (!ptr) throw new Error("WASM malloc failed");
    try {
      const rc = this.module._wasm_generate_biomes(
        x, z, width, height, scale, y, ptr,
      );
      if (rc !== 0) throw new Error(`generateBiomes failed: ${rc}`);
      const heap = new Int32Array(this.module.HEAP32.buffer, ptr, count);
      return Int32Array.from(heap);
    } finally {
      this.module._free(ptr);
    }
  }

  biomeName(biomeId) {
    this.#assertInit();
    const len = this.module._wasm_biome_name_length(this.mcCurrent, biomeId);
    if (len <= 0) return "unknown";
    const ptr = this.module._wasm_biome_name_ptr(this.mcCurrent, biomeId);
    return this.module.UTF8ToString(ptr, len);
  }

  structurePos(structureType, seed, regX, regZ) {
    if (!this.module) throw new Error("WASM module not loaded");
    const [low, high] = JavaWorldGenerator.splitSeed(seed);
    const ptr = this.module._malloc(8);
    if (!ptr) throw new Error("WASM malloc failed");
    try {
      const ok = this.module._wasm_structure_pos(
        typeof structureType === "object" ? structureType.type : structureType,
        this.mcCurrent,
        low,
        high,
        regX,
        regZ,
        ptr,
      );
      if (!ok) return null;
      return {
        x: this.module.getValue(ptr, "i32"),
        z: this.module.getValue(ptr + 4, "i32"),
      };
    } finally {
      this.module._free(ptr);
    }
  }

  isSlimeChunk(seed, chunkX, chunkZ) {
    if (!this.module) throw new Error("WASM module not loaded");
    const [low, high] = JavaWorldGenerator.splitSeed(seed);
    return this.module._wasm_slime_chunk(low, high, chunkX, chunkZ) === 1;
  }

  #assertModule() {
    if (!this.module) throw new Error("WASM module not loaded");
  }

  #assertInit() {
    if (!this.module) throw new Error("WASM module not loaded");
    if (!this.initialized) throw new Error("World generator not initialized");
  }

  /**
   * Handle-based generator for parallel finders. Each handle owns an
   * independent native Generator, so workers never share state.
   */
  createGenerator({ version, seed, dimension = 0 }) {
    if (!this.module) throw new Error("WASM module not loaded");
    const [low, high] = JavaWorldGenerator.splitSeed(seed);
    const mc = typeof version === "number" ? version : this.mc[version];
    if (mc === undefined) throw new Error(`Unknown version: ${version}`);
    const handle = this.module._wasm_create(mc, dimension, low, high);
    if (!handle) throw new Error("Engine handle allocation failed");
    return {
      handle,
      setSeed: (seed) => {
        const [l, h] = JavaWorldGenerator.splitSeed(seed);
        this.module._wasm_set_seed(handle, l, h);
      },
      getBiome: (x, y, z, scale = 1) =>
        this.module._wasm_ctx_get_biome(handle, scale, x, y, z),
      generateBiomes: ({ x, z, width, height, scale = 4, y = 15 }) =>
        this.#ctxBiomes(handle, { x, z, width, height, scale, y }),
      structureViable: (structType, bx, bz) =>
        this.module._wasm_ctx_structure_viable(
          handle, typeof structType === "object" ? structType.type : structType,
          bx, bz,
        ) === 1,
      getSpawn: () => this.#ctxPos(handle, this.module._wasm_ctx_get_spawn),
      estimateSpawn: () =>
        this.#ctxPos(handle, this.module._wasm_ctx_estimate_spawn),
      destroy: () => {
        this.module._wasm_destroy(handle);
      },
    };
  }

  structureName(structType) {
    if (!this.module) throw new Error("WASM module not loaded");
    const type = typeof structType === "object" ? structType.type : structType;
    const len = this.module._wasm_structure_name_length(type);
    if (len <= 0) return "unknown";
    const ptr = this.module._wasm_structure_name_ptr(type);
    return this.module.UTF8ToString(ptr, len);
  }

  /** Full Cubiomes biome color palette as { [biomeId]: "#rrggbb" }. */
  biomeColors() {
    if (!this.module) throw new Error("WASM module not loaded");
    const ptr = this.module._malloc(768);
    if (!ptr) throw new Error("WASM malloc failed");
    try {
      const rc = this.module._wasm_biome_colors(ptr);
      if (rc !== 0) throw new Error(`biomeColors failed: ${rc}`);
      const heap = new Uint8Array(this.module.HEAPU8.buffer, ptr, 768);
      const colors = {};
      for (let id = 0; id < 256; id++) {
        const rgb = [heap[id * 3], heap[id * 3 + 1], heap[id * 3 + 2]];
        if (rgb.some((v) => v !== 0 || id === 0)) {
          colors[id] = `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        }
      }
      return colors;
    } finally {
      this.module._free(ptr);
    }
  }

  #ctxBiomes(handle, { x, z, width, height, scale = 4, y = 15 }) {
    const count = width * height;
    const ptr = this.module._malloc(count * 4);
    if (!ptr) throw new Error("WASM malloc failed");
    try {
      const rc = this.module._wasm_ctx_generate_biomes(
        handle, x, z, width, height, scale, y, ptr,
      );
      if (rc !== 0) throw new Error(`generateBiomes failed: ${rc}`);
      const heap = new Int32Array(this.module.HEAP32.buffer, ptr, count);
      return Int32Array.from(heap);
    } finally {
      this.module._free(ptr);
    }
  }

  #ctxPos(handle, fn) {
    const ptr = this.module._malloc(8);
    if (!ptr) throw new Error("WASM malloc failed");
    try {
      const ok = fn(handle, ptr);
      if (!ok) return null;
      return {
        x: this.module.getValue(ptr, "i32"),
        z: this.module.getValue(ptr + 4, "i32"),
      };
    } finally {
      this.module._free(ptr);
    }
  }
}
