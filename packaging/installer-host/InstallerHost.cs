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
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
  [STAThread]
  static int Main(string[] args)
  {
    try
    {
      Native.EnablePerMonitorV2();
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      Options options = Options.Parse(args);
      options.UiDir = UserData.StageUiFolder(options.UiDir);
      if (options.UiDir.Length == 0 || !File.Exists(Path.Combine(options.UiDir, "index.html")))
      {
        return 2;
      }
      // Elevated NSIS $PLUGINSDIR is Administrators-only (NSIS 3). WebView2's
      // medium-IL child cannot read file:// there (ERR_ACCESS_DENIED) and
      // cannot write EBWebView there either. Stage UI + cache under ProgramData
      // and navigate via Microsoft's virtual host mapping.
      options.UserDataDir = UserData.PrepareWritableFolder();
      Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", options.UserDataDir);
      Application.Run(new MainForm(options));
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
  }
}

public sealed class Options
{
  public string UiDir = "";
  public string Dir = "";
  public string UserDataDir = "";

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
      Close();
      return;
    }
    webView.ZoomFactor = 1;
    await FitCssViewport();
    Opacity = 1;
    WriteMarker("host-ready.txt");
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
    cancelled = true;
    WriteIni(Path.Combine(options.Dir, "cancel.ini"), "Install", new string[] {
      "Cancel=1"
    });
    Environment.ExitCode = 1;
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
    startInstall: function (opts) { b.StartInstall(JSON.stringify(opts || {})); },
    poll: function () { return JSON.parse(b.Poll()); },
    finish: function (opts) { b.Finish(JSON.stringify(opts || {})); },
    killApp: function () { return b.KillApp(); }
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
    bool running = AppIsRunning(existingDir);
    string occJson = occupancy.Length == 0 ? "null" : Json.Str(occupancy);
    StringBuilder sb = new StringBuilder();
    sb.Append('{');
    sb.Append("\"productName\":").Append(Json.Str("OMP Studio"));
    sb.Append(",\"version\":").Append(Json.Str(version));
    sb.Append(",\"runtimeVersion\":").Append(Json.Str(runtime));
    sb.Append(",\"arch\":").Append(Json.Str("x64"));
    sb.Append(",\"defaultPath\":").Append(Json.Str(defaultDir));
    sb.Append(",\"existingVersion\":").Append(Json.Str(existingVersion));
    sb.Append(",\"existingPath\":").Append(Json.Str(existingDir));
    sb.Append(",\"occupancy\":").Append(occJson);
    sb.Append(",\"running\":").Append(running ? "true" : "false");
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

  public void StartInstall(string json)
  {
    Dictionary<string, string> opts = Json.FlatObject(json);
    string dir = Get(opts, "path", "");
    string desktop = BoolFlag(Get(opts, "desktopShortcut", "true"));
    string kill = BoolFlag(Get(opts, "kill", "false"));
    if (dir.Length == 0) dir = DefaultInstallDir();
    MainForm.WriteIni(Path.Combine(form.Dir, "options.ini"), "Install", new string[] {
      "Dir=" + dir,
      "Desktop=" + desktop,
      "Kill=" + kill
    });
  }

  public string Poll()
  {
    bool done = File.Exists(Path.Combine(form.Dir, "done.ini"));
    return done ? "{\"done\":true}" : "{\"done\":false}";
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

  public bool KillApp()
  {
    string ini = Path.Combine(form.Dir, "host.ini");
    string existingDir = Ini.Read(ini, "ExistingDir", "");
    KillByName("OMP Studio");
    KillOmpUnder(existingDir);
    return !AppIsRunning(existingDir);
  }

  static void KillByName(string name)
  {
    Process[] list = Process.GetProcessesByName(name);
    for (int i = 0; i < list.Length; i++)
    {
      try { list[i].Kill(); }
      catch { }
      try { list[i].Dispose(); }
      catch { }
    }
  }

  static void KillOmpUnder(string root)
  {
    if (string.IsNullOrEmpty(root)) return;
    string prefix = root.TrimEnd('\\') + "\\";
    Process[] list = Process.GetProcessesByName("omp");
    for (int i = 0; i < list.Length; i++)
    {
      try
      {
        string file = list[i].MainModule.FileName;
        if (file != null && file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
          list[i].Kill();
        }
      }
      catch
      {
      }
      try { list[i].Dispose(); }
      catch { }
    }
  }

  static bool AppIsRunning(string existingDir)
  {
    Process[] studio = Process.GetProcessesByName("OMP Studio");
    bool running = studio != null && studio.Length > 0;
    for (int i = 0; studio != null && i < studio.Length; i++)
    {
      try { studio[i].Dispose(); }
      catch { }
    }
    if (running) return true;
    if (string.IsNullOrEmpty(existingDir)) return false;
    string prefix = existingDir.TrimEnd('\\') + "\\";
    Process[] omps = Process.GetProcessesByName("omp");
    for (int i = 0; i < omps.Length; i++)
    {
      try
      {
        string file = omps[i].MainModule.FileName;
        if (file != null && file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
          running = true;
        }
      }
      catch
      {
      }
      try { omps[i].Dispose(); }
      catch { }
    }
    return running;
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
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "OMP Studio");
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
  public static string Read(string path, string key, string fallback)
  {
    if (string.IsNullOrEmpty(path) || !File.Exists(path)) return fallback;
    try
    {
      string[] lines = ReadLines(path);
      for (int i = 0; i < lines.Length; i++)
      {
        string line = lines[i].Trim();
        if (line.Length == 0 || line[0] == '[' || line[0] == ';') continue;
        int eq = line.IndexOf('=');
        if (eq <= 0) continue;
        if (string.Equals(line.Substring(0, eq).Trim(), key, StringComparison.OrdinalIgnoreCase))
        {
          return line.Substring(eq + 1).Trim();
        }
      }
    }
    catch
    {
    }
    return fallback;
  }

  static string[] ReadLines(string path)
  {
    byte[] bytes = File.ReadAllBytes(path);
    Encoding enc = Encoding.UTF8;
    if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) enc = Encoding.Unicode;
    string text = enc.GetString(bytes);
    return text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
  }
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
    Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    if (string.IsNullOrEmpty(json)) return map;
    string s = json.Trim();
    if (s.Length < 2) return map;
    int i = 0;
    while (i < s.Length)
    {
      int keyStart = s.IndexOf('"', i);
      if (keyStart < 0) break;
      int keyEnd = s.IndexOf('"', keyStart + 1);
      if (keyEnd < 0) break;
      string key = s.Substring(keyStart + 1, keyEnd - keyStart - 1);
      int colon = s.IndexOf(':', keyEnd + 1);
      if (colon < 0) break;
      int valueStart = colon + 1;
      while (valueStart < s.Length && (s[valueStart] == ' ' || s[valueStart] == '\t')) valueStart++;
      if (valueStart >= s.Length) break;
      string value;
      int next;
      if (s[valueStart] == '"')
      {
        StringBuilder vb = new StringBuilder();
        int p = valueStart + 1;
        while (p < s.Length)
        {
          char c = s[p];
          if (c == '\\' && p + 1 < s.Length)
          {
            vb.Append(s[p + 1]);
            p += 2;
            continue;
          }
          if (c == '"') break;
          vb.Append(c);
          p++;
        }
        value = vb.ToString();
        next = p + 1;
      }
      else
      {
        int comma = s.IndexOfAny(new char[] { ',', '}' }, valueStart);
        if (comma < 0) comma = s.Length;
        value = s.Substring(valueStart, comma - valueStart).Trim();
        next = comma;
      }
      map[key] = value;
      i = next;
    }
    return map;
  }
}

internal static class UserData
{
  public const string VirtualHost = "omp-installer";

  public static string StageUiFolder(string sourceDir)
  {
    if (sourceDir == null || sourceDir.Length == 0) return "";
    string[] dests = new string[] {
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "omp-studio", "installer", "ui"),
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "omp-studio", "installer", "ui")
    };
    for (int i = 0; i < dests.Length; i++)
    {
      string dest = dests[i];
      if (dest == null || dest.Length == 0) continue;
      try
      {
        if (!string.Equals(Path.GetFullPath(sourceDir), Path.GetFullPath(dest), StringComparison.OrdinalIgnoreCase))
        {
          CopyTree(sourceDir, dest);
        }
        GrantUsers(dest, "RX");
        if (File.Exists(Path.Combine(dest, "index.html"))) return dest;
      }
      catch
      {
      }
    }
    return sourceDir;
  }

  public static string PrepareWritableFolder()
  {
    string[] candidates = new string[] {
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "omp-studio", "installer-webview"),
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "omp-studio", "installer-webview"),
      Path.Combine(Path.GetTempPath(), "omp-studio-installer-webview")
    };
    Exception last = null;
    for (int i = 0; i < candidates.Length; i++)
    {
      string dir = candidates[i];
      if (dir == null || dir.Length == 0) continue;
      try
      {
        Directory.CreateDirectory(dir);
        GrantUsers(dir, "M");
        string probe = Path.Combine(dir, ".write-test");
        File.WriteAllText(probe, "1", Encoding.ASCII);
        File.Delete(probe);
        return dir;
      }
      catch (Exception ex)
      {
        last = ex;
      }
    }
    if (last != null) throw last;
    throw new IOException("No writable WebView2 user data folder");
  }

  public static bool RuntimeInstalled()
  {
    try
    {
      string version = CoreWebView2Environment.GetAvailableBrowserVersionString();
      return version != null && version.Length > 0;
    }
    catch
    {
      return false;
    }
  }

  static void GrantUsers(string dir, string rights)
  {
    try
    {
      ProcessStartInfo psi = new ProcessStartInfo();
      psi.FileName = "icacls.exe";
      psi.Arguments = "\"" + dir + "\" /grant *S-1-5-32-545:(OI)(CI)" + rights + " /T /C /Q";
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      psi.WindowStyle = ProcessWindowStyle.Hidden;
      Process p = Process.Start(psi);
      if (p != null) p.WaitForExit(4000);
    }
    catch
    {
    }
  }

  static void CopyTree(string from, string to)
  {
    Directory.CreateDirectory(to);
    string[] files = Directory.GetFiles(from);
    for (int i = 0; i < files.Length; i++)
    {
      File.Copy(files[i], Path.Combine(to, Path.GetFileName(files[i])), true);
    }
    string[] dirs = Directory.GetDirectories(from);
    for (int i = 0; i < dirs.Length; i++)
    {
      CopyTree(dirs[i], Path.Combine(to, Path.GetFileName(dirs[i])));
    }
  }
}

internal static class Native
{
  public const int WM_NCLBUTTONDOWN = 0xA1;
  public const int HTCAPTION = 2;
  static readonly IntPtr DpiPerMonitorV2 = new IntPtr(-4);

  public static void EnablePerMonitorV2()
  {
    try
    {
      if (SetProcessDpiAwarenessContext(DpiPerMonitorV2)) return;
    }
    catch
    {
    }
    SetProcessDPIAware();
  }

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll")]
  static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [DllImport("user32.dll")]
  public static extern bool ReleaseCapture();

  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}
