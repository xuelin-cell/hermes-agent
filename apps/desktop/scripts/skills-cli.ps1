# Electron 路径和桌面路径由注册脚本写在此文件前面。
$ErrorActionPreference = 'Stop'
$requestFile = Join-Path ([IO.Path]::GetTempPath()) ('uniworker-cli-' + [Guid]::NewGuid().ToString('N') + '.json')
$resultFile = $requestFile + '.result'
$resultCode = 1
try {
    [IO.File]::WriteAllText($requestFile, (ConvertTo-Json -InputObject @($args) -Compress), [Text.UTF8Encoding]::new($false))
    # 只给 GUI 进程传文件路径，技能参数通过 JSON 保留空格、引号和非 ASCII 字符。
    $resolver = Start-Process -FilePath $cliElectron -ArgumentList @(('"' + $cliDesktop + '"'), '--desktop-skills-cli', ('"' + $requestFile + '"')) -WindowStyle Hidden -Wait -PassThru
    if (!(Test-Path -LiteralPath $resultFile)) { throw '无法解析桌面账号，请检查 UniWork 开发构建。' }
    $resolved = Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($resolved.error) { throw $resolved.error }
    if ($resolver.ExitCode -ne 0) { throw '桌面账号解析失败。' }
    foreach ($property in $resolved.env.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
    }
    $cliArguments = @($resolved.args)
    & $resolved.command @cliArguments
    $resultCode = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
} finally {
    Remove-Item -LiteralPath $requestFile, $resultFile -Force -ErrorAction SilentlyContinue
}
exit $resultCode
