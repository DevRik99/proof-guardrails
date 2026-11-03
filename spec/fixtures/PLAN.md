# Plan: pagos

Scope: pagos
Depth: tree 2

## Tree

- 1 pagos .............. GATES.md
  - 1.1 api ............ gates/node-1.1.md
    - 1.1.1 checkout ... gates/leaf-1.1.1.md
    - 1.1.2 webhooks ... gates/leaf-1.1.2.md

## Leaf dispatch table

| Leaf | Owns | Needs | Tier | Planned wave | State |
|---|---|---|---|---|---|
| 1.1.1 | src/checkout/**, tests/checkout/** | - | judgment | 1 | READY |
| 1.1.2 | src/webhooks/** | 1.1.1 | mechanical | 2 | WAITING |

```text
| 9.9.9 | not/a/leaf | - | x | 1 | READY |
```
