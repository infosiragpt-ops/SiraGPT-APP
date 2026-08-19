# Skills

Each subdirectory is a self-contained agent capability. The skills registry
(`backend/src/services/skills/registry.js`) scans this folder at boot and
exposes each skill through adapters for `react-agent` and `agent-core`.

## Adding a skill

Create a folder named after the skill id (`^[a-z][a-z0-9_]*$`) containing:

- `manifest.json` — metadata, capabilities, params (JSON Schema)
- `handler.js` — `module.exports = { execute: async (args, ctx) => any }`

Reload with `require('../services/skills').reload({ fresh: true })` in dev,
or restart the server in prod.

## Manifest fields

| field        | required | meaning                                                     |
|--------------|----------|-------------------------------------------------------------|
| id           | yes      | stable identifier, matches folder name                      |
| name         | yes      | human label                                                 |
| version      | yes      | semver                                                      |
| description  | yes      | shown to the LLM as tool description                        |
| capabilities | yes      | array from `services/skills/capabilities.js`                |
| params       | yes      | JSON Schema for the args the LLM will pass                  |

## Handler contract

```js
module.exports = {
  async execute(args, ctx) {
    // args — validated against manifest.params by the caller
    // ctx  — { userId, collection, openai, sessionId, ... }
    return { anything: 'JSON-serialisable' };
  }
};
```

Throwing is fine — `react-agent` and `agent-core` both catch and surface
tool errors to the model as observations, so the loop keeps going.

## Policy / capabilities

Declaring a capability means the skill **requires** that permission to
run. The session policy (`services/skills/policy.js`) decides whether
the capability is granted for the current invocation. A skill that runs
a disallowed capability is blocked before `execute` is called.
