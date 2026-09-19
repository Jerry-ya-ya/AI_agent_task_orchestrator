import '@angular/compiler';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectEditorDialogComponent } from './project-editor-dialog.component';

afterEach(() => vi.unstubAllGlobals());

describe('ProjectEditorDialogComponent', () => {
  it('uses the Electron folder chooser and copies its selected path into the project draft', async () => {
    const chooseRepository = vi.fn().mockResolvedValue('C:\\Projects\\chosen-repository');
    vi.stubGlobal('window', { desktopWindow: { chooseRepository } });
    const component = new ProjectEditorDialogComponent();
    component.draft = { name: '', repository_path: 'C:\\Projects\\previous', context: '' };

    await component.chooseRepository();

    expect(chooseRepository).toHaveBeenCalledWith('C:\\Projects\\previous');
    expect(component.draft.repository_path).toBe('C:\\Projects\\chosen-repository');
    expect(component.choosingRepository).toBe(false);
  });

  it('keeps the typed path when the folder chooser is cancelled', async () => {
    vi.stubGlobal('window', { desktopWindow: { chooseRepository: vi.fn().mockResolvedValue(null) } });
    const component = new ProjectEditorDialogComponent();
    component.draft = { name: '', repository_path: 'C:\\Projects\\typed', context: '' };

    await component.chooseRepository();

    expect(component.draft.repository_path).toBe('C:\\Projects\\typed');
  });
});
