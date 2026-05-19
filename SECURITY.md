# Security Policy

We take the security of SiraGPT seriously. This document explains how to report
vulnerabilities and what to expect from the maintainers.

## Supported versions

Only the **latest minor release** of SiraGPT receives security updates. Older
minor versions are not patched — please upgrade before reporting issues that
affect them.

| Version            | Supported          |
| ------------------ | ------------------ |
| latest minor       | :white_check_mark: |
| previous minors    | :x:                |

## Reporting a vulnerability

**Please do not open public GitHub issues for security problems.**

Use one of the following private channels:

1. **Email** — [security@siragpt.io](mailto:security@siragpt.io) (preferred).
   PGP-encrypted reports are welcome; request our public key in plaintext first.
2. **GitHub Security Advisory** — open a private advisory at
   <https://github.com/SiraGPT-ORg/siraGPT/security/advisories/new>.

Please include:

- A description of the issue and its potential impact
- Steps to reproduce (proof-of-concept code if possible)
- Affected versions / commit SHA
- Any suggested mitigation
- Whether you would like public credit in the hall of fame

## Response time SLA

| Stage                          | Target                |
| ------------------------------ | --------------------- |
| Initial acknowledgement        | within **48 hours**   |
| Triage + severity assessment   | within **5 business days** |
| Fix for **critical** issues    | within **7 days**     |
| Fix for **high** issues        | within **30 days**    |
| Fix for medium / low issues    | next scheduled release |

Severity follows [CVSS v3.1](https://www.first.org/cvss/v3-1/specification-document)
unless otherwise noted.

## Disclosure policy

We follow **coordinated disclosure**. Once a fix has shipped (or 90 days have
elapsed, whichever comes first), we will publish a GitHub Security Advisory
crediting the reporter (unless anonymity is requested).

## Bug bounty

We **do not currently operate a paid bug-bounty program**. We deeply appreciate
responsible disclosure and will publicly credit researchers in our hall of fame
(see below).

## Hall of fame

The following researchers have helped keep SiraGPT secure. Thank you!

<!-- Add reporter names in chronological order. Format: `- @handle — short description (YYYY-MM-DD)` -->

_Be the first._

## Scope

In scope:

- The SiraGPT web application (frontend + backend)
- Official Docker images and deployment scripts in this repository
- Official `@siragpt/*` packages on npm

Out of scope:

- Denial-of-service attacks
- Social engineering of SiraGPT staff or contributors
- Findings against third-party services we integrate with (please report to
  those vendors directly)
- Issues that require physical access to a victim's device

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to comply with this policy
- Avoid privacy violations, destruction of data, and service disruption
- Give us reasonable time to remediate before public disclosure
