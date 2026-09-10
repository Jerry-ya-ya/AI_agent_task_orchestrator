import { describe, expect, it } from 'vitest';

import { parseTaskRunDiff } from './task-diff.utils';

describe('parseTaskRunDiff', () => {
  it('groups one commit patch into independently viewable changed files', () => {
    const files = parseTaskRunDiff(`diff --git a/src/hello.ts b/src/hello.ts
index 1111111..2222222 100644
--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1 +1,2 @@
 export const hello = 'hello';
+export const world = 'world';
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3333333..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..4444444
Binary files /dev/null and b/assets/logo.png differ
`);

    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({
      path: 'src/hello.ts', status: 'Modified', additions: 1, deletions: 0,
    });
    expect(files[0]?.lines.some((line) => line.kind === 'hunk')).toBe(true);
    expect(files[1]).toMatchObject({ path: 'old.txt', status: 'Deleted', additions: 0, deletions: 1 });
    expect(files[2]).toMatchObject({ path: 'assets/logo.png', status: 'Binary' });
  });

  it('keeps unquoted paths with spaces and non-ASCII characters intact', () => {
    const files = parseTaskRunDiff(`diff --git a/文件 old.ts b/文件 old.ts
index 1111111..2222222 100644
--- a/文件 old.ts
+++ b/文件 old.ts
@@ -1 +1 @@
-old
+new
`);

    expect(files[0]).toMatchObject({ path: '文件 old.ts', additions: 1, deletions: 1 });
  });

  it('lists every numstat file even when a capped code patch omits its content', () => {
    const files = parseTaskRunDiff('', '3\t1\tsrc/first.ts\n-\t-\tassets/image.png\n');

    expect(files).toEqual([
      expect.objectContaining({ path: 'src/first.ts', additions: 3, deletions: 1, lines: [] }),
      expect.objectContaining({ path: 'assets/image.png', status: 'Binary', lines: [] }),
    ]);
  });
});
