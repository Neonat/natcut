import type { ChangeEvent, PointerEvent } from 'react';

type Props = {
  value: number;
  custom: boolean;
  onPreset: (value: number) => void;
  onCustom: () => void;
  onCustomChange: (value: number) => void;
  onCustomRelease: () => void;
};

const presets = [
  { label: 'Tight', value: 1 },
  { label: 'Standard', value: 1.5 },
  { label: 'Wide', value: 2 },
] as const;

export function CutBorderControl(props: Props) {
  const change = (event: ChangeEvent<HTMLInputElement>) => props.onCustomChange(Number(event.target.value));
  const release = (_event: PointerEvent<HTMLInputElement>) => props.onCustomRelease();
  return (
    <section className="controls" aria-labelledby="border-title">
      <div className="section-heading">
        <div><p className="eyebrow">Cut border</p><h2 id="border-title">Choose the white edge</h2></div>
        <output className="measurement" aria-live="polite">{props.value.toFixed(1)} mm</output>
      </div>
      <div className="preset-grid">
        {presets.map((preset) => (
          <button
            className={!props.custom && props.value === preset.value ? 'preset selected' : 'preset'}
            key={preset.label}
            type="button"
            aria-pressed={!props.custom && props.value === preset.value}
            onClick={() => props.onPreset(preset.value)}
          ><span>{preset.label}</span><small>{preset.value.toFixed(1)} mm</small></button>
        ))}
        <button className={props.custom ? 'preset selected' : 'preset'} type="button" aria-pressed={props.custom} onClick={props.onCustom}>
          <span>Custom</span><small>Fine tune</small>
        </button>
      </div>
      {props.custom ? (
        <div className="slider-wrap">
          <label htmlFor="custom-cut-border">Custom cut border</label>
          <input id="custom-cut-border" type="range" min="0.5" max="3" step="0.1" value={props.value} onChange={change} onPointerUp={release} />
          <div className="range-labels" aria-hidden="true"><span>0.5 mm</span><span>3.0 mm</span></div>
        </div>
      ) : null}
    </section>
  );
}
