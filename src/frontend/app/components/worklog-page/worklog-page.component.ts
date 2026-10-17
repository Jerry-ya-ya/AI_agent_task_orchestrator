import { CommonModule } from '@angular/common';
import { Component, Input, OnChanges } from '@angular/core';

interface WorklogSection {
  date: string;
  entries: string[];
}

@Component({
  selector: 'worklog-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './worklog-page.component.html',
  styleUrl: './worklog-page.component.css',
})
export class WorklogPageComponent implements OnChanges {
  @Input() content = '';
  @Input() loading = false;

  sections: WorklogSection[] = [];

  ngOnChanges(): void {
    this.sections = parseWorklog(this.content);
  }

  trackSection(_index: number, section: WorklogSection): string {
    return section.date;
  }

  trackEntry(_index: number, entry: string): string {
    return entry;
  }
}

export function parseWorklog(content: string): WorklogSection[] {
  const sections: WorklogSection[] = [];
  let current: WorklogSection | null = null;
  for (const line of content.split(/\r?\n/u)) {
    const heading = /^##\s+(\d{4}\/\d{2}\/\d{2})\s*$/u.exec(line);
    if (heading !== null) {
      current = { date: heading[1] as string, entries: [] };
      sections.push(current);
      continue;
    }
    const entry = /^-\s+(.+)$/u.exec(line);
    if (current !== null && entry !== null) current.entries.push(entry[1] as string);
  }
  return sections
    .filter((section) => section.entries.length > 0)
    .reverse()
    .map((section) => ({ ...section, entries: [...section.entries].reverse() }));
}
