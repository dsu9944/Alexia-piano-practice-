/** Kid-friendly sticker chips Joe can assign to a take or section. */
export interface StickerDef {
  id: string
  label: string
  emoji: string
  /** Soft background tint */
  tint: string
}

export const STICKERS: StickerDef[] = [
  { id: 'great-rhythm', label: 'Great rhythm', emoji: '🥁', tint: '#ffe8c8' },
  { id: 'careful-hands', label: 'Careful hands', emoji: '🙌', tint: '#e0f0ff' },
  { id: 'lovely-tone', label: 'Lovely tone', emoji: '🎵', tint: '#e8f8e8' },
  { id: 'music-notes', label: 'Music notes', emoji: '🎶', tint: '#f3e8ff' },
  { id: 'star-shine', label: 'Star shine', emoji: '⭐', tint: '#fff3c4' },
  { id: 'trophy', label: 'Trophy', emoji: '🏆', tint: '#ffe4d6' },
  { id: 'rainbow', label: 'Rainbow', emoji: '🌈', tint: '#e8f4ff' },
  { id: 'heart', label: 'Big heart', emoji: '💖', tint: '#ffe0ec' },
  { id: 'high-five', label: 'High five', emoji: '✋', tint: '#e8fbe8' },
  { id: 'sparkle', label: 'Sparkle', emoji: '✨', tint: '#fff8e0' },
]

export function stickerById(id: string): StickerDef | undefined {
  return STICKERS.find((s) => s.id === id)
}
