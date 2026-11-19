// Hosted Windows QA only. Copies of this executable stand in for WinGet and
// both Copilot programs. The holder opens one test file without delete sharing.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;

static class ConversionFixture
{
    static readonly string Evidence = Environment.GetEnvironmentVariable("COPILOT_HOME");

    static void Marker(string name, string detail)
    {
        string path = Path.Combine(Evidence, name);
        File.WriteAllText(path + ".tmp", Process.GetCurrentProcess().Id + "\t" + detail);
        File.Move(path + ".tmp", path);
    }

    // Monotonic milliseconds on the Windows performance counter, shared with Node.
    static long NowMs() { return (long)(Stopwatch.GetTimestamp() * (1000.0 / Stopwatch.Frequency)); }

    static int Hold(string file, string releaseOn, int delayMs)
    {
        if (!Stopwatch.IsHighResolution) throw new InvalidOperationException("QPC unavailable");
        string signal;
        long seenMs, closingMs;
        using (new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            Marker("holder-ready", file);
            var clock = Stopwatch.StartNew();
            while (!File.Exists(Path.Combine(Evidence, releaseOn)) &&
                   !File.Exists(Path.Combine(Evidence, "update-finished")))
            {
                if (clock.Elapsed.TotalMinutes >= 3)
                    throw new TimeoutException("Holder received no release request");
                Thread.Sleep(5);
            }
            signal = File.Exists(Path.Combine(Evidence, releaseOn)) ? releaseOn : "update-finished";
            seenMs = NowMs();
            // Once a denial exists, even an already-finished control gets the
            // same delayed release. update-finished alone is cleanup evidence.
            if (signal == "first-denial.json")
            {
                long remaining;
                while ((remaining = seenMs + delayMs - NowMs()) > 0) Thread.Sleep((int)remaining);
            }
            closingMs = NowMs();
        }
        long closedMs = NowMs();
        Marker("holder-released", signal + "\t" + seenMs + "\t" + closingMs + "\t" + closedMs);
        return 0;
    }

    static int Main(string[] args)
    {
        string image = Assembly.GetExecutingAssembly().Location;
        string role = Path.GetFileNameWithoutExtension(image).ToLowerInvariant();
        if (role == "fixture" && args.Length == 4 && args[0] == "hold")
            return Hold(args[1], args[2], int.Parse(args[3]));
        File.AppendAllText(Path.Combine(Evidence, "programs.tsv"),
            image + "\t" + string.Join("\t", args) + "\n");
        if (role == "copilot" && args.SequenceEqual(new[] { "--no-auto-update", "--version" }))
        {
            Console.WriteLine(File.ReadAllText(image + ".version"));
            return 0;
        }
        if (role == "winget" && args.SequenceEqual(new[] {
            "install", "--id", "GitHub.Copilot", "--exact",
            "--accept-package-agreements", "--accept-source-agreements" }))
        {
            Console.Error.WriteLine("Synthetic installer: the newer program is already installed.");
            return 17;
        }
        return 64;
    }
}
