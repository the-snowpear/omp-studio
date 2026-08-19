/**
 * Install-directory resolution for the Windows NSIS wizard.
 *
 * Mirrors `packaging/nsis/custom.nsh` (`ompResolveInstDir`). NSIS cannot
 * import this module; keep the two tables in lockstep.
 *
 * Mature installer rule (Inno `AppendDefaultDirName` + empty-folder keep):
 * nest `\OMP Studio` only when the selection is a container (drive root,
 * Program Files / Desktop / …, or a non-empty folder). An empty folder or a
 * path that does not exist yet is the destination itself.
 */

export const PRODUCT_DIR = "OMP Studio";

export const CONTAINER_NAMES = Object.freeze([
  "Program Files",
  "Program Files (x86)",
  "Desktop",
  "Documents",
  "Downloads",
  "Windows",
  "Users",
  "ProgramData",
  "Public",
]);

export function normalizeInstallPath(selected) {
  let path = String(selected ?? "").replace(/\//g, "\\");
  while (path.endsWith("\\") && path.length > 3) {
    path = path.slice(0, -1);
  }
  return path;
}

export function lastInstallSegment(path) {
  const normalized = normalizeInstallPath(path);
  const i = normalized.lastIndexOf("\\");
  return i < 0 ? normalized : normalized.slice(i + 1);
}

function parentPath(path) {
  const normalized = normalizeInstallPath(path);
  const i = normalized.lastIndexOf("\\");
  if (i <= 0) return "";
  if (i === 2 && normalized.charAt(1) === ":") {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, i);
}

export function isDriveRoot(path) {
  const normalized = normalizeInstallPath(path);
  return /^[A-Za-z]:\\?$/u.test(normalized);
}

export function isProductDir(path) {
  return lastInstallSegment(path).toLowerCase() === PRODUCT_DIR.toLowerCase();
}

function isContainerName(name) {
  const lower = String(name ?? "").toLowerCase();
  return CONTAINER_NAMES.some((item) => item.toLowerCase() === lower);
}

function collapseProductSuffix(path) {
  let current = normalizeInstallPath(path);
  while (isProductDir(current) && isProductDir(parentPath(current))) {
    current = normalizeInstallPath(parentPath(current));
  }
  return current;
}

function appendProduct(path) {
  const normalized = normalizeInstallPath(path);
  if (!normalized) return PRODUCT_DIR;
  if (normalized.endsWith("\\")) return `${normalized}${PRODUCT_DIR}`;
  return `${normalized}\\${PRODUCT_DIR}`;
}

/**
 * @param {string} selected
 * @param {{
 *   lockedPath?: string | null,
 *   exists?: boolean,
 *   empty?: boolean,
 *   hasProductFiles?: boolean,
 *   specialFolders?: string[],
 * }} [ctx]
 */
export function resolveInstallDir(selected, ctx = {}) {
  if (ctx.lockedPath) return normalizeInstallPath(ctx.lockedPath);

  const raw = normalizeInstallPath(selected);
  if (!raw) return "";

  const path = collapseProductSuffix(raw);
  if (isProductDir(path)) return path;
  if (ctx.hasProductFiles) return path;
  if (isDriveRoot(path)) return appendProduct(path);

  const special = (ctx.specialFolders ?? []).map((item) => normalizeInstallPath(item).toLowerCase());
  if (special.includes(path.toLowerCase()) || isContainerName(lastInstallSegment(path))) {
    return appendProduct(path);
  }

  if (ctx.exists === true && ctx.empty === false) {
    return appendProduct(path);
  }

  return path;
}
