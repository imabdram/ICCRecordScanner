$ErrorActionPreference = 'Stop'

$manifest = Join-Path $PSScriptRoot '..\android\app\src\main\AndroidManifest.xml'
$manifest = [System.IO.Path]::GetFullPath($manifest)

if (-not (Test-Path -LiteralPath $manifest)) {
    throw "AndroidManifest.xml was not found: $manifest"
}

$content = [System.IO.File]::ReadAllText($manifest)
$permission = '<uses-permission android:name="android.permission.CAMERA" />'

if ($content -notmatch 'android\.permission\.CAMERA') {
    $manifestMatch = [regex]::Match($content, '<manifest\b[^>]*>')
    if (-not $manifestMatch.Success) {
        throw 'Could not find the opening <manifest> tag.'
    }

    $insert = $manifestMatch.Value + [Environment]::NewLine + '    ' + $permission
    $content = $content.Remove($manifestMatch.Index, $manifestMatch.Length).Insert($manifestMatch.Index, $insert)
    [System.IO.File]::WriteAllText($manifest, $content, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Camera permission added.'
} else {
    Write-Host 'Camera permission already exists.'
}
