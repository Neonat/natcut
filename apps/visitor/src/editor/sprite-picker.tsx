import { assetPngFilename, sprites } from '@natcut/render/browser';

export function SpritePicker({ selected, onChange }: { selected: string; onChange: (id: string) => void }) {
  return (
    <fieldset className="sprite-picker">
      <legend>Choose your sprite</legend>
      <div className="sprite-options">
        {sprites.map((entry) => (
          <label className="sprite-option" key={entry.id}>
            <input type="radio" name="sprite" value={entry.id} checked={entry.id === selected}
              onChange={() => onChange(entry.id)} />
            <img src={'/' + assetPngFilename(entry.id)} alt="" loading="lazy" width="44" height="44" />
            <span>{entry.name}{entry.scientificName && <small>{entry.scientificName}</small>}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
