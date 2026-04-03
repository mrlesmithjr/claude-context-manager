/**
 * Memory Consolidation Module
 *
 * Migrates memory files from child project paths to a parent path,
 * then rebuilds the parent MEMORY.md index.
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { auditMemoryDirectories } from './audit.js';
import type { MemoryFileType } from './audit.js';
import { convertPathToDashed } from '../utils/transcript.js';

const EXCLUDED_FILES = new Set(['MEMORY.md', 'context-manager-activity.md']);
const STALE_THRESHOLD_DAYS = 90;

export interface MigrationCandidate {
  sourceDir: string;
  sourcePath: string;
  filename: string;
  name: string;
  description: string;
  type: MemoryFileType;
  modifiedAt: Date;
}

export interface SkippedFile {
  filename: string;
  sourceDir: string;
  reason: 'excluded' | 'duplicate' | 'stale';
}

export interface ConsolidationReport {
  project: string;
  dryRun: boolean;
  migrated: MigrationCandidate[];
  skipped: SkippedFile[];
  totalSourceDirs: number;
  parentTotalAfter: number;
  summary: string;
}

/**
 * Check if a file's modification date is older than the stale threshold.
 */
function isStale(modifiedAt: Date): boolean {
  const ageMs = Date.now() - modifiedAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > STALE_THRESHOLD_DAYS;
}

/**
 * Parse frontmatter from a memory file.
 * Returns name, description, and type for building the MEMORY.md index.
 */
function parseFrontmatterForIndex(
  content: string,
  filename: string
): { name: string; description: string; type: MemoryFileType } {
  const defaults = {
    name: filename.replace(/\.md$/, ''),
    description: '',
    type: 'unknown' as MemoryFileType,
  };

  if (!content.startsWith('---')) return defaults;

  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) return defaults;

  const frontmatter = content.substring(3, endIndex);
  const result = { ...defaults };

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim();
    const value = line.substring(colonIdx + 1).trim();

    if (key === 'name' && value) {
      result.name = value;
    } else if (key === 'description' && value) {
      result.description = value;
    } else if (key === 'type') {
      if (
        value === 'user' ||
        value === 'feedback' ||
        value === 'project' ||
        value === 'reference'
      ) {
        result.type = value;
      }
    }
  }

  return result;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Rebuild MEMORY.md for a directory by reading all memory files
 * and generating a categorized index grouped by type.
 */
function rebuildMemoryIndex(memoryDir: string, projectPath: string): void {
  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return;
  }

  const byType: Record<
    MemoryFileType,
    Array<{ filename: string; name: string; description: string }>
  > = {
    user: [],
    feedback: [],
    project: [],
    reference: [],
    unknown: [],
  };

  for (const filename of entries) {
    if (!filename.endsWith('.md')) continue;
    if (EXCLUDED_FILES.has(filename)) continue;

    const filePath = join(memoryDir, filename);
    let content = '';
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const { name, description, type } = parseFrontmatterForIndex(content, filename);
    byType[type].push({ filename, name, description });
  }

  const lines: string[] = [];

  // Derive a title from the last segment of the project path
  const parts = projectPath.replace(/\/$/, '').split('/');
  const title = parts[parts.length - 1] ?? 'Project';
  lines.push(`# Memory - ${title}`);
  lines.push('');

  const sectionOrder: MemoryFileType[] = ['user', 'reference', 'feedback', 'project', 'unknown'];

  for (const type of sectionOrder) {
    const files = byType[type];
    if (!files || files.length === 0) continue;

    const heading = type === 'unknown' ? 'Other' : capitalize(type);
    lines.push(`## ${heading}`);
    for (const file of files) {
      const desc = file.description ? ` — ${file.description}` : '';
      lines.push(`- [${file.name}](${file.filename})${desc}`);
    }
    lines.push('');
  }

  const indexContent = lines.join('\n').trimEnd() + '\n';
  writeFileSync(join(memoryDir, 'MEMORY.md'), indexContent);
}

/**
 * Consolidate memory files from orphaned child directories into the parent.
 *
 * @param projectPath - The parent project path to consolidate into
 * @param dryRun - If true, preview changes without writing anything
 * @param includeStale - If true, include project-type memories older than 90 days
 */
export function consolidateMemories(
  projectPath: string,
  dryRun: boolean = true,
  includeStale: boolean = false
): ConsolidationReport {
  const auditReport = auditMemoryDirectories(projectPath);
  const parentDashedPath = convertPathToDashed(projectPath);
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  const parentMemoryDir = join(claudeProjectsDir, parentDashedPath, 'memory');

  // Build set of filenames already present in the parent to detect duplicates
  const existingInParent = new Set<string>();
  if (existsSync(parentMemoryDir)) {
    try {
      for (const f of readdirSync(parentMemoryDir)) {
        existingInParent.add(f);
      }
    } catch {
      // proceed with empty set
    }
  }

  const migrated: MigrationCandidate[] = [];
  const skipped: SkippedFile[] = [];

  for (const orphan of auditReport.orphans) {
    for (const file of orphan.files) {
      // Skip excluded files
      if (EXCLUDED_FILES.has(file.filename)) {
        skipped.push({
          filename: file.filename,
          sourceDir: orphan.dashedPath,
          reason: 'excluded',
        });
        continue;
      }

      // Skip duplicates — same filename already exists at the target
      if (existingInParent.has(file.filename)) {
        skipped.push({
          filename: file.filename,
          sourceDir: orphan.dashedPath,
          reason: 'duplicate',
        });
        continue;
      }

      // Optionally skip stale project-type memories
      if (!includeStale && file.type === 'project' && isStale(file.modifiedAt)) {
        skipped.push({
          filename: file.filename,
          sourceDir: orphan.dashedPath,
          reason: 'stale',
        });
        continue;
      }

      const candidate: MigrationCandidate = {
        sourceDir: orphan.dashedPath,
        sourcePath: join(orphan.memoryDir, file.filename),
        filename: file.filename,
        name: file.name,
        description: file.description,
        type: file.type,
        modifiedAt: file.modifiedAt,
      };

      migrated.push(candidate);

      // Track as existing so later orphans don't emit duplicate candidates
      existingInParent.add(file.filename);
    }
  }

  let parentTotalAfter = (auditReport.current?.fileCount ?? 0) + migrated.length;

  if (!dryRun && migrated.length > 0) {
    // Ensure the parent memory directory exists
    mkdirSync(parentMemoryDir, { recursive: true });

    // Copy each candidate file
    for (const candidate of migrated) {
      try {
        copyFileSync(candidate.sourcePath, join(parentMemoryDir, candidate.filename));
      } catch (err) {
        process.stderr.write(
          `[context-memory-consolidate] Failed to copy ${candidate.filename}: ${String(err)}\n`
        );
      }
    }

    // Rebuild the MEMORY.md index to reflect the new state
    rebuildMemoryIndex(parentMemoryDir, projectPath);

    // Recount actual files after copying for accurate reporting
    try {
      const allFiles = readdirSync(parentMemoryDir);
      parentTotalAfter = allFiles.filter(
        (f) => f.endsWith('.md') && !EXCLUDED_FILES.has(f)
      ).length;
    } catch {
      // fall back to calculated count
    }
  }

  // Build summary message
  const migratedWord = migrated.length === 1 ? 'file' : 'files';
  const dirWord = auditReport.orphans.length === 1 ? 'directory' : 'directories';
  const dryRunNote = dryRun ? ' (dry run — no changes made)' : '';

  let summary: string;
  if (migrated.length === 0) {
    const skipNote =
      skipped.length > 0 ? ` ${skipped.length} files skipped (duplicates/stale/excluded).` : '';
    summary = `No files to migrate${dryRunNote}.${skipNote}`;
  } else if (dryRun) {
    summary = `Would migrate ${migrated.length} ${migratedWord} from ${auditReport.orphans.length} ${dirWord}. Parent would have ${parentTotalAfter} total memories.`;
  } else {
    summary = `Migrated ${migrated.length} ${migratedWord} from ${auditReport.orphans.length} ${dirWord}. Parent now has ${parentTotalAfter} total memories.`;
  }

  if (skipped.length > 0 && migrated.length > 0) {
    const skipCounts = { excluded: 0, duplicate: 0, stale: 0 };
    for (const s of skipped) skipCounts[s.reason]++;
    const skipParts: string[] = [];
    if (skipCounts.duplicate > 0) skipParts.push(`${skipCounts.duplicate} duplicates`);
    if (skipCounts.stale > 0) skipParts.push(`${skipCounts.stale} stale`);
    if (skipCounts.excluded > 0) skipParts.push(`${skipCounts.excluded} excluded`);
    summary += ` Skipped: ${skipParts.join(', ')}.`;
  }

  return {
    project: projectPath,
    dryRun,
    migrated,
    skipped,
    totalSourceDirs: auditReport.orphans.length,
    parentTotalAfter,
    summary,
  };
}

/**
 * Format a consolidation report as human-readable text.
 */
export function formatConsolidationReport(report: ConsolidationReport): string {
  const lines: string[] = [];

  lines.push(report.dryRun ? 'Memory Consolidation (Dry Run)' : 'Memory Consolidation');
  lines.push('');
  lines.push(`Project: ${report.project}`);
  lines.push('');

  if (report.migrated.length > 0) {
    const heading = report.dryRun ? '=== Would Migrate ===' : '=== Migrated ===';
    lines.push(heading);
    for (const m of report.migrated) {
      const desc = m.description ? ` — ${m.description}` : '';
      lines.push(`  [${m.type}] ${m.filename}${desc}`);
      lines.push(`    Source: ${m.sourceDir}`);
    }
    lines.push('');
  }

  if (report.skipped.length > 0) {
    lines.push('=== Skipped ===');
    for (const s of report.skipped) {
      lines.push(`  ${s.filename} (${s.reason}) from ${s.sourceDir}`);
    }
    lines.push('');
  }

  lines.push('=== Summary ===');
  lines.push(`  ${report.summary}`);

  if (!report.dryRun && report.migrated.length > 0) {
    lines.push('');
    lines.push('  MEMORY.md index rebuilt in parent directory.');
  }

  return lines.join('\n');
}
