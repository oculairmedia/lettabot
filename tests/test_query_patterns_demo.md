# Query Pattern Test - Demo

This document demonstrates how the `test_query_patterns.test.ts` regression test works.

## Background

Previously, 4 instances of unlabeled `MATCH (n {uuid: ...})` queries caused 61K node scans instead of using index lookups in the graph database. This test prevents reintroduction of this anti-pattern.

## Test Coverage

The test scans all `.py`, `.rs`, `.ts`, and `.js` files in the codebase for:

### ❌ Bad Pattern (Caught by test)
```cypher
MATCH (n {uuid: $uuid})
```
This causes a full node scan because there's no label to help the database use an index.

### ✅ Good Pattern (Passes test)
```cypher
MATCH (n:Entity {uuid: $uuid})
```
This uses an index lookup on the `Entity` label, dramatically improving performance.

## Example Violations

If the test finds violations, it will output:

```
❌ Found unlabeled MATCH queries with uuid parameter!

These queries will cause full node scans instead of using index lookups.

Violations:
  /path/to/file.ts:42
    const query = 'MATCH (n {uuid: $uuid}) RETURN n';

Fix: Add a label to the MATCH query.
  Bad:  MATCH (n {uuid: $uuid})
  Good: MATCH (n:Entity {uuid: $uuid})

Total violations: 1
```

## Running the Test

```bash
# Run just the query pattern test
npm test -- tests/test_query_patterns.test.ts

# Run all tests (includes this test)
npm run test:run
```

## CI Integration

The test is automatically run as part of the CI pipeline via the `test.yml` workflow on all PRs and main branch commits.

## Valid Labels

Common labels that should be used:
- `Entity`
- `Episodic`
- Other domain-specific labels appropriate to your graph schema

## Test Implementation Details

The test:
1. Recursively scans the codebase for `.py`, `.rs`, `.ts`, and `.js` files
2. Skips common directories like `node_modules`, `dist`, `.git`, etc.
3. Uses regex patterns to detect unlabeled MATCH queries with uuid parameters
4. Excludes test files themselves to avoid false positives
5. Provides detailed violation reports with file paths and line numbers

## Current Status

✅ Test passes on current codebase (0 violations after fixes)
