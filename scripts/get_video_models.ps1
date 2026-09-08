# Downloads the LTX-Video pipeline for ComfyUI.
# LTX-Video is the fastest open text-to-video model; the 2B checkpoint bundles
# its own VAE, so only the T5 text encoder is needed alongside it.

param(
  [string]$ComfyRoot = "D:\AI\ComfyUI_windows_portable\ComfyUI"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$targets = @(
  @{
    Url  = "https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors"
    Path = "$ComfyRoot\models\checkpoints\ltx-video-2b-v0.9.5.safetensors"
    Name = "LTX-Video 2B checkpoint (~6 GB)"
  },
  @{
    Url  = "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors"
    Path = "$ComfyRoot\models\text_encoders\t5xxl_fp8_e4m3fn.safetensors"
    Name = "T5-XXL text encoder fp8 (~5 GB)"
  }
)

foreach ($t in $targets) {
  $dir = Split-Path $t.Path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  if (Test-Path $t.Path) {
    $mb = [math]::Round((Get-Item $t.Path).Length / 1MB, 1)
    Write-Output "SKIP  $($t.Name) - already present ($mb MB)"
    continue
  }

  Write-Output "GET   $($t.Name)"
  $tmp = $t.Path + ".part"
  try {
    Invoke-WebRequest -Uri $t.Url -OutFile $tmp -UseBasicParsing -TimeoutSec 7200
    Move-Item -Force $tmp $t.Path
    $mb = [math]::Round((Get-Item $t.Path).Length / 1MB, 1)
    Write-Output "OK    $($t.Name) - $mb MB"
  } catch {
    Write-Output "FAIL  $($t.Name) - $($_.Exception.Message)"
    if (Test-Path $tmp) { Remove-Item -Force $tmp }
  }
}

Write-Output "--- models present ---"
Get-ChildItem "$ComfyRoot\models\checkpoints", "$ComfyRoot\models\text_encoders" -File -ErrorAction SilentlyContinue |
  Select-Object Name, @{n = 'GB'; e = { [math]::Round($_.Length / 1GB, 2) } } | Format-Table -AutoSize
