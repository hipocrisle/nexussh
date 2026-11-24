# Диагностика до аутентификации: два TCP-соединения, без логина и пароля.
# Совместимо с Windows PowerShell 5.1 / PowerShell 7. Настройки устройства не меняет.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TargetHost,
    [ValidateRange(1, 65535)][int]$Port = 22,
    [ValidateRange(500, 15000)][int]$TimeoutMs = 4000
)

foreach ($identity in @('SSH-2.0-russh_0.61.1', 'SSH-2.0-PuTTY_0.73_RU_17')) {
    $client = New-Object System.Net.Sockets.TcpClient
    $result = [ordered]@{ Client = $identity; Result = ''; Server = ''; BytesRead = 0 }
    try {
        $connection = $client.ConnectAsync($TargetHost, $Port)
        if (-not $connection.Wait($TimeoutMs)) { throw 'ConnectTimeout' }
        $connection.GetAwaiter().GetResult()
        $stream = $client.GetStream()
        $stream.WriteTimeout = $TimeoutMs
        $hello = [System.Text.Encoding]::ASCII.GetBytes($identity + "`r`n")
        $stream.Write($hello, 0, $hello.Length)
        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        $line = New-Object System.Text.StringBuilder
        $lines = 0
        while ($result.BytesRead -lt 4096) {
            $remaining = $TimeoutMs - [int]$clock.ElapsedMilliseconds
            if ($remaining -le 0) { throw 'ReadTimeout' }
            $stream.ReadTimeout = $remaining
            $value = $stream.ReadByte()
            if ($value -eq -1) { $result.Result = 'ClosedBeforeServerId'; break }
            $result.BytesRead++
            if ($value -eq 10) {
                $text = $line.ToString().TrimEnd([char]13)
                # Выводим только SSH-идентификатор, не произвольный текст сервера.
                if ($text -cmatch '^SSH-(2\.0|1\.99)-[\x20-\x7e]+$') {
                    $result.Result = 'ServerIdReceived'
                    $result.Server = $text
                    break
                }
                $lines++
                if ($lines -ge 20) { $result.Result = 'NoSshId'; break }
                [void]$line.Clear()
            } else {
                [void]$line.Append([char]$value)
                if ($line.Length -ge 255) { $result.Result = 'LineTooLong'; break }
            }
        }
        if (-not $result.Result) { $result.Result = 'NoSshId' }
    } catch {
        # Сообщение исключения может содержать путь/сетевые сведения; не выводим.
        $result.Result = 'TimeoutOrSocketError'
    } finally {
        $client.Dispose()
    }
    [pscustomobject]$result
    Start-Sleep -Milliseconds 500
}
