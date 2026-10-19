# Family Calendar authentication — test only

This is NOT a public-access deployment. The existing production calendar,
Tailscale preview, SQLite databases and Arney PR #43 remain unchanged until
the household explicitly approves deployment.

## Purpose

Allow access from normal browsers anywhere, without a VPN or Tailscale app on
the visiting phone, tablet or wall display. Tailscale Funnel will make an
address publicly reachable, so all calendar API endpoints, pages and private
uploads must be authenticated first.

## Security model

- Per-device server-managed sessions held in the existing local calendar.db.
- Passwords are salted scrypt hashes. Setup passwords are accepted on standard
  input, never placed in shell arguments, source code or GitHub.
- Session tokens are random and stored only as SHA-256 hashes in the database.
- HTTPS-only host-scoped Secure, HttpOnly, SameSite=Strict session cookies.
- A trusted session expires after 180 days WITHOUT activity. Continued use
  renews it; there is no annual scheduled sign-in.
- Clearing browser data, browser privacy rules, session revocation, password
  reset or security incidents can require signing in again.
- Each account can see and revoke its own trusted devices at /account.
- Password resets revoke all trusted devices for the affected account.
- Rate-limited login attempts, HTTPS same-origin checking for POST/PUT/DELETE,
  and middleware guarding calendar endpoints and uploaded images.
- Generic GET /api/health, login assets and sign-in/status endpoints are
  accessible without a session.

## Safe opt-in

For backward compatibility with the PRIVATE deployments, authentication is
disabled by default until explicitly activated on a server process using the
environment variable FAMILY_CALENDAR_AUTH_MODE=required.

NEVER open Funnel, a public reverse proxy or direct public port forwarding
unless authentication is actively required. Test that requests without a
cookie cannot read /api/events, /api/lists, /uploads/... or the homepage.
Disabling the auth flag while any public path is open will expose the site.

## Create the first account in the separate preview database

On the laptop, after building the authentication draft PR into the existing
isolated preview, run the following PowerShell. Type a strong password when
prompted; never paste it into ChatGPT or command history.

    $root = "$env:USERPROFILE\Projects\family-calendar-preview"
    $db = Join-Path $root "Server\data\calendar.db"
    $cli = Join-Path $root "scripts\manage-family-account.mjs"
    $secure = Read-Host "Choose a family password (14+ characters)" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $clear = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
      $clear | & node.exe $cli $db familyadmin "Family Admin"
      if ($LASTEXITCODE -ne 0) { throw "Family account setup failed." }
    } finally {
      if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
      Remove-Variable clear,secure -ErrorAction SilentlyContinue
    }

Creating or resetting an account replaces its password hash and removes its
existing remembered sessions. Create a separate username for each family
member if individual device revocation is desired.

## Start the isolated authenticated PR preview

The preview-pr.ps1 script lives in family-calendar-test. It inherits the
calling PowerShell environment when it starts the separate preview server.
Provision an account first; then run:

    $env:FAMILY_CALENDAR_AUTH_MODE = "required"
    try {
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Projects\family-calendar-test\scripts\preview-pr.ps1" -PullRequest NEW_PR_NUMBER
    } finally {
      Remove-Item Env:\FAMILY_CALENDAR_AUTH_MODE -ErrorAction SilentlyContinue
    }

Use the already working PRIVATE HTTPS preview address, not plain HTTP.
The browser must be on HTTPS for Secure cookies. Do not enable Funnel yet.

## Required tests before any public exposure

Verify signed-out GET and POST rejection for all APIs, uploaded files and
front-end pages; correct/wrong passwords and rate limits; cookie lifetime;
per-device revocation; password reset; server restart; phone Home Screen
login persistence; voice assistant; proxy origin/Host behavior; session
backups; and access from remote cellular.

Tailscale Funnel activation is a separate approved step. Do not expose the
calendar merely because this draft PR builds.
