# Prints the title of every Edge window, with invisible/non-ASCII characters shown as <U+XXXX>.
Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object {
  $chars = foreach ($c in $_.MainWindowTitle.ToCharArray()) {
    if ([int]$c -gt 126 -or [int]$c -lt 32) { '<U+{0:X4}>' -f [int]$c } else { [string]$c }
  }
  $chars -join ''
}
