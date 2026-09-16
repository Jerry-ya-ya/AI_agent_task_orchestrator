import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';

import { AppNavigationComponent } from './app-navigation.component';

describe('AppNavigationComponent', () => {
  it('opens Settings from the navigation bar', () => {
    const component = new AppNavigationComponent();
    const selected = vi.spyOn(component.pageSelected, 'emit');
    component.selectPage({ preventDefault: vi.fn() } as unknown as MouseEvent, 'settings');
    expect(selected).toHaveBeenCalledWith('settings');
  });

  it('detaches a page only after the pointer moves 48 pixels beyond the navigation bounds', () => {
    const component = new AppNavigationComponent();
    const detached = vi.spyOn(component.pageDetached, 'emit');
    const releasePointerCapture = vi.fn();
    const state = component as unknown as {
      dragPointerId: number;
      navigationBounds: DOMRect;
    };
    component.draggingPage = 'features';
    state.dragPointerId = 7;
    state.navigationBounds = { left: 0, right: 64, top: 0, bottom: 700 } as DOMRect;

    component.continuePageDrag(pointerEvent({ clientX: 111, releasePointerCapture }), 'features');
    expect(detached).not.toHaveBeenCalled();

    component.continuePageDrag(pointerEvent({ clientX: 112, releasePointerCapture }), 'features');
    expect(detached).toHaveBeenCalledWith({ page: 'features', screenX: 312, screenY: 240 });
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(component.draggingPage).toBeNull();
  });

  it('suppresses the navigation click generated after a successful detach', () => {
    const component = new AppNavigationComponent();
    const selected = vi.spyOn(component.pageSelected, 'emit');
    const preventDefault = vi.fn();
    const state = component as unknown as { suppressClickPage: 'history' };
    state.suppressClickPage = 'history';

    component.selectPage({ preventDefault } as unknown as MouseEvent, 'history');

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(selected).not.toHaveBeenCalled();
  });
});

function pointerEvent(options: {
  clientX: number;
  releasePointerCapture: (pointerId: number) => void;
}): PointerEvent {
  return {
    button: 0,
    pointerId: 7,
    clientX: options.clientX,
    clientY: 240,
    screenX: 312,
    screenY: 240,
    currentTarget: { releasePointerCapture: options.releasePointerCapture },
    preventDefault: vi.fn(),
  } as unknown as PointerEvent;
}
