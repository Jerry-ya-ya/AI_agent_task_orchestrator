import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { FrontendConnection } from '../../models';

export type AppPage = 'features' | 'taskboard' | 'history' | 'settings';
type DetachablePage = AppPage | 'frontend';

export interface DetachedPageRequest {
  page: DetachablePage;
  connectionId?: string;
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
  @Input({ required: true }) activePage: AppPage | 'frontend' = 'taskboard';
  @Input({ required: true }) historyCount = 0;
  @Input({ required: true }) connections: readonly FrontendConnection[] = [];
  @Input() activeConnectionId: string | null = null;

  @Output() expandedChange = new EventEmitter<boolean>();
  @Output() pageSelected = new EventEmitter<AppPage>();
  @Output() pageDetached = new EventEmitter<DetachedPageRequest>();
  @Output() connectionSelected = new EventEmitter<FrontendConnection>();
  @Output() connectionCreateRequested = new EventEmitter<void>();

  draggingPage: DetachablePage | null = null;
  draggingConnectionId: string | null = null;
  private dragPointerId: number | null = null;
  private dragConnectionId: string | null = null;
  private navigationBounds: DOMRect | null = null;
  private suppressClickPage: DetachablePage | null = null;
  private suppressClickConnectionId: string | null = null;

  selectPage(event: MouseEvent, page: AppPage): void {
    if (this.consumeSuppressedClick(page)) {
      event.preventDefault();
      return;
    }
    this.pageSelected.emit(page);
  }

  selectConnection(event: MouseEvent, connection: FrontendConnection): void {
    if (this.consumeSuppressedClick('frontend', connection.id)) {
      event.preventDefault();
      return;
    }
    this.connectionSelected.emit(connection);
  }

  beginPageDrag(event: PointerEvent, page: DetachablePage, connectionId: string | null = null): void {
    if (event.button !== 0) return;
    const navigation = (event.currentTarget as HTMLElement | null)?.closest('.app-navigation');
    if (!(navigation instanceof HTMLElement)) return;
    this.draggingPage = page;
    this.draggingConnectionId = connectionId;
    this.dragPointerId = event.pointerId;
    this.dragConnectionId = connectionId;
    this.navigationBounds = navigation.getBoundingClientRect();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  continuePageDrag(event: PointerEvent, page: DetachablePage, connectionId: string | null = null): void {
    if (this.draggingPage !== page || this.dragConnectionId !== connectionId
      || this.dragPointerId !== event.pointerId || this.navigationBounds === null) return;
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
    this.suppressClickConnectionId = connectionId;
    this.pageDetached.emit({
      page,
      ...(connectionId === null ? {} : { connectionId }),
      screenX: event.screenX,
      screenY: event.screenY,
    });
    this.finishPageDrag(event);
  }

  finishPageDrag(event?: PointerEvent): void {
    if (event !== undefined && this.dragPointerId !== null) {
      (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(this.dragPointerId);
    }
    this.draggingPage = null;
    this.draggingConnectionId = null;
    this.dragPointerId = null;
    this.dragConnectionId = null;
    this.navigationBounds = null;
  }

  private consumeSuppressedClick(page: DetachablePage, connectionId: string | null = null): boolean {
    if (this.suppressClickPage !== page || this.suppressClickConnectionId !== connectionId) return false;
    this.suppressClickPage = null;
    this.suppressClickConnectionId = null;
    return true;
  }
}
