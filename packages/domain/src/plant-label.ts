const names: Record<string, string> = {
  'plumeria pudica': 'Frangipani',
  'plumeria rubra': 'Frangipani',
  'strelitzia reginae': 'Bird of paradise',
  'bougainvillea glabra': 'Bougainvillea',
  'capsicum annuum': 'Chilli plant',
  'kroenleinia grusonii': 'Golden barrel cactus',
  'hibiscus rosa-sinensis': 'Hibiscus',
  'monstera deliciosa': 'Monstera',
  'dracaena trifasciata': 'Snake plant',
  'fragaria ananassa': 'Strawberry',
  'helianthus annuus': 'Sunflower',
  'dionaea muscipula': 'Venus flytrap',
  'phalaenopsis amabilis': 'Moth orchid',
  'prunus serrulata': 'Cherry blossom',
};

export function commonPlantLabel(scientificName: string | null | undefined): string {
  if (!scientificName) return 'YOUR PLANT';
  const normalized = scientificName.normalize('NFKD').replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return 'YOUR PLANT';
  if (names[normalized]) return names[normalized].toUpperCase();
  const genus = normalized.split(' ')[0] ?? 'YOUR PLANT';
  return genus.slice(0, 24).toUpperCase();
}
