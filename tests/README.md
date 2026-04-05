# Query Pattern Regression Tests

## Overview

This directory contains regression tests to prevent reintroduction of anti-patterns in graph database queries.

## test_query_patterns.test.ts

### Purpose
Prevents unlabeled `MATCH` queries with `uuid` parameters that cause full node scans instead of using index lookups.

### Background
On 2026-03-23, we fixed 4 instances of unlabeled `MATCH (n {uuid: ...})` queries that were causing 61,000 node scans instead of efficient index lookups. This test ensures these patterns are never reintroduced.

### What it checks

#### ❌ Anti-pattern (Test fails)
```cypher
MATCH (n {uuid: $uuid})  // Missing label - causes full scan
```

#### ✅ Correct pattern (Test passes)
```cypher
MATCH (n:Entity {uuid: $uuid})  // Has label - uses index
```

### Coverage
- Scans all `.py`, `.rs`, `.ts`, and `.js` files
- Excludes: `node_modules`, `dist`, `.git`, test files, and other build artifacts
- Uses regex pattern matching to detect violations
- Provides detailed error reports with file paths and line numbers

### Running the test

```bash
# Run just this test
npm test -- tests/test_query_patterns.test.ts

# Run all unit tests (includes this test)
npm run test:run
```

### CI Integration
✅ Automatically runs on all PRs and main branch commits via `.github/workflows/test.yml`

### Current Status
✅ 0 violations (as of 2026-03-23 after fixes)

### Example Output

When violations are found:
```
❌ Found unlabeled MATCH queries with uuid parameter!

These queries will cause full node scans instead of using index lookups.

Violations:
  src/example.ts:42
    const query = 'MATCH (n {uuid: $uuid}) RETURN n';

Fix: Add a label to the MATCH query.
  Bad:  MATCH (n {uuid: $uuid})
  Good: MATCH (n:Entity {uuid: $uuid})

Total violations: 1
```

When no violations:
```
✓ tests/test_query_patterns.test.ts (2 tests) 43ms

Test Files  1 passed (1)
     Tests  2 passed (2)
```

## Adding More Pattern Tests

To add additional query pattern checks:

1. Add new test cases to `test_query_patterns.test.ts`
2. Follow the existing pattern of scanning files and detecting anti-patterns
3. Include both positive and negative test cases
4. Document the anti-pattern and correct pattern clearly

## Related Documentation

- See `test_query_patterns_demo.md` for detailed examples
- Check `.github/workflows/test.yml` for CI configuration
