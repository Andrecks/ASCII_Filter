# OCR helper for ASCII Shader desktop — wraps the Windows 10 built-in OCR engine
# (Windows.Media.Ocr, the same one PowerToys Text Extractor uses). Runs as a
# persistent child process: reads an image path per stdin line, answers with one
# JSON line: {ok, ms, words:[{t,x,y,w,h}]} in source-image pixel coords.
# -Test <path>: one-shot diagnostic run with timing and a word sample.
param([string]$Test)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                 $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $null = $netTask.Wait(-1)
  $netTask.Result
}

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
  $lang = New-Object Windows.Globalization.Language 'en-US'
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
}

function Recognize([string]$path) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $words = New-Object System.Collections.ArrayList
      foreach ($line in $result.Lines) {
        foreach ($w in $line.Words) {
          $r = $w.BoundingRect
          $null = $words.Add([ordered]@{
            t = $w.Text
            x = [math]::Round($r.X, 1); y = [math]::Round($r.Y, 1)
            w = [math]::Round($r.Width, 1); h = [math]::Round($r.Height, 1)
          })
        }
      }
      return [ordered]@{ ok = $true; ms = $sw.ElapsedMilliseconds; words = $words }
    } finally { $bitmap.Dispose() }
  } finally { $stream.Dispose() }
}

if ($Test) {
  "engine language : $($engine.RecognizerLanguage.LanguageTag)"
  "available langs : $(([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ', ')"
  "max dimension   : $([Windows.Media.Ocr.OcrEngine]::MaxImageDimension)"
  $r = Recognize $Test
  "run 1: $($r.ms) ms, $($r.words.Count) words"
  $r2 = Recognize $Test
  "run 2 (warm): $($r2.ms) ms, $($r2.words.Count) words"
  "sample:"
  $r2.words | Select-Object -First 18 | ForEach-Object { "  '$($_.t)' @ $($_.x),$($_.y) $($_.w)x$($_.h)" }
  exit 0
}

# persistent loop: one image path in, one compact JSON line out
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  try {
    $resp = Recognize $line
  } catch {
    $resp = [ordered]@{ ok = $false; error = "$($_.Exception.Message)" }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 5 $resp))
}
