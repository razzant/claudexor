// #672 QA observer, compiled on the disposable Windows runner with the .NET
// Framework csc.exe before any vendor iteration. rm/ps are read-only.
// hold opens only the explicit synthetic calibration file; no process signals.
//
//   c672obs.exe rm @<listfile>     Restart Manager RmGetList for the listed files
//   c672obs.exe ps [--since=<FILETIME>] <root> [<root>]
//                                   processes whose image is below a root or
//                                   whose image name contains "copilot"; with
//                                   --since, also up to 64 processes of the same
//                                   enumeration created at or after that time
//                                   (this helper and its children excluded)
//
// Output is one JSON object on stdout. Restart Manager reports processes that
// hold the registered FILES; it does not report directory handles or a
// process's current directory. Both are stated in the output as gaps.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

static class C672Obs
{
    [StructLayout(LayoutKind.Sequential)]
    struct FILETIME { public uint Low; public uint High; }

    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS { public int dwProcessId; public FILETIME ProcessStartTime; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, IntPtr rgApplications, uint nServices, IntPtr rgsServiceNames);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr h, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    const uint TH32CS_SNAPPROCESS = 0x2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    static readonly IntPtr INVALID = new IntPtr(-1);

    static string J(string s)
    {
        if (s == null) return "null";
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') { b.Append('\\').Append(c); }
            else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }
    static long Ft(FILETIME t) { return ((long)t.High << 32) | t.Low; }

    static int Rm(string listFile)
    {
        var files = new List<string>();
        foreach (var line in File.ReadAllLines(listFile, Encoding.UTF8))
            if (line.Trim().Length > 0) files.Add(line.Trim());
        var o = new StringBuilder("{\"mode\":\"rm\",\"files\":" + files.Count);
        o.Append(",\"limits\":[\"Restart Manager reports holders of the registered files only; directory handles and current directories are not reported\"]");
        uint session; var key = new StringBuilder(64);
        int rc = RmStartSession(out session, 0, key);
        if (rc != 0) { Console.WriteLine(o.Append(",\"error\":\"RmStartSession " + rc + "\"}")); return 2; }
        try
        {
            rc = RmRegisterResources(session, (uint)files.Count, files.ToArray(), 0, IntPtr.Zero, 0, IntPtr.Zero);
            if (rc != 0) { Console.WriteLine(o.Append(",\"error\":\"RmRegisterResources " + rc + "\"}")); return 2; }
            uint needed = 0, count = 0, reasons = 0;
            RM_PROCESS_INFO[] info = null;
            for (int attempt = 0; attempt < 4; attempt++)
            {
                info = new RM_PROCESS_INFO[count];
                rc = RmGetList(session, out needed, ref count, count == 0 ? null : info, ref reasons);
                if (rc == 234) { count = needed; continue; }
                break;
            }
            o.Append(",\"rmGetList\":" + rc + ",\"rebootReasons\":" + reasons + ",\"processes\":[");
            if (rc == 0)
                for (int i = 0; i < count; i++)
                {
                    if (i > 0) o.Append(',');
                    var p = info[i];
                    o.Append("{\"pid\":" + p.Process.dwProcessId + ",\"startTime\":" + Ft(p.Process.ProcessStartTime)
                        + ",\"appName\":" + J(p.strAppName) + ",\"service\":" + J(p.strServiceShortName)
                        + ",\"appType\":" + p.ApplicationType + ",\"appStatus\":" + p.AppStatus
                        + ",\"restartable\":" + (p.bRestartable ? "true" : "false") + "}");
                }
            o.Append("]}");
            Console.WriteLine(o);
            return rc == 0 ? 0 : 2;
        }
        finally { RmEndSession(session); }
    }

    static int Ps(string[] args)
    {
        long since = 0;
        var norm = new List<string>();
        foreach (var a in args)
        {
            if (a.StartsWith("--since=", StringComparison.Ordinal))
                since = long.Parse(a.Substring(8), NumberStyles.None, CultureInfo.InvariantCulture);
            else norm.Add(Path.GetFullPath(a).TrimEnd('\\') + "\\");
        }
        if (norm.Count == 0) throw new ArgumentException("ps needs at least one root");
        uint self = (uint)Process.GetCurrentProcess().Id;
        int recentTotal = 0, recentListed = 0;
        var recentRows = new StringBuilder();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID) { Console.WriteLine("{\"mode\":\"ps\",\"error\":\"snapshot " + Marshal.GetLastWin32Error() + "\"}"); return 2; }
        var o = new StringBuilder("{\"mode\":\"ps\",\"roots\":[");
        for (int i = 0; i < norm.Count; i++) { if (i > 0) o.Append(','); o.Append(J(norm[i])); }
        o.Append("],\"limits\":[\"image paths only; open handles, loaded modules and current directories are not listed\"],\"matches\":[");
        int total = 0, unreadable = 0, n = 0, enumerationError = 0;
        var unreadableRows = new StringBuilder();
        try
        {
            var e = new PROCESSENTRY32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            bool ok = Process32FirstW(snap, ref e);
            for (; ok; ok = Process32NextW(snap, ref e))
            {
                total++;
                string image = null; long created = 0; int imageError = 0;
                IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, e.th32ProcessID);
                if (h == IntPtr.Zero) imageError = Marshal.GetLastWin32Error();
                if (h != IntPtr.Zero)
                {
                    var sb = new StringBuilder(32768); uint size = (uint)sb.Capacity;
                    if (QueryFullProcessImageNameW(h, 0, sb, ref size)) image = sb.ToString();
                    else imageError = Marshal.GetLastWin32Error();
                    FILETIME c, x, k, u;
                    if (GetProcessTimes(h, out c, out x, out k, out u)) created = Ft(c);
                    CloseHandle(h);
                }
                if (image == null) {
                    if (unreadable++ > 0) unreadableRows.Append(',');
                    // Toolhelp's name is available independently of image-path access.
                    // Keep every gap, including idle/protected/exit-racing processes.
                    unreadableRows.Append("{\"pid\":" + e.th32ProcessID + ",\"exe\":" + J(e.szExeFile)
                        + ",\"error\":" + imageError + "}");
                }
                // Same enumeration, no extra calls: processes created since the caller's
                // start that are still present. Unreadable ones stay in unreadableImages.
                if (since > 0 && created >= since && e.th32ProcessID != self && e.th32ParentProcessID != self)
                {
                    recentTotal++;
                    if (recentListed < 64)
                    {
                        if (recentListed++ > 0) recentRows.Append(',');
                        recentRows.Append("{\"pid\":" + e.th32ProcessID + ",\"ppid\":" + e.th32ParentProcessID
                            + ",\"exe\":" + J(e.szExeFile) + ",\"image\":" + J(image) + ",\"created\":" + created + "}");
                    }
                }
                bool below = false;
                if (image != null) foreach (var r in norm) if (image.StartsWith(r, StringComparison.OrdinalIgnoreCase)) below = true;
                bool named = (e.szExeFile ?? "").IndexOf("copilot", StringComparison.OrdinalIgnoreCase) >= 0;
                if (!below && !named) continue;
                if (n++ > 0) o.Append(',');
                o.Append("{\"pid\":" + e.th32ProcessID + ",\"ppid\":" + e.th32ParentProcessID + ",\"exe\":" + J(e.szExeFile)
                    + ",\"image\":" + J(image) + ",\"created\":" + created + ",\"belowRoot\":" + (below ? "true" : "false") + "}");
            }
            int endError = Marshal.GetLastWin32Error();
            if (endError != 18) enumerationError = endError == 0 ? -1 : endError; // ERROR_NO_MORE_FILES only
        }
        finally { CloseHandle(snap); }
        o.Append("],\"total\":" + total + ",\"imageUnreadable\":" + unreadable
            + ",\"unreadableImages\":[" + unreadableRows + "],\"since\":" + since
            + ",\"recentTotal\":" + recentTotal + ",\"recent\":[" + recentRows + "]}");
        if (enumerationError != 0) {
            o.Length--; o.Append(",\"error\":\"enumeration " + enumerationError + "\"}");
        }
        Console.WriteLine(o);
        return enumerationError == 0 ? 0 : 2;
    }

    // Both arms use the same Windows FileStream call; only FILE_SHARE_DELETE
    // differs. The ready marker is written after opening the file and pipe.
    // The release acknowledgement is written only after disposing the handle.
    static int Hold(string file, string mode, string ready, string released, string pipeName)
    {
        if (mode != "delete" && mode != "no-delete") throw new ArgumentException("share mode");
        FileShare share = FileShare.ReadWrite;
        if (mode == "delete") share |= FileShare.Delete;
        int pid = Process.GetCurrentProcess().Id;
        bool requested = false;
        using (var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
        using (var fileHandle = new FileStream(file, FileMode.Open, FileAccess.Read, share))
        {
            var waiting = pipe.BeginWaitForConnection(null, null);
            File.WriteAllText(ready, "{\"pid\":" + pid + ",\"mode\":" + J(mode) + "}");
            // Safety bound for an abandoned calibration, not a release success.
            if (waiting.AsyncWaitHandle.WaitOne(600000)) {
                pipe.EndWaitForConnection(waiting);
                requested = pipe.ReadByte() == 1;
            }
            waiting.AsyncWaitHandle.Close();
        }
        File.WriteAllText(released, "{\"pid\":" + pid + ",\"released\":true,\"requested\":" + (requested ? "true" : "false") + "}");
        return requested ? 0 : 3;
    }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 6 && args[0] == "hold") return Hold(args[1], args[2], args[3], args[4], args[5]);
            if (args.Length == 2 && args[0] == "rm" && args[1].StartsWith("@")) return Rm(args[1].Substring(1));
            if (args.Length >= 2 && args[0] == "ps") { var r = new string[args.Length - 1]; Array.Copy(args, 1, r, 0, r.Length); return Ps(r); }
            Console.WriteLine("{\"error\":\"usage: c672obs rm @list | ps [--since=<filetime>] <root>...\"}");
            return 64;
        }
        catch (Exception ex)
        {
            Console.WriteLine("{\"error\":" + J(ex.ToString()) + "}");
            return 70;
        }
    }
}
