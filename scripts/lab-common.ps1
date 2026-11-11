function Assert-LabTree {
    if (Test-Path -LiteralPath $labRoot) {
        $items = @((Get-Item -LiteralPath $labRoot)) + @(Get-ChildItem -LiteralPath $labRoot -Force -Recurse)
        foreach ($item in $items) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Lab contains a reparse point: $($item.FullName)" }
            if (-not ($item.FullName -eq $labRoot -or $item.FullName.StartsWith($labRoot + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'Path outside lab' }
        }
    }
}
