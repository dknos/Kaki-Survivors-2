/** Draw Your Track mode coordinator. Owns one editor instance at a time. */
import { DrawTrackUI } from './drawTrackUI.js';
import { TRACK_WIDTH_PRESETS } from './drawTrackGeometry.js';
import { getTrackGallerySummary } from './drawTrackStorage.js';

let activeEditor = null;

function defaultBuild({ draft, course }) {
  const width = TRACK_WIDTH_PRESETS[draft.widthId] || TRACK_WIDTH_PRESETS.standard;
  if (typeof window?.kkStartRacing !== 'function') throw new Error('Kaki Rally is not ready yet');
  return window.kkStartRacing(course.id, {
    mode: 'draw',
    customCourse: course,
    customTrack: draft,
    carCount: width.cars,
  });
}

export function openDrawTrackMode({ initialTrack = null, onBuild = null, onExit = null } = {}) {
  activeEditor?.destroy?.();
  activeEditor = new DrawTrackUI({
    initialTrack,
    onBuild: (payload) => {
      activeEditor = null;
      return (onBuild || defaultBuild)(payload);
    },
    onExit: () => {
      activeEditor = null;
      onExit?.();
    },
  });
  return activeEditor;
}

export function closeDrawTrackMode() {
  if (!activeEditor) return false;
  activeEditor.destroy();
  activeEditor = null;
  return true;
}

export function getDrawTrackModeCardStats() {
  return getTrackGallerySummary();
}

export function isDrawTrackModeOpen() {
  return !!activeEditor;
}

if (typeof window !== 'undefined') {
  window.kkOpenDrawTrackEditor = (initialTrack = null) => openDrawTrackMode({ initialTrack });
}
