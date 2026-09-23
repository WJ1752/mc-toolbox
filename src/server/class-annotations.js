// Read actual class annotations instead of guessing values from adjacent UTF-8
// constants (which can include unrelated strings or annotations on other mods).
export function classAnnotations(buf) {
  let p = 0
  const u1 = () => buf.readUInt8(p++)
  const u2 = () => { const n = buf.readUInt16BE(p); p += 2; return n }
  const u4 = () => { const n = buf.readUInt32BE(p); p += 4; return n }
  if (u4() !== 0xcafebabe) return []
  p += 4
  const cp = new Array(u2())
  for (let i = 1; i < cp.length; i++) {
    const tag = u1()
    if (tag === 1) { const n = u2(); cp[i] = buf.toString('utf8', p, p + n); p += n }
    else if (tag === 3) { cp[i] = buf.readInt32BE(p); p += 4 }
    else if (tag === 4 || [9, 10, 11, 12, 17, 18].includes(tag)) p += 4
    else if (tag === 5 || tag === 6) { p += 8; i++ }
    else if (tag === 8) cp[i] = { string: u2() }
    else if ([7, 16, 19, 20].includes(tag)) p += 2
    else if (tag === 15) p += 3
    else throw new Error('Unknown class constant tag')
  }
  p += 6
  const interfaces = u2()
  p += interfaces * 2
  const skipAttributes = () => { for (let n = u2(); n > 0; n--) { p += 2; const size = u4(); p += size } }
  const constants = {}
  for (let n = u2(); n > 0; n--) {
    p += 2; const name = cp[u2()]; p += 2
    for (let k = u2(); k > 0; k--) {
      const attribute = cp[u2()], size = u4(), end = p + size
      if (attribute === 'ConstantValue') { const v = cp[u2()]; constants[name] = v?.string ? cp[v.string] : v }
      p = end
    }
  }
  for (let n = u2(); n > 0; n--) { p += 6; skipAttributes() }
  const value = () => {
    const tag = String.fromCharCode(u1())
    if (tag === '@') return annotation()
    if (tag === '[') return Array.from({ length: u2() }, value)
    if (tag === 'e') return { type: cp[u2()], value: cp[u2()] }
    return cp[u2()]
  }
  const annotation = () => {
    const type = cp[u2()], values = {}
    for (let n = u2(); n > 0; n--) { const name = cp[u2()]; values[name] = value() }
    return { type, values }
  }
  const out = []
  out.constants = constants
  for (let n = u2(); n > 0; n--) {
    const name = cp[u2()], size = u4(), end = p + size
    if (name === 'RuntimeVisibleAnnotations' || name === 'RuntimeInvisibleAnnotations') for (let k = u2(); k > 0; k--) out.push(annotation())
    p = end
  }
  return out
}
