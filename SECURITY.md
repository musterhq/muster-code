# Security policy

## Supported versions

Only the latest release of Muster Agent receives security fixes. Please update to the latest
[release](https://github.com/musterhq/muster-code/releases/latest) (the app can update itself) before reporting.

## Reporting a vulnerability

Please report privately using GitHub Security Advisories:
**Security tab > Report a vulnerability** on this repository
(<https://github.com/musterhq/muster-code/security/advisories/new>).

Do not open a public issue or pull request for a vulnerability. Include the app version, your OS,
what you found, and steps to reproduce. We aim to acknowledge reports within a few days and will keep
you updated until a fix ships. Please give us reasonable time to release a fix before disclosing.

Particularly relevant areas: the Electron main/preload boundary, the local sandbox and scoped computers,
provider credential handling, the auto-updater, and the built-in browser.
