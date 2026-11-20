/** Match Three's area-weighted vertex normals without per-face attribute lookups. */
export function indexedNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = 3 * indices[i]!;
    const b = 3 * indices[i + 1]!;
    const c = 3 * indices[i + 2]!;
    const cbX = positions[c]! - positions[b]!;
    const cbY = positions[c + 1]! - positions[b + 1]!;
    const cbZ = positions[c + 2]! - positions[b + 2]!;
    const abX = positions[a]! - positions[b]!;
    const abY = positions[a + 1]! - positions[b + 1]!;
    const abZ = positions[a + 2]! - positions[b + 2]!;
    const x = cbY * abZ - cbZ * abY;
    const y = cbZ * abX - cbX * abZ;
    const z = cbX * abY - cbY * abX;
    normals[a] = normals[a]! + x;
    normals[a + 1] = normals[a + 1]! + y;
    normals[a + 2] = normals[a + 2]! + z;
    normals[b] = normals[b]! + x;
    normals[b + 1] = normals[b + 1]! + y;
    normals[b + 2] = normals[b + 2]! + z;
    normals[c] = normals[c]! + x;
    normals[c + 1] = normals[c + 1]! + y;
    normals[c + 2] = normals[c + 2]! + z;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i]!;
    const y = normals[i + 1]!;
    const z = normals[i + 2]!;
    const inverseLength = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    normals[i] = x * inverseLength;
    normals[i + 1] = y * inverseLength;
    normals[i + 2] = z * inverseLength;
  }
  return normals;
}
