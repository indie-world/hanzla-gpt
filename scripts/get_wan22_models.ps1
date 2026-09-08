# Downloads WAN 2.2 TI2V-5B, which does both text-to-video and image-to-video.
# Feeding it a photo is the only way to get a specific real person's likeness,
# since no open model knows people by name.

param(
  [string]$ComfyRoot = "D:\AI\ComfyUI_windows_portable\ComfyUI"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$base = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files"

$targets = @(
  @{
    Url  = "$base/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"
    Path = "$ComfyRoot\models\diffusion_models\wan2.2_ti2v_5B_fp16.safetensors"
    Name = "WAN 2.2 TI2V 5B (~10 GB)"
  },
  @{
    Url  = "$base/vae/wan2.2_vae.safetensors"
    Path = "$ComfyRoot\models\vae\wan2.2_vae.safetensors"
    Name = "WAN 2.2 VAE (~1.4 GB)"
  }
)

foreach ($t in $targets) {
  New-Item -ItemType Directory -Force -Path (Split-Path $t.Path -Parent) | Out-Null
  if (Test-Path $t.Path) {
    Write-Output ("SKIP  {0} - present ({1:N1} MB)" -f $t.Name, ((Get-Item $t.Path).Length / 1MB))
    continue
  }
  Write-Output "GET   $($t.Name)"
  $tmp = $t.Path + ".part"
  try {
    Invoke-WebRequest -Uri $t.Url -OutFile $tmp -UseBasicParsing -TimeoutSec 10800
    Move-Item -Force $tmp $t.Path
    Write-Output ("OK    {0} - {1:N1} MB" -f $t.Name, ((Get-Item $t.Path).Length / 1MB))
  } catch {
    Write-Output "FAIL  $($t.Name) - $($_.Exception.Message)"
    if (Test-Path $tmp) { Remove-Item -Force $tmp }
  }
}
Write-Output "WAN22 DOWNLOAD FINISHED"
