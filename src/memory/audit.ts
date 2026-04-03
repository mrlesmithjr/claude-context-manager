/**
 * Memory Audit Module
 *
 * Scans ~/.claude/projects/ for memory directories related to a project path,
 * identifying orphaned child directories whose memories become invisible when
 * the user changes their launch directory to a parent path.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { convertPathToDashed } from '../utils/transcript.js';

const EXCLUDED_FILES = new Set(['MEMORY.md', 'context-manager-activity.md']);
const MEMORY_FILE_PATTERN = /\.md$/;

export type MemoryFileType = 'user' | 'feedback' | 'project' | 'reference' | 'unknown';

export interface MemoryFileSummary {
  filename: string;
  name: string;
  description: string;
  type: MemoryFileType;
  modifiedAt: Date;
}

export interface MemoryDirectoryStats {
  /** Full path to the project directory under ~/.claude/projects/ */
  projectDir: string;
  /** The dashed path segment (e.g., -Users-foo-bar-baz) */
  dashedPath: string;
  /** Full path to the memory/ subdirectory */
  memoryDir: string;
  /** Total countable memory files (excluding MEMORY.md and context-manager-activity.md) */
  fileCount: number;
  /** Files grouped by type */
  byType: Record<MemoryFileType, number>;
  /** Most recent file modification date */
  mostRecentModified: Date | null;
  /** True when this directory's dashed path exactly matches the project dashed path */
  isCurrent: boolean;
  /** Summaries of individual memory files */
  files: MemoryFileSummary[];
}

export interface MemoryAuditReport {
  /** The project path that was audited */
  project: string;
  /** The dashed prefix used for scanning */
  dashedPrefix: string;
  /** Stats for the exact current project (may be null if no memory dir yet) */
  current: MemoryDirectoryStats | null;
  /** Stats for child/orphan directories */
  orphans: MemoryDirectoryStats[];
  /** Total orphaned memory files across all orphan directories */
  totalOrphanedFiles: number;
  /** Human-readable recommendation */
  recommendation: string;
}

/**
 * Parse YAML frontmatter from a memory file.
 * Returns the name, description, and type fields.
 */
function parseFrontmatter(content: string): {
  name: string;
  description: string;
  type: MemoryFileType;
} {
  const defaults = { name: '', description: '', type: 'unknown' as MemoryFileType };

  if (!content.startsWith('---')) {
    return defaults;
  }

  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) {
    return defaults;
  }

  const frontmatter = content.substring(3, endIndex);
  const result = { ...defaults };

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim();
    const value = line.substring(colonIdx + 1).trim();

    if (key === 'name') {
      result.name = value;
    } else if (key === 'description') {
      result.description = value;
    } else if (key === 'type') {
      const candidate = value as string;
      if (
        candidate === 'user' ||
        candidate === 'feedback' ||
        candidate === 'project' ||
        candidate === 'reference'
      ) {
        result.type = candidate;
      }
    }
  }

  return result;
}

/**
 * Scan a memory directory and return stats about its files.
 */
function scanMemoryDirectory(
  projectDir: string,
  dashedPath: string,
  isCurrentProject: boolean
): MemoryDirectoryStats {
  const memoryDir = join(projectDir, 'memory');

  const stats: MemoryDirectoryStats = {
    projectDir,
    dashedPath,
    memoryDir,
    fileCount: 0,
    byType: { user: 0, feedback: 0, project: 0, reference: 0, unknown: 0 },
    mostRecentModified: null,
    isCurrent: isCurrentProject,
    files: [],
  };

  if (!existsSync(memoryDir)) {
    return stats;
  }

  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return stats;
  }

  for (const filename of entries) {
    if (!MEMORY_FILE_PATTERN.test(filename)) continue;
    if (EXCLUDED_FILES.has(filename)) continue;

    const filePath = join(memoryDir, filename);

    let fileStat: ReturnType<typeof statSync>;
    try {
      fileStat = statSync(filePath);
    } catch {
      continue;
    }

    let content = '';
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      // Use empty content if unreadable; still count the file
    }

    const { name, description, type } = parseFrontmatter(content);
    const modifiedAt = fileStat.mtime;

    stats.fileCount++;
    stats.byType[type]++;

    if (stats.mostRecentModified === null || modifiedAt > stats.mostRecentModified) {
      stats.mostRecentModified = modifiedAt;
    }

    stats.files.push({
      filename,
      name: name || filename.replace(/\.md$/, ''),
      description,
      type,
      modifiedAt,
    });
  }

  return stats;
}

/**
 * Audit memory directories for a project path.
 *
 * Scans ~/.claude/projects/ for all directories whose dashed name starts with
 * the dashed representation of the given project path. Returns stats about the
 * current project directory and any child/orphan directories.
 */
export function auditMemoryDirectories(projectPath: string): MemoryAuditReport {
  const dashedPrefix = convertPathToDashed(projectPath);
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');

  let allEntries: string[];
  try {
    allEntries = readdirSync(claudeProjectsDir);
  } catch {
    return {
      project: projectPath,
      dashedPrefix,
      current: null,
      orphans: [],
      totalOrphanedFiles: 0,
      recommendation: 'Could not read ~/.claude/projects/ directory.',
    };
  }

  const current: MemoryDirectoryStats[] = [];
  const orphans: MemoryDirectoryStats[] = [];

  for (const entry of allEntries) {
    // Only match directories that start with the dashed prefix
    if (!entry.startsWith(dashedPrefix)) continue;

    const fullProjectDir = join(claudeProjectsDir, entry);

    let entryStat: ReturnType<typeof statSync>;
    try {
      entryStat = statSync(fullProjectDir);
    } catch {
      continue;
    }

    if (!entryStat.isDirectory()) continue;

    // Check that the match is either exact or a proper child
    // (avoid matching -Users-foo-bar-baz matching -Users-foo-bar-bazmore)
    const remainder = entry.substring(dashedPrefix.length);
    const isExactMatch = remainder === '';
    const isChildMatch = remainder.startsWith('-');

    if (!isExactMatch && !isChildMatch) continue;

    // Only process directories that have a memory/ subdirectory
    const memoryDir = join(fullProjectDir, 'memory');
    if (!existsSync(memoryDir)) continue;

    const dirStats = scanMemoryDirectory(fullProjectDir, entry, isExactMatch);

    if (isExactMatch) {
      current.push(dirStats);
    } else {
      orphans.push(dirStats);
    }
  }

  const currentStats = current[0] ?? null;
  const totalOrphanedFiles = orphans.reduce((sum, o) => sum + o.fileCount, 0);

  let recommendation: string;
  if (orphans.length === 0) {
    recommendation = 'No orphaned memory directories found.';
  } else {
    const dirWord = orphans.length === 1 ? 'directory' : 'directories';
    recommendation = `${totalOrphanedFiles} ${totalOrphanedFiles === 1 ? 'memory' : 'memories'} across ${orphans.length} orphaned ${dirWord} could be consolidated into the current project.`;
  }

  return {
    project: projectPath,
    dashedPrefix,
    current: currentStats,
    orphans,
    totalOrphanedFiles,
    recommendation,
  };
}

/**
 * Format an audit report as human-readable text.
 */
export function formatAuditReport(report: MemoryAuditReport): string {
  const lines: string[] = [];

  lines.push('Memory Audit Report');
  lines.push('');
  lines.push(`Project: ${report.project}`);
  lines.push(`Dashed prefix: ${report.dashedPrefix}`);
  lines.push('');

  // Current project
  lines.push('=== Current Project ===');
  if (!report.current || report.current.fileCount === 0) {
    lines.push('  No memory files found at the current launch point.');
  } else {
    const c = report.current;
    lines.push(`  Directory: ${c.dashedPath}`);
    lines.push(`  Memory files: ${c.fileCount}`);
    lines.push(formatTypeBreakdown(c.byType, '  '));
    if (c.mostRecentModified) {
      lines.push(`  Most recent: ${c.mostRecentModified.toISOString()}`);
    }
  }

  // Orphaned directories
  lines.push('');
  lines.push('=== Orphaned Directories ===');
  if (report.orphans.length === 0) {
    lines.push('  None found.');
  } else {
    for (const o of report.orphans) {
      lines.push(`  ${o.dashedPath}`);
      lines.push(`    Memory files: ${o.fileCount}`);
      lines.push(formatTypeBreakdown(o.byType, '    '));
      if (o.mostRecentModified) {
        lines.push(`    Most recent: ${o.mostRecentModified.toISOString()}`);
      }
    }
  }

  // Summary
  lines.push('');
  lines.push('=== Summary ===');
  lines.push(`  Total orphaned files: ${report.totalOrphanedFiles}`);
  lines.push(`  Recommendation: ${report.recommendation}`);

  if (report.totalOrphanedFiles > 0) {
    lines.push('');
    lines.push('  Run context_memory_consolidate to migrate orphaned memories.');
  }

  return lines.join('\n');
}

function formatTypeBreakdown(
  byType: Record<MemoryFileType, number>,
  indent: string
): string {
  const parts: string[] = [];
  for (const [type, count] of Object.entries(byType)) {
    if (count > 0) parts.push(`${type}: ${count}`);
  }
  return parts.length > 0 ? `${indent}Types: ${parts.join(', ')}` : '';
}
