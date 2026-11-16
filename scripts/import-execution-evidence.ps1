#Requires -Version 5.1
<#
.SYNOPSIS
  Publica nove capturas originais de execucao local no repositorio Jungle Gaming.
.DESCRIPTION
  Extrai o ZIP distribuido com o guia do projeto, confere os hashes SHA256,
  copia apenas arquivos PNG da lista autorizada para docs/evidence,
  realiza commit com a identidade Git local e opcionalmente envia para origin/main.
  Nao altera codigo-fonte e nao executa o ambiente Docker.
.EXAMPLE
  .\scripts\import-execution-evidence.ps1 -Archive "$HOME\Downloads\jungle_evidence_images_only.zip" -Push
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Archive,
  [switch]$Push
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$archivePath = (Resolve-Path -LiteralPath $Archive -ErrorAction Stop).Path
$expected = @{
  '01-docker-compose.png' = 'c2d7e32ff6c3942aaaecab6c0cbd4b40aeb3bab44388cbb615e3e6ddc3ac9ab3'
  '02-health-and-sqs.png' = 'ae9527c557e7862ab1eebf21356a94e9092452525db9b551d1521d4d73cc3c05'
  '03-wallet-created.png' = 'ea530efa8d6944e16e682cc89a8c9c32a6a580fd7e4df9d715010b4c82c6f016'
  '04-bet-processed.png' = 'bc702652996f5b2af2a15d71548c5d6573a5911920dd27f77ade47cb71d2fbd5'
  '05-idempotent-replay.png' = '42ac342df5fb494d9447769ad01e7fb281c600c503badd410107f6c674b152a8'
  '06-refund-processed.png' = '0448f862e61b73ffe946baeb5dd0e9203c6072af22ca72a3e0b07887d5e5109d'
  '07-ledger-history.png' = 'bd07967eed4ae0445b2ed4f1c2232c379d581f807389609929077c4887bc66e6'
  '08-reconciliation.png' = '544fd0870f0ab7b4d0221cc2ca021c871b094c139210dee4ce51a19960cc18c5'
  '09-concurrency-test.png' = 'ab23feafbfeb163ea009267b6025655e1de877a91aa298a948a0352c5f3d5c3b'
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git nao foi encontrado no PATH.'
}
if ((git -C $repo branch --show-current).Trim() -ne 'main') {
  throw 'Use a branch main antes de importar as imagens.'
}
$gitStatus = @(git -C $repo status --porcelain)
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel consultar git status.' }
if ($gitStatus.Count -gt 0) {
  throw 'O repositorio possui arquivos modificados ou nao versionados. Revise o git status antes de continuar.'
}
git -C $repo pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'Falha no git pull. Nada foi importado.' }

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("jungle-evidence-" + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $temp -Force
  $destination = Join-Path $repo 'docs\evidence'
  New-Item -ItemType Directory -Path $destination -Force | Out-Null

  foreach ($name in $expected.Keys) {
    $source = Join-Path (Join-Path $temp 'docs\evidence') $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Imagem obrigatoria ausente no ZIP: $name"
    }
    $actualHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expected[$name]) {
      throw "Hash SHA256 divergente: $name. Nao sera publicada."
    }
  }

  foreach ($name in ($expected.Keys | Sort-Object)) {
    $source = Join-Path (Join-Path $temp 'docs\evidence') $name
    Copy-Item -LiteralPath $source -Destination (Join-Path $destination $name) -Force
    Write-Host "Imagem verificada: $name"
  }

  git -C $repo add -- docs/evidence
  if ($LASTEXITCODE -ne 0) { throw 'Falha no git add.' }
  $staged = @(git -C $repo diff --cached --name-only)
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao verificar arquivos preparados.' }
  if ($staged.Count -eq 0) {
    Write-Host 'As nove imagens ja estao presentes e sem alteracoes.'
  } else {
    git -C $repo commit -m 'docs: add verified Windows PowerShell screenshots'
    if ($LASTEXITCODE -ne 0) { throw 'Falha no git commit. Verifique identidade Git e credenciais.' }
    Write-Host 'Imagens adicionadas em commit local.'
  }

  if ($Push) {
    git -C $repo push origin main
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao publicar no origin/main. O commit local foi preservado.' }
    Write-Host 'Publicadas as imagens em origin/main.'
  } else {
    Write-Host 'Para publicar, execute: git push origin main'
  }
} finally {
  if (Test-Path -LiteralPath $temp) {
    Remove-Item -LiteralPath $temp -Recurse -Force
  }
}
