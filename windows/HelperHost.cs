using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

namespace WireGuardDesktop {
  sealed class HelperService : ServiceBase {
    Process child;
    readonly string root = Directory.GetParent(
      AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)
    ).FullName;
    public HelperService() {
      var key = Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar)).Replace("Helper-", "");
      ServiceName = "WireGuardDesktopHelper-" + key;
      CanStop = true;
      AutoLog = true;
    }
    void Log(string stream, string line) {
      if (String.IsNullOrEmpty(line)) return;
      try {
        File.AppendAllText(Path.Combine(root, "helper.log"),
          DateTime.UtcNow.ToString("o") + " " + stream + " " + line + Environment.NewLine);
      } catch { }
    }
    protected override void OnStart(string[] args) {
      var key = Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar)).Replace("Helper-", "");
      if (!System.Text.RegularExpressions.Regex.IsMatch(key, "^[a-f0-9]{16}$"))
        throw new InvalidOperationException("Invalid helper identity");
      var start = new ProcessStartInfo {
        FileName = Path.Combine(root, "bin", "node.exe"),
        Arguments = "--no-addons --disable-proto=delete \"" +
          Path.Combine(root, "windows-server.cjs") + "\" " + key,
        WorkingDirectory = root,
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardInput = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true
      };
      child = new Process { StartInfo = start, EnableRaisingEvents = true };
      child.OutputDataReceived += (sender, e) => Log("stdout", e.Data);
      child.ErrorDataReceived += (sender, e) => Log("stderr", e.Data);
      child.Start();
      child.BeginOutputReadLine();
      child.BeginErrorReadLine();
    }
    protected override void OnStop() {
      if (child == null) return;
      try {
        if (!child.HasExited) {
          child.StandardInput.WriteLine("shutdown");
          child.StandardInput.Flush();
          if (!child.WaitForExit(15000)) child.Kill();
        }
      } catch {
        try { if (!child.HasExited) child.Kill(); } catch { }
      } finally {
        child.Dispose();
        child = null;
      }
    }
    public static void Main(string[] args) {
      if (Environment.UserInteractive && args.Length == 1 && args[0] == "--console") {
        var service = new HelperService();
        service.OnStart(new string[0]);
        Console.CancelKeyPress += (sender, e) => { e.Cancel = true; service.OnStop(); };
        Thread.Sleep(Timeout.Infinite);
        return;
      }
      Run(new HelperService());
    }
  }
}
