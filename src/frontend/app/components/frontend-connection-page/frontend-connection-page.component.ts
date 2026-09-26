import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';

import type { FrontendConnection } from '../../models';

@Component({
  selector: 'frontend-connection-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './frontend-connection-page.component.html',
})
export class FrontendConnectionPageComponent implements AfterViewInit, OnChanges {
  @Input({ required: true }) connection!: FrontendConnection;
  @Output() removeRequested = new EventEmitter<FrontendConnection>();
  @Output() settingsRequested = new EventEmitter<FrontendConnection>();
  @ViewChild('frontendFrame', { static: true }) private frontendFrame!: ElementRef<HTMLIFrameElement>;

  ngAfterViewInit(): void {
    this.loadConnection();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    this.loadConnection();
  }

  reload(): void {
    this.loadConnection(true);
  }

  private loadConnection(forceReload = false): void {
    if (this.frontendFrame === undefined || !isLoopbackFrontendUrl(this.connection?.url)) return;
    const frame = this.frontendFrame.nativeElement;
    if (forceReload) frame.src = 'about:blank';
    frame.src = this.connection.url;
  }
}

function isLoopbackFrontendUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLocaleLowerCase());
  } catch {
    return false;
  }
}
