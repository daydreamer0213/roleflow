param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
$archive = [System.IO.Compression.ZipFile]::OpenRead($Path)

try {
  $entry = $archive.GetEntry("word/document.xml")
  if ($null -eq $entry) {
    throw "Invalid DOCX file."
  }
  $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8)
  try {
    [xml]$document = $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }

  $paragraphs = foreach ($paragraph in $document.GetElementsByTagName("p", $namespace)) {
    ($paragraph.GetElementsByTagName("t", $namespace) | ForEach-Object { $_.InnerText }) -join ""
  }
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::Write(($paragraphs -join [Environment]::NewLine))
} finally {
  $archive.Dispose()
}
