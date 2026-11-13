# Windows Docker and WSL bootstrap

## TEST3: Windows PowerShell empty-path regression

On a host without Docker, the previous `Select-Object -First 1` pipeline
assigned PowerShell's empty-result value to both executable fields. Windows
PowerShell 5 serialized these values as `{}`, not JSON `null`. The JavaScript
path check then failed before the Docker installer could be offered.

TEST3 indexes the collected candidate array and explicitly converts each result
to a scalar string or `$null`. Non-string non-null executable inventory values
are rejected with `BOOTSTRAP_HOST_PROBE_INVALID` before any executable is used.
Hardware checks, vendor verification, elevation and manual licence acceptance
are unchanged.

An additional native end-to-end probe exposed a separate module-loading issue:
the PowerShell signature cmdlet could not autoload from the inherited module
environment and produced empty signature fields. The signature probe now
imports `Microsoft.PowerShell.Security` by its absolute path under `$PSHOME`,
uses its qualified cmdlet name and stops on PowerShell execution errors. It
still requires the expected valid publisher; no signature check is bypassed.

The regression tests execute the full `WINDOWS_HOST_PROBE` in actual
`powershell.exe` 5.1, with isolated CIM/path-presence fixtures. Six cases cover
absence, system and per-user paths (including Cyrillic/spaces), both locations
and either missing executable. Their JSON passes through `ensureDocker` to a
mocked installer/start action. These tests do not install Docker or constitute
a completed clean-Windows installation. The affected deployment suite passes
37 checks with no failures. A separate regression executes the exact signature
command in Windows PowerShell with a deliberately incompatible security module
on the inherited module path and confirms that an unsigned file is rejected.

`src/deployment-bundle/bootstrap/index.mjs` exports `probeDocker`,
`planDockerPrerequisites`, `verifyBootstrapAsset` and `ensureDocker`.

`ensureDocker({bundleRoot,manifest,run,launch,signal,allowInstall:false,receiptPath})`
is a read-only check by default. The manifest's `components.bootstrap` contains
`dockerInstaller` and `wslInstaller`, each with a bundle-relative `path`, exact
`bytes` and SHA-256. `BOOTSTRAP_VENDOR_ASSETS` records the verified vendor pins.
The full vendor installers are packaged, not the small installed Docker
maintenance executable. Recipient verification rechecks size/hash and valid
Authenticode with Docker Inc or Microsoft Corporation respectively.

Injected runners receive `{operation,file,args,env?,signal,timeoutMs}` and return
`{code,stdout}` (`exitCode` is also accepted). Interactive launches additionally
receive `interactive`, `elevated` and `wait`; the recipient launcher handles
vendor windows and native UAC. Tests replace both adapters with fixtures.

A healthy Linux Docker engine with Compose v2 or later is reused without
installation, restart, feature changes or context changes. Every Docker probe
pins the local Windows pipe and removes inherited `DOCKER_*` overrides. The
adapter never changes the user's default Docker context, proxy or network.

For a new installation the package checks Windows 11 x64 workstation build
22631+, 8 GiB RAM, virtualization/SLAT and 20 GiB free system-drive space. The disk
threshold is a package policy for bundled runtime and images, not a vendor claim.
Docker documents WSL 2.1.5+, Windows and hardware requirements in its
[Windows installation guide](https://docs.docker.com/desktop/setup/install/windows-install/).

With `allowInstall:true`, the adapter performs one resumable step:

- If Virtual Machine Platform is disabled, request native elevation and enable
  only that component with `/norestart`; return `reboot-required` and a receipt.
- If modern WSL is absent/old, open the bundled Microsoft MSI interactively.
- If Docker Desktop is absent, open its verified full installer in per-user,
  WSL-2 mode. There is no quiet or license-acceptance flag.
- If Docker is installed but not running, open its existing application. The
  recipient completes any vendor terms or setup UI manually.

The outer Setup resumes by calling the same check again after the vendor UI or
Windows restart. No RunOnce registration, forced reboot, feature removal, distro
installation, default distro switch or destructive rollback is performed.
Microsoft documents MSI-based offline WSL installation and enabling Virtual
Machine Platform in its [WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install#offline-install).

Docker's agreement is presented by Docker and accepted only by the recipient.
The adapter neither edits vendor acceptance state nor asserts that the current
user/organization has a suitable license. See Docker's
[startup instructions](https://docs.docker.com/desktop/setup/install/windows-install/#start-docker-desktop).

Prepared payloads: full Docker Desktop 4.99.0.245822, 623,969,712 bytes; official
WSL 3.0.5.0 x64 MSI, 367,788,032 bytes. Both signatures were verified without
running either installer. The WSL hash also matches Microsoft's release asset
metadata at [Microsoft WSL releases](https://github.com/microsoft/WSL/releases/tag/3.0.5).

Seven fixture tests pass: reuse, interactive install, reboot/resume, WSL update,
unsupported hardware/engine, cancellation and pinned payload verification.
No real Docker/WSL installation, service restart or Windows feature change was
performed during preparation. Fresh-recipient VM installation is not claimed.
