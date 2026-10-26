using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading.Tasks;
using System.Security.Principal;

internal static class Askpass
{
    private static int Main(string[] args)
    {
        byte[] response = null;
        try
        {
            string endpoint = Environment.GetEnvironmentVariable("OMP_SSH_ASKPASS_ENDPOINT");
            string ticket = Environment.GetEnvironmentVariable("OMP_SSH_ASKPASS_TICKET");
            if (String.IsNullOrEmpty(endpoint) || String.IsNullOrEmpty(ticket) || args.Length != 1 || Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT") == "confirm") return 1;
            const string prefix = @"\\.\pipe\";
            if (!endpoint.StartsWith(prefix, StringComparison.Ordinal)) return 1;
            using (var pipe = new NamedPipeClientStream(".", endpoint.Substring(prefix.Length), PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification))
            {
                pipe.Connect(5000);
                var bytes = Encoding.UTF8.GetBytes(ticket + "\n" + Convert.ToBase64String(Encoding.UTF8.GetBytes(args[0])) + "\n");
                Task write = pipe.WriteAsync(bytes, 0, bytes.Length);
                if (!write.Wait(5000)) return 1;
                using (var result = new MemoryStream())
                {
                    byte[] buffer = new byte[4098];
                    while (true)
                    {
                        Task<int> read = pipe.ReadAsync(buffer, 0, buffer.Length);
                        if (!read.Wait(5000)) { Array.Clear(buffer, 0, buffer.Length); return 1; }
                        int count = read.Result;
                        if (count == 0) break;
                        if (result.Length + count > 4097) { Array.Clear(buffer, 0, buffer.Length); return 1; }
                        result.Write(buffer, 0, count);
                    }
                    Array.Clear(buffer, 0, buffer.Length);
                    response = result.ToArray();
                    Array.Clear(result.GetBuffer(), 0, (int)result.Length);
                }
            }
            if (response.Length < 2 || response[0] != 1) return 1;
            using (Stream output = Console.OpenStandardOutput())
            {
                output.Write(response, 1, response.Length - 1);
                output.WriteByte(10);
                output.Flush();
            }
            return 0;
        }
        catch { return 1; }
        finally { if (response != null) Array.Clear(response, 0, response.Length); }
    }
}
