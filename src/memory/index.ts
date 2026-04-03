/**
 * Memory Module
 *
 * Exports for auditing and consolidating Claude Code memory files
 * across project directories.
 */

export { auditMemoryDirectories, formatAuditReport } from './audit.js';
export type {
  MemoryFileType,
  MemoryFileSummary,
  MemoryDirectoryStats,
  MemoryAuditReport,
} from './audit.js';

export { consolidateMemories, formatConsolidationReport } from './consolidate.js';
export type {
  MigrationCandidate,
  SkippedFile,
  ConsolidationReport,
} from './consolidate.js';
