/** Linux desktop packaging policy. Runtime targets do not imply desktop support. */
export const LINUX_TARGET_PLATFORM = "linux-x64";
export const LINUX_ARCH = "x64";
export const LINUX_EXECUTABLE = "omp-studio";
export const LINUX_PACKAGE_NAME = "omp-studio";
export const LINUX_DESKTOP_FILE = "omp-studio.desktop";
export const LINUX_UNPACKED_DIRECTORY = "linux-unpacked";
export const LINUX_INSTALL_DIRECTORY = "/opt/OMP Studio";
export const LINUX_MIN_GLIBC = "2.39";

export function linuxAppImageName(version) {
  return `OMP-Studio-${version}-linux-${LINUX_ARCH}.AppImage`;
}

export function linuxDebName(version) {
  return `OMP-Studio-${version}-linux-${LINUX_ARCH}.deb`;
}

export function deriveLinuxBuilderConfig(base, { outputDirectory }) {
  const shared = Object.fromEntries(Object.entries(base).filter(([key]) =>
    !["win", "nsis", "extraFiles", "artifactName", "publish", "forceCodeSigning"].includes(key)));
  const artifactName = "OMP-Studio-${version}-linux-${arch}.${ext}";
  return {
    ...shared,
    executableName: LINUX_EXECUTABLE,
    directories: { ...base.directories, output: outputDirectory },
    extraMetadata: {
      ...base.extraMetadata,
      desktopName: LINUX_DESKTOP_FILE,
      homepage: "https://github.com/the-snowpear/omp-studio",
    },
    files: [...base.files,
      "!**/node-pty/prebuilds/win32-*/**",
      "!**/node-pty/prebuilds/darwin-*/**",
      "!**/node-pty/prebuilds/linux-arm64/**",
      "!**/node-pty/third_party/**",
      "!**/node-pty/deps/**",
    ],
    extraResources: [
      ...base.extraResources.filter(entry => !entry.from.endsWith(".ico")),
      // POSIX desktop paths resolve the signed seed under process.resourcesPath.
      ...base.extraFiles,
    ],
    linux: {
      target: [{ target: "AppImage", arch: [LINUX_ARCH] }, { target: "deb", arch: [LINUX_ARCH] }],
      icon: "apps/desktop/resources/icon.png",
      category: "Development",
      synopsis: "Desktop workspace for OMP agents",
      description: "OMP Studio desktop workspace with a bundled, signed OMP Runtime.",
      syncDesktopName: true,
      desktop: { entry: { StartupWMClass: LINUX_EXECUTABLE, Terminal: "false" } },
      artifactName,
    },
    // electron-builder's legacy AppImage default adds --no-sandbox. Override it.
    appImage: { artifactName, executableArgs: [] },
    deb: {
      artifactName,
      packageName: LINUX_PACKAGE_NAME,
      maintainer: "OMP Studio contributors <the-snowpear@users.noreply.github.com>",
      depends: [
        `libc6 (>= ${LINUX_MIN_GLIBC})`, "libstdc++6 (>= 13.2)", "libgcc-s1",
        "libgtk-3-0t64 | libgtk-3-0", "libasound2t64 | libasound2",
        "libnss3", "libnotify4", "libxss1", "libxtst6", "libgbm1",
        "libatspi2.0-0t64 | libatspi2.0-0", "libuuid1", "libsecret-1-0", "xdg-utils",
      ],
      recommends: ["libayatana-appindicator3-1", "gnome-keyring | kwalletmanager"],
      // Use the builder's package-owned sandbox/AppArmor and desktop integration scripts.
    },
    // Discovery uses Studio's signed catalogs. No electron-updater feed is installed.
    publish: null,
  };
}
