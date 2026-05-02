# First Message Echo Bug

```mermaid
flowchart TD
    A[Mobile Connect] --> B{onConnect fires}
    B --> C[Spurious emit?]
    C -->|Yes| D[Mobile receives ECHO ❌]
    C -->|No| E[Welcome msg sent?]
    E -->|Yes| F[Mobile receives ECHO ❌]
    E -->|No| G[Proceed to sync]
    D --> H[User sees duplicate]
    F --> H
    G --> I[Full sync]
    I --> J[Live subscription]
    J --> K[Stable ✅]
    H --> K

    style D fill:#ff6b6b
    style F fill:#ff6b6b
    style K fill:#51cf66
```

## Root Cause

1. `onConnect` fires extra subscription immediately
2. Server sends welcome/ping message on connect
3. Mobile renders ALL incoming messages (no dedupe)

## Fix Options

1. Dedupe by `message_id` client-side
2. Gate welcome msg behind flag
3. Start live sub only AFTER full sync acked
