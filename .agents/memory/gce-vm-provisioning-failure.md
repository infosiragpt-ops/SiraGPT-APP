---
name: GCE VM provisioning failure
description: How to recognize a Reserved VM publish that fails after the image is pushed.
---

# Reserved VM fails during provisioning

When a GCE publish reaches `Pushed image manifest` and then stops at repeated
`Creating virtual machine` lines, with no application logs or health-check
messages, the image and build passed but the VM was not provisioned. The
published URL may show “This app isn't live yet.”

**Why:** Replit cannot emit application logs until the VM exists and starts the
run command, so changing routes, ports, or secrets based on this log pattern
creates false fixes.

**How to apply:** Retry publishing once. If the same provisioning-only failure
repeats, treat it as platform capacity/provisioning trouble and use Replit
support; only investigate `start` or health-check code after runtime logs
appear.