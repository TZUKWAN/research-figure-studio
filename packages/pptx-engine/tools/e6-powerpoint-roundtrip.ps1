param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [Parameter(Mandatory = $true)][string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$pp = $null
$presentation = $null
$report = [ordered]@{
  input = $InputFile
  output = $OutputFile
  opened = $false
  initialShapeCount = 0
  moved = 0
  textChanged = 0
  colorsChanged = 0
  pasted = 0
  saved = $false
}

try {
  $pp = New-Object -ComObject PowerPoint.Application
  # This desktop PowerPoint instance rejects hidden automation (E_FAIL), so
  # keep the temporary experiment visible for a real application round-trip.
  $pp.Visible = -1
  $presentation = $pp.Presentations.Open($InputFile, 0, 0, 0)
  $report.opened = $true
  $slide = $presentation.Slides.Item(1)
  $report.initialShapeCount = $slide.Shapes.Count

  # The three generated test shapes are the only shapes on the blank slide.
  $targets = @()
  for ($i = 1; $i -le $slide.Shapes.Count; $i++) {
    $shape = $slide.Shapes.Item($i)
    if ($shape.Name -like 'RFS-A*' -or $shape.Name -like 'Shape *') {
      $targets += $shape
    }
  }
  if ($targets.Count -lt 3) {
    throw "Expected three metadata test shapes, found $($targets.Count)"
  }

  foreach ($shape in $targets) {
    $shape.Left = $shape.Left + 18
    $shape.Top = $shape.Top + 12
    $report.moved++

    $shape.TextFrame.TextRange.Text = "$($shape.TextFrame.TextRange.Text) | moved-text"
    $report.textChanged++

    $shape.Fill.Solid()
    $shape.Fill.ForeColor.RGB = [int]0x00C08020
    $report.colorsChanged++

    $shape.Copy()
    $pastedRange = $slide.Shapes.Paste()
    $pastedShape = $pastedRange.Item(1)
    $pastedShape.Left = $shape.Left + 24
    $pastedShape.Top = $shape.Top + 24
    $report.pasted++
  }

  # 24 = ppSaveAsOpenXMLPresentation (.pptx).
  $presentation.SaveAs($OutputFile, 24)
  $report.saved = $true
  $report.finalShapeCount = $slide.Shapes.Count
  $report | ConvertTo-Json -Depth 4
}
finally {
  if ($presentation) {
    try { $presentation.Close() } catch { }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  }
  if ($pp) {
    try { $pp.Quit() } catch { }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($pp)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
