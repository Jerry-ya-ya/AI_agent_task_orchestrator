import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app.component';
import { applyTheme, readStoredTheme } from './app/theme-preferences';

applyTheme(readStoredTheme());

bootstrapApplication(AppComponent, {
  providers: [provideHttpClient()],
}).catch((error: unknown) => {
  console.error('Unable to start the orchestrator UI.', error);
});
