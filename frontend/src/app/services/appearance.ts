import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';

const paletteStorageKey = 'deploy.ui-color-palette.v1';

export type UiColorPaletteId = 'ocean' | 'graphite' | 'sage' | 'ember' | 'lavender';

export interface UiColorPalette {
  id: UiColorPaletteId;
  name: string;
  description: string;
  swatches: readonly string[];
}

const palettes: readonly UiColorPalette[] = [
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Cool gray with a clear blue accent',
    swatches: ['#f5f5f7', '#ffffff', '#007aff', '#e5e5ea'],
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Quiet neutrals with a teal accent',
    swatches: ['#f4f5f6', '#ffffff', '#008b8b', '#e0e4e8'],
  },
  {
    id: 'sage',
    name: 'Sage',
    description: 'Soft greens with a forest accent',
    swatches: ['#f3f6f2', '#fffefa', '#34764b', '#e0e7de'],
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm sand with a terracotta accent',
    swatches: ['#f7f3ef', '#fffefd', '#bc5634', '#e9ddd5'],
  },
  {
    id: 'lavender',
    name: 'Lavender',
    description: 'Cool lilac with a muted violet accent',
    swatches: ['#f4f3f8', '#ffffff', '#7052a5', '#e4e0ed'],
  },
];

@Injectable({ providedIn: 'root' })
export class AppearanceService {
  private readonly document = inject(DOCUMENT);
  readonly palettes = palettes;
  readonly palette = signal(readStoredPalette());

  constructor() {
    this.applyPalette(this.palette());
  }

  setPalette(palette: UiColorPaletteId) {
    this.palette.set(palette);
    this.applyPalette(palette);
    try {
      localStorage.setItem(paletteStorageKey, palette);
    } catch {
      // Keep the selection active for this page even when browser storage is unavailable.
    }
  }

  private applyPalette(palette: UiColorPaletteId) {
    this.document.documentElement.dataset['palette'] = palette;
  }
}

function readStoredPalette(): UiColorPaletteId {
  try {
    const stored = localStorage.getItem(paletteStorageKey);
    return palettes.some((palette) => palette.id === stored) ? stored as UiColorPaletteId : 'ocean';
  } catch {
    return 'ocean';
  }
}
