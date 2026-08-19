---
name: security-hardening
description: "Security hardening: dependency scanning, cryptographic validation, secret detection, OWASP compliance, and threat modeling."
---

# Security Hardening

Proactive security for SiraGPT backend, frontend, and agent systems.

## Contract

- All high-severity CVEs must be fixed before release.
- No hardcoded secrets; use `.env` and secret management only.
- Cryptographic functions must use strong algorithms (AES-256, SHA-256+, etc.).
- Input validation is mandatory on all API endpoints and agent tools.
- OWASP Top 10 risks must be mitigated: injection, broken auth, XSS, CSRF, etc.

## Dependency Scanning

```bash
# Audit production dependencies
npm audit --omit=dev --audit-level=moderate

# Check for high-severity vulns
npm audit --audit-level=high

# Update deps safely
npm update [--depth 2]

# Custom vulnerability database
npm run security:scan -- --db custom
```

Unpatched high-severity = blocker for release.

## Cryptographic Validation

```bash
# Check for weak crypto usage
npm run security:crypto-audit

# Find hardcoded secrets
npm run security:secrets-scan -- --entropy

# Validate encryption implementations
npm run security:crypto-validate -- backend/src/**/*.js
```

Blockers: MD5, SHA1, DES, hardcoded keys.

## API Endpoint Hardening

```bash
# Validate input schemas on all endpoints
npm run security:validate-schemas -- app/api/**/*.ts

# Test CSRF protection
npm run security:csrf-test

# Test rate limiting
npm run security:ratelimit-test -- /api/ai/generate

# Test auth bypass
npm run security:auth-test
```

Each endpoint must have:
- Input validation (Zod/TypeBox schema)
- CSRF token check (for mutations)
- Rate limiting
- Auth guard (if protected)

## Agent System Hardening

```bash
# Validate tool registry for injection risks
npm run security:agents:validate-tools

# Check sandbox escapes
npm run security:agents:sandbox-test

# Audit task manifest for privilege escalation
npm run security:agents:manifest-audit

# Test task tool access controls
npm run security:agents:acl-test
```

Agent-specific blockers:
- Tool injection in prompts
- Sandbox escape attempts
- Privilege escalation in tool chains
- Malicious task arguments

## Frontend Security

```bash
# Check for XSS vulnerabilities
npm run security:xss-scan -- app/**/*.tsx

# Validate Content-Security-Policy headers
npm run security:csp-test

# Check for prototype pollution
npm run security:prototype-pollution

# Audit third-party libraries
npm run security:deps:inspect
```

## OWASP Compliance

### A01: Broken Access Control
```bash
npm run security:rbac-test    # Role-based access control
npm run security:authz-test   # Authorization checks
```

### A02: Cryptographic Failures
```bash
npm run security:crypto-audit # Weak algorithms
npm run security:secrets-scan # Exposed secrets
```

### A03: Injection
```bash
npm run security:injection-test -- sql,no-sql,xpath
```

### A04: Insecure Design
```bash
npm run security:threat-model # STRIDE analysis
```

### A05: Broken Authentication
```bash
npm run security:auth-test -- session,jwt,mfa
```

### A06: Software & Data Integrity Failures
```bash
npm run security:deps:audit   # Supply chain
npm run security:integrity    # Data validation
```

### A07: Identification & Authentication Failures
```bash
npm run security:identity-test
```

### A08: Software & Data Integrity Failures
```bash
npm run security:data-protection-test
```

### A09: Logging & Monitoring Failures
```bash
npm run security:audit-logs-test
```

### A10: SSRF
```bash
npm run security:ssrf-test
```

## Pre-Release Checklist

- [ ] `npm audit` reports 0 high-severity issues
- [ ] `npm run security:crypto-audit` passes
- [ ] `npm run security:secrets-scan` reports clean
- [ ] `npm run security:validate-schemas` all endpoints pass
- [ ] `npm run security:csrf-test` passes
- [ ] `npm run security:auth-test` passes
- [ ] `npm run security:agents:validate-tools` passes
- [ ] `npm run security:agents:sandbox-test` passes
- [ ] All OWASP tests pass

## Incident Response

**If CVE found:**
1. Check if SiraGPT is affected: `npm ls <package>`
2. Patch locally: `npm install <package>@<patch-version>`
3. Run audit: `npm audit`
4. Test: `npm run test`
5. Merge & deploy immediately

**If exploit found in code:**
1. Isolate the code path
2. Implement fix
3. Add regression test
4. Run full security suite
5. PR & merge

## Team Rules

- Never commit hardcoded secrets
- Use `.env` and secret manager for credentials
- Never skip `npm audit` before release
- Document security exceptions (rare)
- Report security issues privately; do not open public issues
