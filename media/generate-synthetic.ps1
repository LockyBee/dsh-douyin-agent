$ErrorActionPreference = 'Stop'
# 只生成测试用合成语音，不录制麦克风，也不播放声音。
$verificationDirectory = Join-Path $PSScriptRoot 'verification'
New-Item -ItemType Directory -Path $verificationDirectory -Force | Out-Null
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $english = $voice.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1
  if (-not $english) { throw '未找到英文SAPI语音，无法生成这项测试素材。' }
  $voice.SelectVoice($english.VoiceInfo.Name)
  $voice.Rate = -1
  $voice.SetOutputToWaveFile((Join-Path $verificationDirectory 'synthetic.wav'))
  $voice.Speak('The orange cat is sleeping beside the blue window. This recording is only a test.')
  Write-Output '已生成本机合成测试语音。'
} finally { $voice.Dispose() }
