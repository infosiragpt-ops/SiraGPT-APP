---
name: agent-validation
description: "Agent system validation: tool registry consistency, task manifest schema validation, sandbox safety, and capability testing."
---

# Agent Validation

Ensure SiraGPT agent system is robust, safe, and performing optimally.

## Contract

- Tool registry must match tool manifest declarations 1:1.
- Task manifest schema must pass JSON schema validation.
- Sandbox must prevent escape and resource exhaustion.
- Agent task execution must complete within time/memory budgets.
- Tool authorization must be enforced; no privilege escalation.

## Tool Registry Validation

```bash
# Check registry vs manifest consistency
npm run agents:validate:registry

# List all registered tools
npm run agents:validate:tools --list

# Test tool invocation contract
npm run agents:validate:tools --invoke

# Check tool documentation
npm run agents:validate:tools --docs
```

Registry must declare:
- Tool name, description, version
- Input schema (JSON Schema)
- Output format (MIME type, shape)
- Authorization level (none/user/admin)
- Budget (call limit, timeout)

## Task Manifest Schema Validation

```bash
# Validate task manifest JSON schema
npm run agents:validate:manifest

# Inspect task manifest structure
npm run agents:validate:manifest -- --inspect backend/src/services/agents/task-manifest.js

# Test manifest against real tasks
npm run agents:validate:manifest -- --audit-tasks
```

Manifest must declare:
- Task ID, name, description
- Required tools and their parameters
- Success/failure conditions
- Output format
- SLA (timeout, retry policy)

## Sandbox Safety

```bash
# Test sandbox isolation
npm run agents:validate:sandbox:isolation

# Check resource limits (CPU, memory, file access)
npm run agents:validate:sandbox:limits

# Test file system access control
npm run agents:validate:sandbox:fs-acl

# Attempt escape (honeypot)
npm run agents:validate:sandbox:escape-test

# Measure sandbox overhead
npm run agents:validate:sandbox:overhead
```

Sandbox constraints:
- Memory: 256MB per task
- CPU: 10s timeout for simple, 30s for complex
- Network: allowlist only (no raw TCP/UDP)
- File system: read-only /src, temp dir only for writes
- Process: single Node.js VM, no spawning shell

## Task Execution Validation

```bash
# Run agent task with full instrumentation
npm run agents:validate:execute -- simple

# Complex task with tool chaining
npm run agents:validate:execute -- complex --trace

# Visual generation task
npm run agents:validate:execute -- visual --profile

# Concurrent tasks (load test)
npm run agents:validate:execute -- concurrent --concurrency 10
```

Acceptable SLAs:
- Simple task: < 2s
- Complex task: < 10s
- Visual generation: < 15s
- Bulk operations: < 30s

## Authorization Validation

```bash
# Test tool access control
npm run agents:validate:authz:tools

# Check user role enforcement
npm run agents:validate:authz:roles

# Test privilege escalation prevention
npm run agents:validate:authz:escalation-test

# Audit tool access logs
npm run agents:validate:authz:audit
```

Authorization layers:
1. User role check (free/pro/admin)
2. Tool-level clearance (none/user/admin)
3. Task-level constraints (budget, scope)

## Agent Performance Validation

```bash
# Baseline agent throughput
npm run agents:validate:perf:baseline

# Tool registry lookup performance
npm run agents:validate:perf:registry-lookup

# Task manifest parsing
npm run agents:validate:perf:manifest-parse

# Sandbox startup time
npm run agents:validate:perf:sandbox-startup

# End-to-end task latency
npm run agents:validate:perf:e2e --tasks 100
```

Performance targets:
- Registry lookup: < 1ms
- Manifest parsing: < 5ms per task
- Sandbox startup: < 500ms
- E2E task: < configured SLA

## Visual Tools Validation

```bash
# Test all 34+ visual generation tools
npm run agents:validate:visual:all

# Specific tool validation
npm run agents:validate:visual -- create_chart --variants 5

# SVG output validation
npm run agents:validate:visual:svg-validate

# Performance profiling
npm run agents:validate:visual:perf
```

Visual tools must:
- Generate valid SVG/HTML output
- Complete within timeout
- Not exceed memory budget
- Properly handle edge cases (empty data, etc.)

## Pre-Release Agent Checklist

- [ ] `npm run agents:validate:registry` passes
- [ ] `npm run agents:validate:manifest` passes
- [ ] `npm run agents:validate:sandbox:isolation` passes
- [ ] `npm run agents:validate:sandbox:escape-test` fails (no escapes)
- [ ] `npm run agents:validate:execute -- complex` completes within SLA
- [ ] `npm run agents:validate:authz:escalation-test` fails (no privilege escalation)
- [ ] `npm run agents:validate:visual:all` passes
- [ ] All agent tests: `npm run test -- agent-*.test.js` pass

## Troubleshooting

**Tool not in registry:**
```bash
npm run agents:validate:tools --missing  # Lists unregistered tools
```

**Sandbox timeout:**
```bash
npm run agents:validate:sandbox:limits --timeout 30000  # Increase if needed
```

**Authorization check failing:**
```bash
npm run agents:validate:authz:audit -- --user-id <id>
```

**Visual tool producing invalid output:**
```bash
npm run agents:validate:visual -- <tool-name> --debug --output /tmp/debug.svg
```

## Team Rules

- Never add tool without registry entry
- Never modify task manifest without schema validation
- Never deploy with sandbox escape vulnerability
- Never exceed agent SLA without explicit adjustment + testing
- Always run full agent validation before release
