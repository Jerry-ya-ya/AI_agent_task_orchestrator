import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

export type AppPage = 'features' | 'taskboard' | 'history';

export interface DetachedPageRequest {
  page: AppPage;
  screenX: number;
  screenY: number;
}

const DETACH_DISTANCE = 48;

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app-navigation.component.html',
})
export class AppNavigationComponent {
  @Input({ required: true }) expanded = false;
  @Input({ required: true }) activePage: AppPage = 'taskboard';
  @Input({ required: true }) historyCount = 0;

  @Output() expandedChange = new EventEmitter<boolean>();
  @Output() pageSelected = new EventEmitter<AppPage>();
  @Output() pageDetached = new EventEmitter<DetachedPageRequest>();

  draggingPage: AppPage | null = null;
  private dragPointerId: number | null = null;
  private navigationBounds: DOMRect | null = null;
  private suppressClickPage: AppPage | null = null;

  selectPage(event: MouseEvent, page: AppPage): void {
    if (this.suppressClickPage === page) {
      event.preventDefault();
      this.suppressClickPage = null;
      return;
    }
    this.pageSelected.emit(page);
  }

  beginPageDrag(event: PointerEvent, page: AppPage): void {
    if (event.button !== 0) return;
    const navigation = (event.currentTarget as HTMLElement | null)?.closest('.app-navigation');
    if (!(navigation instanceof HTMLElement)) return;
    this.draggingPage = page;
    this.dragPointerId = event.pointerId;
    this.navigationBounds = navigation.getBoundingClientRect();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  continuePageDrag(event: PointerEvent, page: AppPage): void {
    if (this.draggingPage !== page || this.dragPointerId !== event.pointerId || this.navigationBounds === null) return;
    const horizontalDistance = Math.max(
      this.navigationBounds.left - event.clientX,
      event.clientX - this.navigationBounds.right,
      0,
    );
    const verticalDistance = Math.max(
      this.navigationBounds.top - event.clientY,
      event.clientY - this.navigationBounds.bottom,
      0,
    );
    if (Math.hypot(horizontalDistance, verticalDistance) < DETACH_DISTANCE) return;

    event.preventDefault();
    this.suppressClickPage = page;
    this.pageDetached.emit({ page, screenX: event.screenX, screenY: event.screenY });
    this.finishPageDrag(event);
  }

  finishPageDrag(event?: PointerEvent): void {
    if (event !== undefined && this.dragPointerId !== null) {
      (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(this.dragPointerId);
    }
    this.draggingPage = null;
    this.dragPointerId = null;
    this.navigationBounds = null;
  }
}
