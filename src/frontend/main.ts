import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app.component';
import { applyTheme, readStoredTheme } from './app/theme-preferences';
import { initializeDesktop } from './desktop';

applyTheme(readStoredTheme());

initializeDesktop().then((interceptors) => bootstrapApplication(AppComponent, {
  providers: [provideHttpClient(withInterceptors(interceptors))],
})).catch((error: unknown) => {
  console.error('Unable to start the orchestrator UI.', error);
  const root = document.querySelector('app-root');
  if (root) root.textContent = 'Unable to start the orchestrator UI.';
});
