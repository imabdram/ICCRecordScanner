# Runs the Edge Function test suite.
#
#   .\test-admin-function.ps1                      # default project root
#   .\test-admin-function.ps1 -Root "C:\path\to\project"
#
# Three deliberate steps, because the sandbox blocks nested process spawns:
#   1. stage   the function (rewrite npm: import, capture the handler)
#   2. compile with the real TypeScript compiler
#   3. run the behavioural tests
param(
  [string]$Root = "..\_backup_ICCRecordScanner_20261119_104045"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "1/3 staging..." -ForegroundColor Cyan
$staged = node .\stage-function.mjs $Root
if ($LASTEXITCODE -ne 0) { Write-Error "staging failed"; exit 1 }
Write-Host "    $staged"

Write-Host "2/3 compiling..." -ForegroundColor Cyan
$errors = & node ".\node_modules\typescript\bin\tsc" $staged `
  --target es2022 --module esnext --moduleResolution bundler `
  --skipLibCheck --noEmitOnError false 2>&1
# Expected noise only: the Deno runtime global and one implicit-any.
$real = $errors | Where-Object {
  $_ -match 'error TS' -and $_ -notmatch "Cannot find name 'Deno'" -and $_ -notmatch 'TS7017'
}
if ($real) {
  Write-Host "    Type errors in the function:" -ForegroundColor Red
  $real | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  exit 1
}
if (-not (Test-Path ".\.fnbuild\stage.js")) {
  Write-Error "tsc produced no output"
  $errors | ForEach-Object { Write-Host $_ }
  exit 1
}
Write-Host "    compiled clean" -ForegroundColor Green

Write-Host "3/3 testing..." -ForegroundColor Cyan
node .\test-admin-function.mjs $Root
exit $LASTEXITCODE
