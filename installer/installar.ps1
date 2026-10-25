# ============================================================
# FLOORP SYSTEM - INSTALADOR DEFINITIVO (v0.18)
#   Una vez por computadora. Sin permisos de administrador:
#   todo se escribe dentro de tu carpeta de perfil de Floorp.
#
#   Hace, en orden:
#     1. Detecta el/los perfiles de Floorp solos.
#     2. Copia el tema oscuro (chrome/) al perfil.
#     3. Deja la home FLOORP SYSTEM como nueva tab (override file://).
#     4. Si hay XPI firmado en dist/ -> lo sideloada a extensions/
#        (a partir de ahi la extension vive PERMANENTE: vault, autos,
#         notificaciones, tabs reales... sin about:debugging nunca mas).
#     5. Backup de prefs.js antes de tocar nada.
#
# Correr asi (o con instalar.bat en Windows):
#   powershell -NoProfile -ExecutionPolicy Bypass -File installar.ps1
# ============================================================
$ErrorActionPreference = "Stop"

$Root  = Split-Path -Parent $PSScriptRoot   # raiz del paquete
$Ext   = Join-Path $Root "dist"
$Theme = Join-Path $Root "chrome"

Write-Host ""
Write-Host "FLOORP SYSTEM // INSTALLER DEFINITIVO" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. perfiles ----------
$profileRoots = @()
$ProfileDirs  = @()

if ($IsWindows -or $env:OS -eq "Windows_NT") {
    $profileRoots += (Join-Path $env:APPDATA "Floorp\Profiles")
    $profileRoots += (Join-Path $env:LOCALAPPDATA "Floorp\Profiles")
} else {
    $profileRoots += (Join-Path $HOME ".floorp/profiles")
    $profileRoots += (Join-Path $HOME ".floorp")
    $profileRoots += (Join-Path $HOME "floorp/profiles")
}

foreach ($r in $profileRoots) {
    if (Test-Path $r) {
        foreach ($d in (Get-ChildItem $r -Directory)) {
            if (Test-Path (Join-Path $d.FullName "prefs.js")) { $ProfileDirs += $d.FullName }
        }
    }
}

if (-not $ProfileDirs.Count) {
    Write-Host "  x No encontre perfiles de Floorp en esta PC." -ForegroundColor Red
    Write-Host "    Abri Floorp una vez, cerrelo, y volvé a correr este script." -ForegroundColor Yellow
    exit 1
}
Write-Host ("  ok - perfil(es): " + ($ProfileDirs -join ", ")) -ForegroundColor Green

# ---------- 2-4. por cada perfil ----------
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$xpiSigned   = Join-Path $Ext "floorp-system-signed.xpi"
$xpiFallback = Get-ChildItem $Ext -Filter "floorp-system@*.xpi" -ErrorAction SilentlyContinue |
               Select-Object -First 1

foreach ($p in $ProfileDirs) {
    Write-Host ""
    Write-Host ("== " + $p)

    # backup de prefs.js (siempre)
    Copy-Item (Join-Path $p "prefs.js") (Join-Path $p "prefs.js.fsys-backup-$stamp") -Force
    Write-Host "   backup prefs.js -> prefs.js.fsys-backup-$stamp" -ForegroundColor DarkGray

    # 2. tema (carpeta chrome del perfil; nunca borra lo que ya hay)
    if (Test-Path $Theme) {
        $dest = Join-Path $p "chrome"
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item (Join-Path $Theme "*") $dest -Recurse -Force
        Write-Host "   tema copiado a chrome\" -ForegroundColor Green
    }

    # 3. nueva tab = our home (file://) -- reemplaza la linea si ya existia
                    $home_html = Join-Path $p "chrome\FLOORP-SYSTEM\index.html"
    if (Test-Path $home_html) {
        $url = ([System.Uri] $home_html).AbsoluteUri
        $prefs = Get-Content (Join-Path $p "prefs.js")
        $prefs = $prefs | Where-Object { $_ -notmatch "floorp\.newtab\.overrides\.newtaburl" }
        $prefs += "user_pref(""floorp.newtab.overrides.newtaburl"", ""$url"");"
        Set-Content -Path (Join-Path $p "prefs.js") -Value $prefs -Encoding ASCII
        Write-Host "   nueva tab -> FLOORP SYSTEM ($url)" -ForegroundColor Green
    }
    # permitir sideload sin confirmacion eterna en about:addons
    $prefs2 = Get-Content (Join-Path $p "prefs.js")
    $prefs2 = $prefs2 | Where-Object { 
                $_ -notmatch "extensions\.autoDisableScopes" -and
                $_ -notmatch "toolkit\.legacyUserProfileCustomizations\.stylesheets"
              }
    $prefs2 += "user_pref(""extensions.autoDisableScopes"", 0);"
    $prefs2 += "user_pref(""toolkit.legacyUserProfileCustomizations.stylesheets"", true);"
    Set-Content -Path (Join-Path $p "prefs.js") -Value $prefs2 -Encoding ASCII

    # 4. XPI permanente (si existe el firmado, u otro como fallback)
    $xpi = if (Test-Path $xpiSigned) { $xpiSigned } elseif ($xpiFallback) { $xpiFallback.FullName } else { $null }
    if ($xpi) {
        $dest2 = Join-Path $p "extensions"
        New-Item -ItemType Directory -Force -Path $dest2 | Out-Null
        $m = ($Root | ForEach-Object { Get-Content (Join-Path $_ "floorp-system-extension\manifest.json") -Raw } | ConvertFrom-Json)
        $name = $m.browser_specific_settings.gecko.id + ".xpi"
        Copy-Item $xpi (Join-Path $dest2 $name) -Force
        Write-Host ("   extension PERMANENTE sideloada -> extensions\" + $name) -ForegroundColor Green
    } else {
        Write-Host "   (sin XPI firmado: la extension queda temporal - ver paso de abajo)" -ForegroundColor Yellow
    }
}

# ---------- aviso Floorp abierto ----------
$lockLeft = @()
foreach ($p in $ProfileDirs) {
    $lock = Join-Path $p "parent.lock"
    if (Test-Path $lock) {
        try { $fs=[System.IO.File]::Open($lock,'Open','ReadWrite','None'); $fs.Close() }
        catch { $lockLeft += $p }
    }
}

Write-Host ""
if ($lockLeft.Count) {
    Write-Host "  IMPORTANTE: Floorp esta corriendo con $($lockLeft.Count) perfil(es) de los tocados." -ForegroundColor Yellow
    Write-Host "  Cerra Floorp y re-arranca: si los cambios no pegaron, corré"
    Write-Host "  este script otra vez con Floorp cerrado. Pref changes pisan prefs.js."
} else {
    Write-Host "  listo. Abrí Floorp: nueva tab = FLOORP SYSTEM v permanente." -ForegroundColor Green
}

if (-not (Test-Path $xpiSigned)) {
    Write-Host ""
    Write-Host "  Para dejar la extension PERMANENTE (tabs vault autos notif):" -ForegroundColor Yellow
    Write-Host "   1) cuenta gratis en addons.mozilla.org (correo)"
    Write-Host "   2) api keys: addons.mozilla.org/es/developers/addon/api/key/"
    Write-Host "   3) python tools/sign_amo.py   (con AMO_API_KEY / AMO_API_SECRET)"
    Write-Host "   4) re-corre este installer (ya sideloada el firmado sin tocarte mas nada)"
    Write-Host "  (5 min una vez en la vida - y ese XPI sirve en CUALQUIER dispositivo)"
} else {
    Write-Host ""
    Write-Host "  Extension firmada ya incluida: no hay un paso 2. Para siempre." -ForegroundColor Green
}
Write-Host ""
