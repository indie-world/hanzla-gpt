# Downloads WAN 2.1 T2V-1.3B for ComfyUI.
# WAN handles people and realistic motion much better than LTX-Video, and the
# 1.3B variant is the only one that has any chance on a 4 GB card.

param(
  [string]$ComfyRoot = "D:\AI\ComfyUI_windows_portable\ComfyUI"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$base = "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files"

$targets = @(
  @{
    Url  = "$base/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors"
    Path = "$ComfyRoot\models\diffusion_models\wan2.1_t2v_1.3B_fp16.safetensors"
    Name = "WAN 2.1 T2V 1.3B (~2.8 GB)"
  },
  @{
    Url  = "$base/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
    Path = "$ComfyRoot\models\text_encoders\umt5_xxl_fp8_e4m3fn_scaled.safetensors"
    Name = "UMT5-XXL text encoder fp8 (~6.7 GB)"
  },
  @{
    Url  = "$base/vae/wan_2.1_vae.safetensors"
    Path = "$ComfyRoot\models\vae\wan_2.1_vae.safetensors"
    Name = "WAN 2.1 VAE (~250 MB)"
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
    Invoke-WebRequest -Uri $t.Url -OutFile $tmp -UseBasicParsing -TimeoutSec 7200
    Move-Item -Force $tmp $t.Path
    Write-Output ("OK    {0} - {1:N1} MB" -f $t.Name, ((Get-Item $t.Path).Length / 1MB))
  } catch {
    Write-Output "FAIL  $($t.Name) - $($_.Exception.Message)"
    if (Test-Path $tmp) { Remove-Item -Force $tmp }
  }
}
Write-Output "WAN DOWNLOAD FINISHED"
