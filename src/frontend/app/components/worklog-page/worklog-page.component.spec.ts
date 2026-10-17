import '@angular/compiler';

import { describe, expect, it } from 'vitest';

import { parseWorklog } from './worklog-page.component';

describe('parseWorklog', () => {
  it('shows the newest dates and newest entries first', () => {
    expect(parseWorklog(`# Worklog

## 2026/10/16

- older entry

## 2026/10/17

- first entry today
- latest entry today
`)).toEqual([
      { date: '2026/10/17', entries: ['latest entry today', 'first entry today'] },
      { date: '2026/10/16', entries: ['older entry'] },
    ]);
  });
});
