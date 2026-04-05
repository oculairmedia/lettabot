import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Regression test for unlabeled MATCH query patterns in graph database queries.
 * 
 * Context: Previously, 4 instances of unlabeled `MATCH (n {uuid: ...})` queries
 * caused 61K node scans instead of using index lookups. This test ensures that
 * all MATCH queries with uuid parameters include proper node labels.
 * 
 * Bad pattern: `MATCH (n {uuid: $uuid})` -- results in full node scan
 * Good pattern: `MATCH (n:Entity {uuid: $uuid})` -- uses index lookup
 * 
 * Valid labels include: Entity, Episodic, and other domain-specific labels.
 */

interface Violation {
  file: string;
  line: number;
  match: string;
  context: string;
}

/**
 * Recursively finds all files matching the given extensions
 */
function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      // Skip common directories that shouldn't contain queries
      if (entry.isDirectory()) {
        if ([
          'node_modules',
          'dist',
          '.git',
          '.github',
          '.letta',
          '.skills',
          '.beads',
          '.claude',
          '.opencode',
          'e2e',
          'assets',
          'docs',
        ].includes(entry.name)) {
          continue;
        }
        results.push(...findFiles(fullPath, extensions));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }
  
  return results;
}

/**
 * Scans a file for unlabeled MATCH queries with uuid parameters
 */
function scanFileForViolations(filePath: string): Violation[] {
  const violations: Violation[] = [];
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;
      
      // Pattern to match MATCH queries with uuid but without labels
      // Matches: MATCH (n {uuid: ...}) or MATCH (variable {uuid: ...})
      // Should NOT match: MATCH (n:Label {uuid: ...})
      //
      // This regex looks for:
      // - "MATCH" keyword (case-insensitive, as a word boundary)
      // - Opening parenthesis
      // - Variable name (word characters)
      // - NO colon (which would indicate a label)
      // - Opening brace with "uuid" inside
      const unlabeledMatchWithUuid = /\bMATCH\s*\(\s*(\w+)\s+\{\s*uuid\s*:/i;
      
      // Also check for the pattern where there's no space before the brace
      const unlabeledMatchWithUuidNoSpace = /\bMATCH\s*\(\s*(\w+)\s*\{\s*uuid\s*:/i;
      
      let match = line.match(unlabeledMatchWithUuid);
      if (!match) {
        match = line.match(unlabeledMatchWithUuidNoSpace);
      }
      
      if (match) {
        // Double-check this isn't a labeled query by looking for a colon
        // between the variable name and the opening brace
        const beforeBrace = line.substring(0, match.index! + match[0].length);
        const hasLabel = /\(\s*\w+\s*:\s*\w+\s*\{/.test(beforeBrace);
        
        if (!hasLabel) {
          violations.push({
            file: filePath,
            line: lineNumber,
            match: match[0],
            context: line.trim(),
          });
        }
      }
    }
  } catch (error) {
    // Skip files we can't read
  }
  
  return violations;
}

describe('Graph Query Patterns', () => {
  it('should not contain unlabeled MATCH queries with uuid parameter', () => {
    const rootDir = path.resolve(__dirname, '..');
    
    // Find all .py and .rs files (as specified in requirements)
    // Also include .ts and .js files since this is a TypeScript codebase
    const files = findFiles(rootDir, ['.py', '.rs', '.ts', '.js']);
    
    // Exclude test files themselves to avoid false positives from test examples
    const filesToScan = files.filter(f => 
      !f.includes('test_query_patterns.test.ts') &&
      !f.includes('/tests/') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.test.js')
    );
    
    // Scan all files for violations
    const allViolations: Violation[] = [];
    for (const file of filesToScan) {
      const violations = scanFileForViolations(file);
      allViolations.push(...violations);
    }
    
    // Build a detailed error message if violations are found
    if (allViolations.length > 0) {
      const errorMessage = [
        '',
        '❌ Found unlabeled MATCH queries with uuid parameter!',
        '',
        'These queries will cause full node scans instead of using index lookups.',
        '',
        'Violations:',
        ...allViolations.map(v => 
          `  ${v.file}:${v.line}\n    ${v.context}\n`
        ),
        '',
        'Fix: Add a label to the MATCH query.',
        '  Bad:  MATCH (n {uuid: $uuid})',
        '  Good: MATCH (n:Entity {uuid: $uuid})',
        '',
        `Total violations: ${allViolations.length}`,
      ].join('\n');
      
      expect(allViolations, errorMessage).toHaveLength(0);
    }
    
    // Test passes if no violations found
    expect(allViolations).toHaveLength(0);
  });
  
  it('should correctly identify unlabeled patterns', () => {
    // Test the regex pattern itself to ensure it works correctly
    const testCases = [
      // Bad patterns (should match)
      { text: 'MATCH (n {uuid: $uuid})', shouldMatch: true },
      { text: 'MATCH (entity {uuid: $id})', shouldMatch: true },
      { text: 'MATCH  (  x  {  uuid  :  $var  }  )', shouldMatch: true },
      { text: 'match (n {uuid: $uuid})', shouldMatch: true }, // case insensitive
      
      // Good patterns (should NOT match)
      { text: 'MATCH (n:Entity {uuid: $uuid})', shouldMatch: false },
      { text: 'MATCH (n:Episodic {uuid: $uuid})', shouldMatch: false },
      { text: 'MATCH (entity:User {uuid: $id})', shouldMatch: false },
      { text: 'MATCH (n:Label {name: "test"})', shouldMatch: false }, // no uuid
      { text: 'const uuid = "123"', shouldMatch: false }, // not a MATCH query
    ];
    
    for (const testCase of testCases) {
      const unlabeledMatchWithUuid = /\bMATCH\s*\(\s*(\w+)\s+\{\s*uuid\s*:/i;
      const unlabeledMatchWithUuidNoSpace = /\bMATCH\s*\(\s*(\w+)\s*\{\s*uuid\s*:/i;
      
      let match = testCase.text.match(unlabeledMatchWithUuid);
      if (!match) {
        match = testCase.text.match(unlabeledMatchWithUuidNoSpace);
      }
      
      if (match) {
        // Check if it has a label
        const beforeBrace = testCase.text.substring(0, match.index! + match[0].length);
        const hasLabel = /\(\s*\w+\s*:\s*\w+\s*\{/.test(beforeBrace);
        const isViolation = !hasLabel;
        
        expect(
          isViolation,
          `Pattern "${testCase.text}" - expected ${testCase.shouldMatch ? 'violation' : 'no violation'}, got ${isViolation ? 'violation' : 'no violation'}`
        ).toBe(testCase.shouldMatch);
      } else {
        expect(
          false,
          `Pattern "${testCase.text}" - expected ${testCase.shouldMatch ? 'match' : 'no match'}, got no match`
        ).toBe(testCase.shouldMatch);
      }
    }
  });
});
