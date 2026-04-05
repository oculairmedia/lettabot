# Query Pattern Test - Quick Reference

## What does this test do?

Prevents unlabeled graph database MATCH queries that cause 61K node scans.

## Bad vs Good

```cypher
# ❌ BAD - Full node scan
MATCH (n {uuid: $uuid})

# ✅ GOOD - Index lookup  
MATCH (n:Entity {uuid: $uuid})
```

## Run the test

```bash
npm test -- tests/test_query_patterns.test.ts
```

## When does it run?

- ✅ Every PR to main
- ✅ Every push to main
- ✅ When you run `npm run test:run`

## What if it fails?

You'll see:
```
❌ Found unlabeled MATCH queries with uuid parameter!

Violations:
  src/yourfile.ts:42
    const query = 'MATCH (n {uuid: $uuid}) RETURN n';
```

**Fix:** Add a label like `:Entity` or `:Episodic` to the MATCH pattern.

## Current status

✅ **0 violations** (passing as of 2026-03-23)
