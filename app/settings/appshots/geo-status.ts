export type AppshotsGeoHintStatus = 'ok' | 'private' | 'unresolved';

export function describeGeoHintStatus(status: AppshotsGeoHintStatus): string | null {
  // Copy intentionally short and neutral. Anything longer would push the
  // device card onto a third visual line and compete with the timestamp.
  switch (status) {
    case 'private':
      return 'Ubicación no disponible (red privada)';
    case 'unresolved':
      return 'Ubicación no disponible';
    case 'ok':
    default:
      return null;
  }
}
