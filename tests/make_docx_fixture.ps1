param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
$archive = [System.IO.Compression.ZipFile]::Open($Path, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $entry = $archive.CreateEntry("word/document.xml")
  $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
  try {
    $writer.Write('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Test Candidate</w:t></w:r></w:p><w:p><w:r><w:t>Python FastAPI RAG Agent project experience for resume parser verification with enough text.</w:t></w:r></w:p></w:body></w:document>')
  } finally {
    $writer.Dispose()
  }
} finally {
  $archive.Dispose()
}
