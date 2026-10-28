// OMP Studio installer UI host.
// C# 5 / .NET Framework 4.x (Framework csc). Frameless 720x480 WinForms
// window hosting packaging/ui via WebView2. NSIS is the copy engine.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class UpdateMaintenance
{
  public static bool IsRunning(string root)
  {
    if (string.IsNullOrEmpty(root)) return false;
    string prefix = Path.GetFullPath(root).TrimEnd('\\') + "\\";
    foreach (string name in new string[] { "OMP Studio", "omp" })
    foreach (Process process in Process.GetProcessesByName(name))
    {
      using (process)
      {
        // QueryFullProcessImageName also works from the x86 WebView2 host on
        // ARM64; Process.MainModule cannot inspect a native 64-bit process.
        IntPtr handle = OpenProcess(0x1000, false, process.Id);
        if (handle == IntPtr.Zero) continue;
        try
        {
          StringBuilder path = new StringBuilder(32768);
          int length = path.Capacity;
          if (QueryFullProcessImageName(handle, 0, path, ref length)
            && path.ToString().StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
        }
        finally { CloseHandle(handle); }
      }
    }
    return false;
  }

  [DllImport("kernel32.dll")]
  static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int length);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  public static int WaitForExit(string root)
  {
    for (int attempt = 0; attempt < 60; attempt++)
    {
      if (!IsRunning(root)) return 0;
      System.Threading.Thread.Sleep(500);
    }
    return 10;
  }

  public static int Migrate(string oldRoot, string newRoot)
  {
    oldRoot = Path.GetFullPath(oldRoot).TrimEnd('\\');
    string localRoot = Path.GetFullPath(newRoot).TrimEnd('\\');
    if (string.Equals(oldRoot, localRoot, StringComparison.OrdinalIgnoreCase)) return 0;
    string uninstaller = Path.Combine(oldRoot, "Uninstall OMP Studio.exe");
    if (!File.Exists(uninstaller) || !File.Exists(Path.Combine(oldRoot, "OMP Studio.exe"))) return 11;
    // The old uninstaller kills by name. Never invoke it while unrelated OMP work exists.
    foreach (string name in new string[] { "OMP Studio", "omp" })
    {
      Process[] processes = Process.GetProcessesByName(name);
      bool busy = processes.Length != 0;
      foreach (Process process in processes) process.Dispose();
      if (busy) return 12;
    }
    ProcessStartInfo migration = new ProcessStartInfo(Path.Combine(localRoot, "OMP Studio.exe"), "--omp-migrate-runtime \"" + oldRoot + "\"");
    migration.UseShellExecute = false;
    migration.CreateNoWindow = true;
    using (Process process = Process.Start(migration))
    {
      if (!process.WaitForExit(120000)) return 14;
      if (process.ExitCode != 0) return 15;
    }
    string oldProfile = Path.Combine(oldRoot, "userdata", "profile");
    string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "omp-studio", "profile");
    if (Directory.Exists(oldProfile) && !Directory.Exists(profile)) CopyTree(oldProfile, profile);
    return UninstallLegacy(oldRoot, delegate(ProcessStartInfo start) {
      return RunUninstaller(start, 600000);
    });
  }

  internal static int UninstallLegacy(string oldRoot, Func<ProcessStartInfo, int> run)
  {
    // Without _?= NSIS spawns a temporary child and the process we wait for
    // exits before uninstalling. Copy it ourselves and disable that handoff.
    string temporary = Path.Combine(Path.GetTempPath(), "omp-migration-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(temporary);
    string uninstaller = Path.Combine(temporary, "old-uninstaller.exe");
    try
    {
      File.Copy(Path.Combine(oldRoot, "Uninstall OMP Studio.exe"), uninstaller, false);
      // NSIS requires _?= last, without quotes around the directory (including spaces).
      ProcessStartInfo start = new ProcessStartInfo(uninstaller, "/S /KEEP_APP_DATA --updated /allusers _?=" + oldRoot);
      start.UseShellExecute = true;
      start.Verb = "runas";
      start.WindowStyle = ProcessWindowStyle.Hidden;
      int code = run(start);
      if (code != 0) return code;
      return File.Exists(Path.Combine(oldRoot, "OMP Studio.exe")) || File.Exists(Path.Combine(oldRoot, "Uninstall OMP Studio.exe")) ? 16 : 0;
    }
    catch (System.ComponentModel.Win32Exception) { return 13; }
    finally
    {
      try { File.Delete(uninstaller); Directory.Delete(temporary); } catch { }
    }
  }

  internal static int RunUninstaller(ProcessStartInfo start, int milliseconds)
  {
    using (Process process = Process.Start(start))
    {
      // A hung silent uninstaller must fail migration (17, retryable) instead of
      // blocking setup forever with no visible UI and no timeout.
      if (!process.WaitForExit(milliseconds))
      {
        try { process.Kill(); } catch { }
        return 17;
      }
      return process.ExitCode;
    }
  }

  static void CopyTree(string source, string destination)
  {
    if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("Refusing linked migration directory");
    Directory.CreateDirectory(destination);
    foreach (string file in Directory.GetFiles(source))
    {
      if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("Refusing linked migration file");
      string target = Path.Combine(destination, Path.GetFileName(file));
      if (!File.Exists(target)) File.Copy(file, target, false);
    }
    foreach (string dir in Directory.GetDirectories(source)) CopyTree(dir, Path.Combine(destination, Path.GetFileName(dir)));
  }
}

internal static class Program
{
  [STAThread]
  static int Main(string[] args)
  {
    string session = null;
    try
    {
      if (args.Length == 2 && args[0] == "--wait-install-root") return UpdateMaintenance.WaitForExit(args[1]);
      if (args.Length == 3 && args[0] == "--migrate-machine") return UpdateMaintenance.Migrate(args[1], args[2]);
      Native.EnablePerMonitorV2();
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      Options options = Options.Parse(args);
      options.UserDataDir = UserData.PrepareWritableFolder();
      session = options.UserDataDir;
      options.UiDir = UserData.StageUiFolder(options.UiDir, Path.Combine(options.UserDataDir, "ui"));
      if (options.UiDir.Length == 0 || !File.Exists(Path.Combine(options.UiDir, "index.html")))
      {
        return 2;
      }
      Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", options.UserDataDir);
      using (MainForm form = new MainForm(options)) Application.Run(form);
      return Environment.ExitCode;
    }
    catch (Exception ex)
    {
      try
      {
        string dir = "";
        try { dir = Options.Parse(args).Dir; } catch { }
        if (dir.Length == 0) dir = Path.GetTempPath();
        File.WriteAllText(Path.Combine(dir, "webview2-error.txt"), ex.ToString(), Encoding.Unicode);
      }
      catch
      {
      }
      return 2;
    }
    finally { if (session != null) UserData.Cleanup(session); }
  }
}

public sealed class Options
{
  public string UiDir = "";
  public string Dir = "";
  public string UserDataDir = "";
  public IntPtr ParentWindow = IntPtr.Zero;

  public static Options Parse(string[] args)
  {
    Options o = new Options();
    for (int i = 0; i < args.Length; i++)
    {
      string key = args[i];
      string value = "";
      if (i + 1 < args.Length) value = args[i + 1];
      if (key == "--ui" && value.Length > 0)
      {
        o.UiDir = Path.GetFullPath(value);
        i++;
      }
      else if (key == "--dir" && value.Length > 0)
      {
        o.Dir = Path.GetFullPath(value);
        i++;
      }
      else if (key == "--parent" && value.Length > 0)
      {
        o.ParentWindow = new IntPtr(long.Parse(value, CultureInfo.InvariantCulture));
        i++;
      }
    }
    if (o.Dir.Length == 0) o.Dir = Path.GetTempPath();
    return o;
  }
}

public sealed class MainForm : Form
{
  readonly Options options;
  readonly WebView2 webView;
  readonly Bridge bridge;
  bool finished;
  bool cancelled;
  bool htmlNavStarted;
  bool started;

  public MainForm(Options options)
  {
    this.options = options;
    this.bridge = new Bridge(this);
    Text = "OMP Studio 安装";
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.CenterScreen;
    MaximizeBox = false;
    MinimizeBox = true;
    ShowInTaskbar = true;
    AutoScaleMode = AutoScaleMode.None;
    ClientSize = new Size(720, 480);
    BackColor = Color.FromArgb(29, 29, 37);
    Opacity = 0;
    try
    {
      Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    }
    catch
    {
    }

    webView = new WebView2();
    webView.Dock = DockStyle.Fill;
    webView.DefaultBackgroundColor = Color.FromArgb(29, 29, 37);
    Controls.Add(webView);

    Load += OnLoad;
    FormClosing += OnFormClosing;
  }

  public string Dir
  {
    get { return options.Dir; }
  }

  public string UiDir
  {
    get { return options.UiDir; }
  }

  public bool Finished
  {
    get { return finished; }
  }

  public IntPtr ParentWindow { get { return options.ParentWindow; } }
  public void MarkStarted() { started = true; }

  public void MarkFinished()
  {
    finished = true;
  }

  public void MarkCancelled()
  {
    cancelled = true;
  }

  async void OnLoad(object sender, EventArgs e)
  {
    try
    {
      string userData = options.UserDataDir;
      if (userData == null || userData.Length == 0)
      {
        userData = UserData.PrepareWritableFolder();
      }
      Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", userData);
      CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userData);
      await webView.EnsureCoreWebView2Async(env);
    }
    catch (Exception ex)
    {
      try
      {
        File.WriteAllText(Path.Combine(options.Dir, UserData.RuntimeInstalled() ? "webview2-error.txt" : "webview2-missing.txt"), ex.ToString(), Encoding.Unicode);
      }
      catch
      {
        WriteMarker(UserData.RuntimeInstalled() ? "webview2-error.txt" : "webview2-missing.txt");
      }
      Environment.ExitCode = 2;
      cancelled = true;
      Close();
      return;
    }

    CoreWebView2 core = webView.CoreWebView2;
    core.Settings.AreDefaultContextMenusEnabled = false;
    core.Settings.AreDevToolsEnabled = false;
    core.Settings.IsStatusBarEnabled = false;
    core.Settings.IsZoomControlEnabled = false;
    core.Settings.AreBrowserAcceleratorKeysEnabled = false;
    core.Settings.IsWebMessageEnabled = true;
    webView.ZoomFactor = 1;
    core.AddHostObjectToScript("bridge", bridge);
    await core.AddScriptToExecuteOnDocumentCreatedAsync(Bridge.BootstrapScript);
    core.SetVirtualHostNameToFolderMapping(
      UserData.VirtualHost,
      options.UiDir,
      CoreWebView2HostResourceAccessKind.Allow);
    core.NavigationStarting += OnNavigationStarting;
    core.NavigationCompleted += OnNavigationCompleted;
    core.Navigate("https://" + UserData.VirtualHost + "/index.html?host=installer");
  }

  void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
  {
    if (e.Uri == null) return;
    string prefix = "https://" + UserData.VirtualHost + "/";
    if (e.Uri.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
    {
      htmlNavStarted = true;
      return;
    }
    if (e.Uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;
    e.Cancel = true;
  }

  async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
  {
    if (!htmlNavStarted) return;
    if (!e.IsSuccess)
    {
      try
      {
        File.WriteAllText(Path.Combine(options.Dir, "webview2-error.txt"), "nav " + e.WebErrorStatus.ToString(), Encoding.Unicode);
      }
      catch
      {
        WriteMarker("webview2-error.txt");
      }
      Environment.ExitCode = 2;
      cancelled = true;
      Close();
      return;
    }
    webView.ZoomFactor = 1;
    await FitCssViewport();
    if (File.Exists(Path.Combine(options.Dir, "native.ini")))
    {
      cancelled = true;
      Environment.ExitCode = 2;
      Close();
      return;
    }
    Opacity = 1;
    WriteIni(Path.Combine(options.Dir, "host-ready.txt"), "Host", new string[] { "Pid=" + Process.GetCurrentProcess().Id });
  }

  async Task FitCssViewport()
  {
    const int designW = 720;
    const int designH = 480;
    try
    {
      for (int i = 0; i < 4; i++)
      {
        string raw = await webView.CoreWebView2.ExecuteScriptAsync(
          "(function(){return String(window.innerWidth)+','+String(window.innerHeight);})()");
        int innerW;
        int innerH;
        if (!TryParseInnerSize(raw, out innerW, out innerH)) break;
        if (innerW <= 0 || innerH <= 0) break;
        if (Math.Abs(innerW - designW) <= 2 && Math.Abs(innerH - designH) <= 2) break;
        int nextW = (int)Math.Round(ClientSize.Width * (double)designW / innerW);
        int nextH = (int)Math.Round(ClientSize.Height * (double)designH / innerH);
        if (nextW < 480 || nextH < 320 || nextW > 3840 || nextH > 2160) break;
        if (nextW == ClientSize.Width && nextH == ClientSize.Height) break;
        ClientSize = new Size(nextW, nextH);
        CenterToScreen();
        await Task.Delay(40);
      }
    }
    catch
    {
    }
  }

  static bool TryParseInnerSize(string raw, out int w, out int h)
  {
    w = 0;
    h = 0;
    if (raw == null) return false;
    string s = raw.Trim();
    if (s.Length >= 2 && s[0] == '"')
    {
      s = s.Substring(1, s.Length - 2).Replace("\\\"", "\"");
    }
    int comma = s.IndexOf(',');
    if (comma <= 0) return false;
    return int.TryParse(s.Substring(0, comma), NumberStyles.Integer, CultureInfo.InvariantCulture, out w)
      && int.TryParse(s.Substring(comma + 1), NumberStyles.Integer, CultureInfo.InvariantCulture, out h);
  }

  void OnFormClosing(object sender, FormClosingEventArgs e)
  {
    if (finished || cancelled) return;
    // Alt+F4 follows the same policy as the HTML close button. Writing files
    // has no transactional rollback, so the UI does not offer cancellation.
    e.Cancel = true;
    if (htmlNavStarted && (!started || File.Exists(Path.Combine(options.Dir, "done.ini")) || !Native.IsWindow(options.ParentWindow)))
      webView.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new Event('installer-close-request'));");
  }

  public void WriteMarker(string name)
  {
    try
    {
      File.WriteAllText(Path.Combine(options.Dir, name), "1", Encoding.Unicode);
    }
    catch
    {
    }
  }

  public static void WriteIni(string path, string section, string[] lines)
  {
    StringBuilder sb = new StringBuilder();
    sb.Append('[').Append(section).Append("]\r\n");
    for (int i = 0; i < lines.Length; i++)
    {
      sb.Append(lines[i]).Append("\r\n");
    }
    File.WriteAllText(path, sb.ToString(), Encoding.Unicode);
  }

  public void DragWindow()
  {
    Native.ReleaseCapture();
    Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
  }
}

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.AutoDual)]
[ProgId("OmpStudio.InstallerBridge")]
public class Bridge
{
  public const string BootstrapScript = @"(function () {
  if (window.installerShell) return;
  var b = chrome.webview.hostObjects.sync.bridge;
  window.installerShell = Object.freeze({
    isHost: true,
    isLive: true,
    minimize: function () { b.Minimize(); },
    close: function () { b.Close(); },
    drag: function () { b.Drag(); },
    getState: function () { return JSON.parse(b.GetState()); },
    statDir: function (p) { return JSON.parse(b.StatDir(p || '')); },
    browse: function (p) { return b.Browse(p || '') || ''; },
    startInstall: function (opts) { return JSON.parse(b.StartInstall(JSON.stringify(opts || {}))); },
    poll: function () { return JSON.parse(b.Poll()); },
    finish: function (opts) { b.Finish(JSON.stringify(opts || {})); },
    openReleaseNotes: function () { b.OpenReleaseNotes(); }
  });
})();";

  readonly MainForm form;

  public Bridge(MainForm form)
  {
    this.form = form;
  }

  public void Minimize()
  {
    form.WindowState = FormWindowState.Minimized;
  }

  public void Close()
  {
    form.MarkCancelled();
    if (Native.IsWindow(form.ParentWindow))
      MainForm.WriteIni(Path.Combine(form.Dir, "cancel.ini"), "Install", new string[] { "Cancel=1" });
    Environment.ExitCode = 1;
    form.BeginInvoke(new Action(form.Close));
  }

  public void Drag()
  {
    form.BeginInvoke(new Action(form.DragWindow));
  }

  public string GetState()
  {
    string ini = Path.Combine(form.Dir, "host.ini");
    string version = Ini.Read(ini, "Version", "0.1.0");
    string runtime = Ini.Read(ini, "RuntimeVersion", "");
    string occupancy = Ini.Read(ini, "Occupancy", "");
    string existingVersion = Ini.Read(ini, "ExistingVersion", "");
    string existingDir = Ini.Read(ini, "ExistingDir", "");
    string defaultDir = Ini.Read(ini, "DefaultDir", DefaultInstallDir());
    string space = Ini.Read(ini, "SpaceRequiredMB", "350");
    if (occupancy.Length == 0 || occupancy == "fresh") occupancy = "";
    bool running = UpdateMaintenance.IsRunning(existingDir);
    string occJson = occupancy.Length == 0 ? "null" : Json.Str(occupancy);
    StringBuilder sb = new StringBuilder();
    sb.Append('{');
    sb.Append("\"productName\":").Append(Json.Str("OMP Studio"));
    sb.Append(",\"version\":").Append(Json.Str(version));
    sb.Append(",\"runtimeVersion\":").Append(Json.Str(runtime));
    sb.Append(",\"arch\":").Append(Json.Str(Ini.Read(ini, "Arch", Ini.Read(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host-defaults.ini"), "Arch", "x64"))));
    sb.Append(",\"defaultPath\":").Append(Json.Str(defaultDir));
    sb.Append(",\"existingVersion\":").Append(Json.Str(existingVersion));
    sb.Append(",\"existingPath\":").Append(Json.Str(existingDir));
    sb.Append(",\"occupancy\":").Append(occJson);
    sb.Append(",\"running\":").Append(running ? "true" : "false");
    bool desktop = existingDir.Length == 0 || File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "OMP Studio.lnk"));
    sb.Append(",\"desktopShortcut\":").Append(desktop ? "true" : "false");
    sb.Append(",\"spaceRequiredMB\":").Append(Json.Number(space));
    sb.Append(",\"specialFolders\":").Append(Json.StrArray(SpecialFolders()));
    sb.Append('}');
    return sb.ToString();
  }

  public string StatDir(string path)
  {
    path = (path ?? "").Trim();
    bool exists = false;
    bool empty = true;
    bool hasProduct = false;
    long freeBytes = 0;
    long totalBytes = 0;
    string drive = "";
    try
    {
      if (path.Length > 0)
      {
        exists = Directory.Exists(path);
        if (exists)
        {
          empty = DirectoryIsEmpty(path);
          hasProduct = File.Exists(Path.Combine(path, "OMP Studio.exe"))
            || File.Exists(Path.Combine(path, "Uninstall OMP Studio.exe"));
        }
        string root = Path.GetPathRoot(path);
        if (root != null && root.Length > 0)
        {
          drive = root;
          DriveInfo info = new DriveInfo(root);
          if (info.IsReady)
          {
            freeBytes = info.AvailableFreeSpace;
            totalBytes = info.TotalSize;
          }
        }
      }
    }
    catch
    {
    }
    StringBuilder sb = new StringBuilder();
    sb.Append("{\"exists\":").Append(exists ? "true" : "false");
    sb.Append(",\"empty\":").Append(empty ? "true" : "false");
    sb.Append(",\"hasProductFiles\":").Append(hasProduct ? "true" : "false");
    sb.Append(",\"freeBytes\":").Append(freeBytes.ToString(CultureInfo.InvariantCulture));
    sb.Append(",\"totalBytes\":").Append(totalBytes.ToString(CultureInfo.InvariantCulture));
    sb.Append(",\"drive\":").Append(Json.Str(drive));
    sb.Append('}');
    return sb.ToString();
  }

  public string Browse(string current)
  {
    string selected = "";
    form.Invoke(new Action(delegate
    {
      using (FolderBrowserDialog dialog = new FolderBrowserDialog())
      {
        dialog.Description = "选择 OMP Studio 安装位置";
        dialog.ShowNewFolderButton = true;
        if (!string.IsNullOrEmpty(current) && Directory.Exists(current))
        {
          dialog.SelectedPath = current;
        }
        if (dialog.ShowDialog(form) == DialogResult.OK)
        {
          selected = dialog.SelectedPath;
        }
      }
    }));
    return selected;
  }

  public string StartInstall(string json)
  {
    Dictionary<string, string> opts = Json.FlatObject(json);
    string dir = Get(opts, "path", "");
    string desktop = BoolFlag(Get(opts, "desktopShortcut", "true"));
    try
    {
      if (!Path.IsPathRooted(dir)) throw new IOException("请选择完整的安装路径。");
      dir = Path.GetFullPath(dir);
      if (UpdateMaintenance.IsRunning(dir)) return "{\"ok\":false,\"reason\":\"running\"}";
      DriveInfo disk = new DriveInfo(Path.GetPathRoot(dir));
      int required = int.Parse(Ini.Read(Path.Combine(form.Dir, "host.ini"), "SpaceRequiredMB", "350"), CultureInfo.InvariantCulture);
      if (disk.AvailableFreeSpace < (long)required * 1024 * 1024) throw new IOException("目标磁盘空间不足，请选择其他安装位置。");
      Directory.CreateDirectory(dir);
      string probe = Path.Combine(dir, ".omp-install-" + Guid.NewGuid().ToString("N"));
      using (FileStream stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
      File.Delete(probe);
    }
    catch (Exception ex)
    {
      return "{\"ok\":false,\"message\":" + Json.Str("无法写入安装位置：" + ex.Message) + "}";
    }
    MainForm.WriteIni(Path.Combine(form.Dir, "options.ini"), "Install", new string[] {
      "Dir=" + dir,
      "Desktop=" + desktop
    });
    form.MarkStarted();
    return "{\"ok\":true,\"path\":" + Json.Str(dir) + "}";
  }

  public string Poll()
  {
    bool done = File.Exists(Path.Combine(form.Dir, "done.ini"));
    if (done) return "{\"done\":true,\"path\":" + Json.Str(Ini.Read(Path.Combine(form.Dir, "done.ini"), "InstDir", "", "Install")) + "}";
    if (form.ParentWindow != IntPtr.Zero && !Native.IsWindow(form.ParentWindow))
      return "{\"error\":\"安装程序已退出，安装未完成。请关闭向导并重新运行安装包。\"}";
    string phase = Ini.Read(Path.Combine(form.Dir, "status.ini"), "Phase", "preparing");
    int progress = Native.InstallProgress(form.ParentWindow);
    return "{\"done\":false,\"phase\":" + Json.Str(phase) + ",\"percent\":" + (progress < 0 ? "null" : progress.ToString(CultureInfo.InvariantCulture)) + "}";
  }

  public void Finish(string json)
  {
    Dictionary<string, string> opts = Json.FlatObject(json);
    string run = BoolFlag(Get(opts, "run", "true"));
    form.MarkFinished();
    MainForm.WriteIni(Path.Combine(form.Dir, "finish.ini"), "Install", new string[] {
      "Run=" + run
    });
    form.BeginInvoke(new Action(delegate
    {
      Environment.ExitCode = 0;
      form.Close();
    }));
  }

  public void OpenReleaseNotes()
  {
    string version = Ini.Read(Path.Combine(form.Dir, "host.ini"), "Version", "");
    Process.Start(new ProcessStartInfo("https://github.com/the-snowpear/omp-studio/releases/tag/v" + version) { UseShellExecute = true });
  }

  static bool DirectoryIsEmpty(string path)
  {
    try
    {
      string[] entries = Directory.GetFileSystemEntries(path);
      return entries == null || entries.Length == 0;
    }
    catch
    {
      return true;
    }
  }

  static string DefaultInstallDir()
  {
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "OMP Studio");
  }

  static string[] SpecialFolders()
  {
    List<string> list = new List<string>();
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86));
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory));
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.Windows));
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
    AddFolder(list, Path.GetTempPath());
    AddFolder(list, Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));
    string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    if (!string.IsNullOrEmpty(profile))
    {
      AddFolder(list, Path.Combine(profile, "Downloads"));
      AddFolder(list, Path.Combine(profile, "Desktop"));
      AddFolder(list, Path.Combine(profile, "Documents"));
    }
    return list.ToArray();
  }

  static void AddFolder(List<string> list, string path)
  {
    if (string.IsNullOrEmpty(path)) return;
    path = path.TrimEnd('\\');
    for (int i = 0; i < list.Count; i++)
    {
      if (string.Equals(list[i], path, StringComparison.OrdinalIgnoreCase)) return;
    }
    list.Add(path);
  }

  static string Get(Dictionary<string, string> map, string key, string fallback)
  {
    string value;
    if (map.TryGetValue(key, out value) && value != null && value.Length > 0) return value;
    return fallback;
  }

  static string BoolFlag(string value)
  {
    if (value == "1" || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)) return "1";
    return "0";
  }
}

internal static class Ini
{
  public static string Read(string path, string key, string fallback, string section = "Setup")
  {
    // Use the same Windows INI API as NSIS: its new INI files use the system
    // code page, whereas the host writes UTF-16. Both preserve Chinese paths.
    StringBuilder value = new StringBuilder(32768);
    GetPrivateProfileString(section, key, fallback, value, value.Capacity, path);
    return value.ToString();
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern int GetPrivateProfileString(string section, string key, string fallback, StringBuilder value, int size, string path);
}

internal static class Json
{
  public static string Str(string value)
  {
    if (value == null) value = "";
    StringBuilder sb = new StringBuilder();
    sb.Append('"');
    for (int i = 0; i < value.Length; i++)
    {
      char c = value[i];
      if (c == '\\' || c == '"') sb.Append('\\').Append(c);
      else if (c == '\n') sb.Append("\\n");
      else if (c == '\r') sb.Append("\\r");
      else if (c == '\t') sb.Append("\\t");
      else sb.Append(c);
    }
    sb.Append('"');
    return sb.ToString();
  }

  public static string Number(string value)
  {
    int n;
    if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out n))
    {
      return n.ToString(CultureInfo.InvariantCulture);
    }
    return "0";
  }

  public static string StrArray(string[] items)
  {
    StringBuilder sb = new StringBuilder();
    sb.Append('[');
    for (int i = 0; i < items.Length; i++)
    {
      if (i > 0) sb.Append(',');
      sb.Append(Str(items[i]));
    }
    sb.Append(']');
    return sb.ToString();
  }

  public static Dictionary<string, string> FlatObject(string json)
  {
    Dictionary<string, object> values = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
    Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (KeyValuePair<string, object> value in values) result[value.Key] = Convert.ToString(value.Value, CultureInfo.InvariantCulture);
    return result;
  }
}

internal static class UserData
{
  public const string VirtualHost = "omp-installer";

  public static string PrepareWritableFolder()
  {
    // Every setup owns its assets and browser cache. Never grant other users
    // write access to a shared WebView2 profile or reuse another setup's UI.
    string session = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
      "omp-studio", "installer", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(session);
    return session;
  }

  public static string StageUiFolder(string source, string destination)
  {
    Directory.CreateDirectory(destination);
    foreach (string name in new string[] { "index.html", "styles.css", "wizard.js", "app-icon.png" })
      File.Copy(Path.Combine(source, name), Path.Combine(destination, name));
    return destination;
  }

  public static void Cleanup(string session)
  {
    // This is the unique folder created above, never an existing user folder.
    try { Directory.Delete(session, true); }
    catch (IOException) { }
    catch (UnauthorizedAccessException) { }
  }

  public static bool RuntimeInstalled()
  {
    try { return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString()); }
    catch { return false; }
  }
}

internal static class Native
{
  public const int WM_NCLBUTTONDOWN = 0xA1;
  public const int HTCAPTION = 2;
  static readonly IntPtr DpiPerMonitorV2 = new IntPtr(-4);

  public static int InstallProgress(IntPtr parent)
  {
    if (parent == IntPtr.Zero) return -1;
    IntPtr page = FindWindowEx(parent, IntPtr.Zero, "#32770", null);
    IntPtr bar = GetDlgItem(page, 1004);
    if (bar == IntPtr.Zero) return -1;
    long maximum = SendMessage(bar, 0x0407, IntPtr.Zero, IntPtr.Zero).ToInt64();
    long position = SendMessage(bar, 0x0408, IntPtr.Zero, IntPtr.Zero).ToInt64();
    return maximum > 0 ? (int)Math.Min(99, position * 100 / maximum) : -1;
  }

  public static void EnablePerMonitorV2()
  {
    try { if (SetProcessDpiAwarenessContext(DpiPerMonitorV2)) return; }
    catch { }
    SetProcessDPIAware();
  }

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
  [DllImport("user32.dll")]
  static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool ReleaseCapture();
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}
