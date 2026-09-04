const PRIVATE_MATERIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u,
  /"privateKey"\s*:/u,
];

export function containsPrivateMaterial(content) {
  return PRIVATE_MATERIAL_PATTERNS.some((pattern) => pattern.test(content));
}
