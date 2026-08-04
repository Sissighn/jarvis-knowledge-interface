type MapControlsProps = {
  canFocus: boolean;
  focusActive: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFocus: () => void;
  onClearFocus: () => void;
};

export function MapControls({
  canFocus,
  focusActive,
  onZoomIn,
  onZoomOut,
  onReset,
  onFocus,
  onClearFocus,
}: MapControlsProps) {
  return (
    <div className="map-controls" role="group" aria-label="Map-Navigation">
      <button type="button" onClick={onZoomIn} title="Vergrößern" aria-label="Map vergrößern">+</button>
      <button type="button" onClick={onZoomOut} title="Verkleinern" aria-label="Map verkleinern">−</button>
      <button type="button" onClick={onReset} title="Gesamtansicht" aria-label="Map zurücksetzen">⌂</button>
      <button
        type="button"
        className={focusActive ? "is-active" : ""}
        disabled={!canFocus}
        onClick={focusActive ? onClearFocus : onFocus}
        title={focusActive ? "Fokus lösen" : "Auswahl fokussieren"}
        aria-label={focusActive ? "Map-Fokus lösen" : "Ausgewählten Knoten fokussieren"}
        aria-pressed={focusActive}
      >
        ◎
      </button>
    </div>
  );
}
