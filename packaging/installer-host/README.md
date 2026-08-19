# OMP Studio installer UI host

Tiny WinForms + WebView2 window that shows `packaging/ui` at 720×480.
NSIS hides the native wizard, copies files in the background, and this
host is the only visible installer UI.

The elevated NSIS `$PLUGINSDIR` is Administrators-only. WebView2's
medium-IL child cannot read `file://` there (`ERR_ACCESS_DENIED`) and
cannot write its user-data folder there either. This host therefore:

1. Copies the HTML tree to `%ProgramData%\omp-studio\installer\ui` and
   grants Users read (`icacls *S-1-5-32-545:(OI)(CI)RX`).
2. Puts the WebView2 user-data folder under
   `%ProgramData%\omp-studio\installer-webview` with Users modify.
3. Maps `omp-installer` → that UI folder with
   `SetVirtualHostNameToFolderMapping` and navigates to
   `https://omp-installer/index.html?host=installer`.

Handshake files (`options.ini`, `done.ini`, …) stay in `--dir`
(`$PLUGINSDIR`); only the HTML and Edge profile leave that directory.

The host is Per-Monitor V2 DPI aware and resizes so the WebView CSS
viewport is exactly 720×480 (the designed layout). High-DPI displays
that would otherwise clip the wizard are corrected at show time.

Built at pack time by `scripts/build-installer-host.mjs` (Framework `csc`
+ the WebView2 NuGet package). Output is not committed.
