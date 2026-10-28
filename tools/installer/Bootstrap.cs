// DSH Mobile Remote 自解压安装器（引导器源码）
//
// 为什么要有这个东西：用户拿到手应该只有一个 exe，双击就能装完。
// 不需要 git、不需要 7-Zip、不需要管理员权限、不需要手敲 mklink。
//
// 做法：
//   - 编译成普通的 .NET 控制台程序，zip 包用 /resource:DSHMOBILE.ZIP 嵌进程序集。
//   - 运行时从自身资源里取出 zip，解到 %TEMP%\dsh-mobile-setup-<pid>，
//     再拉起解出来的 install.cmd。
//   - install.cmd → Install-DshMobile.ps1 负责真正的工作（拷文件、建 junction、
//     写 cordis.patch.yml）。
//
// 这样打包只用 System.IO.Compression（.NET 4.5+ 自带），开发端不需要 7z，
// 用户端也不需要任何东西。

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

namespace DshMobileSetup
{
    internal static class Bootstrap
    {
        private const string ResourceName = "DSHMOBILE.ZIP";

        // 用 GetTempPath 而不是硬编码 %TEMP%：路径里可能带中文或空格，
        // 而 cmd 在没加引号时会把空格切成两半。
        // 进程号用 Process.GetCurrentProcess()：Environment.ProcessId 要 .NET 5+，
        // 而这里编译目标是 .NET Framework 4，没有那个属性。
        private static string NewWorkDir()
        {
            int pid = Process.GetCurrentProcess().Id;
            string root = Path.Combine(Path.GetTempPath(), "dsh-mobile-setup-" + pid);
            if (Directory.Exists(root)) Directory.Delete(root, true);
            Directory.CreateDirectory(root);
            return root;
        }

        private static bool Extract(string target)
        {
            Assembly self = Assembly.GetExecutingAssembly();
            using (Stream packed = self.GetManifestResourceStream(ResourceName))
            {
                if (packed == null)
                {
                    Console.Error.WriteLine("安装包损坏：内部资源 " + ResourceName + " 缺失。");
                    return false;
                }
                // 资源在编译时就是 zip，直接交给 ZipArchive，不必先落盘。
                using (var archive = new ZipArchive(packed, ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string name = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        if (name.EndsWith(Path.DirectorySeparatorChar.ToString())) continue;
                        string dest = Path.Combine(target, name);
                        string dir = Path.GetDirectoryName(dest);
                        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                        using (Stream src = entry.Open())
                        using (FileStream dst = File.Create(dest))
                        {
                            src.CopyTo(dst);
                        }
                        // 保留原始时间戳，方便日后核对版本。
                        try { File.SetLastWriteTime(dest, entry.LastWriteTime.DateTime); } catch { }
                    }
                }
            }
            return true;
        }

        private static int RunInstaller(string dir)
        {
            string cmd = Path.Combine(dir, "install.cmd");
            if (!File.Exists(cmd))
            {
                Console.Error.WriteLine("安装包不完整：缺少 install.cmd。");
                return 2;
            }
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c \"\"" + cmd + "\"\"",
                WorkingDirectory = dir,
                UseShellExecute = false,
            };
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }

        private static int Main()
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("DSH Mobile Remote 安装器");
            Console.WriteLine("================================");

            string dir = null;
            try
            {
                dir = NewWorkDir();
                if (!Extract(dir)) return 3;
                int code = RunInstaller(dir);
                if (code == 0)
                {
                    Console.WriteLine();
                    Console.WriteLine("按任意键关闭窗口。");
                    try { Console.ReadKey(true); } catch { }
                }
                return code;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("安装失败：" + error.Message);
                Console.Error.WriteLine(error.StackTrace);
                try { Console.ReadKey(true); } catch { }
                return 1;
            }
            finally
            {
                // 只在成功时清理；失败留着现场，用户/开发者还能去看日志。
                // 也绝不清理用户的安装目录——那不在 temp 下。
                try
                {
                    if (dir != null && Directory.Exists(dir)) { /* 保留，见上 */ }
                }
                catch { }
            }
        }
    }
}
