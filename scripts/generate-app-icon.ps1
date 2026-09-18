$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$iconDirectory = Join-Path $PSScriptRoot '..\src\frontend\public'
$variants = @(
  @{ Id = 'original'; SurfaceStart = '#203447'; SurfaceEnd = '#101b2a'; FlowStart = '#72efd4'; FlowEnd = '#34a9e6'; Bar = '#eefaf8'; Border = [System.Drawing.Color]::FromArgb(31, 255, 255, 255) },
  @{ Id = 'violet'; SurfaceStart = '#30294c'; SurfaceEnd = '#171528'; FlowStart = '#c7a6ff'; FlowEnd = '#8a73f2'; Bar = '#f7f0ff'; Border = [System.Drawing.Color]::FromArgb(31, 255, 255, 255) },
  @{ Id = 'ember'; SurfaceStart = '#443027'; SurfaceEnd = '#241a1d'; FlowStart = '#ffd189'; FlowEnd = '#f38672'; Bar = '#fff7e9'; Border = [System.Drawing.Color]::FromArgb(31, 255, 255, 255) },
  @{ Id = 'frost'; SurfaceStart = '#f9fcff'; SurfaceEnd = '#dceaf4'; FlowStart = '#29647b'; FlowEnd = '#438fc0'; Bar = '#17283d'; Border = [System.Drawing.Color]::FromArgb(41, 23, 48, 74) }
)

function New-RoundedPath([single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Get-IconPng([int]$size, [hashtable]$palette) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $stream = [System.IO.MemoryStream]::new()
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.ScaleTransform($size / 64.0, $size / 64.0)

    $surface = New-RoundedPath 0 0 64 64 16
    $surfaceBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      [System.Drawing.PointF]::new(0, 0), [System.Drawing.PointF]::new(64, 64),
      [System.Drawing.ColorTranslator]::FromHtml($palette.SurfaceStart),
      [System.Drawing.ColorTranslator]::FromHtml($palette.SurfaceEnd)
    )
    $border = New-RoundedPath 1 1 62 62 15
    $borderPen = [System.Drawing.Pen]::new($palette.Border, 2)
    $flowBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      [System.Drawing.PointF]::new(0, 0), [System.Drawing.PointF]::new(64, 64),
      [System.Drawing.ColorTranslator]::FromHtml($palette.FlowStart),
      [System.Drawing.ColorTranslator]::FromHtml($palette.FlowEnd)
    )
    $flowPen = [System.Drawing.Pen]::new($flowBrush, 6)
    $symbolPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $crossbarBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($palette.Bar))
    $crossbarPen = [System.Drawing.Pen]::new($crossbarBrush, 5)
    try {
      $graphics.FillPath($surfaceBrush, $surface)
      $graphics.DrawPath($borderPen, $border)
      $flowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $flowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $flowPen.Width = 7
      $symbolPath.AddBezier(39, 22, 30, 19, 23, 24, 23, 32)
      $symbolPath.AddBezier(23, 32, 23, 40, 30, 45, 39, 42)
      $graphics.DrawPath($flowPen, $symbolPath)
      $crossbarPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $crossbarPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $graphics.DrawLine($crossbarPen, 13, 32, 52, 32)
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      return ,$stream.ToArray()
    } finally {
      $surface.Dispose()
      $surfaceBrush.Dispose()
      $border.Dispose()
      $borderPen.Dispose()
      $flowBrush.Dispose()
      $flowPen.Dispose()
      $symbolPath.Dispose()
      $crossbarBrush.Dispose()
      $crossbarPen.Dispose()
    }
  } finally {
    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

foreach ($palette in $variants) {
  $baseName = if ($palette.Id -eq 'original') { 'icon' } else { "icon-$($palette.Id)" }
  $pngPath = Join-Path $iconDirectory "$baseName.png"
  $icoPath = Join-Path $iconDirectory "$baseName.ico"
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $images = @($sizes | ForEach-Object { [pscustomobject]@{ Size = $_; Bytes = (Get-IconPng $_ $palette) } })
  [System.IO.File]::WriteAllBytes($pngPath, (Get-IconPng 1024 $palette))

  $iconStream = [System.IO.MemoryStream]::new()
  $writer = [System.IO.BinaryWriter]::new($iconStream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($image in $images) {
      $dimension = if ($image.Size -eq 256) { 0 } else { $image.Size }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$image.Bytes.Length)
      $writer.Write([uint32]$offset)
      $offset += $image.Bytes.Length
    }
    foreach ($image in $images) { $writer.Write([byte[]]$image.Bytes) }
    [System.IO.File]::WriteAllBytes($icoPath, $iconStream.ToArray())
  } finally {
    $writer.Dispose()
    $iconStream.Dispose()
  }
  Write-Output "Generated $pngPath and $icoPath"
}
