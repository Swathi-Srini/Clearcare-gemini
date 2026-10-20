param(
  [string]$Deck = (Join-Path $PSScriptRoot '..\CLEARCARE_AMD_ACT_III_SUBMISSION\ClearCare_Hackathon_Presentation.pptx'),
  [string]$Output = (Join-Path $PSScriptRoot '..\CLEARCARE_AMD_ACT_III_SUBMISSION\videos\ClearCare_Hackathon_Presentation.mp4')
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$work = Join-Path $PSScriptRoot 'presentation_work'
$narrationPath = Join-Path $work 'narration.json'
$videoPath = [IO.Path]::GetFullPath($Output)
$audioDir = Join-Path $work 'narration_audio'
New-Item -ItemType Directory -Force $audioDir, (Split-Path $Output -Parent) | Out-Null
if (-not (Test-Path $narrationPath)) { throw "Narration source is missing: $narrationPath" }
$scenes = Get-Content -Raw -LiteralPath $narrationPath | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -match 'Zira|Aria|Jenny' } | Select-Object -First 1
if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
$synth.Rate = 0
$timings = @()
try {
  foreach ($scene in $scenes) {
    $wav = Join-Path $audioDir ($scene.id + '.wav')
    $synth.SetOutputToWaveFile($wav)
    $synth.Speak([string]$scene.text)
    $synth.SetOutputToNull()
    $bytes = [IO.File]::ReadAllBytes($wav)
    $sampleRate = [BitConverter]::ToInt32($bytes, 24)
    $channels = [BitConverter]::ToInt16($bytes, 22)
    $bits = [BitConverter]::ToInt16($bytes, 34)
    $dataBytes = 0
    for ($pos = 12; $pos + 8 -le $bytes.Length;) {
      $chunk = [Text.Encoding]::ASCII.GetString($bytes, $pos, 4)
      $chunkSize = [BitConverter]::ToInt32($bytes, $pos + 4)
      if ($chunk -eq 'data') { $dataBytes = $chunkSize; break }
      $pos += 8 + $chunkSize
    }
    if (-not $sampleRate -or -not $channels -or -not $bits -or -not $dataBytes) { throw "Narration WAV has no readable audio data: $wav" }
    $duration = [math]::Round($dataBytes / ($sampleRate * $channels * ($bits / 8)), 2)
    if ($duration -le 0) { throw "Narration audio was empty for $($scene.id)" }
    $timings += [pscustomobject]@{ id = $scene.id; file = $wav; text = [string]$scene.text; duration = $duration; slideDuration = $duration + 1.2 }
  }
} finally { $synth.Dispose() }

$ppt = $null; $pres = $null
try {
  $ppt = New-Object -ComObject PowerPoint.Application
  $ppt.Visible = -1
  $pres = $ppt.Presentations.Open((Resolve-Path -LiteralPath $Deck).Path, $false, $false, $false)
  if ($pres.Slides.Count -ne $timings.Count) { throw "Deck has $($pres.Slides.Count) slides but there are $($timings.Count) narration tracks." }
  for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    $slide = $pres.Slides.Item($i)
    $item = $timings[$i - 1]
    $shape = $slide.Shapes.AddMediaObject2($item.file, $false, $true, -20, -20, 1, 1)
    $shape.Name = "ClearCare narration $i"
    $shape.AnimationSettings.PlaySettings.PlayOnEntry = -1
    $shape.AnimationSettings.PlaySettings.HideWhileNotPlaying = -1
    $slide.SlideShowTransition.AdvanceOnClick = 0
    $slide.SlideShowTransition.AdvanceOnTime = -1
    $slide.SlideShowTransition.AdvanceTime = [single]$item.slideDuration
  }
  if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output -Force }
  $pres.CreateVideo($videoPath, $true, 5, 1080, 30, 85)
  $deadline = [DateTime]::UtcNow.AddMinutes(8)
  do {
    Start-Sleep -Seconds 3
    $status = [int]$pres.CreateVideoStatus
    Write-Host "[ClearCare video] Export status: $status"
    if ([DateTime]::UtcNow -gt $deadline) { throw 'PowerPoint video export exceeded 8 minutes.' }
  } while ($status -in 1, 2)
  if ($status -ne 3) { throw "PowerPoint video export did not complete (status $status)." }

  $srtTime = { param([double]$Seconds) $span = [TimeSpan]::FromSeconds($Seconds); '{0:00}:{1:00}:{2:00},{3:000}' -f [math]::Floor($span.TotalHours), $span.Minutes, $span.Seconds, $span.Milliseconds }
  $captions = @(); $offset = 0.0
  for ($i = 0; $i -lt $timings.Count; $i++) {
    $start = & $srtTime $offset; $end = & $srtTime ($offset + $timings[$i].duration)
    $captions += "$($i + 1)`n$start --> $end`n$($timings[$i].text)`n"
    $offset += $timings[$i].slideDuration
  }
  $srtPath = [IO.Path]::ChangeExtension($videoPath, '.srt')
  [IO.File]::WriteAllText($srtPath, ($captions -join "`n"), [Text.UTF8Encoding]::new($false))
  $header = [IO.File]::ReadAllBytes($videoPath) | Select-Object -First 12
  $signature = [Text.Encoding]::ASCII.GetString($header)
  if ($signature.Length -lt 8 -or $signature.Substring(4,4) -ne 'ftyp') { throw 'Exported file does not have an MP4 file header.' }
  Write-Host "Created narrated ClearCare presentation: $videoPath"
  Write-Host "Captions: $srtPath"
  $totalNarration = [math]::Round(($timings | Measure-Object -Property duration -Sum).Sum, 1)
  Write-Host "Slides: $($timings.Count) | Narration: $totalNarration seconds"
} finally {
  if ($pres) { $pres.Close() }
  if ($ppt) { $ppt.Quit() }
  if ($pres) { [Runtime.InteropServices.Marshal]::ReleaseComObject($pres) | Out-Null }
  if ($ppt) { [Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
