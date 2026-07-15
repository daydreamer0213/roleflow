param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
$archive = [System.IO.Compression.ZipFile]::OpenRead($Path)

try {
  $entries = @($archive.Entries | Where-Object {
    $_.FullName -eq "word/document.xml" -or $_.FullName -match '^word/(header|footer)\d+\.xml$'
  } | Sort-Object { if ($_.FullName -eq "word/document.xml") { 0 } else { 1 } }, FullName)
  if ($entries.Count -eq 0) {
    throw "Invalid DOCX file."
  }

  $paragraphs = foreach ($entry in $entries) {
    $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8)
    try {
      [xml]$document = $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
    foreach ($paragraph in $document.GetElementsByTagName("p", $namespace)) {
      ($paragraph.GetElementsByTagName("t", $namespace) | ForEach-Object { $_.InnerText }) -join ""
    }
  }
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::Write(($paragraphs -join [Environment]::NewLine))
} finally {
  $archive.Dispose()
}
