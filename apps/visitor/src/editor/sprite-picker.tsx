import { assetPngFilename, spriteChoices } from '@natcut/render/browser';

export function SpritePicker({ selected, onChange, reloadKey = 0 }: {
  selected: string;
  onChange: (id: string) => void;
  reloadKey?: number;
}) {
  return (
    <fieldset className="sprite-picker">
      <legend>Choose your sprite</legend>
      <div className="sprite-options">
        {spriteChoices(selected).map((entry) => (
          <label className="sprite-option" key={entry.id}>
            <input type="radio" name="sprite" value={entry.id} checked={entry.id === selected}
              onChange={() => onChange(entry.id)} />
            <img src={`/${assetPngFilename(entry.id)}?reload=${entry.id === selected ? reloadKey : 0}`} alt="" loading="lazy" width="44" height="44" />
            <span>{entry.name}{entry.scientificName && <small>{entry.scientificName}</small>}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
