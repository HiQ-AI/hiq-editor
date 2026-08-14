# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue:

- Open a [GitHub Security Advisory](https://github.com/HiQ-AI/hiq-editor/security/advisories/new)
  on this repository (preferred), or
- email **security@hiq.earth** with the details and, if possible, a reproduction.

We aim to acknowledge a report within a few business days. Please give us a
reasonable window to ship a fix before any public disclosure.

## What's in scope

This is a thin client that forwards to a closed editor server and adds local
file handling. In-scope issues are those in **this code** — for example:

- leakage of the SSO token (logs, error messages, telemetry);
- a tool that performs a destructive write without the documented contract;
- path traversal or arbitrary file read/write via the local file tools
  (`parse_upr_template`, `export_process`).

Vulnerabilities in the upstream editor server or the platform it talks to are
out of scope here — report those to the platform operator.

## How credentials are handled

- The only credential is the **SSO token** (`HIQ_EDITOR_TOKEN`). It is a
  per-user secret that grants full editor access as that user. The client reads
  it from the environment the host spawns it with and forwards it verbatim as
  `Authorization: Bearer <token>` to the server — never from a file in the repo,
  and it is never written to logs.
- No token is bundled in the published package.

## Supported versions

Only the latest published version receives security fixes. Pin a version you
trust and upgrade promptly when a fix is released.
