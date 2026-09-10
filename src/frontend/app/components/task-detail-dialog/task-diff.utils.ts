export interface TaskDiffLine {
  text: string;
  kind: 'addition' | 'deletion' | 'hunk' | 'meta' | 'context';
}

export interface TaskDiffFile {
  path: string;
  status: 'Added' | 'Deleted' | 'Modified' | 'Binary';
  additions: number;
  deletions: number;
  lines: TaskDiffLine[];
}

export function parseTaskRunDiff(codeDiff: string, fileDiff = ''): TaskDiffFile[] {
  const patchFiles = codeDiff
    .split(/(?=^diff --git )/mu)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map((chunk): TaskDiffFile => {
      const rawLines = chunk.trimEnd().split(/\r?\n/u);
      const addedPath = diffHeaderPath(rawLines.find((line) => line.startsWith('+++ ')), 'b/');
      const removedPath = diffHeaderPath(rawLines.find((line) => line.startsWith('--- ')), 'a/');
      const headerPath = diffGitHeaderPath(rawLines[0]);
      const isAdded = rawLines.some((line) => line.startsWith('new file mode '));
      const isDeleted = rawLines.some((line) => line.startsWith('deleted file mode '));
      const isBinary = rawLines.some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'));
      const lines = rawLines.map((text): TaskDiffLine => ({
        text,
        kind: text.startsWith('@@')
          ? 'hunk'
          : text.startsWith('+') && !text.startsWith('+++')
            ? 'addition'
            : text.startsWith('-') && !text.startsWith('---')
              ? 'deletion'
              : text.startsWith('diff --git ') || text.startsWith('index ') || text.startsWith('---')
                || text.startsWith('+++') || text.endsWith(' file mode 100644')
                ? 'meta'
                : 'context',
      }));
      return {
        path: addedPath ?? removedPath ?? headerPath ?? 'Unknown file',
        status: isBinary ? 'Binary' : isAdded ? 'Added' : isDeleted ? 'Deleted' : 'Modified',
        additions: lines.filter((line) => line.kind === 'addition').length,
        deletions: lines.filter((line) => line.kind === 'deletion').length,
        lines,
      };
    });
  const filesByPath = new Map(patchFiles.map((file) => [file.path, file]));
  for (const line of fileDiff.split(/\r?\n/u)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(line);
    if (match === null) continue;
    const [, rawAdditions, rawDeletions, path] = match;
    const additions = rawAdditions === '-' ? 0 : Number(rawAdditions);
    const deletions = rawDeletions === '-' ? 0 : Number(rawDeletions);
    const existing = filesByPath.get(path);
    if (existing !== undefined) {
      existing.additions = additions;
      existing.deletions = deletions;
    } else {
      const file: TaskDiffFile = {
        path,
        status: rawAdditions === '-' || rawDeletions === '-' ? 'Binary' : 'Modified',
        additions,
        deletions,
        lines: [],
      };
      patchFiles.push(file);
      filesByPath.set(path, file);
    }
  }
  return patchFiles;
}

function diffGitHeaderPath(line: string | undefined): string | null {
  if (line === undefined) return null;
  const binaryMatch = /^Binary files (?:a\/(.+)|\/dev\/null) and (?:b\/(.+)|\/dev\/null) differ$/u.exec(line);
  if (binaryMatch !== null) return binaryMatch[2] ?? binaryMatch[1] ?? null;
  const headerMatch = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
  return headerMatch?.[2] ?? headerMatch?.[1] ?? null;
}

function diffHeaderPath(line: string | undefined, prefix: 'a/' | 'b/'): string | null {
  if (line === undefined) return null;
  let value = line.slice(4);
  if (value === '/dev/null') return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
